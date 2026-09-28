// ==UserScript==
// @name         115 网盘 JAV 标签助手
// @namespace    https://github.com/jv115-tagger
// @version      1.3.0
// @description  读取 115 网盘视频文件名，自动提取番号，从 JavBus / javlibrary 拉取影片信息，在文件列表上以「标题+演员+类别」标签形式展示。纯本地标签库，不改动 115 任何原始文件，无需 API key。
// @author       jv115-tagger
// @match        *://*.115.com/*
// @match        *://*.115cdn.com/*
// @match        *://*.115vod.com/*
// @include      *://*.115.com/*
// @include      *://*.115cdn.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_log
// @connect      javbus.com
// @connect      www.javbus.com
// @connect      javlibrary.com
// @connect      www.javlibrary.com
// @connect      dmm.co.jp
// @connect      api.dmm.com
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ---- 立即探针：脚本一被注入就打印，用于区分「未运行」和「运行后失败」 ----
  try {
    console.log('%c[jv115-tagger] ✅ 脚本已注入并开始执行', 'color:#1a7f45;font-size:13px;font-weight:bold');
    console.log('%c[jv115-tagger]', 'color:#888', 'URL =', location.href);
  } catch (e) { /* 忽略 */ }

  // 避免重复注入（同一页面被多次加载时）
  if (window.__JV115_TAGGER_LOADED__) {
    console.log('[jv115-tagger] 已加载，跳过重复注入');
    return;
  }
  window.__JV115_TAGGER_LOADED__ = true;


/* ==================================================================
 * core/frames.js
 * ================================================================== */

/**
 * 跨 frame 通信
 * ------------------------------------------------------------------
 * 115 的文件列表渲染在 iframe 里（tpl=view_large&ct=file），
 * 而控制面板挂在顶层窗口。两者需要协作：
 *
 *   顶层面板 ──(广播指令)──> 列表 iframe（执行扫描/渲染标签）
 *   列表 iframe ──(回报结果)──> 顶层面板（更新进度/统计）
 *
 * 由于是同源（都是 115.com），用 postMessage 最简单可靠。
 */

const CHANNEL = 'jv115-tagger';

/** 判断当前是否顶层窗口 */
function isTopFrame() {
  try {
    return window.top === window.self;
  } catch (e) {
    return false;
  }
}

/**
 * 判断当前 frame 是否是「文件列表 frame」。
 * 115 的列表 iframe URL 特征：ct=file & ac=userfile & tpl=view_large
 */
function isFileListFrame() {
  try {
    const u = new URL(location.href);
    const ct = u.searchParams.get('ct');
    const ac = u.searchParams.get('ac');
    return ct === 'file' && (ac === 'userfile' || ac === 'userfiles');
  } catch (e) {
    return false;
  }
}

/** 广播指令给所有 frame（含自身） */
function broadcast(type, payload = {}) {
  const msg = { __jv115: CHANNEL, type, payload, ts: Date.now() };
  try {
    if (window.top === window.self) {
      // 顶层：发给所有子 frame
      for (const f of document.querySelectorAll('iframe')) {
        try { f.contentWindow?.postMessage(msg, '*'); } catch (e) { /* 跨域忽略 */ }
      }
    } else {
      // 子 frame：发给顶层
      try { window.top.postMessage(msg, '*'); } catch (e) { /* 忽略 */ }
    }
  } catch (e) { /* 忽略 */ }
}

/**
 * 监听广播。
 * @param {(type: string, payload: object) => void} handler
 * @returns {() => void} 取消监听
 */
function onBroadcast(handler) {
  const listener = (ev) => {
    const d = ev.data;
    if (!d || d.__jv115 !== CHANNEL) return;
    try {
      handler(d.type, d.payload || {});
    } catch (e) {
      console.warn('[jv115-tagger] 广播处理异常', e);
    }
  };
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}

/** 枚举当前页面所有同源 iframe 的 document（用于跨 frame 扫描兜底） */
function collectSameOriginDocuments() {
  const docs = [document];
  for (const f of document.querySelectorAll('iframe')) {
    try {
      const d = f.contentDocument;
      if (d && d.body) docs.push(d);
    } catch (e) { /* 跨域忽略 */ }
  }
  return docs;
}


/* ==================================================================
 * core/tag-extractor.js
 * ================================================================== */

/**
 * 番号提取模块
 * ------------------------------------------------------------------
 * 从 115 网盘的视频文件名中提取影片番号（品番 / 品番号）。
 *
 * 设计原则：
 *  1. 宽容优先 —— 115 里的命名极其混乱，宁可有误判也不能漏判
 *  2. 归一化 —— 统一输出 "ABC-123" 这种「大写前缀-数字」标准形式
 *  3. 带置信度 —— 区分「高置信度精确命中」和「低置信度猜测」
 *
 * 覆盖的命名变体：
 *   ABC-123       标准形式
 *   ABC_123       下划线分隔
 *   ABC 123       空格分隔
 *   ABC123        无分隔
 *   h_123         无码常见形式（字面量 h_）
 *   abc-123-c     带后缀（-c / -C 表示中文字幕）
 *   [高清]ABC-123 带方括号标签前缀
 *   ABC-123.mp4   带扩展名
 *   ABC00123      部分厂商的连号写法
 */
const VARIANT_SAMPLES = [
  'SSNI-730.mp4',
  'abc-123-c.mp4',
  'ABP_456 中文字幕.mp4',
  'h_123.mp4',
  'MIAA123.mp4',
  '[高清] DVAJ-556 无码破解.mp4',
  'JUQ-434-C 4K.mp4',
  'SONE-119[中文字幕].mkv',
  '[ThZu.Cc]PRED-501.mp4',
  '120123-456-1pon.mp4',
  '第01集.mp4',
  '我的视频.MP4'
];

/** 无码厂商常见的纯数字番号前缀（如 1pon / carib / pacopacomama 等） */
const UNCENSORED_PREFIX = /^(1pon|10mu|carib|pacopacomama|heydouga|muramura|Tokyo-Hot|n\d{4}|k\d{4})/i;

/**
 * 高置信度番号模式。
 * 前缀 2~6 位字母，可选分隔符，3~5 位数字。
 * 用 \b 边界约束，避免把 4K / 1080P 这类误判成番号。
 */
const PATTERN_PRIMARY = /\b([A-Z]{2,6})[-_\s]?(\d{2,5})\b/gi;

/**
 * 无码 h_ 形式：h_123 / h_1234
 */
const PATTERN_H_FORMAT = /\bh[-_](\d{3,4})\b/gi;

/** 需要排除的伪番号（分辨率、编码、常见标签） */
const BLACKLIST = new Set([
  'MP4', 'MKV', 'AVI', 'WMV', 'MOV', 'TS', 'M2TS', 'ISO', 'RMVB',
  'HD', 'FHD', 'UHD', 'SD', 'BD', 'WEB', 'WEBRIP', 'BLURAY',
  'X264', 'X265', 'H264', 'H265', 'HEVC', 'AVC', 'AAC', 'AC3', 'DTS',
  'CH', 'GB', 'MB', 'KB', 'TB', 'FPS', 'KBS', 'MBPS',
  'CD1', 'CD2', 'CD3', 'PART1', 'PART2', 'DISC1', 'DISC2',
  'NEW', 'FINAL', 'FULL', 'VIP', 'THE', 'AND', 'FOR',
  'EP', 'EPS', 'SP', 'OVA', 'EXTRA', 'TRAILER', 'PREVIEW', 'SAMPLE',
  'S01', 'S02', 'S1', 'S2', 'EP01', 'EP1',
  'AM', 'PM', 'UTC', 'GMT', 'USB', 'URL', 'HTTP', 'HTTPS',
  'JPG', 'JPEG', 'PNG', 'GIF', 'ZIP', 'RAR', '7Z',
  'XXX', 'COM', 'NET', 'ORG', 'CC', 'TV', 'ME', 'XYZ'
]);

/**
 * 常见厂商前缀白名单。命中则显著提升置信度。
 * 不追求穷尽 —— 未命中不代表无效，只是降一档置信度。
 */
const KNOWN_STUDIO_PREFIX = new Set([
  // 北都系（S1 / IdeaPocket / Premium / Madonna / MOODYZ / Wanz / Attackers）
  'SSNI', 'SONE', 'SSIS', 'SNIS', 'ONED', 'OFJE', 'MIDE', 'MIDV', 'MIAA', 'MIMK', 'MIFD',
  'IPX', 'IPZZ', 'IPIT', 'IPBF', 'PFES', 'PRED', 'PGD', 'PRST', 'PRMJ',
  'JUL', 'JUQ', 'JULI', 'ACHJ',
  'MIDV', 'MDON',
  'STARS', 'START', 'SIRO', 'SGA', 'SGS',
  'ATID', 'ATKD', 'ADN', 'SHKD', 'RBD', 'DOM',
  'RCTD', 'RCT', 'HUNTA', 'GVG', 'NHDTA', 'NHDT',
  // KMP 系（Moodyz 之外的独立系）
  'MUKD', 'MUKC', 'MIRD', 'MIAE', 'MIKR',
  // 其他主流
  'ABP', 'ABW', 'ADV', 'AARM', 'ARM',
  'DVAJ', 'DVAS', 'DASD', 'DANDY', 'DMOW',
  'FSDSS', 'FSDSS', 'FNS', 'FALENO',
  'CAWD', 'CJOD', 'CIEL', 'CLOT',
  'EBOD', 'EBWH', 'EKDV',
  'GAN', 'GANA', 'GAS',
  'HND', 'HODV', 'HOMA',
  'JAV', 'JAC',
  'KAWD', 'KIRE', 'KNAM',
  'LULU', 'LUXU',
  'MEYD', 'MIGD', 'MIST', 'MNGS', 'MRSS', 'MTALL',
  'NACR', 'NACX', 'NEO', 'NGOD', 'NITR',
  'OAE', 'OIGS', 'OKS',
  'PPP', 'PPPD', 'PXH',
  'RKI', 'ROE', 'RUM',
  'SABA', 'SAD', 'SAN', 'SBK', 'SDDE', 'SDJS', 'SDMF', 'SDNM', 'SHN', 'SIBN',
  'SILK', 'SKY', 'SNOS', 'SOE', 'SQTE', 'SSPD', 'STAR', 'SUKE',
  'TD', 'TEK', 'TIKB', 'TMEM', 'TMRD', 'TORG', 'TPPN', 'TSF',
  'UMSO', 'URE', 'URKK',
  'VAGU', 'VEC', 'VENU', 'VRTM', 'VSPDS',
  'WAAP', 'WAAA', 'WANZ', 'WSS',
  'YMDD', 'YSN', 'YST',
  'ZEX', 'ZUKO', 'ZOOM'
]);

/**
 * 归一化番号。
 * 将各种分隔形式统一为 "ABC-123"。
 *
 * @param {string} prefix 字母前缀
 * @param {string} digits 数字部分
 * @returns {string} 归一化后的番号
 */
function normalizeCode(prefix, digits) {
  const p = prefix.toUpperCase();
  // 去掉数字的前导零，但保留至少 3 位（如 00123 -> 123，007 -> 007）
  let d = String(digits).replace(/^0+(?=\d{3,})/, '');
  return `${p}-${d}`;
}

/**
 * 从单个文件名中提取番号。
 *
 * @param {string} filename 原始文件名（可含扩展名）
 * @returns {{code: string, confidence: number, raw: string, source: string} | null}
 *          code       归一化番号，如 "SSNI-730"
 *          confidence 0~100 置信度
 *          raw        原始命中文本
 *          source     命中的模式名
 */
function extractCode(filename) {
  if (!filename || typeof filename !== 'string') return null;

  // 去掉扩展名与常见噪音，但保留正文用于匹配
  const work = filename
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/[\[\]()【】（）]/g, ' ');

  const candidates = [];

  // ---- 模式 1：h_ 无码形式 ----
  let m;
  PATTERN_H_FORMAT.lastIndex = 0;
  while ((m = PATTERN_H_FORMAT.exec(work)) !== null) {
    const digits = m[1];
    candidates.push({
      code: `H-${digits}`,
      confidence: 85,
      raw: m[0],
      source: 'h_format',
      index: m.index
    });
  }

  // ---- 模式 2：标准字母+数字 ----
  PATTERN_PRIMARY.lastIndex = 0;
  while ((m = PATTERN_PRIMARY.exec(work)) !== null) {
    const prefix = m[1];
    const digits = m[2];
    const upper = prefix.toUpperCase();

    if (BLACKLIST.has(upper)) continue;
    // 排除纯分辨率写法 1080P / 720P
    if (/^\d+$/.test(prefix)) continue;

    let confidence = 70;
    if (KNOWN_STUDIO_PREFIX.has(upper)) confidence = 95;
    // 数字部分 3~4 位更像番号（xxx-123）
    if (digits.length === 3 || digits.length === 4) confidence += 3;
    // 原文带分隔符更像正式番号
    if (/[-_\s]/.test(m[0])) confidence += 2;

    candidates.push({
      code: normalizeCode(prefix, digits),
      confidence: Math.min(confidence, 99),
      raw: m[0],
      source: 'primary',
      index: m.index
    });
  }

  // ---- 模式 3：无码纯数字系列（120123-456 这类）----
  const uncensored = work.match(/\b(\d{6})[-_](\d{3})\b/);
  if (uncensored) {
    candidates.push({
      code: `${uncensored[1]}-${uncensored[2]}`,
      confidence: 75,
      raw: uncensored[0],
      source: 'uncensored_date',
      index: uncensored.index
    });
  }

  if (candidates.length === 0) return null;

  // 取置信度最高者；同分时取位置靠前的
  candidates.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return a.index - b.index;
  });

  const best = candidates[0];
  return {
    code: best.code,
    confidence: best.confidence,
    raw: best.raw,
    source: best.source
  };
}

/**
 * 批量提取。返回每个文件的提取结果。
 *
 * @param {Array<string|{name:string, id?:string}>} files
 * @returns {Array<{input: string, id: string|null, result: object|null}>}
 */
function extractBatch(files) {
  return files.map((f) => {
    const name = typeof f === 'string' ? f : f.name;
    const id = typeof f === 'string' ? null : (f.id ?? null);
    return {
      input: name,
      id,
      name,
      result: extractCode(name)
    };
  });
}

/** 自测：跑一遍样例，打印命中情况 */
function selfTest() {
  const rows = VARIANT_SAMPLES.map((n) => {
    const r = extractCode(n);
    return {
      文件名: n,
      番号: r ? r.code : '—',
      置信度: r ? r.confidence : 0,
      模式: r ? r.source : '—'
    };
  });
  return rows;
}


/* ==================================================================
 * core/providers.js
 * ================================================================== */

/**
 * 数据源 Provider 层（浏览器直连版）
 * ------------------------------------------------------------------
 * 核心变化：所有网络请求走 GM_xmlhttpRequest，绕开 CORS 限制。
 * 请求实际在你浏览器的网络环境中发出，因此能利用你本机的 VPN 通道。
 *
 * Provider 列表：
 *   JavbusProvider     javbus.com —— 主板番号库，解析搜索页 + 详情页
 *   JavlibraryProvider javlibrary.com —— 备用，带影片详情表格
 *   DmmProvider        DMM 官方 API —— 可选，有 key 时才启用
 *
 * 统一输出结构（NormalizedMeta）：
 *   {
 *     code, title, actresses[], studio, releaseDate,
 *     cover, genres[], source, fetchedAt, url
 *   }
 */

const REQUEST_TIMEOUT = 20000;

/**
 * 统一请求入口。
 * 优先用 GM_xmlhttpRequest（可跨域）。
 * 没有 GM API 时降级到 fetch。
 *
 * @param {string} url
 * @param {{method?:string, headers?:object, timeout?:number}} opts
 * @returns {Promise<string>} 响应文本
 */
function request(url, opts = {}) {
  const method = opts.method || 'GET';
  const timeout = opts.timeout || REQUEST_TIMEOUT;
  const headers = {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,ja;q=0.8,en;q=0.7',
    ...(opts.headers || {})
  };

  // 优先 GM_xmlhttpRequest
  if (typeof GM_xmlhttpRequest === 'function') {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url,
        headers,
        timeout,
        onload: (res) => {
          if (res.status >= 200 && res.status < 400) {
            resolve(res.responseText);
          } else {
            reject(new Error(`HTTP ${res.status}`));
          }
        },
        onerror: () => reject(new Error('网络请求失败')),
        ontimeout: () => reject(new Error('请求超时')),
        onabort: () => reject(new Error('请求被中止'))
      });
    });
  }

  // 降级：fetch
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  return fetch(url, { method, headers, signal: controller.signal, credentials: 'omit' })
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.text();
    })
    .finally(() => clearTimeout(timer));
}

/** HTML 解析辅助：把字符串转成 Document */
function parseHtml(html) {
  return new DOMParser().parseFromString(html, 'text/html');
}

/** 文本清洗 */
function clean(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/** 判断响应是否被 Cloudflare 拦截 */
function isBlocked(html) {
  if (!html || html.length < 500) return true;
  return /cf-browser-verification|Just a moment|Checking your browser|Attention Required|cf_chl_/i.test(html);
}

/* ==================================================================
 * 基类
 * ================================================================== */
class BaseProvider {
  constructor(name) {
    this.name = name;
    this.enabled = true;
  }
  // eslint-disable-next-line no-unused-vars
  async search(code) {
    throw new Error('search() 未实现');
  }
}

/* ==================================================================
 * JavBus Provider
 * ------------------------------------------------------------------
 * 搜索页：/{lang}/search/{code}/1    或  /search/{code}/1
 * 详情页：/{lang}/{code}
 *
 * 列表项结构（常见）：
 *   <div class="movie-box" href="...">
 *     <div class="photo-frame"><img src="封面" title="标题"></div>
 *     <div class="photo-info">
 *       <span>番号 <date>2024-01-01</date></span>
 *     </div>
 *   </div>
 *
 * 详情页：
 *   .bigImage img      封面
 *   .star-name a       演员
 *   .genre a           类别
 *   .info p            厂商/发行商
 * ================================================================== */
class JavbusProvider extends BaseProvider {
  constructor(config = {}) {
    super('javbus');
    this.baseUrl = (config.javbusBaseUrl || 'https://www.javbus.com').replace(/\/$/, '');
    this.enabled = config.enableJavbus !== false;
  }

  async search(code) {
    const searchUrl = `${this.baseUrl}/search/${encodeURIComponent(code)}/1`;
    const html = await request(searchUrl, { headers: { Referer: `${this.baseUrl}/` } });

    if (isBlocked(html)) {
      const err = new Error('被 Cloudflare 拦截，请在浏览器里打开一次 javbus 通过验证');
      err.code = 'BLOCKED';
      err.url = this.baseUrl;
      throw err;
    }

    const hits = this.parseSearch(html);
    if (hits.length === 0) return null;

    const norm = (s) => String(s).replace(/[-_\s]/g, '').toUpperCase();
    const target = norm(code);
    const hit = hits.find((h) => norm(h.code) === target) || hits[0];

    // 进详情页补全
    try {
      const detail = await this.fetchDetail(hit.detailUrl);
      return {
        code,
        title: detail.title || hit.title,
        actresses: detail.actresses,
        genres: detail.genres,
        studio: detail.studio,
        cover: detail.cover || hit.cover,
        releaseDate: detail.releaseDate || hit.releaseDate,
        source: 'javbus',
        fetchedAt: Date.now(),
        url: hit.detailUrl
      };
    } catch (e) {
      // 详情页失败也要返回列表页信息
      return {
        code,
        title: hit.title,
        actresses: [],
        genres: [],
        studio: '',
        cover: hit.cover,
        releaseDate: hit.releaseDate,
        source: 'javbus',
        fetchedAt: Date.now(),
        url: hit.detailUrl,
        partial: true
      };
    }
  }

  parseSearch(html) {
    const doc = parseHtml(html);
    const out = [];

    // 容器可能是 .movie-box 或 .item
    const nodes = doc.querySelectorAll('.movie-box, .item, a.movie-box');
    nodes.forEach((node) => {
      const link = node.tagName === 'A' ? node : node.querySelector('a');
      const href = link?.getAttribute('href') || node.getAttribute('href') || '';
      if (!href) return;

      const img = node.querySelector('img');
      const title = clean(img?.getAttribute('title') || node.querySelector('.photo-info span')?.textContent);
      const dateEl = node.querySelector('date, .date');
      const dateText = clean(dateEl?.textContent);

      out.push({
        code: this.extractCodeFromText(title + ' ' + href),
        title,
        detailUrl: href.startsWith('http') ? href : `${this.baseUrl}${href.startsWith('/') ? '' : '/'}${href}`,
        cover: img?.getAttribute('src') || '',
        releaseDate: dateText
      });
    });

    return out;
  }

  extractCodeFromText(text) {
    const m = String(text).match(/([A-Z]{2,6})[-_\s]?(\d{2,5})/i);
    return m ? `${m[1].toUpperCase()}-${m[2]}` : '';
  }

  async fetchDetail(url) {
    const html = await request(url, { headers: { Referer: `${this.baseUrl}/` } });
    if (isBlocked(html)) throw new Error('详情页被拦截');

    const doc = parseHtml(html);

    // 标题：h3 优先
    let title = clean(doc.querySelector('h3')?.textContent);

    // 演员
    const actresses = [];
    doc.querySelectorAll('.star-name a, .avatar-box .star-name, .star-name').forEach((el) => {
      const n = clean(el.textContent);
      if (n && !actresses.includes(n)) actresses.push(n);
    });

    // 类别
    const genres = [];
    doc.querySelectorAll('.genre a, .genre label a').forEach((el) => {
      const n = clean(el.textContent);
      if (n && !genres.includes(n)) genres.push(n);
    });

    // 封面
    const cover =
      doc.querySelector('.bigImage img')?.getAttribute('src') ||
      doc.querySelector('#bigImage img')?.getAttribute('src') ||
      doc.querySelector('.screencap img')?.getAttribute('src') || '';

    // 发行日期 + 厂商
    let releaseDate = '';
    let studio = '';
    doc.querySelectorAll('.info p').forEach((p) => {
      const t = clean(p.textContent);
      if (/發行日期|发行日期|発売日/.test(t)) {
        const d = t.match(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/);
        if (d) releaseDate = `${d[1]}-${String(d[2]).padStart(2, '0')}-${String(d[3]).padStart(2, '0')}`;
      }
      if (/製作商|发行商|メーカー/.test(t)) {
        studio = clean(p.querySelector('a')?.textContent) || t.replace(/^[^：:]*[：:]/, '').trim();
      }
    });

    return { title, actresses, genres, cover, releaseDate, studio };
  }
}

/* ==================================================================
 * JavLibrary Provider
 * ------------------------------------------------------------------
 * javlibrary 结构（繁中站）：
 *   搜索：/cn/vl_searchbyid.php?keyword={code}
 *   详情：/cn/?v=javli...
 *
 * 详情页关键区域：
 *   #video_title          标题
 *   #video_cast .cast .star a   演员
 *   #video_genres .genre a      类别
 *   #video_info            信息表
 * ================================================================== */
class JavlibraryProvider extends BaseProvider {
  constructor(config = {}) {
    super('javlibrary');
    this.baseUrl = (config.javlibraryBaseUrl || 'https://www.javlibrary.com').replace(/\/$/, '');
    this.lang = config.javlibraryLang || 'cn';
    this.enabled = config.enableJavlibrary !== false;
  }

  async search(code) {
    const searchUrl = `${this.baseUrl}/${this.lang}/vl_searchbyid.php?keyword=${encodeURIComponent(code)}`;
    const html = await request(searchUrl, { headers: { Referer: `${this.baseUrl}/${this.lang}/` } });

    if (isBlocked(html)) {
      const err = new Error('javlibrary 被拦截或不可用');
      err.code = 'BLOCKED';
      err.url = this.baseUrl;
      throw err;
    }

    const doc = parseHtml(html);

    // 情况一：直接跳到了详情页
    let detailUrl = '';
    if (doc.querySelector('#video_title')) {
      detailUrl = searchUrl;
    } else {
      // 情况二：搜索结果列表
      const first = doc.querySelector('.video a, .videothumblist a');
      const href = first?.getAttribute('href') || '';
      if (!href) return null;
      detailUrl = href.startsWith('http') ? href : `${this.baseUrl}/${this.lang}/${href.replace(/^\/?(cn\/)?/, '')}`;
    }

    const detail = await this.fetchDetail(detailUrl);
    return {
      code,
      title: detail.title,
      actresses: detail.actresses,
      genres: detail.genres,
      studio: detail.studio,
      cover: detail.cover,
      releaseDate: detail.releaseDate,
      source: 'javlibrary',
      fetchedAt: Date.now(),
      url: detailUrl
    };
  }

  async fetchDetail(url) {
    const html = await request(url, { headers: { Referer: `${this.baseUrl}/${this.lang}/` } });
    const doc = parseHtml(html);

    const title = clean(doc.querySelector('#video_title h3, #video_title')?.textContent)
      .replace(/^[^:：]*[：:]/, '').trim();

    const actresses = [];
    doc.querySelectorAll('#video_cast .cast .star a, #video_cast .star a').forEach((el) => {
      const n = clean(el.textContent);
      if (n && !actresses.includes(n)) actresses.push(n);
    });

    const genres = [];
    doc.querySelectorAll('#video_genres .genre a, #video_genres a').forEach((el) => {
      const n = clean(el.textContent);
      if (n && !genres.includes(n)) genres.push(n);
    });

    const cover =
      doc.querySelector('#video_jacket_img')?.getAttribute('src') ||
      doc.querySelector('#video_jacket img')?.getAttribute('src') || '';

    let releaseDate = '';
    let studio = '';
    doc.querySelectorAll('#video_info tr, #video_info .item').forEach((row) => {
      const t = clean(row.textContent);
      if (/發行日期|发行日期/.test(t)) {
        const d = t.match(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/);
        if (d) releaseDate = `${d[1]}-${String(d[2]).padStart(2, '0')}-${String(d[3]).padStart(2, '0')}`;
      }
      if (/製作商|发行商|メーカー/.test(t)) {
        studio = clean(row.querySelector('a')?.textContent);
      }
    });

    return { title, actresses, genres, cover, releaseDate, studio };
  }
}

/* ==================================================================
 * DMM Provider（可选，需 key）
 * ================================================================== */
class DmmProvider extends BaseProvider {
  constructor(config = {}) {
    super('dmm');
    this.apiId = config.dmmApiId || '';
    this.affiliateId = config.dmmAffiliateId || '';
    this.baseUrl = 'https://api.dmm.com/affiliate/v3/ItemList';
    this.enabled = Boolean(this.apiId && this.affiliateId) && config.enableDmm !== false;
  }

  async search(code) {
    const params = new URLSearchParams({
      api_id: this.apiId,
      affiliate_id: this.affiliateId,
      site: 'FANZA',
      service: 'digital',
      floor: 'videoa',
      keyword: code,
      hits: '10',
      sort: 'match',
      output: 'json'
    });

    const text = await request(`${this.baseUrl}?${params.toString()}`);
    const data = JSON.parse(text);
    const items = data?.result?.items || [];
    if (items.length === 0) return null;

    const norm = code.replace(/[-_\s]/g, '').toUpperCase();
    const exact = items.find((it) =>
      `${it.content_id || ''}${it.title || ''}`.replace(/[-_\s]/g, '').toUpperCase().includes(norm)
    );
    const item = exact || items[0];
    const info = item.iteminfo || {};

    return {
      code,
      title: item.title || '',
      actresses: (info.actress || []).map((a) => a.name).filter(Boolean),
      genres: (info.genre || []).map((g) => g.name).filter(Boolean),
      studio: (info.maker || [])[0]?.name || '',
      cover: item.imageURL?.large || '',
      releaseDate: (info.date || '').slice(0, 10),
      source: 'dmm',
      fetchedAt: Date.now(),
      url: item.URL || ''
    };
  }
}

/* ==================================================================
 * 聚合解析器
 * ================================================================== */
class MetaResolver {
  constructor(providers, cache = null) {
    this.providers = providers.filter((p) => p && p.enabled);
    this.cache = cache;
    this.stats = { hit: 0, miss: 0, error: 0, cacheHit: 0 };
    this.blockedHints = [];
  }

  async resolve(code, opts = {}) {
    if (!opts.force && this.cache) {
      const cached = await this.cache.get(code);
      if (cached) {
        this.stats.cacheHit++;
        return { ...cached, fromCache: true };
      }
    }

    const errors = [];
    for (const p of this.providers) {
      try {
        const meta = await p.search(code);
        if (meta) {
          this.stats.hit++;
          if (this.cache) await this.cache.put(meta);
          return meta;
        }
      } catch (e) {
        errors.push({ provider: p.name, message: e.message, code: e.code, url: e.url });
        if (e.code === 'BLOCKED') this.blockedHints.push({ provider: p.name, url: e.url });
      }
    }

    if (errors.some((e) => e.code !== 'BLOCKED')) this.stats.error++;
    else this.stats.miss++;

    return { code, notFound: true, errors };
  }

  async resolveBatch(codes, opts = {}) {
    const concurrency = opts.concurrency || 3;
    const results = new Map();
    const queue = [...codes];
    let done = 0;

    const workers = Array.from({ length: Math.min(concurrency, Math.max(queue.length, 1)) }, async () => {
      while (queue.length > 0) {
        const code = queue.shift();
        if (code === undefined) break;
        let meta;
        try {
          meta = await this.resolve(code, opts);
        } catch (e) {
          meta = { code, notFound: true, errors: [{ message: e.message }] };
        }
        results.set(code, meta);
        done++;
        if (opts.onProgress) opts.onProgress({ done, total: codes.length, code, meta });
      }
    });

    await Promise.all(workers);
    return results;
  }
}

/** 生成手动搜索链接，用于兜底 */
function buildManualLinks(code, cfg = {}) {
  const javbus = (cfg.javbusBaseUrl || 'https://www.javbus.com').replace(/\/$/, '');
  const javlib = (cfg.javlibraryBaseUrl || 'https://www.javlibrary.com').replace(/\/$/, '');
  const e = encodeURIComponent(code);
  return [
    { name: 'JavBus', url: `${javbus}/search/${e}/1` },
    { name: 'javlibrary', url: `${javlib}/cn/vl_searchbyid.php?keyword=${e}` },
    { name: 'DMM', url: `https://www.dmm.co.jp/search/=/searchstr=${e}/` },
    { name: 'Google', url: `https://www.google.com/search?q=${e}` }
  ];
}


/* ==================================================================
 * core/storage.js
 * ================================================================== */

/**
 * 本地标签库（IndexedDB 存储层）
 * ------------------------------------------------------------------
 * 方案 C 的核心：标签不打回 115，而是存在浏览器本地。
 *
 * 五张表：
 *   meta     番号 -> 影片元数据（标题/演员/厂商/封面/标签）
 *   fileMap  115 文件 ID -> 番号 的映射（含文件名快照，用于变更检测）
 *   library  「收录」结果：一个视频文件一条，含 cid / 番号 / 演员 / 类别
 *            —— 这是「资料库」页签的数据源，支持按演员、类别筛选
 *   dirs     每个收录过的目录的汇总（收录时间 / 条目数 / 上次新增多少）
 *            —— 「增量收录」的依据：同一目录再收一次时，靠它和 library
 *               对照，只对「新文件」和「上次没抓到标签的」发请求
 *   settings 键值配置（api key、并发数、数据源开关等）
 *
 * 数据完全本地，支持导出/导入 JSON 备份，清缓存前请先导出。
 */

const DB_NAME = 'jv115-tagger';
/**
 * ⚠️ 升级版本号时，onupgradeneeded 会整体重跑。
 * 里面每个建表动作都用 `contains` 包住，所以老表及其数据不受影响，
 * 只有新增的表会被创建。绝对不要在 upgrade 里 drop 既有表。
 */
const DB_VERSION = 3;
const STORE_META = 'meta';
const STORE_FILEMAP = 'fileMap';
const STORE_LIBRARY = 'library';
const STORE_DIRS = 'dirs';
const STORE_SETTINGS = 'settings';

let _dbPromise = null;

/** 打开数据库（单例） */
function openDB() {
  if (_dbPromise) return _dbPromise;

  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains(STORE_META)) {
        const s = db.createObjectStore(STORE_META, { keyPath: 'code' });
        s.createIndex('title', 'title', { unique: false });
        s.createIndex('fetchedAt', 'fetchedAt', { unique: false });
        s.createIndex('source', 'source', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORE_FILEMAP)) {
        const s = db.createObjectStore(STORE_FILEMAP, { keyPath: 'fileId' });
        s.createIndex('code', 'code', { unique: false });
        s.createIndex('updatedAt', 'updatedAt', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORE_LIBRARY)) {
        const s = db.createObjectStore(STORE_LIBRARY, { keyPath: 'id' });
        s.createIndex('code', 'code', { unique: false });
        s.createIndex('cid', 'cid', { unique: false });
        // multiEntry：一个文件可以有多个演员 / 多个类别，
        // 建多值索引后可以直接按「演员A」查出所有含该演员的记录。
        s.createIndex('actresses', 'actresses', { unique: false, multiEntry: true });
        s.createIndex('genres', 'genres', { unique: false, multiEntry: true });
        s.createIndex('updatedAt', 'updatedAt', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORE_DIRS)) {
        const s = db.createObjectStore(STORE_DIRS, { keyPath: 'cid' });
        s.createIndex('harvestedAt', 'harvestedAt', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
        db.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  return _dbPromise;
}

/** 通用事务包装 */
async function withStore(storeName, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let result;
    try {
      result = fn(store);
    } catch (e) {
      reject(e);
      return;
    }
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('事务被中止'));
  });
}

/** 把 IDBRequest 转成 Promise */
function reqToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/* ==================== meta 表操作 ==================== */

/** 缓存实现，供 MetaResolver 使用 */
const metaCache = {
  async get(code) {
    const db = await openDB();
    const tx = db.transaction(STORE_META, 'readonly');
    return reqToPromise(tx.objectStore(STORE_META).get(code));
  },
  async put(meta) {
    return putMeta(meta);
  }
};
async function putMeta(meta) {
  if (!meta || !meta.code) throw new Error('meta 缺少 code 字段');
  const record = { ...meta, fetchedAt: meta.fetchedAt || Date.now() };
  await withStore(STORE_META, 'readwrite', (s) => s.put(record));
  return record;
}
async function putMetaBatch(list) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_META, 'readwrite');
    const store = tx.objectStore(STORE_META);
    list.forEach((m) => m && m.code && store.put({ ...m, fetchedAt: m.fetchedAt || Date.now() }));
    tx.oncomplete = () => resolve(list.length);
    tx.onerror = () => reject(tx.error);
  });
}
async function getMeta(code) {
  const db = await openDB();
  const tx = db.transaction(STORE_META, 'readonly');
  return reqToPromise(tx.objectStore(STORE_META).get(code));
}
async function getAllMeta() {
  const db = await openDB();
  const tx = db.transaction(STORE_META, 'readonly');
  return reqToPromise(tx.objectStore(STORE_META).getAll());
}
async function countMeta() {
  const db = await openDB();
  const tx = db.transaction(STORE_META, 'readonly');
  return reqToPromise(tx.objectStore(STORE_META).count());
}
async function deleteMeta(code) {
  return withStore(STORE_META, 'readwrite', (s) => s.delete(code));
}

/* ==================== fileMap 表操作 ==================== */

/**
 * 记录「115 文件 -> 番号」映射。
 * 存 nameSnapshot 是为了检测文件是否被改名/替换。
 */
async function putFileMap({ fileId, code, fileName, confidence }) {
  const record = {
    fileId: String(fileId),
    code,
    fileName,
    nameSnapshot: fileName,
    confidence: confidence ?? 0,
    updatedAt: Date.now()
  };
  await withStore(STORE_FILEMAP, 'readwrite', (s) => s.put(record));
  return record;
}
async function putFileMapBatch(list) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_FILEMAP, 'readwrite');
    const store = tx.objectStore(STORE_FILEMAP);
    list.forEach((r) => {
      store.put({
        fileId: String(r.fileId),
        code: r.code,
        fileName: r.fileName,
        nameSnapshot: r.fileName,
        confidence: r.confidence ?? 0,
        updatedAt: Date.now()
      });
    });
    tx.oncomplete = () => resolve(list.length);
    tx.onerror = () => reject(tx.error);
  });
}
async function getFileMap(fileId) {
  const db = await openDB();
  const tx = db.transaction(STORE_FILEMAP, 'readonly');
  return reqToPromise(tx.objectStore(STORE_FILEMAP).get(String(fileId)));
}
async function getAllFileMap() {
  const db = await openDB();
  const tx = db.transaction(STORE_FILEMAP, 'readonly');
  return reqToPromise(tx.objectStore(STORE_FILEMAP).getAll());
}
async function countFileMap() {
  const db = await openDB();
  const tx = db.transaction(STORE_FILEMAP, 'readonly');
  return reqToPromise(tx.objectStore(STORE_FILEMAP).count());
}

/* ==================== library 表操作（资料库） ==================== */

/**
 * 把 meta（可能是 null / notFound）+ 文件信息组装成一条 library 记录。
 *
 * id 用 `cid@@fileName`：
 *   - 同名的文件在不同目录下是两个条目，不会被互相覆盖
 *   - 目录内改名会变成新条目（旧的留给用户手动清理）
 *
 * @param {object} p
 * @param {object|null} p.prev 同一文件的**上一条记录**（增量收录时传入）。
 *   作用：① 保留 firstSeenAt（首次见到的时间）；② 新一次没抓到标签时
 *   不把已有的标签覆盖掉（数据源偶尔抽风不该让库里的信息变少）。
 */
function buildLibraryRecord({ cid, fileName, fileId, pickcode, size, dirIndex, code, meta, confidence, prev = null }) {
  const cleanArr = (v) => {
    if (!Array.isArray(v)) return [];
    return [...new Set(v.map((x) => String(x ?? '').trim()).filter(Boolean))];
  };
  const now = Date.now();

  const fresh = meta && !meta.notFound;
  // 同一个番号、上次拿到了标签、这次却没拿到 → 保留旧数据，别让信息退化
  const keepPrev = !fresh && prev && prev.matched && prev.code === (code || '');
  const src = fresh ? meta : (keepPrev ? prev : null);

  return {
    id: `${cid || ''}@@${fileName}`,
    cid: String(cid || ''),
    fileName: String(fileName || ''),
    fileId: fileId ? String(fileId) : (keepPrev ? prev.fileId : null),
    // pickcode 是 115 播放接口唯一需要的参数，收录时能挖到就一定要存下来
    pickcode: pickcode ? String(pickcode) : (keepPrev ? prev.pickcode : null),
    size: size || (keepPrev ? prev.size : ''),
    // 该文件在整个目录清单里的位置（含文件夹）。
    // 115 网页每页只渲染 24 条，点播放时要靠它算「该翻到第几页」，
    // 否则 78 页的目录里点一条第 50 页的文件会「跳回目录但找不到」。
    dirIndex: Number.isFinite(dirIndex) ? dirIndex : (prev && Number.isFinite(prev.dirIndex) ? prev.dirIndex : null),
    code: code || '',
    confidence: confidence ?? 0,
    title: src ? (src.title || '') : '',
    actresses: src ? cleanArr(src.actresses) : [],
    genres: src ? cleanArr(src.genres) : [],
    cover: src ? (src.cover || '') : '',
    source: src ? (src.source || '') : '',
    matched: !!(fresh || keepPrev),
    keptPrev: keepPrev,
    // 增量收录用：gone=true 表示「上次收录过，这次目录里已经没有了」
    gone: false,
    firstSeenAt: (prev && prev.firstSeenAt) || now,
    lastSeenAt: now,
    harvestedAt: (prev && prev.harvestedAt) || now,
    updatedAt: now
  };
}
async function putLibraryBatch(list) {
  if (!list || !list.length) return 0;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_LIBRARY, 'readwrite');
    const store = tx.objectStore(STORE_LIBRARY);
    list.forEach((r) => r && r.id && store.put(r));
    tx.oncomplete = () => resolve(list.length);
    tx.onerror = () => reject(tx.error);
  });
}
async function getAllLibrary() {
  const db = await openDB();
  const tx = db.transaction(STORE_LIBRARY, 'readonly');
  return reqToPromise(tx.objectStore(STORE_LIBRARY).getAll());
}
async function countLibrary() {
  const db = await openDB();
  const tx = db.transaction(STORE_LIBRARY, 'readonly');
  return reqToPromise(tx.objectStore(STORE_LIBRARY).count());
}

/**
 * 取某个目录下已经收录的条目（走 cid 索引）。
 * 增量收录的第一步：拿它和接口返回的当前文件清单对照，
 * 就能算出「新增 / 未变 / 已失效」三类。
 */
async function getLibraryByCid(cid) {
  const key = String(cid || '');
  if (!key) return [];
  const db = await openDB();
  const tx = db.transaction(STORE_LIBRARY, 'readonly');
  const idx = tx.objectStore(STORE_LIBRARY).index('cid');
  return reqToPromise(idx.getAll(key));
}

/** 统计「已失效」条目数（文件已从 115 目录里消失） */
async function countLibraryGone() {
  const all = await getAllLibrary();
  return all.filter((r) => r.gone).length;
}

/** 删除全部「已失效」条目，返回删掉的条数 */
async function deleteLibraryGone() {
  const all = await getAllLibrary();
  const gone = all.filter((r) => r.gone);
  if (!gone.length) return 0;
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_LIBRARY, 'readwrite');
    const store = tx.objectStore(STORE_LIBRARY);
    gone.forEach((r) => store.delete(r.id));
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  return gone.length;
}

/* ==================== dirs 表操作 ==================== */

/**
 * 记录/更新一个目录的收录汇总。
 * 只存「轻量元信息」，不存文件清单本身（清单就在 library 表里）。
 */
async function putDirMeta(rec) {
  if (!rec || !rec.cid) throw new Error('dirs 记录缺少 cid');
  return withStore(STORE_DIRS, 'readwrite', (s) => s.put({
    ...rec,
    cid: String(rec.cid),
    harvestedAt: rec.harvestedAt || Date.now()
  }));
}
async function getDirMeta(cid) {
  const db = await openDB();
  const tx = db.transaction(STORE_DIRS, 'readonly');
  return reqToPromise(tx.objectStore(STORE_DIRS).get(String(cid || '')));
}
async function getAllDirs() {
  const db = await openDB();
  const tx = db.transaction(STORE_DIRS, 'readonly');
  return reqToPromise(tx.objectStore(STORE_DIRS).getAll());
}
async function countDirs() {
  const db = await openDB();
  const tx = db.transaction(STORE_DIRS, 'readonly');
  return reqToPromise(tx.objectStore(STORE_DIRS).count());
}
async function deleteLibrary(id) {
  return withStore(STORE_LIBRARY, 'readwrite', (s) => s.delete(id));
}
async function clearLibrary() {
  return withStore(STORE_LIBRARY, 'readwrite', (s) => s.clear());
}

/**
 * 清理「同一个文件但 id 不同」的旧记录，返回删掉的条数。
 *
 * 为什么需要：id = `cid@@fileName`，所以 cid 一旦变化，同一部片会算出两个 id。
 * 典型场景就是「cid 取值方式修好后重新收录」—— 旧记录里带着错的 cid
 * （比如 0），不清理就会同一部片在资料库里出现两条。
 *
 * @param {Array} keepRecords 本次刚写入的记录，它们的 id 视为最新
 */
async function pruneLibraryDuplicates(keepRecords) {
  if (!keepRecords || !keepRecords.length) return 0;
  const keepIds = new Set(keepRecords.map((r) => r.id));
  const names = new Set(keepRecords.map((r) => r.fileName).filter(Boolean));
  if (!names.size) return 0;

  const all = await getAllLibrary();
  const stale = all.filter((r) => names.has(r.fileName) && !keepIds.has(r.id));
  if (!stale.length) return 0;

  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_LIBRARY, 'readwrite');
    const store = tx.objectStore(STORE_LIBRARY);
    stale.forEach((r) => store.delete(r.id));
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  return stale.length;
}

/**
 * 汇总可筛选的维度：演员 / 类别 / 目录。
 * 供资料库页签生成筛选 chips（带出现次数，按次数降序）。
 */
async function getLibraryFacets() {
  const allRaw = await getAllLibrary();
  // 失效条目（文件已不在 115 目录里）默认不参与筛选维度统计
  const gone = allRaw.filter((r) => r.gone).length;
  const all = allRaw.filter((r) => !r.gone);
  const tally = (pick) => {
    const m = new Map();
    all.forEach((r) => {
      pick(r).forEach((v) => m.set(v, (m.get(v) || 0) + 1));
    });
    return [...m.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  };
  return {
    total: all.length,
    gone,
    actresses: tally((r) => r.actresses || []),
    genres: tally((r) => r.genres || []),
    cids: tally((r) => (r.cid ? [r.cid] : []))
  };
}

/**
 * 纯函数版筛选 —— 不碰数据库，便于单元测试。
 * 规则：
 *   - 关键词：大小写不敏感，命中番号/标题/文件名/演员/类别 任一即可
 *   - 演员/类别：多选时是 **AND**（要同时满足所有选中项）
 *     —— 选「演员A」+「演员B」表示「同时有这两个演员的作品」
 *   - hideGone：默认隐藏「已失效」条目（文件已从 115 目录消失）
 */
function filterLibraryRows(all, {
  keyword = '', actresses = [], genres = [], cid = '', hideGone = true
} = {}) {
  const kw = String(keyword || '').trim().toLowerCase();

  return (all || []).filter((r) => {
    if (hideGone && r.gone) return false;
    if (cid && r.cid !== cid) return false;
    if (actresses.length && !actresses.every((a) => (r.actresses || []).includes(a))) return false;
    if (genres.length && !genres.every((g) => (r.genres || []).includes(g))) return false;
    if (!kw) return true;
    const hay = [r.code, r.title, r.fileName, ...(r.actresses || []), ...(r.genres || [])]
      .join(' ')
      .toLowerCase();
    return hay.includes(kw);
  }).sort((a, b) =>
    String(a.code || '').localeCompare(String(b.code || '')) ||
    String(a.fileName || '').localeCompare(String(b.fileName || ''))
  );
}

/** 在库内按关键词 + 演员/类别筛选（先从 IDB 取全量，再走纯函数过滤） */
async function queryLibrary(filters = {}) {
  const all = await getAllLibrary();
  return filterLibraryRows(all, filters);
}

/* ==================== settings 表操作 ==================== */
async function setSetting(key, value) {
  return withStore(STORE_SETTINGS, 'readwrite', (s) => s.put({ key, value }));
}
async function getSetting(key, defaultValue = null) {
  const db = await openDB();
  const tx = db.transaction(STORE_SETTINGS, 'readonly');
  const row = await reqToPromise(tx.objectStore(STORE_SETTINGS).get(key));
  return row ? row.value : defaultValue;
}
async function getAllSettings() {
  const db = await openDB();
  const tx = db.transaction(STORE_SETTINGS, 'readonly');
  const rows = await reqToPromise(tx.objectStore(STORE_SETTINGS).getAll());
  return rows.reduce((acc, r) => ({ ...acc, [r.key]: r.value }), {});
}

/**
 * 「播放」按钮的默认地址模板（唯一权威定义，main.js / panel.js 都从这里引）。
 * 可用变量：{pickcode} {cid} {fileId} {name}
 *
 * 取值来源：115Master 公开的播放器唤起接口。
 * 若在未安装 115Master 的环境下打不开，可在「设置」页改成自己环境可用的地址。
 *
 * ⚠️ 打包器会把所有模块拼进同一个作用域，所以这个名字全局只能出现一次。
 */
const DEFAULT_PLAYER_URL =
  'https://115.com/web/lixian/master/video/?pick_code={pickcode}&cid={cid}';

/**
 * 播放方式。
 *
 *   PAGE   —— 点「播放」直接开播放页（一步直达，默认）
 *   INPAGE —— 跳回该文件所在目录，在网页列表里定位并模拟点击播放
 *
 * 为什么默认是 PAGE 而不是「自动检测」：
 *   115Master 的 DOM 标记（#master-app / x-player）**只在播放页挂载**，
 *   文件列表页上根本不存在。所以在列表页做「装没装 115Master」的检测
 *   必然返回 false —— 旧版的 auto 模式等于被强制降级成 INPAGE，
 *   用户看到的现象就是「点了播放却跳回目录，还找不到视频」。
 *   与其猜，不如直接开播放页；开出来是不是空白由「播放页自检」事后判定。
 */
const PLAY_MODES = { PAGE: 'page', INPAGE: 'inpage' };

/** 把历史/非法值归一化为当前支持的播放方式 */
function normalizePlayMode(v) {
  if (v === PLAY_MODES.INPAGE) return PLAY_MODES.INPAGE;
  // 历史值：'auto'（在列表页恒判 false，等于强制模拟点击）、'master'（开播放页）
  return PLAY_MODES.PAGE;
}

/**
 * 从一条资料库记录里取模板变量（纯函数，便于单测）。
 *
 * {name} = 去掉扩展名的文件名。留给「用搜索页接文件」这类自定义模板，
 * 默认模板用不到它。
 */
function playerTemplateVars(row = {}) {
  return {
    pickcode: row.pickcode || '',
    cid: row.cid || '',
    fileId: row.fileId || '',
    name: String(row.fileName || '').replace(/\.[a-z0-9]{2,5}$/i, '')
  };
}

/**
 * 按模板拼播放地址（纯函数，便于单测）。
 *
 * 模板里写了但没提供的变量**保持原样**，不替换成空串 ——
 * 这样用户一眼就能看出「{foo} 这个变量不存在」，比拼出一个残缺 URL 好排查。
 */
function fillPlayerTemplate(tpl, vars = {}) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (m, k) =>
    Object.prototype.hasOwnProperty.call(vars, k) ? encodeURIComponent(vars[k]) : m
  );
}

/**
 * 播放页自检结果的存放键。
 *
 * 脚本在**播放页**里也会运行，那一侧才检测得准。
 * 判定结果写进 localStorage，列表页打开播放页前先读一眼：
 * 上次如果是空白页，就先提醒用户，不要让他对着白屏发呆。
 */
const PLAYER_PROBE_KEY = 'jv115-player-probe';
/** 自检结果的有效期（ms）：超过就重新判一次，避免用户后来装了 115Master 还一直报错 */
const PLAYER_PROBE_TTL = 10 * 60 * 1000;
const DEFAULT_SETTINGS = {
  // 数据源（默认全部走网页直连，不需要任何 key）
  enableJavbus: true,
  javbusBaseUrl: 'https://www.javbus.com',
  enableJavlibrary: true,
  javlibraryBaseUrl: 'https://www.javlibrary.com',
  javlibraryLang: 'cn',
  // DMM 可选（有 key 才启用）
  enableDmm: false,
  dmmApiId: '',
  dmmAffiliateId: '',
  // 行为
  concurrency: 3,
  useCache: true,
  autoInjectColumn: true,
  cacheTTLDays: 30,
  minConfidence: 60,
  showCover: false,
  // 悬停浮层空间充裕 → 0 表示全显示，不截断
  maxActress: 0,
  maxGenres: 0,
  /**
   * 点「播放」时怎么打开（取值见上方 PLAY_MODES）：
   *   'page'   直接打开播放页（一步直达，默认）
   *   'inpage' 跳回目录 + 页面内模拟点击播放（不依赖任何插件，但受分页/渲染影响）
   */
  playMode: PLAY_MODES.PAGE,
  /** 「播放」按钮的地址模板，见文件上方 DEFAULT_PLAYER_URL 的说明 */
  playerUrlTemplate: DEFAULT_PLAYER_URL
};
async function loadSettings() {
  const saved = await getAllSettings();
  const merged = { ...DEFAULT_SETTINGS, ...saved };
  // 历史存档里可能是 'auto'/'master'，这里统一迁移，面板上的下拉才不会空掉
  merged.playMode = normalizePlayMode(merged.playMode);
  if (!merged.playerUrlTemplate) merged.playerUrlTemplate = DEFAULT_PLAYER_URL;
  return merged;
}

/* ==================== 导出 / 导入 ==================== */

/** 导出全部数据为 JSON 字符串 */
async function exportAll() {
  const [meta, fileMap, library, dirs, settings] = await Promise.all([
    getAllMeta(),
    getAllFileMap(),
    getAllLibrary(),
    getAllDirs(),
    getAllSettings()
  ]);
  return JSON.stringify(
    {
      _format: 'jv115-tagger-backup',
      _version: DB_VERSION,
      _exportedAt: new Date().toISOString(),
      meta,
      fileMap,
      library,
      dirs,
      settings
    },
    null,
    2
  );
}

/**
 * 导入备份。默认合并（同 key 覆盖）。
 * @param {string} jsonText
 * @param {{merge?: boolean}} opts merge=false 时先清空
 */
async function importAll(jsonText, opts = {}) {
  const data = JSON.parse(jsonText);
  if (data._format !== 'jv115-tagger-backup') {
    throw new Error('备份文件格式不匹配');
  }

  if (opts.merge === false) {
    await clearAll();
  }

  const metaCount = await putMetaBatch(data.meta || []);
  const mapCount = await putFileMapBatch(data.fileMap || []);
  const libCount = await putLibraryBatch(data.library || []);

  let dirCount = 0;
  for (const d of data.dirs || []) {
    if (d && d.cid) { await putDirMeta(d); dirCount++; }
  }

  let settingCount = 0;
  if (data.settings) {
    for (const [key, value] of Object.entries(data.settings)) {
      await setSetting(key, value);
      settingCount++;
    }
  }

  return { metaCount, mapCount, libCount, dirCount, settingCount };
}

/** 清空所有业务数据（不含设置） */
async function clearAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_META, STORE_FILEMAP, STORE_LIBRARY, STORE_DIRS], 'readwrite');
    tx.objectStore(STORE_META).clear();
    tx.objectStore(STORE_FILEMAP).clear();
    tx.objectStore(STORE_LIBRARY).clear();
    tx.objectStore(STORE_DIRS).clear();
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

/** 清理超过 TTL 的缓存条目 */
async function purgeExpired(ttlDays = 30) {
  const cutoff = Date.now() - ttlDays * 86400 * 1000;
  const all = await getAllMeta();
  const expired = all.filter((m) => (m.fetchedAt || 0) < cutoff);
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_META, 'readwrite');
    const store = tx.objectStore(STORE_META);
    expired.forEach((m) => store.delete(m.code));
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  return expired.length;
}

/** 获取统计信息 */
async function getStats() {
  const [metaCount, mapCount, libCount, dirCount] = await Promise.all([
    countMeta(),
    countFileMap(),
    countLibrary(),
    countDirs()
  ]);
  const all = await getAllMeta();
  const bySource = all.reduce((acc, m) => {
    acc[m.source] = (acc[m.source] || 0) + 1;
    return acc;
  }, {});
  const goneCount = await countLibraryGone();
  return { metaCount, mapCount, libCount, dirCount, goneCount, bySource };
}


/* ==================================================================
 * core/ui.js
 * ================================================================== */

/**
 * UI 层：115 页面注入、控制面板、标签展示
 * ------------------------------------------------------------------
 * 组成：
 *   injectStyles()      注入样式（用 Shadow DOM 隔离，避免污染 115 页面）
 *   Panel               控制面板（悬浮按钮 + 抽屉）
 *   TagColumn           标签列：在文件列表行上渲染标签
 *   Toast               轻提示
 *
 * 设计要点：
 *  - 所有 UI 挂载在 Shadow DOM 里，115 改版不会互相影响
 *  - 标签用 pill 形式贴在文件名后面，视觉上和 115 原生元素融为一体
 */

const HOST_ID = 'jv115-tagger-host';

const STYLES = `
:host { all: initial; }
* { box-sizing: border-box; }

.panel {
  position: fixed;
  right: 24px;
  bottom: 24px;
  z-index: 2147483000;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  font-size: 13px;
  color: #1f2329;
}

.fab {
  width: 48px; height: 48px;
  border-radius: 50%;
  background: #2b5cff;
  color: #fff;
  border: none;
  cursor: pointer;
  box-shadow: 0 2px 12px rgba(43,92,255,.35);
  display: flex; align-items: center; justify-content: center;
  font-size: 12px; font-weight: 500;
  transition: transform .15s ease;
  line-height: 1.1;
  text-align: center;
}
.fab:hover { transform: scale(1.06); }
.fab.busy { background: #8a94a6; cursor: progress; }

.drawer {
  position: fixed;
  right: 24px; bottom: 84px;
  width: 380px;
  max-height: 74vh;
  background: #fff;
  border: 1px solid #e3e6eb;
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0,0,0,.12);
  display: flex; flex-direction: column;
  overflow: hidden;
  transform-origin: bottom right;
  transition: opacity .16s ease, transform .16s ease;
}
.drawer.hidden { opacity: 0; transform: scale(.96); pointer-events: none; }

.hd {
  padding: 12px 14px;
  border-bottom: 1px solid #eef0f3;
  display: flex; align-items: center; justify-content: space-between;
  flex-shrink: 0;
}
.hd h3 { margin: 0; font-size: 14px; font-weight: 500; }
.hd .sub { font-size: 11px; color: #8a94a6; margin-top: 2px; }

.tabs { display: flex; gap: 2px; padding: 8px 10px 0; border-bottom: 1px solid #eef0f3; flex-shrink: 0; }
.tab {
  padding: 6px 12px; border: none; background: none; cursor: pointer;
  font-size: 12.5px; color: #5c6470; border-bottom: 2px solid transparent;
  font-family: inherit;
}
.tab.active { color: #2b5cff; border-bottom-color: #2b5cff; font-weight: 500; }

.body { padding: 12px 14px; overflow-y: auto; flex: 1; }
.pane { display: none; }
.pane.active { display: block; }

.row { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
.row label { color: #5c6470; font-size: 12.5px; flex-shrink: 0; }
.row .grow { flex: 1; }

input[type=text], input[type=password], input[type=number], select {
  width: 100%; padding: 6px 9px;
  border: 1px solid #d8dce2; border-radius: 6px;
  font-size: 12.5px; font-family: inherit; color: #1f2329;
  background: #fff; outline: none;
}
input:focus, select:focus { border-color: #2b5cff; }

.btn {
  padding: 7px 14px; border-radius: 6px; border: 1px solid #d8dce2;
  background: #fff; color: #1f2329; cursor: pointer;
  font-size: 12.5px; font-family: inherit;
}
.btn:hover { border-color: #b8bfc9; }
.btn.primary { background: #2b5cff; border-color: #2b5cff; color: #fff; }
.btn.primary:hover { background: #1e4ce0; }
.btn:disabled { opacity: .5; cursor: not-allowed; }
.btn.sm { padding: 5px 10px; font-size: 12px; }

.btnrow { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }

.stat { display: flex; gap: 8px; margin-bottom: 12px; }
.stat .cell {
  flex: 1; padding: 8px 10px; border: 1px solid #eef0f3; border-radius: 8px; background: #fafbfc;
}
.stat .cell .k { font-size: 11px; color: #8a94a6; }
.stat .cell .v { font-size: 16px; font-weight: 500; margin-top: 2px; }

.progress { height: 6px; background: #eef0f3; border-radius: 3px; overflow: hidden; margin: 10px 0 6px; }
.progress .bar { height: 100%; background: #2b5cff; width: 0; transition: width .2s ease; }

.list { max-height: 240px; overflow-y: auto; border: 1px solid #eef0f3; border-radius: 8px; }
.list .item {
  padding: 7px 10px; border-bottom: 1px solid #f5f6f8;
  display: flex; align-items: center; gap: 8px; font-size: 12px;
}
.list .item:last-child { border-bottom: none; }
.list .item .fn { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #5c6470; }
.list .item .badge { flex-shrink: 0; font-size: 11px; padding: 1px 6px; border-radius: 4px; }
.badge.ok { background: #e7f5ec; color: #1a7f45; }
.badge.miss { background: #fdf0e6; color: #b4600f; }
.badge.err { background: #fdeaea; color: #c0322b; }

.hint { font-size: 11.5px; color: #8a94a6; line-height: 1.6; margin-top: 6px; }
.hint a { color: #2b5cff; text-decoration: none; }
.empty { text-align: center; color: #a8b0bd; padding: 24px 0; font-size: 12.5px; }

.toast-wrap {
  position: fixed; z-index: 2147483001;
  top: 20px; left: 50%; transform: translateX(-50%);
  display: flex; flex-direction: column; gap: 8px; align-items: center;
  pointer-events: none;
  font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
}
.toast {
  padding: 9px 16px; border-radius: 8px;
  background: rgba(31,35,41,.92); color: #fff;
  font-size: 12.5px; box-shadow: 0 4px 16px rgba(0,0,0,.16);
  animation: slidein .2s ease;
  max-width: 420px;
}
.toast.err { background: rgba(192,50,43,.94); }
.toast.ok { background: rgba(26,127,69,.94); }
@keyframes slidein { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: none; } }

/* ==================================================================
 * 资料库页签
 * ------------------------------------------------------------------
 * 搜索框 + 演员/类别筛选 chips + 结果列表（每行带播放入口）。
 * 全部在 Shadow DOM 内，不受 115 页面样式影响。
 * ================================================================== */
.lib-search { display: flex; gap: 8px; margin-bottom: 10px; }
.lib-search input { flex: 1; min-width: 0; }

/* ---- 下拉多选筛选器 ---- */
.dd { position: relative; margin-bottom: 8px; }
.dd-btn {
  width: 100%; padding: 7px 10px;
  border: 1px solid #d8dce2; border-radius: 6px; background: #fff;
  cursor: pointer; font-size: 12.5px; font-family: inherit; color: #1f2329;
  display: flex; align-items: center; gap: 8px; text-align: left;
}
.dd-btn:hover { border-color: #b8bfc9; }
.dd.open .dd-btn { border-color: #2b5cff; }
.dd-btn .lab { color: #5c6470; flex-shrink: 0; }
.dd-btn .val {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: #2b5cff; font-weight: 500;
}
.dd-btn .val.none { color: #a8b0bd; font-weight: 400; }
.dd-btn .arrow { flex-shrink: 0; color: #8a94a6; font-size: 9px; transition: transform .15s ease; }
.dd.open .dd-btn .arrow { transform: rotate(180deg); }

.dd-panel {
  position: absolute; left: 0; right: 0; top: calc(100% + 4px);
  background: #fff; border: 1px solid #e3e6eb; border-radius: 8px;
  box-shadow: 0 8px 28px rgba(0,0,0,.16);
  z-index: 20; display: flex; flex-direction: column; max-height: 268px;
}
.dd-panel.hidden { display: none; }
.dd-search { margin: 8px 8px 4px; width: auto; }
.dd-opts { overflow-y: auto; flex: 1; padding: 2px 0; min-height: 40px; }
.dd-opt {
  display: flex; align-items: center; gap: 8px;
  padding: 5px 10px; cursor: pointer; font-size: 12px;
}
.dd-opt:hover { background: #f5f7fa; }
.dd-opt input[type=checkbox] { width: auto; margin: 0; flex-shrink: 0; cursor: pointer; }
.dd-opt .nm {
  flex: 1; min-width: 0; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; color: #1f2329;
}
.dd-opt .n { color: #8a94a6; font-size: 11px; flex-shrink: 0; }
.dd-opt-none { padding: 14px 10px; text-align: center; color: #a8b0bd; font-size: 12px; }
.dd-foot { display: flex; gap: 6px; padding: 6px 8px; border-top: 1px solid #eef0f3; flex-shrink: 0; }
.dd-foot button {
  flex: 1; padding: 5px 0; border: 1px solid #e3e6eb; border-radius: 5px;
  background: #fff; color: #5c6470; cursor: pointer; font-size: 11.5px; font-family: inherit;
}
.dd-foot button:hover { border-color: #b8bfc9; }
.dd-foot button.primary { background: #2b5cff; border-color: #2b5cff; color: #fff; }
.dd-foot button.primary:hover { background: #1e4ce0; }

.lib-list { max-height: 320px; overflow-y: auto; border: 1px solid #eef0f3; border-radius: 8px; }
.lib-item {
  padding: 8px 10px; border-bottom: 1px solid #f5f6f8;
  display: flex; gap: 9px; align-items: flex-start;
}
.lib-item:last-child { border-bottom: none; }
.lib-item .mid { flex: 1; min-width: 0; }
.lib-item .code { font-weight: 600; font-size: 12.5px; color: #1f2329; }
/* 状态小角标：缺提取码 / 已失效 —— 让用户点之前就知道哪些播不了 */
.lib-item .badge {
  display: inline-block; margin-left: 6px; padding: 0 5px;
  font-size: 10px; font-weight: 400; line-height: 15px;
  border-radius: 3px; vertical-align: 1px;
}
.lib-item .badge.warn { background: #fff6e0; color: #a06a00; border: 1px solid #f2dfb0; }
.lib-item .badge.bad  { background: #fdeceb; color: #c0322b; border: 1px solid #f5cdc9; }
.lib-item .ttl {
  font-size: 11.5px; color: #5c6470; margin-top: 2px; line-height: 1.45;
  overflow: hidden; display: -webkit-box;
  -webkit-line-clamp: 2; -webkit-box-orient: vertical;
}
.lib-item .tags {
  font-size: 11px; color: #8a94a6; margin-top: 3px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.lib-item .tags b { color: #2b5cff; font-weight: 500; }
.lib-item .act { flex-shrink: 0; display: flex; flex-direction: column; gap: 4px; }
.lib-empty { text-align: center; color: #a8b0bd; padding: 30px 0; font-size: 12.5px; }
`;

/* ==================================================================
 * 注入到 115 列表页面的标签样式
 * ------------------------------------------------------------------
 * 重要：这段样式 **不能** 放在 STYLES 里。
 *
 * STYLES 只注入 Shadow DOM（见 ensureHost），而小圆点 .jv-dot
 * 与浮层 .jv-tip 是插到 **115 宿主页面的 DOM**（nameEl / document.body）
 * 里的。宿主页面的元素完全不受 Shadow DOM 内部样式表影响，
 * 所以必须单独把这段样式注入宿主 document（含列表 iframe 的 document）。
 *
 * 设计原则：**绝不修改文件名节点的内容**。
 * 只在文件名旁加一个极小的标记点（.jv-dot），
 * 鼠标悬停时才弹出信息浮层（.jv-tip）。
 * 这样文件名始终是用户原本看到的样子，可读、可复制、可排序。
 * ================================================================== */
const TAG_STYLES = `
/* ---- 注入到 115 列表的标签 ---- */

/* 文件名旁的小标记点
 *
 * 视觉上是 6px 小圆点，但**点击/悬停热区被扩到 ~20px**：
 * 用一个透明伪元素向外扩出一圈，鼠标移到热区任意位置都能触发浮层，
 * 不用精确瞄准那个小点。（用户反馈：小点太难选中）
 */
.jv-dot {
  position: relative !important;
  display: inline-block !important;
  width: 8px !important; height: 8px !important;
  min-width: 8px !important; min-height: 8px !important;
  max-width: 8px !important; max-height: 8px !important;
  padding: 0 !important; border: none !important;
  border-radius: 50% !important;
  margin: 0 0 0 8px !important;
  vertical-align: middle !important;
  flex-shrink: 0 !important;
  visibility: visible !important;
  opacity: 1 !important;
  cursor: help !important;
  background: #2b5cff !important;
  box-shadow: 0 0 0 2px rgba(43,92,255,.18) !important;
}
/* 扩大热区：伪元素向外扩 8px（合计约 24px 热区），完全透明不影响观感 */
.jv-dot::before {
  content: '' !important;
  position: absolute !important;
  left: 50% !important; top: 50% !important;
  width: 26px !important; height: 26px !important;
  transform: translate(-50%, -50%) !important;
  border-radius: 50% !important;
  background: transparent !important;
}
.jv-dot.miss  { background: #b6bcc6 !important; box-shadow: 0 0 0 2px rgba(182,188,198,.2) !important; }
.jv-dot.warn  { background: #e0a020 !important; box-shadow: 0 0 0 2px rgba(224,160,32,.2) !important; }

/* 悬停浮层 */
.jv-tip {
  position: fixed !important;
  z-index: 2147483600 !important;
  min-width: 220px;
  max-width: 420px;
  padding: 10px 12px;
  border-radius: 8px;
  background: #ffffff;
  color: #1f2329;
  border: 1px solid #e3e6eb;
  box-shadow: 0 6px 24px rgba(16,24,40,.16);
  font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
  font-size: 12px;
  line-height: 1.6;
  text-align: left;
  display: none;
}
.jv-tip.show { display: block !important; }

/* 防止 115 的全局样式（如 * { ... } / .xxx span { ... }）污染浮层内容 */
.jv-tip, .jv-tip * {
  box-sizing: border-box !important;
  float: none !important;
  letter-spacing: normal !important;
  text-transform: none !important;
}
.jv-tip .jv-t {
  font-size: 13px !important; font-weight: 600 !important;
  color: #1f2329 !important; margin: 0 0 6px !important;
  word-break: break-word; line-height: 1.5 !important;
}
.jv-tip .jv-row { display: flex !important; gap: 6px; margin-top: 4px; align-items: flex-start; }
.jv-tip .jv-k { color: #8a94a6 !important; flex-shrink: 0 !important; min-width: 34px; font-size: 12px !important; }
.jv-tip .jv-v { color: #384051 !important; word-break: break-word; font-size: 12px !important; }

/* 小标签（演员/类别用） */
.jv-tip .jv-tags { display: flex; flex-wrap: wrap; gap: 4px; }
.jv-tip .jv-tag {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 11px;
  line-height: 1.5;
  white-space: nowrap;
}
.jv-tip .jv-tag.actress { background: #fdf2f7; color: #b8346b; }
.jv-tip .jv-tag.genre   { background: #f0f7ee; color: #3d7a2a; }
.jv-tip .jv-tag.studio  { background: #f5f2fc; color: #6a4bb5; }
.jv-tip .jv-tag.src     { background: #f2f4f7; color: #77808d; }

/* 封面缩略图 */
.jv-tip .jv-cover {
  width: 100%;
  max-height: 180px;
  object-fit: contain;
  border-radius: 4px;
  margin-bottom: 8px;
  background: #f6f7f9;
}

/* 底部提示 */
.jv-tip .jv-foot {
  margin-top: 8px; padding-top: 6px;
  border-top: 1px solid #eef0f3;
  color: #8a94a6; font-size: 11px;
}

/* 未匹配时的手动搜索链接 */
.jv-tip .jv-links { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.jv-tip .manuallink {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  background: #eef2ff;
  color: #2b4fd4;
  font-size: 11px;
  text-decoration: none;
}
.jv-tip .manuallink:hover { background: #dfe6ff; }
`;

const TAG_STYLE_ID = 'jv115-tag-styles';

/**
 * 把标签样式注入到 **宿主 document**（不是 Shadow DOM）。
 *
 * - 支持跨 frame：传入 nameEl.ownerDocument 即可把样式注入列表 iframe 内
 * - 幂等：同一 document 只注入一次
 */
function ensureTagStyles(doc) {
  const d = doc || (typeof document !== 'undefined' ? document : null);
  if (!d) return;
  if (d.getElementById?.(TAG_STYLE_ID)) return;

  const style = d.createElement('style');
  style.id = TAG_STYLE_ID;
  style.textContent = TAG_STYLES;
  (d.head || d.documentElement).appendChild(style);
  console.log('[jv115-tagger] 标签样式已注入宿主 document');
}

/**
 * 确保 Shadow DOM 宿主存在，返回可用的挂载容器。
 * 注意：宿主节点用最高优先级样式强制显示，避免被 115 的全局样式影响。
 */
function ensureHost() {
  let host = document.getElementById(HOST_ID);
  if (host && host.__jvInner) return host.__jvInner;

  host = document.createElement('div');
  host.id = HOST_ID;
  // 强制可见 + 最高层级，防止被 115 的 body/容器样式影响
  host.style.cssText = [
    'position: static',
    'display: block',
    'visibility: visible',
    'opacity: 1',
    'z-index: 2147483000'
  ].join(' !important;') + ' !important;';

  const mount = document.body || document.documentElement;
  mount.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = STYLES;
  shadow.appendChild(style);

  // 实际挂载容器（Shadow 内元素可正常交互）
  const inner = document.createElement('div');
  shadow.appendChild(inner);
  host.__jvInner = inner;

  // 便于调试
  console.log('[jv115-tagger] Shadow 宿主已创建');
  return inner;
}

/** 轻提示 */
function toast(message, type = '') {
  const shadow = ensureHost();
  let wrap = shadow.querySelector('.toast-wrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'toast-wrap';
    shadow.appendChild(wrap);
  }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  wrap.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .2s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 220);
  }, 2600);
}
/**
 * 在 115 文件列表的文件名旁注入一个「信息标记点」。
 *
 * 设计原则（重要，v2）：
 *   **绝不修改文件名节点的文本内容**。
 *   只在文件名旁加一个 6px 的小圆点，鼠标悬停时才弹出信息浮层。
 *
 *   这样解决了旧版的问题：旧版把一大堆标签 pill 塞进文件名里，
 *   导致文件名被撑乱、显示成不可读的乱码。
 *
 *   新版效果：
 *     文件名.mp4  ●        ← 鼠标移上去才弹出信息
 *
 * @param {Element} nameEl  文件名节点
 * @param {object} meta     元数据；meta.notFound 时标记为灰点 + 手动搜索链接
 * @param {object} opts     { showCover, maxActress, maxGenres, manualLinks }
 */
function renderTagPill(nameEl, meta, opts = {}) {
  if (!nameEl) return;

  // 列表可能渲染在同源 iframe 内 —— 所有 DOM 操作与样式注入
  // 都必须基于该元素所属的 document，否则样式不生效 / 节点插错树。
  const doc = nameEl.ownerDocument || document;

  ensureTagStyles(doc);
  // 先清掉「本行」里可能残留的旧圆点（不止本节点，防止一文件两点）
  removeTagNear(nameEl);

  const notFound = !meta || meta.notFound;

  /* ---------- 小圆点 ---------- */
  const dot = doc.createElement('span');
  dot.className = 'jv-dot' + (notFound ? ' miss' : '');
  dot.dataset.jvTagged = '1';

  /* ---------- 浮层 ---------- */
  const tip = buildTip(meta, opts, doc);
  dot.__jvTip = tip;              // 便于调试与测试

  /*
   * 115 会给文件名节点加原生 title 属性，鼠标悬停时浏览器会弹出
   * 一个黑色原生 tooltip，盖住我们自己的浮层。
   * 悬停期间临时摘掉 title，离开时还原（不破坏 115 自己的行为）。
   */
  const titleNodes = [];
  {
    let n = nameEl;
    for (let i = 0; i < 3 && n && n !== doc.body; i++, n = n.parentElement) {
      if (n.tagName !== 'DIV' && n.getAttribute?.('title') != null) {
        titleNodes.push({ el: n, title: n.getAttribute('title') });
      }
    }
    // 也要处理节点本身（不是 DIV 时）。
    if (nameEl.getAttribute?.('title') != null) {
      titleNodes.push({ el: nameEl, title: nameEl.getAttribute('title') });
    }
  }
  const suppressTitle = () => {
    titleNodes.forEach(({ el }) => el.removeAttribute?.('title'));
  };
  const restoreTitle = () => {
    titleNodes.forEach(({ el, title }) => {
      if (el.isConnected) el.setAttribute?.('title', title);
    });
  };

  let hideTimer = null;
  const show = () => {
    clearTimeout(hideTimer);
    suppressTitle();
    // 挂到 body，避免被 115 的 overflow:hidden 容器裁掉
    (doc.body || doc.documentElement).appendChild(tip);
    tip.classList.add('show');
    positionTip(tip, dot);
  };
  const hide = () => {
    hideTimer = setTimeout(() => {
      tip.classList.remove('show');
      if (tip.parentElement) tip.remove();
      restoreTitle();
    }, 140);
  };

  dot.addEventListener('mouseenter', show);
  dot.addEventListener('mouseleave', hide);
  tip.addEventListener('mouseenter', () => clearTimeout(hideTimer));
  tip.addEventListener('mouseleave', hide);

  const reposition = () => { if (tip.classList.contains('show')) positionTip(tip, dot); };
  const win = doc.defaultView || window;
  win.addEventListener('scroll', reposition, true);
  win.addEventListener('resize', reposition);

  dot.__jvCleanup = () => {
    win.removeEventListener('scroll', reposition, true);
    win.removeEventListener('resize', reposition);
    clearTimeout(hideTimer);
    restoreTitle();
    tip.remove();
  };

  // ---- 阻止事件冒泡，避免点击圆点触发 115 自己的「打开文件」 ----
  ['click', 'mousedown', 'mouseup', 'dblclick'].forEach((ev) => {
    dot.addEventListener(ev, (e) => { e.stopPropagation(); e.preventDefault(); });
  });

  nameEl.appendChild(dot);
}

/** 移除某个文件名节点上的标记点（及其后代里的） */
function removeTagAt(nameEl) {
  nameEl.querySelectorAll('.jv-dot').forEach(cleanupDot);
}

/**
 * 移除「同一个文件」上可能残留的标记点。
 *
 * 为什么需要它：同一个文件的行容器与文件名节点**可能被扫描器同时收录**
 * （父子都命中），于是 renderTagPill 会被调用两次、插两个圆点。
 *
 * ⚠️ 关键约束：**绝不能清到别的文件行上去**。
 * 早期实现是「向上找最近一个含圆点的祖先，清掉那一层」——
 * 但 115 的文件名节点离公共列表容器只有两三层，
 * 循环往上走会**越过本行、命中整个列表容器**，
 * 把此前所有行已经渲染好的圆点全部清掉（表现为「一个圆点都没有」）。
 *
 * 正确做法：只在「本节点 + 它的直系祖先链，且该祖先不包含其它文件名」范围内清理。
 * 一旦祖先里出现了别的文件名（说明已经跨到列表容器），立刻停止。
 */
function removeTagNear(nameEl) {
  // 1. 先清自己 + 后代
  removeTagAt(nameEl);

  // 2. 向上逐层清，但遇到「含多个文件名」的容器就停 —— 那是列表容器，不是本行
  let node = nameEl;
  for (let i = 0; i < 4 && node.parentElement; i++) {
    const parent = node.parentElement;

    // 若该父级里还挂着别的文件名节点 → 已经越界到列表容器，停止
    if (countFileNames(parent) > 1) break;

    // 只清「直接挂在该父级下」的圆点（即本行的残留），不递归进别的子树
    for (const child of Array.from(parent.children || [])) {
      if (String(child.className || '').split(/\s+/).includes('jv-dot')) cleanupDot(child);
    }

    node = parent;
  }
}

/** 统计一个容器里出现的视频文件名节点数量（用于判断是不是列表容器） */
function countFileNames(root) {
  const VIDEO_EXT = /\.(mp4|mkv|avi|wmv|mov|ts|m2ts|rmvb|flv|webm|iso|mpg|mpeg|m4v)$/i;
  let n = 0;
  for (const el of root.querySelectorAll?.('*') || []) {
    let own = '';
    for (const c of el.childNodes || []) if (c.nodeType === 3) own += c.nodeValue;
    if (VIDEO_EXT.test(own.trim())) n++;
    if (n > 1) return n;      // 早退
  }
  return n;
}

/** 清理一个圆点：断开事件监听并移除节点 */
function cleanupDot(d) {
  try { d.__jvCleanup?.(); } catch (e) { /* 忽略 */ }
  d.remove();
}

/** 构造浮层 DOM */
function buildTip(meta, opts = {}, doc = document) {
  const tip = doc.createElement('div');
  tip.className = 'jv-tip';

  /* ---- 未匹配 ---- */
  if (!meta || meta.notFound) {
    const t = doc.createElement('div');
    t.className = 'jv-t';
    t.textContent = meta?.code ? `未找到：${meta.code}` : '未找到对应影片信息';
    tip.appendChild(t);

    if (opts.manualLinks?.length) {
      const note = doc.createElement('div');
      note.className = 'jv-foot';
      note.textContent = '可手动搜索：';
      tip.appendChild(note);

      const links = doc.createElement('div');
      links.className = 'jv-links';
      opts.manualLinks.forEach((l) => {
        const a = doc.createElement('a');
        a.className = 'manuallink';
        a.href = l.url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = l.name;
        links.appendChild(a);
      });
      tip.appendChild(links);
    }
    return tip;
  }

  /* ---- 封面（可选） ---- */
  if (opts.showCover && meta.cover) {
    const img = doc.createElement('img');
    img.className = 'jv-cover';
    img.src = meta.cover;
    img.referrerPolicy = 'no-referrer';
    img.onerror = () => img.remove();
    tip.appendChild(img);
  }

  /* ---- 标题 ---- */
  if (meta.title) {
    const t = doc.createElement('div');
    t.className = 'jv-t';
    t.textContent = meta.title;
    tip.appendChild(t);
  }

  /* ---- 番号 ---- */
  if (meta.code) tip.appendChild(row('番号', meta.code, doc));

  /* ---- 演员（悬停层空间充裕，默认全显示） ---- */
  const actresses = meta.actresses || [];
  if (actresses.length) {
    const max = opts.maxActress ?? 0;
    tip.appendChild(tagRow('演员', max > 0 ? actresses.slice(0, max) : actresses, 'actress', doc));
  }

  /* ---- 类别 ---- */
  const genres = meta.genres || [];
  if (genres.length) {
    const max = opts.maxGenres ?? 0;
    tip.appendChild(tagRow('类别', max > 0 ? genres.slice(0, max) : genres, 'genre', doc));
  }

  /* ---- 厂商 / 发行日期 ---- */
  if (meta.studio) tip.appendChild(row('厂商', meta.studio, doc));
  if (meta.releaseDate) tip.appendChild(row('发行', meta.releaseDate, doc));

  /* ---- 来源 ---- */
  if (meta.source) {
    const foot = doc.createElement('div');
    foot.className = 'jv-foot';
    foot.textContent = `数据来源：${meta.source}`;
    tip.appendChild(foot);
  }

  return tip;
}

/** 一行「键：值」 */
function row(k, v, doc = document) {
  const div = doc.createElement('div');
  div.className = 'jv-row';
  const kk = doc.createElement('span');
  kk.className = 'jv-k';
  kk.textContent = k;
  const vv = doc.createElement('span');
  vv.className = 'jv-v';
  vv.textContent = v;
  div.append(kk, vv);
  return div;
}

/** 一行「键：标签标签标签」 */
function tagRow(k, values, cls, doc = document) {
  const div = doc.createElement('div');
  div.className = 'jv-row';
  const kk = doc.createElement('span');
  kk.className = 'jv-k';
  kk.textContent = k;
  const box = doc.createElement('span');
  box.className = 'jv-tags';
  values.forEach((v) => {
    const t = doc.createElement('span');
    t.className = `jv-tag ${cls}`;
    t.textContent = v;
    box.appendChild(t);
  });
  div.append(kk, box);
  return div;
}

/** 把浮层定位到圆点旁（自动避让视口边缘） */
function positionTip(tip, dot) {
  const r = dot.getBoundingClientRect();
  const tw = tip.offsetWidth || 280;
  const th = tip.offsetHeight || 150;
  const gap = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // 水平：优先放右侧，空间不够则放左侧
  let left = r.right + gap;
  if (left + tw > vw - 8) left = r.left - tw - gap;
  if (left < 8) left = Math.max(8, Math.min(r.left, vw - tw - 8));

  // 垂直：优先放下方，空间不够则放上方
  let top = r.bottom + gap;
  if (top + th > vh - 8) top = Math.max(8, r.top - th - gap);

  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
}

/**
 * 兼容旧调用名。
 * 旧版会在文件名后插入大片标签，新版只在旁边放一个小圆点。
 */
const renderTag = renderTagPill;

/** 清除所有已注入的标记点与浮层 */
function clearTagPills(root = document) {
  const doc = root.ownerDocument || document;
  root.querySelectorAll('.jv-dot').forEach(cleanupDot);
  root.querySelectorAll('.jv-tip').forEach((el) => el.remove());
  // 浮层是挂到 body 的，可能不在传入的 root 子树内
  doc.querySelectorAll?.('.jv-tip').forEach((el) => el.remove());
}


/* ==================================================================
 * core/site-115.js
 * ================================================================== */

/**
 * 115 页面适配层（增强版）
 * ------------------------------------------------------------------
 * 职责：
 *   1. 从 115 文件列表 DOM 中读出「文件名 + 元素引用」
 *   2. 在文件名元素上注入标签
 *   3. 通过 MutationObserver 监听列表变化（翻页/切换目录）自动重绘
 *   4. 扫描失败时提供结构化的诊断信息，便于定位选择器问题
 *
 * 设计思路：
 *   115 的类名带哈希后缀且频繁改版，硬编码选择器极易失效。
 *   因此采用「广度扫描 + 特征打分」策略：
 *     遍历所有叶子节点 → 按「文本像视频文件名」打分 → 取最高分节点作为文件名节点
 *   这样不依赖具体 class 名，抗改版能力强。
 */const VIDEO_EXT = /\.(mp4|mkv|avi|wmv|mov|ts|m2ts|rmvb|flv|webm|iso|mpg|mpeg|m4v)$/i;

/** 统计一段文本里出现的视频扩展名个数（用于识别「多文件名拼在一起」的容器） */
function countVideoExt(text) {
  // 注意：不要加「后面不能再跟字母数字」的限制 ——
  // "PIYO-046.mp4YO-046.mp4" 里第一个 .mp4 后面正好跟着 Y，
  // 加了限制就会漏掉，导致容器被判成单个文件名。
  const re = /\.(mp4|mkv|avi|wmv|mov|ts|m2ts|rmvb|flv|webm|iso|mpg|mpeg|m4v)/gi;
  let n = 0;
  while (re.exec(text)) n++;
  return n;
}

/** 扫描统计，用于诊断 */
let lastScanStats = {
  totalElements: 0,
  leafNodes: 0,
  videoLike: 0,
  accepted: 0,
  byStrategy: {},
  rejected: [],
  skippedNav: 0,        // 被「面包屑/导航区」过滤掉的节点数
  multiExtSkipped: 0    // 被「含多个扩展名（容器）」过滤掉的节点数
};

/**
 * 收集元素的「内联文本」——自身文本 + 行内子元素文本，但跳过块级容器。
 *
 * 为什么需要它：
 *   115 会把文件名拆成多段，例如：
 *     <div class="name">SONE<span class="hl">-119</span>.mp4</div>
 *   只取直系文本会得到 "SONE.mp4"（丢失番号），
 *   只取 textContent 又会把整个列表容器吸进来。
 *   所以要「拼接行内内容、遇到块级就停」。
 */
function collectOwnText(el) {
  const INLINE_SKIP = /^(svg|i|img|input|button)$/i;
  const out = [];

  const walk = (node, depth) => {
    if (depth > 3) return;
    for (const n of node.childNodes) {
      if (n.nodeType === 3) {
        out.push(n.nodeValue);
        continue;
      }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName || '';
      const cls = String(n.className || '');
      // 跳过图标/按钮/隐藏辅助元素
      if (INLINE_SKIP.test(tag)) continue;
      if (/icon|btn|button|checkbox|arrow|caret/i.test(cls)) continue;
      walk(n, depth + 1);
    }
  };

  walk(el, 0);
  // 合并冗余空白
  return out.join('').replace(/\s+/g, ' ').trim();
}

/**
 * 判断元素是否可能承载文件名文本。
 * 保留此函数用于诊断/兼容，主流程已改用 collectOwnText。
 */
function isTextLeaf(el) {
  // 完全没有子元素 → 一定是
  if (el.children.length === 0) return true;
  // 有子元素：只允许极少量的行内子元素（高亮 span / 图标 i 等）
  if (el.children.length > 3) return false;
  // 子元素里不能有 div/p/ul/li 等块级容器
  for (const c of el.children) {
    if (/^(DIV|P|UL|OL|LI|TABLE|TR|TD|SECTION|ARTICLE|BUTTON|INPUT|SVG)$/.test(c.tagName)) {
      return false;
    }
  }
  return true;
}

/**
 * 从元素上获取可作为文件名使用的文本。
 * 优先 title 属性，其次文本内容。
 */
function getNodeText(el) {
  const title = el.getAttribute?.('title');
  const text = el.textContent || '';
  return { title: (title || '').trim(), text: text.trim() };
}

/**
 * 判断元素是否位于「面包屑 / 路径导航 / 工具栏」区域。
 *
 * 为什么需要：
 *   115 的路径栏会显示当前文件名（如「云下载 > PIYO-046.mp4」），
 *   这个节点长得和列表里的文件名一模一样，会被扫描器当成第二个视频文件，
 *   导致「明明只有 1 个文件，却扫出 2~3 个」。
 *
 * 判定方式（不依赖具体 class 名，抗改版）：
 *   - 元素自身或祖先的 className / id 命中导航类关键词
 *   - aria-label / role 指明是导航
 *   - 祖先链上出现了「面包屑分隔符」特征（含 > 或 / 且很短）
 */
function isInNavArea(el) {
  const NAV_RE = /(breadcrumb|crumb|path|nav|toolbar|tool-bar|toolstrip|locationbar|location-bar|addressbar|dir-?path|filepath|file-?path|currentdir|current-?path|header-?bar)/i;

  let cur = el;
  for (let d = 0; d < 6 && cur; d++, cur = cur.parentElement) {
    if (cur.nodeType !== 1) continue;

    const cls = String(cur.className || '');
    const id = String(cur.id || '');
    if (NAV_RE.test(cls) || NAV_RE.test(id)) return true;

    // aria / role 语义
    const role = cur.getAttribute?.('role') || '';
    const aria = cur.getAttribute?.('aria-label') || '';
    if (/navigation|breadcrumb/i.test(role) || /导航|路径|面包屑|当前位置/i.test(aria)) return true;

    // 语义化标签
    const tag = cur.tagName || '';
    if (tag === 'NAV') return true;
  }
  return false;
}

/**
 * 广度扫描：找出所有「文本像视频文件名」的节点。
 * 这是核心探测器，不依赖任何 class 名。
 *
 * 关键改进（v3）：
 *   1. 不再用 textContent（会吸入整个子树），改用「自身直系文本」
 *   2. 同时检查 title / data-* / aria-label 等属性
 *   3. 不再强依赖 isTextLeaf——只要有直系文本命中就接受
 *      因为 115 的文件名可能挂在带子元素的容器上
 */
function findVideoLikeNodes(root = document) {
  const out = [];
  const all = root.querySelectorAll('*');

  for (const el of all) {
    lastScanStats.totalElements++;

    // 跳过「面包屑 / 路径导航」区域里的节点 ——
    // 115 的路径栏会显示当前文件名（如「云下载 > PIYO-046.mp4」），
    // 它长得和列表里的文件名一模一样，会被误当成第二个视频文件。
    if (isInNavArea(el)) {
      lastScanStats.skippedNav = (lastScanStats.skippedNav || 0) + 1;
      continue;
    }

    // 取候选文本：
    //   - 有子元素时用完整 textContent（文件名可能被拆成多个 span）
    //   - 用长度上限排除「整个列表容器」被误判
    const ownText = collectOwnText(el);
    const fullText = (el.textContent || '').trim();
    const title = (el.getAttribute?.('title') || '').trim();

    const sources = [];
    if (title) sources.push({ from: 'title', value: title });

    // 优先用「自身+行内子元素」拼出的短文本
    if (ownText) sources.push({ from: 'text', value: ownText });

    // 兜底：完整 textContent（仅在足够短时使用，防止匹配到列表容器）
    if (fullText && fullText.length <= 300 && fullText !== ownText) {
      sources.push({ from: 'textContent', value: fullText });
    }

    for (const attr of ['data-name', 'data-title', 'aria-label']) {
      const v = el.getAttribute?.(attr);
      if (v) sources.push({ from: attr, value: String(v).trim() });
    }

    lastScanStats.leafNodes++;

    let matched = null;
    for (const s of sources) {
      if (s.value.length > 0 && s.value.length <= 300 && VIDEO_EXT.test(s.value)) {
        matched = s;
        break;
      }
    }

    // 完整性校验：如果命中的是内联拼接文本，但完整文本更长且仍像视频文件，
    // 说明内联拼接可能丢了中间片段（如高亮 span 被跳过）→ 改用完整文本
    if (matched && matched.from === 'text' && fullText.length > matched.value.length) {
      if (fullText.length <= 300 && VIDEO_EXT.test(fullText)) {
        matched = { from: 'textContent', value: fullText };
      }
    }

    // ★ 关键防线：文本里出现「2 个及以上」视频扩展名 → 这是把多个文件名
    //   拼在一起的容器（如某行的父级把完整名和残片连成了
    //   "PIYO-046.mp4YO-046.mp4"），不是单个文件名，必须拒绝。
    //   否则会收下一个名字超长的假条目，同时把真正的文件名挤掉。
    if (matched && countVideoExt(matched.value) > 1) {
      if (lastScanStats.rejected.length < 30) {
        lastScanStats.rejected.push({
          tag: el.tagName,
          cls: String(el.className).slice(0, 60),
          text: `${matched.value.slice(0, 60)}  ← 含多个扩展名(容器)`,
          children: el.children.length
        });
      }
      lastScanStats.multiExtSkipped = (lastScanStats.multiExtSkipped || 0) + 1;
      continue;
    }

    if (!matched) {
      // 记录「有扩展名但没通过」的样本，用于诊断
      const probe = ownText || fullText.slice(0, 200) || title;
      if (probe && probe.length < 200 && /\.\w{1,5}$/.test(probe) && lastScanStats.rejected.length < 30) {
        lastScanStats.rejected.push({
          tag: el.tagName,
          cls: String(el.className).slice(0, 60),
          text: probe.slice(0, 80),
          children: el.children.length
        });
      }
      continue;
    }

    lastScanStats.videoLike++;
    out.push({ el, name: matched.value, from: matched.from });
  }

  return out;
}

/**
 * 115 列表「行容器」的识别。
 * ------------------------------------------------------------------
 * 实测（2026-09 真机采样）真实 DOM 长这样：
 *
 *   <li rel="item" title="hmpd-10044.mp4" file_id="3527247704331650213"
 *       pick_code="bi0izro13wfpq8syt" file_size="6984372848"
 *       cid="3063507687632273050" ico="mp4" file_type="1" user_ptime="昨天 21:42">
 *     <div class="file-name-wrap">
 *       <span class="file-name">
 *         <em>
 *           <a class="name" href="javascript:;" menu="view_file_one"
 *              title="hmpd-10044.mp4" rel="file" field="file_name">
 *             <span>hmpd</span><span>-10044.mp4</span>
 *           </a>
 *         </em>
 *       </span>
 *     </div>
 *     <div class="file-size"><span>6.50GB</span></div>
 *     <div class="file-opr">…下载 / 移动 / 重命名 / 删除…</div>
 *   </li>
 *
 * 两个必须记住的事实：
 *   ① 关键属性都带**下划线**：`file_id` / `pick_code` / `file_size`
 *      —— 早期版本只找 `pickcode` / `data-id`，结果一无所获。
 *   ② 行容器是那个 `<li rel="item">`，它的父节点 `<ul>` 装的是**所有行**。
 *      把 `<ul>` 当行容器会导致：大小取错、pickcode 串到别的文件上。
 *      所以这里用「这个容器里有几个视频文件名」做闸门（> 1 即越界）。
 */
const ROW_ID_ATTRS = ['file_id', 'file-id', 'data-file-id', 'fid', 'data-fid', 'data-id', 'fileId'];
const ROW_PC_ATTRS = ['pick_code', 'pick-code', 'pickcode', 'data-pickcode', 'data-pick-code', 'data-pc', 'data-file-pickcode', 'pc'];
const ROW_SIZE_ATTRS = ['file_size', 'file-size', 'data-size'];
const ROW_CID_ATTRS = ['cid', 'p_id', 'p-id', 'parent_id', 'data-cid'];

/** 元素是不是「一行文件」（115 给行容器挂了只有它才有的自定义属性） */
function isRowElement(el) {
  if (!el || !el.getAttribute) return false;
  try {
    const rel = el.getAttribute('rel');
    if (rel && String(rel) === 'item') return true;
    for (const a of ['file_id', 'pick_code', 'file_type']) {
      const v = el.getAttribute(a);
      if (v && String(v).length >= 4) return true;
    }
    const cls = typeof el.className === 'string' ? el.className : (el.className?.baseVal || '');
    if (/(^|[\s-])file-item($|[\s-])/.test(String(cls))) return true;
  } catch (e) { /* 忽略 */ }
  return false;
}

/**
 * 从一段文本里抠出所有「像视频文件名」的令牌（去空白、小写）。
 * 用惰性匹配，所以 `PIYO-046.mp4YO-046.mp4` 这种挨着的两段也能各抠出来。
 */
function videoNameTokens(text) {
  const out = [];
  const re = /[^\s/\\:*?"<>|]{1,160}?\.(mp4|mkv|avi|wmv|mov|ts|m2ts|rmvb|flv|webm|iso|mpg|mpeg|m4v)/gi;
  const s = String(text || '');
  let m;
  while ((m = re.exec(s))) {
    out.push(m[0].replace(/\s+/g, '').toLowerCase());
    if (out.length > 60) break;   // 保险丝，避免超大容器把正则跑爆
  }
  return out;
}

/**
 * 这个容器里装了「多个**不同**的视频文件」吗？
 *
 * ⚠️ 不能用「视频扩展名出现几次」来判断 —— 同一个文件名被拆成几段渲染时
 *    （`<span>PI</span><span>YO-046.mp4</span>` → 文本 `PIYO-046.mp4YO-046.mp4`）
 *    扩展名也会出现两次，但那明明是**一个**文件。
 *    拿它当「多文件」会导致 sameFile 判据失效 → 同一部片被拆成两条记录。
 *
 * 所以改成：把所有文件名令牌收集起来，只有「不能全部被最长那个包含」
 * 才算真的装了多个文件。列表容器（`<ul>`）里各文件名互不相干 → true。
 */
function holdsManyFiles(el, fileName) {
  const names = videoNameTokens(el?.textContent || '');
  if (names.length <= 1) return false;
  const longest = names.reduce((a, b) => (b.length > a.length ? b : a));
  return !names.every((n) => longest.includes(n));
}

/**
 * 收集「可以信任的属性来源」：文件名节点 → 逐层向上到行容器。
 * 路上会丢掉越界的容器（装多个文件的），避免串号。
 */
function attrScope(nameEl, rowEl, fileName) {
  const out = [];
  const push = (el) => {
    if (!el || out.includes(el)) return;
    if (holdsManyFiles(el, fileName)) return;
    out.push(el);
  };
  push(nameEl);
  let n = nameEl;
  for (let i = 0; i < 6 && n; i++) {
    n = n.parentElement;
    if (!n) break;
    push(n);
    if (n === rowEl) break;
  }
  push(rowEl);
  return out;
}

/** 在一组元素里按顺序找第一个符合 test 的属性值 */
function pickAttr(els, attrNames, test) {
  for (const el of els) {
    if (!el || !el.getAttribute) continue;
    for (const a of attrNames) {
      let v;
      try { v = el.getAttribute(a); } catch (e) { continue; }
      if (v == null) continue;
      v = String(v).trim();
      if (!v || v === '0') continue;
      if (!test || test(v)) return v;
    }
  }
  return null;
}

/** 从元素的 onclick / href 里正则抠出 pickcode */
function pickcodeFromRaw(el) {
  if (!el || !el.getAttribute) return null;
  const raw = `${el.getAttribute('onclick') || ''} ${el.getAttribute('href') || ''}`;
  const m = String(raw).match(/[?&]pick_?code=([A-Za-z0-9]{8,})/i);
  return m ? m[1] : null;
}

/**
 * 从文件名节点向上寻找「列表行容器」。
 *
 * 优先用 115 自己的行标记（`li[rel="item"]` / 带 file_id 的元素）——
 * 这是最可靠的判据。找不到才退回「文本更长」的老启发式。
 *
 * ⚠️ 老启发式的坑：它从父节点开始往上走，所以当传入的 nameEl
 *    本身已经是行容器时，第一跳就跳到了装着**所有行**的 `<ul>`。
 *    实测就是这样把 `ul` 当成了行容器（大小取到第一行、pickcode 全空）。
 *    现在第一件事是「先看自己是不是行」。
 */
function findRowContainer(nameEl, fileName) {
  // ① 自己或最近的祖先就是行标记元素 → 直接用它
  let n = nameEl;
  for (let i = 0; i < 7 && n; i++) {
    if (isRowElement(n) && !holdsManyFiles(n, fileName)) return n;
    n = n.parentElement;
  }

  // ② 回退：文本比文件名长（含大小/日期）的最近容器，且不许越界
  let row = nameEl;
  let best = nameEl;
  for (let i = 0; i < 8 && row.parentElement; i++) {
    row = row.parentElement;
    if (holdsManyFiles(row, fileName)) break;   // 装多个文件了 → 越界，停
    const t = row.textContent || '';
    if (t.length > fileName.length + 2) {
      best = row;
      if (/(\d+(?:\.\d+)?)\s*(KB|MB|GB|TB)|刚刚|\d{4}-\d{2}-\d{2}/i.test(t)) break;
    }
  }
  return best;
}

/**
 * 找出「能真正触发 115 打开/播放」的那个元素。
 *
 * 115 的交互是「委托 + menu 属性」驱动的：点 `<li>` 本身没有任何反应，
 * 必须点到那个带 `menu="view_file_one"` 的 `<a class="name">`。
 * 早期版本从 `nameEl` 开始逐层向上试点击，而 `nameEl` 恰好是
 * `<li>`（因为它带 title，命中的是行），于是第一层就点错了元素。
 */
function findClickTarget(nameEl, name) {
  if (!nameEl) return null;
  const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
  const target = norm(name);
  const hit = (el) => {
    if (!el) return false;
    const t = norm(el.textContent);
    const ti = norm(el.getAttribute?.('title'));
    return (target && (t.includes(target) || ti.includes(target)));
  };

  const sels = [
    '[menu="view_file_one"]',
    'a.name',
    'a[rel="file"]',
    '[field="file_name"]',
    'a[href]:not([href="javascript:;"])'
  ];
  for (const sel of sels) {
    let list = [];
    try { list = Array.from(nameEl.querySelectorAll?.(sel) || []); } catch (e) { list = []; }
    for (const el of list) if (hit(el)) return el;
  }

  // 自身就是可点的（有些版本文件名直接就是 <a>）
  try {
    const tag = String(nameEl.tagName || '').toUpperCase();
    if (tag === 'A' || nameEl.getAttribute?.('menu')) return nameEl;
  } catch (e) { /* 忽略 */ }

  return nameEl;
}

/**
 * 从行容器里挖掘可用作稳定 key 的信息。
 */
function extractKeys(nameEl, rowEl, fileName) {
  const scope = attrScope(nameEl, rowEl, fileName);

  // ---- fileId：115 的 file_id（19 位数字）----
  let fileId = pickAttr(scope, ROW_ID_ATTRS, (v) => /^[A-Za-z0-9_-]{4,}$/.test(v));
  // 排除明显不是 ID 的东西（例如 `id="3065373494322658712"` 这类标签 ID 在别的元素上，
  // 但既然 scope 已限定在本行内，这里只做格式兜底）
  if (fileId && !/^\d{4,}$/.test(fileId) && fileId.length < 8) fileId = null;

  // ---- pickcode：115 播放接口唯一需要的参数 ----
  let pickcode = pickAttr(scope, ROW_PC_ATTRS, (v) => /^[A-Za-z0-9]{8,}$/.test(v));
  if (!pickcode) {
    for (const el of scope) {
      pickcode = pickcodeFromRaw(el);
      if (pickcode) break;
    }
  }
  /*
   * 行内链接兜底：有些版本把「下载/预览」链接挂在行内的 <a href> 上，
   * href 里带 pickcode=xxx。
   * ⚠️ 这里必须再确认一次 rowEl 是「真行容器」—— 万一它是整个列表容器，
   *    querySelectorAll 会扫到别的文件的链接，把 A 的 pickcode 安到 B 头上
   *    （表现为「点这个播那个」）。
   */
  if (!pickcode && rowEl?.querySelectorAll && !holdsManyFiles(rowEl, fileName)) {
    for (const a of rowEl.querySelectorAll('a[href]')) {
      pickcode = pickcodeFromRaw(a);
      if (pickcode) break;
    }
  }

  // ---- 大小：优先用 file_size 属性（字节数，最准），退回文本正则 ----
  let size = '';
  const rawSize = pickAttr(scope, ROW_SIZE_ATTRS, (v) => /^\d{4,}$/.test(v));
  if (rawSize) size = humanSize(Number(rawSize));
  if (!size) {
    const rowText = (holdsManyFiles(rowEl, fileName) ? (nameEl?.textContent || '') : (rowEl?.textContent || ''));
    const m = rowText.match(/(\d+(?:\.\d+)?)\s*(KB|MB|GB|TB)/i);
    if (m) size = m[0];
  }

  // ---- 所在目录 cid：行上就写着呢，可以顺手校正列表 frame 里 cid=0 的老问题 ----
  const rowCid = pickAttr(scope, ROW_CID_ATTRS, (v) => /^\d{4,}$/.test(v)) || '';

  // 复合键：fileId 优先，否则用 文件名+大小
  const key = fileId || `${fileName}@@${size}`;

  return {
    key: String(key),
    fileId,
    pickcode,
    size,
    cid: rowCid,
    strategy: fileId ? 'fileId' : 'name-size'
  };
}

/**
 * 主扫描函数：返回当前页（或指定 document）所有视频条目。
 * @param {Document} root 要扫描的 document，默认当前页面。
 *                        传入 iframe 的 contentDocument 可跨 frame 扫描。
 */function scanVideoItems(root = document) {
  lastScanStats = {
    totalElements: 0, leafNodes: 0, videoLike: 0, accepted: 0,
    byStrategy: {}, rejected: [], skippedNav: 0, multiExtSkipped: 0
  };

  const items = [];
  const seenEl = new Set();      // 按元素引用去重（同名不同文件不应被合并）
  const seenKey = new Map();     // key → 已用次数，用于发现 key 冲突

  const nodes = findVideoLikeNodes(root);

  /**
   * 判定两个元素是否「指向同一个文件」。
   * 同一个文件的文件名往往同时挂在「外层容器」和「内层文本节点」上，
   * 两者都会命中扫描。需要识别这种情况并只保留最内层的那个。
   */
  /**
   * 判定两个候选是否「指向同一个文件」。
   *
   * 两种情况：
   *   A. DOM 上的包含关系 —— 同一个文件名同时挂在外层容器和内层节点上
   *   B. 文本上的包含关系 —— 文件名被拆成多段，某段单独也匹配到了扩展名
   *      例如 「PIYO-046.mp4」 被拆成 PI + YO-046 + .mp4，
   *      内层某个节点只拿到「YO-046.mp4」，于是被当成另一个文件。
   *
   * 判据 B 的约束：短文本必须是长文本的**子串**，且两者在同一行容器内，
   * 否则会把「A-1.mp4」和「BA-1.mp4」这种不同文件误合并。
   */
  const sameFile = (a, b, nameA, nameB) => {
    if (a === b) return true;

    // A. DOM 包含关系
    try {
      if (a.contains?.(b) || b.contains?.(a)) return true;
    } catch (e) { /* 忽略 */ }

    // B. 文本包含关系（仅在同一个行容器内才认，避免跨行误合并）
    const shortN = nameA.length <= nameB.length ? nameA : nameB;
    const longN = nameA.length <= nameB.length ? nameB : nameA;
    if (shortN !== longN) {
      const normShort = shortN.replace(/\s+/g, '').toLowerCase();
      const normLong = longN.replace(/\s+/g, '').toLowerCase();
      if (normShort && normLong.includes(normShort)) {
        const rowA = findRowContainer(a, nameA);
        const rowB = findRowContainer(b, nameB);
        if (rowA === rowB) return true;
      }
    }

    return false;
  };

  /**
   * 处理顺序（重要）：
   *   1. 浅 → 深：外层容器先被处理，这样它的「包含关系」能立刻标记到内层，
   *      内层随后被同一个 sameFile 判定拦掉（保证只留一个）
   *   2. 文本短 → 长：同一层里，**长文本（更完整）优先**。
   *      例如 →「PIYO-046.mp4」优先于被截断的「YO-046.mp4」。
   */
  const sorted = nodes.slice().sort((x, y) => {
    const dx = depthOf(x.el);
    const dy = depthOf(y.el);
    if (dx !== dy) return dx - dy;              // 浅的（外层）先处理
    return y.name.length - x.name.length;        // 同深度：长文本优先
  });

  sorted.forEach(({ el, name }) => {
    // 同一元素重复命中（例如同时命中 title 和 text）→ 跳过
    if (seenEl.has(el)) return;

    // 已有「同一个文件」的其他节点被收录 → 跳过
    let conflict = false;
    for (const it of items) {
      if (sameFile(el, it.nameEl, name, it.name)) { conflict = true; break; }
    }
    if (conflict) return;

    seenEl.add(el);

    const rowEl = findRowContainer(el, name);
    const keys = extractKeys(el, rowEl, name);
    // 真正能触发 115「打开/播放」的元素（带 menu="view_file_one" 的那个 <a>）
    const clickEl = findClickTarget(el, name);

    // key 冲突检测：同名同大小的不同文件会有相同 key，追加序号保证唯一
    let finalKey = keys.key;
    if (seenKey.has(finalKey)) {
      const n = seenKey.get(finalKey) + 1;
      seenKey.set(finalKey, n);
      finalKey = `${finalKey}#${n}`;
    } else {
      seenKey.set(finalKey, 0);
    }

    lastScanStats.accepted++;
    lastScanStats.byStrategy[keys.strategy] = (lastScanStats.byStrategy[keys.strategy] || 0) + 1;

    items.push({
      key: finalKey,
      fileId: keys.fileId,
      pickcode: keys.pickcode,
      // 行上自带的目录 cid（列表 frame 的 URL 里 cid 恒为 0，这里是它的正确来源）
      rowCid: keys.cid || '',
      name,
      size: keys.size,
      nameEl: el,
      clickEl,
      rowEl
    });
  });

  return items;
}

/** 元素的 DOM 深度（用于「更深=更具体」的排序） */
function depthOf(el) {
  let d = 0;
  let n = el;
  while (n && n.parentElement) { d++; n = n.parentElement; }
  return d;
}

/** 获取上次扫描的统计信息（用于诊断） */function getScanStats() {
  return { ...lastScanStats };
}

/** 页面当前路径 */function getCurrentPath() {
  const params = new URLSearchParams(location.search);
  return { cid: params.get('cid') || '0', url: location.href };
}

/**
 * 等待文件列表渲染出来。
 *
 * 115 是 SPA，列表异步渲染。如果扫描太早会得到「0 个视频」。
 * 这里轮询等待，直到出现「有视频文件名的节点」或超时。
 *
 * @param {number} timeoutMs 最长等待时间
 * @param {number} intervalMs 轮询间隔
 * @returns {Promise<{items: Array, waited: number, reason: string}>}
 */function waitForVideoItems(timeoutMs = 8000, intervalMs = 400) {
  return new Promise((resolve) => {
    const start = Date.now();

    const tick = () => {
      // 同时检查当前 frame 和所有同源 iframe
      const all = scanAllFrames();
      if (all.items.length > 0) {
        resolve({ items: all.items, frames: all.frames, waited: Date.now() - start, reason: 'found' });
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        resolve({ items: [], frames: all.frames, waited: Date.now() - start, reason: 'timeout' });
        return;
      }
      setTimeout(tick, intervalMs);
    };

    tick();
  });
}

/**
 * 监听列表变化，防抖后回调。
 */function observeList(onChange, debounceMs = 600) {
  let timer = null;
  const trigger = () => {
    clearTimeout(timer);
    timer = setTimeout(onChange, debounceMs);
  };

  const observer = new MutationObserver(trigger);
  observer.observe(document.body, { childList: true, subtree: true });

  let lastUrl = location.href;
  const urlTimer = setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      trigger();
    }
  }, 800);

  return () => {
    observer.disconnect();
    clearInterval(urlTimer);
    clearTimeout(timer);
  };
}

/** 判断当前是否在 115 文件列表页 */function isStoragePage() {
  const host = location.hostname;
  return /(^|\.)115\.com$/.test(host) ||
    /(^|\.)115cdn\.com$/.test(host) ||
    /(^|\.)115vod\.com$/.test(host);
}

/**
 * 全页面文本普查：不依赖任何结构假设，直接找出页面里所有
 * 「短文本且带视频扩展名结尾」的元素。
 *
 * 用途：当 findVideoLikeNodes 返回 0 时，用这个函数兜底，
 * 直接告诉用户「页面上到底有没有视频文件名、它们长在哪个元素上」。
 */
function surveyPageText() {
  const found = [];
  const all = document.querySelectorAll('*');

  for (const el of all) {
    // 只看自身直接文本（排除子元素文本），避免大容器被误算
    let ownText = '';
    for (const n of el.childNodes) {
      if (n.nodeType === 3) ownText += n.nodeValue;
    }
    ownText = ownText.trim();
    if (!ownText || ownText.length > 300) continue;

    if (VIDEO_EXT.test(ownText)) {
      found.push({
        tag: el.tagName,
        cls: String(el.className || '').slice(0, 80),
        id: el.id || '',
        text: ownText.slice(0, 100),
        children: el.children.length,
        parentTag: el.parentElement?.tagName || '',
        parentCls: String(el.parentElement?.className || '').slice(0, 60),
        title: (el.getAttribute?.('title') || '').slice(0, 100)
      });
    }
  }
  return found;
}

/** 页面里出现的所有视频扩展名种类（判断文件是否存在） */
function surveyExtensions() {
  const counter = {};
  const re = /\.([a-z0-9]{2,5})(?=["'\s,，、）)]|$)/gi;
  const txt = (document.body?.innerText || '').slice(0, 200000);
  let m;
  while ((m = re.exec(txt))) {
    const ext = m[1].toLowerCase();
    if (/^(mp4|mkv|avi|wmv|mov|ts|m2ts|rmvb|flv|webm|iso|mpg|mpeg|m4v|jpg|png|gif|zip|rar|7z|pdf|txt|srt|ass|mp3|wav|flac)$/.test(ext)) {
      counter[ext] = (counter[ext] || 0) + 1;
    }
  }
  return counter;
}

/**
 * 跨 frame 扫描：把当前页面 + 所有同源 iframe 里的视频条目都扫出来。
 *
 * 为什么需要它：
 *   115 把文件列表渲染在同源 iframe 里（tpl=view_large&ct=file），
 *   顶层 document 里一个文件都没有。必须钻进 iframe 才能扫到。
 *
 * @returns {{items: Array, frames: Array<{url, count}>}}
 */function scanAllFrames() {
  const frames = [];
  const all = [];

  // 1. 当前 document
  const own = scanVideoItems(document);
  frames.push({ url: location.href.slice(0, 100), count: own.length, self: true });
  all.push(...own);

  // 2. 所有同源 iframe
  let iframes = [];
  try {
    iframes = [...document.querySelectorAll('iframe')];
  } catch (e) { /* 忽略 */ }

  for (const f of iframes) {
    let doc = null;
    try {
      doc = f.contentDocument;
    } catch (e) {
      frames.push({ url: (f.src || '').slice(0, 100), count: -1, error: 'cross-origin' });
      continue;
    }
    if (!doc || !doc.body) continue;
    try {
      const items = scanVideoItems(doc);
      frames.push({ url: (f.src || doc.location?.href || '').slice(0, 100), count: items.length });
      all.push(...items);
    } catch (e) {
      frames.push({ url: (f.src || '').slice(0, 100), count: -1, error: e.message });
    }
  }

  return { items: all, frames };
}

/**
 * 列出页面上所有「可能的文件列表容器」。
 *
 * 这是判断「列表到底有没有渲染」最直接的手段：
 * 不管 class 叫什么，只要某个元素里有 ≥3 个结构相似、
 * 且文本量相近的子元素，就很可能是一个列表容器。
 */
function surveyContainers(doc = document) {
  const out = [];

  for (const el of doc.querySelectorAll('*')) {
    const kids = el.children;
    if (!kids || kids.length < 3) continue;

    // 子元素平均文本长度（太短说明是图标行，太长说明是文档流）
    let total = 0;
    let similarTag = 0;
    const firstTag = kids[0].tagName;
    for (const k of kids) {
      total += (k.textContent || '').length;
      if (k.tagName === firstTag) similarTag++;
    }
    const avg = total / kids.length;
    if (avg < 5 || avg > 400) continue;
    // 至少 70% 的子元素标签相同 → 典型的重复列表项
    if (similarTag / kids.length < 0.7) continue;

    out.push({
      tag: el.tagName,
      cls: String(el.className || '').slice(0, 80),
      id: el.id || '',
      childCount: kids.length,
      childTag: firstTag,
      avgTextLen: Math.round(avg),
      sample: (kids[0].textContent || '').replace(/\s+/g, ' ').slice(0, 120)
    });
  }

  // 按子元素数量降序，最像列表的排前面
  return out.sort((a, b) => b.childCount - a.childCount).slice(0, 20);
}

/** surveyContainers 的显式命名别名（语义更清楚） */
function surveyContainersIn(doc) {
  return surveyContainers(doc);
}

/**
 * 页面框架体检：判断 115 的文件列表到底有没有渲染出来。
 * 这是本轮诊断的核心——如果列表压根没渲染，改选择器是没用的。
 */function inspectPage(doc = document) {
  const info = {
    url: doc === document ? location.href : (doc.location?.href || '(子 frame)'),
    readyState: doc.readyState,
    body文本长度: (doc.body?.innerText || '').length,
    body元素总数: doc.querySelectorAll('*').length,
    滚动高度: doc.documentElement?.scrollHeight,
    视口高度: doc.defaultView?.innerHeight || window.innerHeight
  };

  // 1. 关键框架节点探测（115 常见容器，用宽松选择器）
  const probes = {
    '文件列表滚动容器': '.scroll-body, .scroll-wrap, [class*="scroll-body"]',
    '列表主区域': '#js_data_list, .list-cell, [class*="list-cell"]',
    '顶部工具条': '.toolbar, [class*="toolbar"]',
    '侧边栏': '.sidebar, [class*="sidebar"]',
    '空状态提示': '[class*="empty"], [class*="no-data"]'
  };
  const framework = {};
  for (const [label, sel] of Object.entries(probes)) {
    try {
      framework[label] = doc.querySelectorAll(sel).length;
    } catch (e) {
      framework[label] = 'selector-error';
    }
  }

  // 2. 列表容器普查（用传入的 document）
  const containers = surveyContainersIn(doc);

  // 3. iframe 检测（列表可能被嵌在 iframe 里）
  const iframes = [...doc.querySelectorAll('iframe')].map((f) => ({
    src: (f.src || '').slice(0, 120),
    w: f.clientWidth,
    h: f.clientHeight
  }));

  return {
    基本信息: info,
    关键容器命中: framework,
    可能的列表容器: containers,
    iframe数: iframes.length,
    iframes
  };
}

/**
 * 逐个体检所有同源 frame（含自身）。
 * 用于回答「列表到底在哪个 frame 里」。
 */function inspectAllFrames() {
  const out = [];
  out.push({ frame: '当前页', ...inspectPage(document) });

  for (const f of document.querySelectorAll('iframe')) {
    let doc = null;
    try { doc = f.contentDocument; } catch (e) { /* 跨域 */ }
    if (!doc || !doc.body) {
      out.push({
        frame: (f.src || '(无 src)').slice(0, 100),
        可访问: false,
        尺寸: `${f.clientWidth}x${f.clientHeight}`
      });
      continue;
    }
    const ins = inspectPage(doc);
    out.push({
      frame: (f.src || '(无 src)').slice(0, 100),
      可访问: true,
      尺寸: `${f.clientWidth}x${f.clientHeight}`,
      ...ins
    });
  }
  return out;
}

/**
 * 诊断报告：全面分析当前页面，输出结构化的排查信息。
 * 这是「扫描不生效」时最有用的工具。
 */function diagnose() {
  scanVideoItems();
  const after = getScanStats();

  const survey = surveyPageText();
  const inspect = inspectPage();
  const frameScan = scanAllFrames();
  const allFrames = inspectAllFrames();

  const report = {
    页面: {
      url: location.href,
      host: location.hostname,
      path: location.pathname,
      是否115域名: isStoragePage(),
      文档状态: document.readyState
    },
    脚本环境: {
      GM_xmlhttpRequest: typeof GM_xmlhttpRequest,
      脚本已标记加载: Boolean(window.__JV115_TAGGER_LOADED__),
      面板宿主存在: Boolean(document.getElementById('jv115-tagger-host'))
    },
    页面框架体检: inspect,
    各frame体检: allFrames,
    跨frame扫描: {
      总收录: frameScan.items.length,
      各frame: frameScan.frames
    },
    扫描结果: {
      页面元素总数: after.totalElements,
      叶子节点数: after.leafNodes,
      像视频文件的节点: after.videoLike,
      成功收录: after.accepted,
      被导航区过滤: after.skippedNav || 0,
      被多扩展名容器过滤: after.multiExtSkipped || 0,
      key策略分布: after.byStrategy
    },
    页面视频文本普查: {
      命中数: survey.length,
      样本: survey.slice(0, 15)
    },
    页面扩展名分布: surveyExtensions(),
    疑似视频但未通过: after.rejected
  };

  console.group('%c[jv115-tagger] 诊断报告', 'color:#2b5cff;font-size:14px;font-weight:bold');
  console.log('页面信息:', report.页面);
  console.log('脚本环境:', report.脚本环境);
  console.log('页面框架体检:', report.页面框架体检);
  console.log('各 frame 体检:', report.各frame体检);
  console.log('跨 frame 扫描:', report.跨frame扫描);
  console.log('扫描结果:', report.扫描结果);
  console.log('页面视频文本普查:', report.页面视频文本普查);
  console.log('页面扩展名分布:', report.页面扩展名分布);
  if (report.疑似视频但未通过.length) {
    console.log('疑似视频但未通过:', report.疑似视频但未通过);
  }
  console.log('完整对象:', report);
  console.groupEnd();

  return report;
}

/**
 * 生成一份可直接复制粘贴给开发者的纯文本诊断摘要。
 * 用户点一下就能拿到，不用截图。
 */function diagnoseText() {
  const r = diagnose();
  const L = [];
  L.push('===== jv115-tagger 诊断摘要 =====');
  L.push(`时间: ${new Date().toLocaleString()}`);
  L.push(`URL: ${r.页面.url}`);
  L.push(`Host: ${r.页面.host} | 是115域名: ${r.页面.是否115域名} | readyState: ${r.页面.文档状态}`);
  L.push(`GM_xmlhttpRequest: ${r.脚本环境.GM_xmlhttpRequest} | 面板宿主: ${r.脚本环境.面板宿主存在}`);
  L.push('');

  // 页面框架体检（本轮新增，用于判断列表是否渲染）
  const ins = r.页面框架体检;
  if (ins) {
    L.push('--- 页面框架体检 ---');
    L.push(`body 文本长度: ${ins.基本信息.body文本长度}`);
    L.push(`body 元素总数: ${ins.基本信息.body元素总数}`);
    L.push(`滚动高度/视口: ${ins.基本信息.滚动高度} / ${ins.基本信息.视口高度}`);
    L.push('关键容器命中:');
    for (const [k, v] of Object.entries(ins.关键容器命中 || {})) {
      L.push(`  ${k}: ${v}`);
    }
    L.push(`可能的列表容器: ${ins.可能的列表容器?.length || 0} 个`);
    (ins.可能的列表容器 || []).slice(0, 10).forEach((c, i) => {
      L.push(`  #${i + 1} <${c.tag}> class="${c.cls}" id="${c.id}"`);
      L.push(`      子元素 ${c.childCount} 个 <${c.childTag}>，平均文本 ${c.avgTextLen} 字`);
      L.push(`      样本: ${c.sample}`);
    });
    L.push(`iframe 数: ${ins.iframe数}`);
    (ins.iframes || []).forEach((f, i) => L.push(`  #${i + 1} ${f.w}x${f.h} ${f.src}`));
    L.push('');
  }

  // 跨 frame 扫描结果
  if (r.跨frame扫描) {
    L.push('--- 跨 frame 扫描 ---');
    L.push(`总收录: ${r.跨frame扫描.总收录}`);
    (r.跨frame扫描.各frame || []).forEach((f, i) => {
      const tag = f.count === -1 ? `访问失败(${f.error || '未知'})` : `${f.count} 个视频`;
      L.push(`  #${i + 1}${f.self ? ' (当前页)' : ''}: ${tag}`);
      L.push(`      ${f.url}`);
    });
    L.push('');
  }

  // 各 frame 体检（定位列表到底在哪个 frame）
  if (r.各frame体检) {
    L.push('--- 各 frame 体检 ---');
    r.各frame体检.forEach((f, i) => {
      L.push(`#${i + 1} ${f.frame}${f.尺寸 ? '  尺寸 ' + f.尺寸 : ''}`);
      if (f.可访问 === false) { L.push('    [不可访问]'); return; }
      L.push(`    body 文本 ${f.基本信息?.body文本长度} 字 / 元素 ${f.基本信息?.body元素总数} 个`);
      const c = f.可能的列表容器 || [];
      L.push(`    列表容器 ${c.length} 个` + (c[0] ? `（最大 ${c[0].childCount} 项 <${c[0].childTag}> 平均 ${c[0].avgTextLen} 字）` : ''));
      if (c[0]) L.push(`      样本: ${c[0].sample}`);
    });
    L.push('');
  }

  L.push('--- 扫描统计 ---');
  L.push(`元素总数: ${r.扫描结果.页面元素总数}`);
  L.push(`叶子节点: ${r.扫描结果.叶子节点数}`);
  L.push(`像视频文件: ${r.扫描结果.像视频文件的节点}`);
  L.push(`成功收录: ${r.扫描结果.成功收录}`);
  L.push(`被导航区过滤: ${r.扫描结果.被导航区过滤 || 0}`);
  L.push(`被多扩展名容器过滤: ${r.扫描结果.被多扩展名容器过滤 || 0}`);
  L.push(`key策略: ${JSON.stringify(r.扫描结果.key策略分布)}`);
  L.push('');
  L.push('--- 页面视频文本普查 ---');
  L.push(`命中数: ${r.页面视频文本普查.命中数}`);
  r.页面视频文本普查.样本.forEach((s, i) => {
    L.push(`  #${i + 1} <${s.tag}> class="${s.cls}" id="${s.id}" children=${s.children}`);
    L.push(`      父级: <${s.parentTag}> class="${s.parentCls}"`);
    L.push(`      文本: ${s.text}`);
    if (s.title) L.push(`      title: ${s.title}`);
  });
  L.push('');
  L.push('--- 页面扩展名分布 ---');
  L.push(JSON.stringify(r.页面扩展名分布));
  if (r.疑似视频但未通过.length) {
    L.push('');
    L.push('--- 疑似视频但未通过 ---');
    r.疑似视频但未通过.slice(0, 15).forEach((s, i) => {
      L.push(`  #${i + 1} <${s.tag}> class="${s.cls}" children=${s.children} text="${s.text}"`);
    });
  }
  L.push('===== 结束 =====');
  return L.join('\n');
}

/** 调试：dump 扫描到的条目 */function dumpItems() {
  const items = scanVideoItems();
  console.group(`[jv115] 扫描到 ${items.length} 个视频条目`);
  items.slice(0, 40).forEach((it, i) => {
    console.log(
      `#${i + 1} <${it.nameEl.tagName} class="${String(it.nameEl.className).slice(0, 50)}"> ` +
      `key=${it.key} size=${it.size || '—'}\n  ${it.name}`, it.nameEl
    );
  });
  console.groupEnd();
  return items;
}

/** 调试：输出页面上所有带扩展名的节点，用于发现选择器盲区 */function dumpFileLikeNodes() {
  const nodes = findVideoLikeNodes();
  console.group(`[jv115] 页面上像视频文件的节点：${nodes.length} 个`);
  nodes.slice(0, 40).forEach((n, i) => {
    console.log(
      `#${i + 1} <${n.el.tagName} class="${String(n.el.className).slice(0, 60)}"> ${n.name}`,
      n.el
    );
  });
  console.groupEnd();

  console.group('[jv115] 页面结构采样（前 3 个视频节点的祖先链）');
  nodes.slice(0, 3).forEach((n, i) => {
    const chain = [];
    let el = n.el;
    for (let d = 0; d < 8 && el; d++) {
      chain.push(`<${el.tagName}${el.className ? `.${String(el.className).split(' ').slice(0, 3).join('.')}` : ''}>`);
      el = el.parentElement;
    }
    console.log(`样本 #${i + 1}: ${chain.reverse().join(' > ')}`);
  });
  console.groupEnd();

  return nodes;
}

/**
 * 原始 DOM 采样：打印含视频扩展名文本的元素及其祖先链的 outerHTML 片段。
 * 这是定位 115 真实结构的终极手段。
 */function dumpRawDom(limit = 3) {
  const hits = [];
  for (const el of document.querySelectorAll('*')) {
    let own = '';
    for (const n of el.childNodes) if (n.nodeType === 3) own += n.nodeValue;
    own = own.trim();
    if (own && own.length <= 300 && VIDEO_EXT.test(own)) hits.push({ el, text: own });
  }

  console.group(`%c[jv115] 原始 DOM 采样（${hits.length} 个命中）`, 'color:#c0322b;font-weight:bold');
  hits.slice(0, limit).forEach((h, i) => {
    console.log(`---------- 样本 #${i + 1}: ${h.text} ----------`);
    // 向上找 3 层，打印最小可读结构
    let root = h.el;
    for (let d = 0; d < 3 && root.parentElement; d++) {
      const p = root.parentElement;
      // 如果父级太大（行容器级别），就停
      if ((p.textContent || '').length > h.text.length * 30) break;
      root = p;
    }
    console.log(root.outerHTML.slice(0, 3000), root);
    console.log('元素路径:', buildPath(h.el));
  });
  console.groupEnd();
  return hits.map((h) => ({ text: h.text, path: buildPath(h.el) }));
}

/** 构建一个元素的 CSS 路径描述 */
function buildPath(el) {
  const parts = [];
  let cur = el;
  for (let d = 0; d < 8 && cur && cur !== document.body; d++) {
    let seg = cur.tagName.toLowerCase();
    if (cur.id) seg += `#${cur.id}`;
    const cls = String(cur.className || '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
    if (cls.length) seg += `.${cls.join('.')}`;
    parts.unshift(seg);
    cur = cur.parentElement;
  }
  return parts.join(' > ');
}

/* ==================================================================
 * 「建库 / 搜索 / 播放」可行性探针
 * ------------------------------------------------------------------
 * 用途：确认能否为每个视频文件拿到稳定的 fileId、所在目录 cid、
 *       以及可用的播放链接。这三样是「本地索引库 + 点击播放」的前提。
 *
 * 用法：在 115 文件列表页按 F12，输入
 *         __jv115.probeLibrary()
 *       然后把输出整段复制回来。
 * ================================================================== */

/** 从 URL 里取当前目录 cid（建库时作为文件归属目录记录） */function getCurrentCid() {
  try {
    const u = new URL(location.href);
    return u.searchParams.get('cid') || '';
  } catch (e) { return ''; }
}

/** 兼容旧名 */
function currentCid() {
  return getCurrentCid();
}

/** 本模块内的 frame 判定（避免与 frames.js 互相依赖） */
function isTopFrameLocal() {
  try { return window.top === window.self; } catch (e) { return false; }
}

/** 115 列表 frame 的 URL 特征：ct=file & ac=userfile */
function isFileListFrameLocal() {
  try {
    const u = new URL(location.href);
    return u.searchParams.get('ct') === 'file'
      && /^userfile/i.test(u.searchParams.get('ac') || '');
  } catch (e) { return false; }
}

/** 全站（含同源 iframe）找 fileId 相关的属性，判断哪些属性最可依赖 */
function surveyIdAttributes() {
  const attrs = ['data-id', 'data-file-id', 'data-fid', 'fid', 'data-cid', 'data-key', 'id'];
  const hits = {};
  attrs.forEach((a) => { hits[a] = 0; });

  const docs = [document];
  try {
    for (const f of document.querySelectorAll('iframe')) {
      if (f.contentDocument && f.contentDocument.body) docs.push(f.contentDocument);
    }
  } catch (e) { /* 忽略 */ }

  let sample = [];
  for (const doc of docs) {
    for (const el of doc.querySelectorAll('*')) {
      for (const a of attrs) {
        const v = el.getAttribute?.(a);
        if (v && /^\d{6,}$/.test(String(v))) {
          hits[a]++;
          if (sample.length < 12) {
            sample.push({ attr: a, tag: el.tagName, cls: String(el.className || '').slice(0, 40), value: String(v) });
          }
        }
      }
    }
  }
  return { hits, sample };
}

/** 找页面里可能的「播放链接」元素，看 115 用的是哪种地址格式 */
function surveyPlayLinks() {
  const out = [];
  const push = (kind, url, extra = '') => {
    if (out.length < 20) out.push({ kind, url: String(url).slice(0, 160), extra });
  };

  const docs = [document];
  try {
    for (const f of document.querySelectorAll('iframe')) {
      if (f.contentDocument && f.contentDocument.body) docs.push(f.contentDocument);
    }
  } catch (e) { /* 忽略 */ }

  for (const doc of docs) {
    // a 标签
    for (const a of doc.querySelectorAll('a[href]')) {
      const h = a.getAttribute('href') || '';
      if (/115\.com|115cdn|115vod|\.mp4|\.mkv|play|video/i.test(h)) {
        push('a[href]', h, String(a.className || '').slice(0, 30));
      }
    }
    // 任何带 data-* 里含 url 的元素
    for (const el of doc.querySelectorAll('[data-url], [data-src], [data-href], [data-play]')) {
      for (const a of ['data-url', 'data-src', 'data-href', 'data-play']) {
        const v = el.getAttribute?.(a);
        if (v) push(a, v, String(el.className || '').slice(0, 30));
      }
    }
  }
  // 去重
  const seen = new Set();
  return out.filter((o) => {
    const k = o.kind + '|' + o.url;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * 主探针：一次性输出「建库 + 播放」所需的全部关键信息。
 */function probeLibrary() {
  const items = scanAllFrames().items;
  const cid = currentCid();

  const lines = [];
  lines.push('===== jv115-tagger 建库/播放 可行性探针 =====');
  lines.push(`时间: ${new Date().toISOString()}`);
  lines.push(`URL: ${location.href}`);
  lines.push(`当前目录 cid: ${cid || '(未识别)'}`);
  lines.push(`顶层帧: ${isTopFrameLocal()} | 列表帧: ${isFileListFrameLocal()}`);
  lines.push('');

  lines.push(`--- ① 扫描到的视频条目（${items.length} 个，最多列 10）---`);
  items.slice(0, 10).forEach((it, i) => {
    lines.push(`#${i + 1} name=${it.name}`);
    lines.push(`     key=${it.key} | fileId=${it.fileId || '(无)'} | pickcode=${it.pickcode || '(无)'} | 大小=${it.size || '(无)'}`);
    // 打印该行上所有可能的 id 属性，帮我们判断哪个最稳
    const rowEl = it.rowEl || it.nameEl;
    const found = [];
    for (const el of [it.nameEl, rowEl]) {
      if (!el?.getAttribute) continue;
      for (const a of ['data-id', 'data-file-id', 'data-fid', 'fid', 'data-cid', 'data-key', 'id']) {
        const v = el.getAttribute(a);
        if (v) found.push(`${a}=${String(v).slice(0, 30)}`);
      }
    }
    lines.push(`     行属性: ${found.length ? found.join(' , ') : '(无)'}`);
    lines.push(`     行路径: ${buildPath(rowEl).slice(0, 120)}`);
  });
  const withId = items.filter((it) => it.fileId).length;
  const withPc = items.filter((it) => it.pickcode).length;
  lines.push(`>> 有 fileId 的条目: ${withId}/${items.length}`);
  lines.push(`>> 有 pickcode 的条目: ${withPc}/${items.length}   ← 播放接口能否直达就看这个`);
  lines.push('');

  lines.push('--- ② 页面里的 ID 类属性普查（判断哪个属性最可依赖）---');
  const idInfo = surveyIdAttributes();
  Object.entries(idInfo.hits).forEach(([k, v]) => lines.push(`  ${k}: ${v} 个`));
  lines.push('  样本:');
  idInfo.sample.forEach((s) => lines.push(`    [${s.attr}] <${s.tag}> class="${s.cls}" = ${s.value}`));
  lines.push('');

  lines.push('--- ③ 页面里的播放链接普查（判断能否直接播放）---');
  const links = surveyPlayLinks();
  if (links.length === 0) {
    lines.push('  (没找到任何像播放链接的元素)');
  } else {
    links.forEach((l, i) => lines.push(`  #${i + 1} [${l.kind}] ${l.url}${l.extra ? '  ← ' + l.extra : ''}`));
  }
  lines.push('');

  lines.push('--- ④ 是否存在「播放」按钮/菜单项（文本匹配）---');
  const playWords = ['播放', '打开', '预览', '在线播放'];
  const found = [];
  const docs2 = [document];
  try {
    for (const f of document.querySelectorAll('iframe')) {
      if (f.contentDocument && f.contentDocument.body) docs2.push(f.contentDocument);
    }
  } catch (e) { /* 忽略 */ }
  for (const doc of docs2) {
    for (const el of doc.querySelectorAll('button, a, li, div, span')) {
      const t = (el.textContent || '').trim();
      if (t.length <= 6 && playWords.some((w) => t === w || t.includes(w))) {
        if (found.length < 12) {
          found.push(`<${el.tagName} class="${String(el.className || '').slice(0, 40)}"> "${t}" href=${el.getAttribute?.('href') || '-'}`);
        }
      }
    }
  }
  if (found.length === 0) lines.push('  (没找到播放类按钮)');
  else found.forEach((f) => lines.push(`  ${f}`));
  lines.push('');
  lines.push('===== 探针结束（请把以上全部内容复制回来）=====');

  const text = lines.join('\n');
  console.log(text);
  // 尝试写剪贴板，方便用户粘贴
  try { navigator.clipboard?.writeText(text); } catch (e) { /* 忽略 */ }
  return text;
}

/* ==================================================================
 * 115 官方 webapi 客户端
 * ------------------------------------------------------------------
 * 为什么需要它：
 *   网页版列表每页只渲染 24 条（URL 里的 ?limit=24）。目录大到几十页时，
 *   DOM 扫描永远只能拿到当前页 —— 78 页的目录就只收得到前 24 个。
 *
 *   而 115 自己的 webapi 支持一次拿上千条，并且**直接返回 pickcode**
 *   （播放接口唯一必需的参数）和 fid，正好把「收不全」和
 *   「没有 pickcode 所以播放不了」两个问题一起解决。
 *
 * 接口：GET https://webapi.115.com/files
 *   aid=1  cid=<目录ID>  offset=<偏移>  limit=<每页条数>
 *   show_dir=0/1  o=user_ptime  asc=0  natsort=1  format=json  is_web=1
 *
 * 返回：{ state, errno, count, data: [ { fid, cid, n, s, pc, fc, ico, upt } ] }
 *   n     = 文件名           s   = 字节大小      pc = pickcode（播放必需）
 *   fid   = 文件 ID          fc  = '0' 文件夹 / '1' 文件
 *   count = 该目录条目总数（用于判断有没有拿完）
 *
 * 登录态：完全靠浏览器 cookie —— fetch 用 credentials:'include'，
 *         GM 请求会自带目标域 cookie。不需要任何 token 配置。
 * ================================================================== */

const API_ORIGIN = 'https://webapi.115.com';

/** 单次拉取条数。115 上限约 1150，取 1000 留点安全边际 */
const API_PAGE_SIZE = 1000;

/** 分页安全阀：最多翻多少轮（1000 × 200 = 20 万条） */
const API_MAX_ROUNDS = 200;

/**
 * 取 JSON —— 先 fetch（同源自动带 cookie），失败再退 GM 请求（不受 CORS 限制）。
 * 两条路都失败才抛错，并把各自的错误串起来，便于诊断。
 */
async function apiGetJson(url) {
  let lastErr = null;

  try {
    const res = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json, text/plain, */*' }
    });
    if (res.ok) return JSON.parse(await res.text());
    lastErr = new Error(`fetch HTTP ${res.status}`);
  } catch (e) {
    lastErr = new Error(`fetch 失败：${e.message}`);
  }

  if (typeof GM_xmlhttpRequest === 'function') {
    try {
      const text = await new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'GET',
          url,
          timeout: 25000,
          headers: { Referer: 'https://115.com/', Accept: 'application/json, text/plain, */*' },
          onload: (r) => (r.status >= 200 && r.status < 300
            ? resolve(r.responseText)
            : reject(new Error(`HTTP ${r.status}`))),
          onerror: () => reject(new Error('网络错误')),
          ontimeout: () => reject(new Error('请求超时'))
        });
      });
      return JSON.parse(text);
    } catch (e) {
      lastErr = new Error(`${lastErr ? lastErr.message + '；' : ''}GM 请求失败：${e.message}`);
    }
  }

  throw lastErr || new Error('请求失败');
}

/** 字节数 → 可读大小（和 115 页面上显示的风格一致） */function humanSize(bytes) {
  const b = Number(bytes) || 0;
  if (!b) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let v = b;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const digits = i === 0 ? 0 : (v >= 100 ? 1 : 2);
  return `${v.toFixed(digits)}${units[i]}`;
}

/** 把 webapi 返回的文件对象转成内部统一的 row 结构 */function apiFileToRow(f) {
  const size = Number(f?.s) || 0;
  return {
    name: String(f?.n || ''),
    fileId: f?.fid ? String(f.fid) : null,
    pickcode: f?.pc ? String(f.pc) : null,
    size: humanSize(size),
    sizeRaw: size,
    isDir: String(f?.fc) === '0',
    updatedAt: Number(f?.upt) || 0
  };
}

/** 拉取一页 */
async function apiListPage(cid, offset, limit, showDir) {
  const qs = new URLSearchParams({
    aid: '1',
    cid: String(cid || '0'),
    o: 'user_ptime',
    asc: '0',
    offset: String(offset),
    show_dir: showDir ? '1' : '0',
    limit: String(limit),
    natsort: '1',
    format: 'json',
    is_web: '1',
    fc_mix: '1'
  });
  return apiGetJson(`${API_ORIGIN}/files?${qs}`);
}

/**
 * 拉取整个目录（自动翻页），返回全部条目。
 *
 * @param {string} cid 目录 ID
 * @param {object} opts
 *   onProgress(got, total)  拉取进度回调
 *   includeDirs             是否包含子文件夹（默认 false，只要文件）
 *   maxItems                安全上限
 * @returns {Promise<{rows: object[], total: number}>}
 */async function apiFetchDirAll(cid, { onProgress, includeDirs = false, maxItems = 100000 } = {}) {
  const rows = [];
  let offset = 0;
  let total = null;
  let round = 0;

  while (round++ < API_MAX_ROUNDS) {
    const json = await apiListPage(cid, offset, API_PAGE_SIZE, includeDirs);

    if (!json || typeof json !== 'object') throw new Error('接口返回内容无法解析');
    if (json.state === false) {
      throw new Error(
        json.error || json.msg ||
        '接口返回 state=false（多半是登录态失效，请先刷新 115 页面再试）'
      );
    }

    const list = Array.isArray(json.data) ? json.data : [];

    /*
     * ⚠️ 这里有个坑：接口在有些情况下不返回 count（或缺字段 / 返回 0）。
     *    早期实现写成 total = Number(json.count) || list.length，
     *    于是「第一页 1000 条」被当成总数 → 立刻判定「已拿齐」→
     *    78 页的目录只收到第一页，而且毫无报错。
     *    现在只有 count 是 > 0 的有限数才采信，否则置 null，
     *    改为靠「某一页拿空」来终止循环。
     */
    if (total === null) {
      const c = Number(json.count);
      total = Number.isFinite(c) && c > 0 ? c : null;
    }

    for (const f of list) rows.push(apiFileToRow(f));

    offset += list.length;
    try { onProgress?.(rows.length, total ?? rows.length); } catch (e) { /* 忽略回调异常 */ }

    if (!list.length) break;                        // ① 这一页拿空了 → 到底了
    if (total !== null && rows.length >= total) break; // ② count 明确且已拿齐
    if (rows.length >= maxItems) break;             // ③ 安全阀
  }

  return { rows, total: total === null ? rows.length : total };
}

/**
 * 从 webapi 数据里挑出视频文件。
 *
 * @param {Array} rows apiFileToRow 产出的行
 * @param {{withIndex?: boolean}} opts
 *   withIndex=true 时，给每条附上 `dirIndex` = 它在**整个目录清单里的位置**
 *   （含文件夹）。这个位置只有一个用途：算「跳回目录时该翻到第几页」。
 *   115 网页版列表每页只渲染 24 条，78 页的目录下，目标文件很可能不在第一页 ——
 *   不带上页码，点播放就会「跳回目录但什么都没找到」。
 *   所以取清单时要带 `includeDirs: true`，让顺序和网页看到的顺序一致。
 */function pickVideoRows(rows, opts = {}) {
  const out = [];
  (rows || []).forEach((r, idx) => {
    if (!r || r.isDir || !VIDEO_EXT.test(r.name)) return;
    out.push(opts.withIndex ? { ...r, dirIndex: idx } : r);
  });
  return out;
}

/* ==================================================================
 * 播放触发（必须跑在「列表 frame」内）
 * ------------------------------------------------------------------
 * 目标：让 115 自己打开播放器，而不是我们另起一套播放逻辑。
 *
 * 坑在哪：
 *   1. 115 的点击处理器绑在**行容器**上，不是文件名文本节点。
 *      只对文件名节点派发一次 click 是没反应的。
 *   2. 有些视图要先 hover 让工具栏浮现，播放按钮才存在于 DOM 里。
 *   3. 事件类型不一定只用 click —— 有的实现监听 mousedown/mouseup。
 * 所以这里「逐层向上试 + 先 hover 再找按钮 + 一整套事件序列」。
 * ================================================================== */

const waitMs = (ms) => new Promise((r) => setTimeout(r, ms));

/** 页面上是否装了 115Master（它的播放页路由是 /web/lixian/master/video/） */function detect115Master(doc = document) {
  try {
    const w = doc.defaultView || window;
    if (w.__115MASTER__ || w.__115Master__ || w.__master__) return true;
    if (doc.querySelector('#master-app, .master-app, [data-master]')) return true;
    if (doc.querySelector('x-player, .x-player, video-player')) return true;
    const html = doc.documentElement?.innerHTML || '';
    if (html.includes('lixian/master/video')) return true;
  } catch (e) { /* 跨域或 doc 不可用 */ }
  return false;
}

/** 顶层调用：把顶层和所有同源 iframe 都探一遍 */function detect115MasterAnywhere() {
  if (detect115Master(document)) return true;
  for (const f of Array.from(document.querySelectorAll('iframe'))) {
    try {
      if (f.contentDocument && detect115Master(f.contentDocument)) return true;
    } catch (e) { /* 跨域 iframe，跳过 */ }
  }
  return false;
}

/**
 * 当前地址是不是「115Master 播放页」。
 *
 * ⚠️ 路径是 115Master 注册的虚拟路由，115 后端并不认识它 ——
 *    没装 115Master 时服务器会返回一个近乎空白的壳，脚本也就不可能被注入。
 *    所以这个函数在「没装」的环境下根本不会被调用到（见 probePlayerPage 的说明）。
 */function isMasterPlayerPage(url = location.href) {
  return /lixian\/master\/video/i.test(String(url));
}

/**
 * 播放页上判断「播放器到底起来了没有」。
 *
 * 判据按可靠性从高到低：
 *   ① 出现了 <video> 且带 src / currentSrc（真的挂上了媒体流）
 *   ② 115Master 的播放器容器（x-player / #master-app）已渲染
 *   ③ 页面有可见的播放控件（兜底，防止 115Master 改 class 名）
 *
 * ⚠️ **不能**只看「存在 <video>」——115 的页面骨架里常驻一个空 <video>，
 *    那样永远恒真。必须要求它有真实的 src 或已经 loadedmetadata。
 */function detectPlayerReady(doc = document) {
  try {
    const vids = Array.from(doc.querySelectorAll('video'));
    for (const v of vids) {
      const src = v.currentSrc || v.src || '';
      if (src && !/^about:blank$/i.test(src)) return { ok: true, via: 'video.src' };
      if (v.readyState > 0 && v.videoWidth > 0) return { ok: true, via: 'video.meta' };
      if (v.querySelector('source[src]')) return { ok: true, via: 'video.source' };
    }
    if (doc.querySelector('x-player, .x-player, #master-app, .master-app')) {
      return { ok: true, via: 'master-app' };
    }
    // 兜底：115 自己的播放器控件
    if (doc.querySelector('.vjs-control-bar, .video-player, .dplayer, [class*="player"] video')) {
      return { ok: true, via: 'player-ui' };
    }
  } catch (e) { /* 跨域或 doc 不可用 */ }
  return { ok: false, via: '' };
}

/** 页面整体是不是「几乎空白」（用来判定播放页是不是白屏） */function looksBlank(doc = document) {
  try {
    const body = doc.body;
    if (!body) return true;
    const text = (body.innerText || '').replace(/\s+/g, '');
    // 有实质文本（>40 字）或有多个可见块级元素 → 不算空白
    if (text.length > 40) return false;
    const blocks = body.querySelectorAll('div,section,ul,main,article');
    let visible = 0;
    for (const el of blocks) {
      const r = el.getBoundingClientRect?.();
      if (r && r.width > 200 && r.height > 120) visible++;
      if (visible >= 3) return false;
    }
    return true;
  } catch (e) { return false; }
}

/** 元素的一句话描述（打日志用） */
function elBrief(el) {
  if (!el || !el.tagName) return '(?)';
  let cls = '';
  try {
    const raw = el.className;
    cls = typeof raw === 'string' ? raw : (raw?.baseVal || '');
  } catch (e) { cls = ''; }
  const c = String(cls).split(/\s+/).filter(Boolean).slice(0, 2).join('.');
  return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${c ? '.' + c : ''}`;
}

/** 派发一整套鼠标事件（115 的处理器有的绑 click，有的绑 mousedown/mouseup） */
function fireMouseSeq(el, types) {
  const out = [];
  for (const type of types) {
    try {
      const Ctor = (type.startsWith('pointer') && typeof PointerEvent === 'function')
        ? PointerEvent
        : MouseEvent;
      el.dispatchEvent(new Ctor(type, {
        bubbles: true,
        cancelable: true,
        view: window,
        button: 0,
        buttons: type.endsWith('down') ? 1 : 0
      }));
      out.push(type);
    } catch (e) { /* 某些类型不支持，跳过 */ }
  }
  return out;
}

/** 在（行）容器内找「播放」类按钮 */
function findPlayControl(root) {
  if (!root?.querySelectorAll) return null;
  const sels = [
    '[data-action="play"]',
    '[class*="ico-play"]', '[class*="icon-play"]', '[class*="-play"]',
    '[title*="播放"]', '[aria-label*="播放"]'
  ];
  for (const sel of sels) {
    for (const el of root.querySelectorAll(sel)) {
      const t = (el.textContent || '').trim();
      if (/列表|list|记录/i.test(t)) continue;   // 「播放列表」不是播放动作
      return el;
    }
  }
  return null;
}

/**
 * 粗判「播放器是不是已经起来了」。
 *
 * 为什么不能只看本 frame：115 的播放器可能开在顶层窗口，
 * 也可能开在列表 frame 里；只看 `document` 会误判成失败，
 * 于是继续对页面乱点一通。所以顶层 + 所有同源 iframe 都扫一遍。
 *
 * 判据用「<video> 真的加载了内容」（有 src / currentSrc / readyState>0 /
 * 有一定可见高度），避免把页面里那个常年存在但没显示的空 <video> 骨架
 * 当成「播放成功」。
 */
function looksOpened() {
  const docOpened = (doc) => {
    if (!doc) return false;
    try {
      const vids = doc.querySelectorAll('video');
      for (const v of vids) {
        if (!v) continue;
        if (v.currentSrc || v.src || v.srcObject) return true;
        if (typeof v.readyState === 'number' && v.readyState > 0) return true;
        if (v.videoWidth > 0) return true;
        try {
          if (v.offsetParent && v.clientHeight > 120) return true;
        } catch (e) { /* 忽略 */ }
      }
    } catch (e) { /* 跨域 / 已卸载，忽略 */ }
    return false;
  };

  try { if (docOpened(document)) return true; } catch (e) { /* 忽略 */ }
  try {
    if (window.top && window.top !== window) {
      if (docOpened(window.top.document)) return true;
    }
  } catch (e) { /* 跨域，忽略 */ }
  try {
    for (const f of Array.from(document.querySelectorAll('iframe'))) {
      if (docOpened(f.contentDocument)) return true;
    }
  } catch (e) { /* 忽略 */ }
  return false;
}

/**
 * 在列表 frame 内按文件名找到那一行，并尽力触发 115 自己的「打开/播放」。
 *
 * 关键修复（v1.2.3）：点击从 `clickEl` 开始，而不是 `nameEl`。
 *   `nameEl` 命中的往往是 `<li>`（它带 title），而 115 的打开动作绑在
 *   行内的 `<a class="name" menu="view_file_one">` 上 —— 点 `<li>` 毫无反应。
 *
 * @returns {Promise<{ok:boolean, via?:string, reason?:string, tried:string[], html?:string}>}
 *          ok=false 时 html 会带上该行的 outerHTML，便于把结构发回来定位问题。
 */async function triggerRowOpen(fileName) {
  const items = scanVideoItems(document);
  const hit = items.find((it) => it.name === fileName);
  if (!hit) return { ok: false, reason: 'not-found', tried: [] };

  const start = hit.clickEl || hit.nameEl;

  const tried = [];

  // ⓪ 最优先：点到 115 自己标记了 menu 的元素上（这就是「人手动点」的那一下）
  const menuEl = (() => {
    try {
      if (start?.getAttribute?.('menu')) return start;
      return start?.querySelector?.('[menu]:not([menu=""])') || null;
    } catch (e) { return null; }
  })();

  const clickOnce = async (el, how) => {
    if (!el) return false;
    fireMouseSeq(el, ['pointerover', 'mouseover', 'mousemove']);
    await waitMs(150);
    // 原生 click() 也补一次：和 dispatchEvent 走的是不同代码路径，
    // 有些库只认其中一种
    try { el.click?.(); } catch (e) { /* 忽略 */ }
    fireMouseSeq(el, ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
    tried.push(how);
    await waitMs(450);
    return looksOpened();
  };

  if (menuEl && menuEl !== hit.nameEl && menuEl !== hit.rowEl) {
    if (await clickOnce(menuEl, `click [menu] ${elBrief(menuEl)}`)) {
      return { ok: true, via: 'menu-element', tried };
    }
  }

  // ① 逐层向上兜底：clickEl → 祖先 → 行容器
  const chain = [];
  let n = start;
  for (let i = 0; i < 4 && n; i++) { chain.push(n); n = n.parentElement; }
  if (hit.nameEl && !chain.includes(hit.nameEl)) chain.push(hit.nameEl);
  if (hit.rowEl && !chain.includes(hit.rowEl)) chain.push(hit.rowEl);

  for (const el of chain) {
    // ② 先 hover，给 115 机会把工具栏显示出来
    fireMouseSeq(el, ['pointerover', 'mouseover', 'mousemove']);
    await waitMs(200);

    // ③ 工具栏里若有明确的播放按钮，优先点它
    const btn = findPlayControl(el);
    if (btn && btn !== el && await clickOnce(btn, `${elBrief(el)} → 点播放按钮 ${elBrief(btn)}`)) {
      return { ok: true, via: 'play-button', tried };
    }

    // ④ 点这一层
    if (await clickOnce(el, `${elBrief(el)} → click`)) return { ok: true, via: 'click', tried };

    // ⑤ 补一次双击（115 双击文件 = 打开）
    fireMouseSeq(el, ['dblclick']);
    tried.push(`${elBrief(el)} → dblclick`);
    await waitMs(400);
    if (looksOpened()) return { ok: true, via: 'dblclick', tried };
  }

  return {
    ok: false,
    reason: 'no-effect',
    tried,
    html: String((hit.clickEl || hit.rowEl || hit.nameEl)?.outerHTML || '').slice(0, 4000)
  };
}

/**
 * 只采样不点击：把第一个视频行的结构 + 行内可点元素摘要整理成文本。
 * 用于排查「自动触发播放为什么不生效」。
 */function sampleRowStructure() {
  const items = scanVideoItems(document);
  if (!items.length) {
    return [
      '===== 视频行结构采样 =====',
      `URL: ${location.href}`,
      '顶层帧: ' + (window.top === window.self) + ' | 列表帧: ' + isFileListFrameLocal(),
      '没有扫到任何视频行 —— 请先进入有视频的目录并等列表加载完。'
    ].join('\n');
  }

  const it = items[0];
  const row = it.rowEl || it.nameEl;
  const lines = [];
  lines.push('===== 视频行结构采样 =====');
  lines.push(`时间: ${new Date().toISOString()}`);
  lines.push(`URL: ${location.href}`);
  lines.push(`顶层帧: ${window.top === window.self} | 列表帧: ${isFileListFrameLocal()}`);
  lines.push(`pickcode: ${it.pickcode || '(无)'} | fileId: ${it.fileId || '(无)'} | size: ${it.size || '(无)'}`);
  lines.push(`nameEl: ${elBrief(it.nameEl)} | clickEl: ${elBrief(it.clickEl)} | rowEl: ${elBrief(row)}`);
  lines.push('');
  lines.push('--- ⓪ 行容器上的 115 自定义属性 ---');
  const attrNames = [
    'rel', 'title', 'file_id', 'pick_code', 'file_size', 'file_type', 'file_mode',
    'cid', 'p_id', 'aid', 'area_id', 'ico', 'user_ptime', 'sha1'
  ];
  const found = [];
  for (const a of attrNames) {
    let v = null;
    try { v = row.getAttribute?.(a); } catch (e) { v = null; }
    if (v != null && v !== '') found.push(`${a}=${String(v).slice(0, 40)}`);
  }
  lines.push(found.length ? `  ${found.join('\n  ')}` : '  (该元素上没有 115 的自定义属性 —— 说明 rowEl 认错了)');
  lines.push('');
  lines.push('--- ① 行内所有可点元素（含 a / 带 onclick / cursor:pointer）---');
  let n = 0;
  for (const el of row.querySelectorAll('a, [onclick], [data-action], [class*="ico"], [class*="btn"], [title]')) {
    if (n++ > 25) break;
    const style = (() => { try { return getComputedStyle(el); } catch (e) { return null; } })();
    lines.push(
      `#${n} ${elBrief(el)} | title=${JSON.stringify(el.getAttribute('title') || '')}` +
      ` | onclick=${(el.getAttribute('onclick') || '').slice(0, 60)}` +
      ` | href=${(el.getAttribute('href') || '').slice(0, 80)}` +
      ` | cursor=${style ? style.cursor : '?'}` +
      ` | 文本=${JSON.stringify((el.textContent || '').trim().slice(0, 20))}`
    );
  }
  if (!n) lines.push('(行内没找到可点元素)');
  lines.push('');
  lines.push('--- ② 该行完整 outerHTML（截断 5000 字）---');
  lines.push(String(row.outerHTML || '').slice(0, 5000));
  lines.push('');
  lines.push('--- ③ 文件名节点到行容器的层级链 ---');
  let cur = it.nameEl;
  for (let i = 0; i < 8 && cur; i++) {
    lines.push(`  ${'  '.repeat(i)}${elBrief(cur)}  cursor=${(() => { try { return getComputedStyle(cur).cursor; } catch (e) { return '?'; } })()}`);
    if (cur === row) break;
    cur = cur.parentElement;
  }
  lines.push('');
  lines.push('===== 采样结束（请把以上全部内容复制回来）=====');

  const text = lines.join('\n');
  console.log(text);
  try { navigator.clipboard?.writeText(text); } catch (e) { /* 忽略 */ }
  return text;
}

/** 检测是否有 115 全局的播放/打开函数可调（有时比模拟点击可靠） */function surveyGlobalOpeners() {
  const out = [];
  try {
    const re = /(open|play|view|preview|video)/i;
    for (const k of Object.keys(window)) {
      if (!re.test(k)) continue;
      let t = '';
      try { t = typeof window[k]; } catch (e) { continue; }
      if (t === 'function') out.push(`${k}()`);
    }
  } catch (e) { /* 忽略 */ }
  return out.slice(0, 60);
}

// 挂到全局，方便控制台调用
if (typeof window !== 'undefined') {
  window.__jv115 = Object.assign(window.__jv115 || {}, {
    diagnose,
    diagnoseText,
    inspectPage,
    inspectAllFrames,
    dumpItems,
    dumpFileLikeNodes,
    dumpRawDom,
    scanVideoItems,
    scanAllFrames,
    waitForVideoItems,
    getScanStats,
    isStoragePage,
    probeLibrary,
    // v1.2.2 新增
    apiFetchDirAll,
    pickVideoRows,
    humanSize,
    triggerRowOpen,
    sampleRowStructure,
    surveyGlobalOpeners,
    detect115Master
  });
}


/* ==================================================================
 * core/panel.js
 * ================================================================== */

/**
 * 控制面板
 * ------------------------------------------------------------------
 * 悬浮按钮 + 抽屉式面板，三个页签：
 *   扫描   读取当前目录视频、提取番号、查询元数据、注入标签
 *   设置   DMM key、数据源开关、并发数等
 *   数据   本地库统计、导出/导入、清理
 */


const PANEL_HTML = `
<button class="fab" id="fab" title="JAV 标签助手">标签</button>
<div class="drawer hidden" id="drawer">
  <div class="hd">
    <div>
      <h3>JAV 标签助手</h3>
      <div class="sub" id="hdsub">本地标签库 · 方案 C</div>
    </div>
    <button class="btn sm" id="btnClose">关闭</button>
  </div>

  <div class="tabs">
    <button class="tab active" data-pane="scan">扫描</button>
    <button class="tab" data-pane="library">资料库</button>
    <button class="tab" data-pane="settings">设置</button>
    <button class="tab" data-pane="data">数据</button>
  </div>

  <div class="body">
    <!-- 扫描 -->
    <div class="pane active" id="pane-scan">
      <div class="stat">
        <div class="cell"><div class="k">本页视频</div><div class="v" id="sVideos">0</div></div>
        <div class="cell"><div class="k">已匹配</div><div class="v" id="sMatched">0</div></div>
        <div class="cell"><div class="k">未匹配</div><div class="v" id="sMiss">0</div></div>
      </div>

      <div class="progress"><div class="bar" id="pbar"></div></div>
      <div class="hint" id="scanHint">点击「扫描并打标签」开始。会先查本地库，未命中的才请求数据源。</div>

      <div class="btnrow">
        <button class="btn primary" id="btnHarvest">📥 收录本目录到资料库</button>
        <button class="btn" id="btnHarvestFull">🔄 全量重抓</button>
      </div>
      <div class="hint" style="margin-bottom:6px">
        在 115 里进入某个目录后点「收录」，会把该目录下<b>所有</b>视频（含分页）抓进「资料库」页签。<br>
        <b>增量更新</b>：已收录且标签完好的文件会跳过，不重新请求数据源 —— 目录里新增了视频，
        再点一次即可，只抓新的。
      </div>

      <div class="btnrow">
        <button class="btn" id="btnScan">扫描并打标签</button>
        <button class="btn" id="btnScanAll">强制刷新(忽略缓存)</button>
        <button class="btn" id="btnClearTags">清除本页标签</button>
      </div>
      <div class="btnrow">
        <button class="btn" id="btnDiagnose">🔍 诊断问题</button>
        <button class="btn" id="btnCopyDiag">📋 复制诊断摘要</button>
        <button class="btn" id="btnDumpDom">🧬 DOM 采样</button>
        <button class="btn" id="btnProbeLib">🔬 建库/播放入口探针</button>
        <button class="btn" id="btnSampleRow">🎬 采样视频行结构</button>
      </div>

      <div class="list" id="scanList" style="margin-top:12px"></div>
    </div>

    <!-- 资料库 -->
    <div class="pane" id="pane-library">
      <div class="lib-search">
        <input type="text" class="grow" id="libKw" placeholder="搜索番号 / 标题 / 演员 / 类别…">
        <button class="btn sm" id="btnLibReload">刷新</button>
      </div>

      <div class="hint" id="libStat" style="margin:0 0 10px">资料库为空，先到「扫描」页签点「📥 收录本目录」。</div>

      <div class="dd" id="ddActress">
        <button class="dd-btn" id="ddActressBtn">
          <span class="lab">演员</span>
          <span class="val none" id="ddActressVal">全部</span>
          <span class="arrow">▼</span>
        </button>
        <div class="dd-panel hidden" id="ddActressPanel">
          <input type="text" class="dd-search" id="ddActressSearch" placeholder="搜索演员…">
          <div class="dd-opts" id="ddActressOpts"></div>
          <div class="dd-foot">
            <button data-act="all">全选</button>
            <button data-act="none">清空</button>
            <button data-act="close" class="primary">完成</button>
          </div>
        </div>
      </div>

      <div class="dd" id="ddGenre">
        <button class="dd-btn" id="ddGenreBtn">
          <span class="lab">类别</span>
          <span class="val none" id="ddGenreVal">全部</span>
          <span class="arrow">▼</span>
        </button>
        <div class="dd-panel hidden" id="ddGenrePanel">
          <input type="text" class="dd-search" id="ddGenreSearch" placeholder="搜索类别…">
          <div class="dd-opts" id="ddGenreOpts"></div>
          <div class="dd-foot">
            <button data-act="all">全选</button>
            <button data-act="none">清空</button>
            <button data-act="close" class="primary">完成</button>
          </div>
        </div>
      </div>

      <div class="lib-list" id="libList"></div>

      <div class="btnrow">
        <button class="btn sm" id="btnLibClearFilter">清空筛选条件</button>
        <button class="btn sm" id="btnLibExport">导出资料库</button>
        <button class="btn sm" id="btnPurgeGone">🗑 清理失效条目</button>
      </div>
    </div>

    <!-- 设置 -->
    <div class="pane" id="pane-settings">
      <div class="hint" style="margin-bottom:10px">
        默认使用网页直连抓取，<b>不需要任何 API key</b>。
      </div>

      <div class="row">
        <label class="grow">启用 JavBus（主源）</label>
        <input type="checkbox" id="cfgEnableJavbus" style="width:auto">
      </div>
      <div class="row">
        <label style="width:96px">JavBus 域名</label>
        <input type="text" class="grow" id="cfgJavbusUrl">
      </div>

      <div class="row" style="margin-top:12px">
        <label class="grow">启用 javlibrary（备用）</label>
        <input type="checkbox" id="cfgEnableJavlibrary" style="width:auto">
      </div>
      <div class="row">
        <label style="width:96px">javlibrary 域名</label>
        <input type="text" class="grow" id="cfgJavlibraryUrl">
      </div>

      <div style="border-top:1px solid #eef0f3;margin:14px 0 12px"></div>

      <div class="row">
        <label style="width:96px">并发数</label>
        <input type="number" class="grow" id="cfgConcurrency" min="1" max="8">
      </div>
      <div class="row">
        <label style="width:96px">最低置信度</label>
        <input type="number" class="grow" id="cfgMinConf" min="0" max="99">
      </div>
      <div class="row">
        <label style="width:96px">演员显示数</label>
        <input type="number" class="grow" id="cfgMaxActress" min="0" max="30" placeholder="0 = 全部">
      </div>
      <div class="row">
        <label style="width:96px">类别显示数</label>
        <input type="number" class="grow" id="cfgMaxGenres" min="0" max="30" placeholder="0 = 全部">
      </div>
      <div class="row">
        <label class="grow">优先使用本地缓存</label>
        <input type="checkbox" id="cfgUseCache" style="width:auto">
      </div>
      <div class="row">
        <label class="grow">自动注入标签</label>
        <input type="checkbox" id="cfgAutoInject" style="width:auto">
      </div>
      <div class="row">
        <label class="grow">显示封面缩略图</label>
        <input type="checkbox" id="cfgShowCover" style="width:auto">
      </div>

      <div style="border-top:1px solid #eef0f3;margin:14px 0 12px"></div>
      <div class="hint" style="margin-bottom:8px">DMM 官方 API（可选，不填则不用）</div>
      <div class="row">
        <label style="width:96px">DMM api_id</label>
        <input type="text" class="grow" id="cfgDmmApiId" placeholder="留空即不启用">
      </div>
      <div class="row">
        <label style="width:96px">DMM aff_id</label>
        <input type="text" class="grow" id="cfgDmmAffId" placeholder="留空即不启用">
      </div>

      <div style="border-top:1px solid #eef0f3;margin:14px 0 12px"></div>
      <div class="hint" style="margin-bottom:8px">
        <b>播放方式</b>。决定点资料库里「▶ 播放」时怎么打开。
      </div>
      <div class="row">
        <select class="grow" id="cfgPlayMode">
          <option value="page">直接打开播放页（一步直达，推荐）</option>
          <option value="inpage">回到目录、页面内打开（不依赖任何插件）</option>
        </select>
      </div>

      <div class="hint" style="margin:10px 0 8px">
        <b>播放地址模板</b>。可用变量：<code>{pickcode}</code> <code>{cid}</code>
        <code>{fileId}</code> <code>{name}</code><br>
        默认这条是 <b>115Master 脚本</b>注册的路由 —— 装上它才能一步直达播放。
        <b>没装的话打开会是空白页</b>（脚本会检测出来并给你提示）。<br>
        「回到目录、页面内打开」则完全不依赖插件，但要受 115 网页每页 24 条的分页限制。
      </div>
      <div class="row">
        <input type="text" class="grow" id="cfgPlayerUrl" placeholder="https://115.com/web/lixian/master/video/?pick_code={pickcode}&cid={cid}">
      </div>

      <div class="btnrow">
        <button class="btn primary" id="btnSaveCfg">保存设置</button>
        <button class="btn" id="btnTestSource">测试数据源连通性</button>
      </div>
    </div>

    <!-- 数据 -->
    <div class="pane" id="pane-data">
      <div class="stat">
        <div class="cell"><div class="k">元数据条目</div><div class="v" id="dMeta">0</div></div>
        <div class="cell"><div class="k">资料库条目</div><div class="v" id="dLib">0</div></div>
        <div class="cell"><div class="k">收录目录</div><div class="v" id="dDirs">0</div></div>
      </div>
      <div class="hint" id="dSources" style="margin-bottom:12px"></div>

      <div class="btnrow">
        <button class="btn" id="btnRefreshStats">刷新统计</button>
        <button class="btn" id="btnExport">导出备份 JSON</button>
        <button class="btn" id="btnImport">导入备份</button>
        <button class="btn" id="btnPurge">清理过期缓存</button>
        <button class="btn" id="btnWipe" style="color:#c0322b">清空全部数据</button>
      </div>
      <input type="file" id="fileImport" accept=".json" style="display:none">
      <div class="hint" style="margin-top:10px">
        数据存在浏览器 IndexedDB，清缓存/换浏览器会丢失，请定期导出备份。
      </div>
    </div>
  </div>
</div>
`;

/**
 * 创建面板。
 * @param {object} handlers 回调集合：onScan(force), onClearTags()
 * @returns {object} 面板控制对象
 */
function createPanel(handlers = {}) {
  const shadow = ensureHost();

  const wrap = document.createElement('div');
  wrap.className = 'panel';
  wrap.innerHTML = PANEL_HTML;
  shadow.appendChild(wrap);

  const $ = (sel) => wrap.querySelector(sel);

  /** 面板自身能力的前向引用（在 return 中赋值） */
  const api = {};

  const drawer = $('#drawer');
  const fab = $('#fab');

  /* ---- 开关抽屉 ---- */
  fab.addEventListener('click', () => drawer.classList.toggle('hidden'));
  $('#btnClose').addEventListener('click', () => drawer.classList.add('hidden'));

  /* ---- 页签切换 ---- */
  wrap.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      wrap.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      wrap.querySelectorAll('.pane').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      $(`#pane-${tab.dataset.pane}`).classList.add('active');
      if (tab.dataset.pane === 'data') refreshStats();
      if (tab.dataset.pane === 'settings') loadConfigToForm();
      if (tab.dataset.pane === 'library') loadLibrary();
    });
  });

  /* ---- 扫描 ---- */
  $('#btnHarvest').addEventListener('click', () => handlers.onHarvest?.());
  $('#btnHarvestFull').addEventListener('click', () => handlers.onHarvestFull?.());
  $('#btnScan').addEventListener('click', () => handlers.onScan?.(false));
  $('#btnScanAll').addEventListener('click', () => handlers.onScan?.(true));
  $('#btnClearTags').addEventListener('click', () => handlers.onClearTags?.());

  /* ---- 诊断 ---- */
  $('#btnDiagnose').addEventListener('click', () => {
    const report = handlers.onDiagnose?.();
    if (!report) return;

    // 把诊断结果渲染到列表区
    const rows = [
      { name: `页面: ${report.页面?.host || '?'}`, status: report.页面?.是否115域名 ? 'ok' : 'err', code: report.页面?.是否115域名 ? '115域名' : '非115' },
      { name: `脚本API: GM_xmlhttpRequest`, status: report.脚本环境?.GM_xmlhttpRequest === 'function' ? 'ok' : 'err', code: String(report.脚本环境?.GM_xmlhttpRequest) },
      { name: `面板宿主节点`, status: report.脚本环境?.面板宿主存在 ? 'ok' : 'err', code: report.脚本环境?.面板宿主存在 ? '存在' : '缺失' },
      { name: `页面元素总数`, status: 'ok', code: String(report.扫描结果?.页面元素总数 ?? 0) },
      { name: `像视频的节点数`, status: report.扫描结果?.像视频的节点数 > 0 ? 'ok' : 'miss', code: String(report.扫描结果?.像视频的节点数 ?? 0) },
      { name: `成功收录视频数`, status: report.扫描结果?.成功收录 > 0 ? 'ok' : 'err', code: String(report.扫描结果?.成功收录 ?? 0) },
      { name: `key 策略分布`, status: 'ok', code: JSON.stringify(report.扫描结果?.key策略分布 || {}) }
    ];

    // 附上疑似未通过的文件名后缀
    (report.疑似视频但未通过 || []).slice(0, 8).forEach((r) => {
      rows.push({ name: `未通过: ${r.text}`, status: 'err', code: `.${String(r.cls).slice(0, 20)}` });
    });

    api.renderList(rows);
    api.setHint('诊断完成。详细报告已输出到控制台（F12 查看）。');
    toast('诊断完成，详情见控制台', 'ok');
  });

  /* ---- 一键复制诊断摘要 ---- */
  $('#btnCopyDiag').addEventListener('click', async () => {
    const text = handlers.onDiagnoseText?.();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toast('诊断摘要已复制，直接粘贴发给我即可', 'ok');
    } catch (e) {
      // 剪贴板 API 被拒时降级：输出到控制台并提示手动复制
      console.log(text);
      toast('复制失败（浏览器限制），已输出到控制台，请手动复制', 'err');
    }
    api.setHint('诊断摘要已生成 → 粘贴到对话里发给我即可定位问题');
  });

  /* ---- 建库/播放入口探针 ---- */
  $('#btnProbeLib').addEventListener('click', async () => {
    const text = handlers.onProbeLibrary?.();
    if (!text) {
      api.setHint('探针执行失败，请看控制台');
      return;
    }
    // 顶层把任务转发给了列表 frame → 等它回传（见下面的 setProbeResult）
    if (text === '__PENDING__') {
      toast('已让文件列表执行探针，结果马上回来…');
      api.setHint('探针正在列表 frame 中执行…');
      return;
    }
    console.log(text);
    try {
      await navigator.clipboard.writeText(text);
      toast('探针结果已复制到剪贴板，直接粘贴发我即可', 'ok');
      api.setHint('探针完成 → 结果已复制。把它整段粘贴到对话里。');
    } catch (e) {
      toast('复制失败（浏览器限制），已输出到控制台，请手动复制', 'err');
      api.setHint('探针完成 → 请看控制台（F12）复制结果');
    }
  });

  /* ---- 采样视频行结构（排查「自动触发播放不生效」） ---- */
  $('#btnSampleRow').addEventListener('click', async () => {
    const text = handlers.onSampleRow?.();
    if (!text) {
      api.setHint('采样失败，请看控制台');
      return;
    }
    // 顶层把任务转给了列表 frame → 等它回传（见 setProbeResult）
    if (text === '__PENDING__') {
      toast('已让文件列表执行采样，结果马上回来…');
      api.setHint('采样正在列表 frame 中执行…');
      return;
    }
    console.log(text);
    try {
      await navigator.clipboard.writeText(text);
      toast('视频行结构已复制，直接粘贴发我即可', 'ok');
      api.setHint('采样完成 → 结果已复制。整段粘贴到对话里，我就能精确定位播放入口。');
    } catch (e) {
      toast('复制失败（浏览器限制），已输出到控制台，请手动复制', 'err');
      api.setHint('采样完成 → 请看控制台（F12）复制结果');
    }
  });

  /* ---- DOM 采样 ---- */
  $('#btnDumpDom').addEventListener('click', () => {
    const out = handlers.onDumpDom?.();
    if (!out) {
      api.setHint('DOM 采样失败，请看控制台');
      return;
    }
    const rows = (out.samples || []).slice(0, 12).map((s) => ({
      name: s.text, status: 'miss', code: s.path ? s.path.slice(-30) : ''
    }));
    if (out.hits === 0) {
      rows.unshift({
        name: '页面文本里完全没有视频扩展名', status: 'err', code: '0 命中'
      });
    }
    api.renderList(rows);
    api.setHint(`DOM 采样完成：${out.hits} 个命中，详见控制台`);
    toast(`DOM 采样：${out.hits} 个命中`, out.hits > 0 ? 'ok' : 'err');
  });

  /* ---- 设置读写 ---- */
  async function loadConfigToForm() {
    const cfg = await loadSettings();
    $('#cfgEnableJavbus').checked = cfg.enableJavbus !== false;
    $('#cfgJavbusUrl').value = cfg.javbusBaseUrl || 'https://www.javbus.com';
    $('#cfgEnableJavlibrary').checked = cfg.enableJavlibrary !== false;
    $('#cfgJavlibraryUrl').value = cfg.javlibraryBaseUrl || 'https://www.javlibrary.com';
    $('#cfgConcurrency').value = cfg.concurrency || 3;
    $('#cfgMinConf').value = cfg.minConfidence ?? 60;
    $('#cfgMaxActress').value = cfg.maxActress ?? 0;
    $('#cfgMaxGenres').value = cfg.maxGenres ?? 0;
    $('#cfgUseCache').checked = cfg.useCache !== false;
    $('#cfgAutoInject').checked = cfg.autoInjectColumn !== false;
    $('#cfgShowCover').checked = cfg.showCover === true;
    $('#cfgDmmApiId').value = cfg.dmmApiId || '';
    $('#cfgDmmAffId').value = cfg.dmmAffiliateId || '';
    $('#cfgPlayerUrl').value = cfg.playerUrlTemplate || DEFAULT_PLAYER_URL;
    $('#cfgPlayMode').value = cfg.playMode === 'inpage' ? 'inpage' : 'page';
  }

  $('#btnSaveCfg').addEventListener('click', async () => {
    await setSetting('enableJavbus', $('#cfgEnableJavbus').checked);
    await setSetting('javbusBaseUrl', $('#cfgJavbusUrl').value.trim() || 'https://www.javbus.com');
    await setSetting('enableJavlibrary', $('#cfgEnableJavlibrary').checked);
    await setSetting('javlibraryBaseUrl', $('#cfgJavlibraryUrl').value.trim() || 'https://www.javlibrary.com');
    await setSetting('concurrency', clamp($('#cfgConcurrency').value, 1, 8, 3));
    await setSetting('minConfidence', clamp($('#cfgMinConf').value, 0, 99, 60));
    await setSetting('maxActress', clamp($('#cfgMaxActress').value, 0, 30, 0));
    await setSetting('maxGenres', clamp($('#cfgMaxGenres').value, 0, 30, 0));
    await setSetting('useCache', $('#cfgUseCache').checked);
    await setSetting('autoInjectColumn', $('#cfgAutoInject').checked);
    await setSetting('showCover', $('#cfgShowCover').checked);
    await setSetting('dmmApiId', $('#cfgDmmApiId').value.trim());
    await setSetting('dmmAffiliateId', $('#cfgDmmAffId').value.trim());
    await setSetting('enableDmm', Boolean($('#cfgDmmApiId').value.trim() && $('#cfgDmmAffId').value.trim()));
    const playerUrl = $('#cfgPlayerUrl').value.trim();
    // 模板必须含 {pickcode}，否则播放页拿不到文件 —— 校验一下再存
    if (playerUrl && !playerUrl.includes('{pickcode}')) {
      toast('播放地址模板缺少 {pickcode} 变量，已保留原值', 'err');
    } else {
      await setSetting('playerUrlTemplate', playerUrl || DEFAULT_PLAYER_URL);
    }
    await setSetting('playMode', $('#cfgPlayMode').value === 'inpage' ? 'inpage' : 'page');
    toast('设置已保存', 'ok');
    handlers.onSettingsChanged?.();
  });

  /* ---- 数据源连通性测试 ---- */
  $('#btnTestSource').addEventListener('click', async () => {
    const btn = $('#btnTestSource');
    btn.disabled = true;
    btn.textContent = '测试中…';
    try {
      const r = await handlers.onTestSources?.();
      if (r) {
        const lines = r.map((x) => `${x.name}：${x.ok ? '✅ 可用' : `❌ ${x.msg}`}`).join('　');
        toast(lines, r.every((x) => x.ok) ? 'ok' : 'err');
      }
    } finally {
      btn.disabled = false;
      btn.textContent = '测试数据源连通性';
    }
  });

  /* ---- 数据管理 ---- */
  async function refreshStats() {
    try {
      const s = await getStats();
      const set = (sel, v) => { const el = $(sel); if (el) el.textContent = v; };
      set('#dMeta', s.metaCount);
      set('#dLib', s.libCount);
      set('#dDirs', s.dirCount);
      const src = Object.entries(s.bySource || {})
        .map(([k, v]) => `${k}: ${v}`)
        .join(' · ');
      const parts = [src ? `来源分布 — ${src}` : '本地库为空'];
      if (s.goneCount) parts.push(`其中失效条目 ${s.goneCount} 条（可在资料库页一键清理）`);
      $('#dSources').textContent = parts.join('　|　');
    } catch (e) {
      toast(`统计失败：${e.message}`, 'err');
    }
  }

  $('#btnRefreshStats').addEventListener('click', refreshStats);

  $('#btnExport').addEventListener('click', async () => {
    try {
      const json = await exportAll();
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const ts = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `jv115-tagger-backup-${ts}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast('备份已导出', 'ok');
    } catch (e) {
      toast(`导出失败：${e.message}`, 'err');
    }
  });

  $('#btnImport').addEventListener('click', () => $('#fileImport').click());
  $('#fileImport').addEventListener('change', async (ev) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const r = await importAll(text, { merge: true });
      toast(`已导入 元数据${r.metaCount} / 映射${r.mapCount}`, 'ok');
      refreshStats();
    } catch (e) {
      toast(`导入失败：${e.message}`, 'err');
    }
    ev.target.value = '';
  });

  $('#btnPurge').addEventListener('click', async () => {
    const cfg = await loadSettings();
    const n = await purgeExpired(cfg.cacheTTLDays || 30);
    toast(`已清理 ${n} 条过期缓存`, 'ok');
    refreshStats();
  });

  $('#btnWipe').addEventListener('click', async () => {
    if (!confirm('确定清空本地标签库全部数据？此操作不可恢复，建议先导出备份。')) return;
    await clearAll();
    toast('本地数据已清空', 'ok');
    refreshStats();
  });

  /* ================================================================
   * 资料库页签
   * ----------------------------------------------------------------
   * 数据来自 IndexedDB 的 library 表（由「收录本目录」写入）。
   * 筛选是纯内存过滤：库里通常几百到几千条，直接遍历足够快，
   * 不需要为每个维度建查询计划。
   * ================================================================ */
  const libState = { kw: '', actresses: [], genres: [], rows: [], facets: null };

  /** 重新从库里读一次，并刷新下拉筛选器 + 列表 */
  async function loadLibrary() {
    try {
      libState.facets = await getLibraryFacets();
    } catch (e) {
      toast(`读取资料库失败：${e.message}`, 'err');
      return;
    }
    // 库里可能已经没有某个已选项了（换了目录/清了数据）→ 剔除失效选中项
    const alive = (kind, picked, list) => {
      const names = new Set(list.map((x) => x.name));
      const kept = picked.filter((n) => names.has(n));
      if (kept.length !== picked.length) {
        console.log(`[jv115-tagger] 资料库筛选：${kind} 有 ${picked.length - kept.length} 个已选项已不存在，自动剔除`);
      }
      return kept;
    };
    libState.actresses = alive('演员', libState.actresses, libState.facets.actresses);
    libState.genres = alive('类别', libState.genres, libState.facets.genres);

    refreshDropdowns();
    await applyLibFilter();
  }

  /* ================================================================
   * 下拉多选筛选器
   * ----------------------------------------------------------------
   * 用原生 checkbox + 自定义面板，而不是 <select multiple>：
   * 原生多选在中文环境里操作反人类（要按住 Ctrl），而且没法显示计数。
   *
   * 选项列表只在「打开面板 / facet 变化 / 搜索框输入」时重建；
   * 勾选时**不重建**（否则会丢滚动位置和焦点），只更新按钮上的摘要文字。
   * ================================================================ */
  const DROPDOWNS = {
    actress: {
      picked: () => libState.actresses,
      options: () => libState.facets?.actresses || [],
      el: { root: '#ddActress', btn: '#ddActressBtn', val: '#ddActressVal', panel: '#ddActressPanel', search: '#ddActressSearch', opts: '#ddActressOpts' }
    },
    genre: {
      picked: () => libState.genres,
      options: () => libState.facets?.genres || [],
      el: { root: '#ddGenre', btn: '#ddGenreBtn', val: '#ddGenreVal', panel: '#ddGenrePanel', search: '#ddGenreSearch', opts: '#ddGenreOpts' }
    }
  };

  /** 按钮上的摘要：「全部」/「已选 N 项」/ 具体名字（≤2 项时直接列出来） */
  function updateDdLabel(kind) {
    const cfg = DROPDOWNS[kind];
    const picked = cfg.picked();
    const valEl = $(cfg.el.val);
    if (!picked.length) {
      valEl.textContent = '全部';
      valEl.classList.add('none');
    } else if (picked.length <= 2) {
      valEl.textContent = picked.join('、');
      valEl.classList.remove('none');
    } else {
      valEl.textContent = `已选 ${picked.length} 项`;
      valEl.classList.remove('none');
    }
  }

  /** 重建选项列表（尊重搜索框关键词，已选项始终置顶） */
  function renderDdOptions(kind) {
    const cfg = DROPDOWNS[kind];
    const picked = cfg.picked();
    const kw = String($(cfg.el.search).value || '').trim().toLowerCase();

    let list = cfg.options();
    if (kw) list = list.filter((o) => o.name.toLowerCase().includes(kw));
    // 已选中的排前面，方便连续操作
    list = list.slice().sort((a, b) => {
      const pa = picked.includes(a.name) ? 0 : 1;
      const pb = picked.includes(b.name) ? 0 : 1;
      return pa - pb || b.count - a.count;
    });

    const optsEl = $(cfg.el.opts);
    if (!list.length) {
      optsEl.innerHTML = '<div class="dd-opt-none">没有匹配项</div>';
      return;
    }
    optsEl.innerHTML = list.map((o) => {
      const on = picked.includes(o.name);
      return `<label class="dd-opt">
        <input type="checkbox" data-name="${escapeHtml(o.name)}"${on ? ' checked' : ''}>
        <span class="nm">${escapeHtml(o.name)}</span>
        <span class="n">${o.count}</span>
      </label>`;
    }).join('');
  }

  /** 全部刷新（facet 数据变了之后调用） */
  function refreshDropdowns() {
    for (const kind of Object.keys(DROPDOWNS)) {
      updateDdLabel(kind);
      const cfg = DROPDOWNS[kind];
      if (!$(cfg.el.panel).classList.contains('hidden')) renderDdOptions(kind);
    }
  }

  function openDd(kind) {
    // 同时只允许一个下拉展开
    for (const k of Object.keys(DROPDOWNS)) {
      const cfg = DROPDOWNS[k];
      const open = k === kind;
      $(cfg.el.panel).classList.toggle('hidden', !open);
      $(cfg.el.root).classList.toggle('open', open);
      if (open) {
        $(cfg.el.search).value = '';
        renderDdOptions(k);
      }
    }
  }

  function closeAllDd() {
    for (const cfg of Object.values(DROPDOWNS)) {
      $(cfg.el.panel).classList.add('hidden');
      $(cfg.el.root).classList.remove('open');
    }
  }

  for (const kind of Object.keys(DROPDOWNS)) {
    const cfg = DROPDOWNS[kind];

    // 点按钮：展开/收起
    $(cfg.el.btn).addEventListener('click', (ev) => {
      ev.stopPropagation();
      const isOpen = !$(cfg.el.panel).classList.contains('hidden');
      if (isOpen) closeAllDd(); else openDd(kind);
    });

    // 面板内点击不冒泡（否则会被「点空白处关闭」的逻辑吃掉）
    $(cfg.el.panel).addEventListener('click', (ev) => ev.stopPropagation());

    // 搜索框
    $(cfg.el.search).addEventListener('input', () => renderDdOptions(kind));

    // 勾选（事件委托）
    $(cfg.el.opts).addEventListener('change', (ev) => {
      const cb = ev.target;
      if (cb?.type !== 'checkbox') return;
      const name = cb.dataset.name;
      const arr = cfg.picked();
      const i = arr.indexOf(name);
      if (cb.checked && i < 0) arr.push(name);
      else if (!cb.checked && i >= 0) arr.splice(i, 1);
      updateDdLabel(kind);
      applyLibFilter();
    });

    // 底部按钮
    $(cfg.el.panel).querySelectorAll('.dd-foot button').forEach((b) => {
      b.addEventListener('click', () => {
        const act = b.dataset.act;
        if (act === 'close') { closeAllDd(); return; }
        const arr = cfg.picked();
        arr.length = 0;
        if (act === 'all') {
          // 「全选」= 选中当前搜索条件下的全部，而不是无条件全选
          const kw = String($(cfg.el.search).value || '').trim().toLowerCase();
          cfg.options()
            .filter((o) => !kw || o.name.toLowerCase().includes(kw))
            .forEach((o) => arr.push(o.name));
        }
        updateDdLabel(kind);
        renderDdOptions(kind);
        applyLibFilter();
      });
    });
  }

  // 点面板其它地方 → 收起所有下拉
  $('#pane-library').addEventListener('click', () => closeAllDd());

  function renderLibList(rows) {
    const list = $('#libList');
    if (!rows.length) {
      list.innerHTML = '<div class="lib-empty">没有匹配的条目</div>';
      return;
    }
    list.innerHTML = rows.slice(0, 300).map((r) => {
      const acts = (r.actresses || []).join('、');
      const gens = (r.genres || []).join('、');
      const tagLine = [acts ? `<b>${escapeHtml(acts)}</b>` : '', gens ? escapeHtml(gens) : '']
        .filter(Boolean)
        .join(' · ') || (r.matched ? '（无演员/类别信息）' : '未获取到标签');
      /*
       * 缺 pickcode 的记录开不了播放页（播放地址里 pick_code 是必填项）——
       * 直接在列表里标出来，省得用户点一次被拒一次。
       */
      let badge = '';
      if (r.gone) badge = '<span class="badge bad">已失效</span>';
      else if (!r.pickcode) badge = '<span class="badge warn">缺提取码</span>';

      const playTitle = r.pickcode
        ? '在新标签页打开播放页'
        : '这条记录没有提取码，点「收录本目录」补全后才能直接播放';

      return `<div class="lib-item" data-id="${escapeHtml(r.id)}">
        <div class="mid">
          <div class="code">${escapeHtml(r.code || '—')}${badge}</div>
          <div class="ttl" title="${escapeHtml(r.title || r.fileName)}">${escapeHtml(r.title || r.fileName)}</div>
          <div class="tags">${tagLine}</div>
        </div>
        <div class="act">
          <button class="btn sm primary" data-act="play" title="${escapeHtml(playTitle)}">▶ 播放</button>
          <button class="btn sm" data-act="del">移除</button>
        </div>
      </div>`;
    }).join('');
  }

  async function applyLibFilter() {
    let rows;
    try {
      rows = await queryLibrary({
        keyword: libState.kw,
        actresses: libState.actresses,
        genres: libState.genres
      });
    } catch (e) {
      toast(`筛选失败：${e.message}`, 'err');
      return;
    }
    libState.rows = rows;
    const total = libState.facets ? libState.facets.total : rows.length;
    const gone = libState.facets ? (libState.facets.gone || 0) : 0;
    const tagged = rows.filter((r) => r.matched).length;
    // 缺提取码 = 点「播放」也开不了播放页的那批（收录一次即可补全）
    const noPc = rows.filter((r) => !r.pickcode && !r.gone).length;
    const filtered = rows.length !== total;
    $('#libStat').innerHTML =
      `资料库共 <b>${total}</b> 条` +
      (filtered ? ` · 当前筛选命中 <b style="color:#2b5cff">${rows.length}</b> 条` : '') +
      ` · 其中 ${tagged} 条有标签` +
      (noPc ? ` · <span style="color:#a06a00">缺提取码 ${noPc} 条</span>` : '') +
      (gone ? ` · <span style="color:#c0322b">已失效 ${gone} 条</span>` : '');
    const pg = $('#btnPurgeGone');
    if (pg) {
      pg.disabled = !gone;
      pg.textContent = gone ? `🗑 清理失效条目 (${gone})` : '🗑 清理失效条目';
    }
    renderLibList(rows);
  }

  /* ---- 资料库交互 ---- */

  let libKwTimer = null;
  $('#libKw').addEventListener('input', (ev) => {
    libState.kw = ev.target.value;
    clearTimeout(libKwTimer);
    libKwTimer = setTimeout(applyLibFilter, 180);
  });

  $('#btnLibReload').addEventListener('click', loadLibrary);

  $('#btnPurgeGone').addEventListener('click', async () => {
    const n = await handlers.onPurgeGone?.();
    if (n) await loadLibrary();
  });

  $('#btnLibClearFilter').addEventListener('click', () => {
    libState.kw = '';
    libState.actresses = [];
    libState.genres = [];
    $('#libKw').value = '';
    refreshDropdowns();
    applyLibFilter();
  });

  // 列表内「播放 / 移除」
  $('#libList').addEventListener('click', async (ev) => {
    const btn = ev.target.closest?.('button[data-act]');
    if (!btn) return;
    const itemEl = btn.closest('.lib-item');
    const id = itemEl?.dataset.id;
    const row = libState.rows.find((r) => r.id === id);
    if (!row) return;

    if (btn.dataset.act === 'play') {
      handlers.onPlay?.(row);
    } else if (btn.dataset.act === 'del') {
      await deleteLibrary(id);
      toast(`已移除 ${row.code || row.fileName}`, 'ok');
      await loadLibrary();
    }
  });

  $('#btnLibExport').addEventListener('click', async () => {
    const rows = await queryLibrary({});
    if (!rows.length) { toast('资料库还是空的', 'err'); return; }
    const blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `jv115-library-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    toast(`已导出 ${rows.length} 条`, 'ok');
  });

  /* ---- 对外接口 ---- */
  Object.assign(api, {
    setBusy(busy, text) {
      fab.classList.toggle('busy', busy);
      fab.textContent = busy ? '处理中' : '标签';
      $('#btnScan').disabled = busy;
      $('#btnScanAll').disabled = busy;
      $('#btnHarvest').disabled = busy;
      $('#btnHarvestFull').disabled = busy;
      if (text) $('#scanHint').textContent = text;
    },
    setProgress(done, total) {
      const pct = total ? Math.round((done / total) * 100) : 0;
      $('#pbar').style.width = `${pct}%`;
    },
    setStats({ videos, matched, miss }) {
      if (videos != null) $('#sVideos').textContent = videos;
      if (matched != null) $('#sMatched').textContent = matched;
      if (miss != null) $('#sMiss').textContent = miss;
    },
    setHint(text) {
      $('#scanHint').textContent = text;
    },
    renderList(rows) {
      const list = $('#scanList');
      if (!rows || rows.length === 0) {
        list.innerHTML = '<div class="empty">暂无数据</div>';
        return;
      }
      list.innerHTML = rows
        .slice(0, 200)
        .map((r) => {
          const cls = r.status === 'ok' ? 'ok' : r.status === 'miss' ? 'miss' : 'err';
          const badge = r.code || (r.status === 'ok' ? '成功' : r.status === 'miss' ? '未匹配' : '错误');
          return `<div class="item">
            <span class="fn" title="${escapeHtml(r.name)}">${escapeHtml(r.name)}</span>
            <span class="badge ${cls}">${escapeHtml(String(badge))}</span>
          </div>`;
        })
        .join('');
    },
    refreshStats,
    /** 收录完成后刷新资料库页签（若当前正打开着） */
    async refreshLibrary() {
      if ($('#pane-library').classList.contains('active')) await loadLibrary();
    },
    /** 切到资料库页签（收录完成后自动带用户过去看结果） */
    async showLibrary() {
      wrap.querySelectorAll('.tab').forEach((t) =>
        t.classList.toggle('active', t.dataset.pane === 'library'));
      wrap.querySelectorAll('.pane').forEach((p) =>
        p.classList.toggle('active', p.id === 'pane-library'));
      await loadLibrary();
    },
    /**
     * 接收「由列表 frame 回传」的探针结果文本。
     * 探针必须在真正渲染文件列表的那一侧执行（顶层 DOM 抓到的全是导航区），
     * 所以结果通过 postMessage 回到顶层后，由这里统一落盘（写剪贴板 + 提示）。
     */
    async setProbeResult(text) {
      if (!text) {
        toast('探针返回空结果', 'err');
        api.setHint('探针返回空结果，请打开控制台看是否有报错。');
        return;
      }
      console.log(text);
      try {
        await navigator.clipboard.writeText(text);
        toast('探针结果已复制到剪贴板，直接粘贴发我即可', 'ok');
        api.setHint('探针完成（列表 frame）→ 结果已复制。把它整段粘贴到对话里。');
      } catch (e) {
        toast('复制失败（浏览器限制），已输出到控制台，请手动复制', 'err');
        api.setHint('探针完成 → 结果在控制台（F12），请手动整段复制。');
      }
    },
    open() {
      drawer.classList.remove('hidden');
    }
  });

  return api;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/** 数值钳制 */
function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}


/* ==================================================================
 * main.js
 * ================================================================== */

/**
 * 主入口
 * ------------------------------------------------------------------
 * 串联：页面适配 -> 番号提取 -> 数据源查询 -> 本地存储 -> UI 渲染
 *
 * 数据源全部走浏览器直连（GM_xmlhttpRequest），不需要任何 API key。
 * 抓取失败时提供手动搜索链接兜底。
 */



// 注意：不再 import renderTagPill —— 蓝点/悬停方案已弃用，
// 标签统一展示在面板的「资料库」页签里。
// clearTagPills 保留，用于清除历史版本残留在页面上的旧标记。




/** 失败原因枚举，用于给出精确提示 */
const FAIL = {
  NO_DOM: 'no_dom',
  NO_VIDEO: 'no_video',
  NO_CODE: 'no_code',
  NO_SOURCE: 'no_source',
  ALL_BLOCKED: 'all_blocked',
  ALL_MISS: 'all_miss',
  ERROR: 'error'
};

/** 把失败原因转成给用户看的提示 */
function failMessage(reason, ctx = {}) {
  switch (reason) {
    case FAIL.NO_DOM:
      return '❌ 页面还没加载完，请等文件列表出现后再点一次';
    case FAIL.NO_VIDEO:
      return `❌ 没找到视频文件（扫描了 ${ctx.totalElements || 0} 个元素，` +
        `${ctx.videoLike || 0} 个像视频）${ctx.extra || ''}。` +
        `请点「📋 复制诊断摘要」发给我`;
    case FAIL.NO_CODE:
      return `❌ 找到 ${ctx.videoCount || 0} 个视频，但文件名里没有可识别的番号。` +
        `请确认文件名格式（如 ABC-123.mp4）`;
    case FAIL.NO_SOURCE:
      return '❌ 没有启用任何数据源，请到「设置」页开启 JavBus 或 javlibrary';
    case FAIL.ALL_BLOCKED:
      return `❌ ${ctx.blocked} 抓取被拦截。请先在浏览器标签页打开该站点完成 Cloudflare 验证，再回来重试`;
    case FAIL.ALL_MISS:
      return `⚠️ 查询了 ${ctx.codeCount} 个番号，全部未找到。可能是番号识别错误，或数据源里没有收录`;
    default:
      return `❌ 出错了：${ctx.error || '未知错误'}`;
  }
}

/** 渲染失败面板内容到扫描列表区 */
function renderFailure(panel, reason, ctx = {}) {
  const msg = failMessage(reason, ctx);
  panel.setBusy(false, msg);
  panel.setHint(msg + '　（按 F12 执行 __jv115.diagnose() 可查看详细诊断）');

  const rows = ctx.rows || [];
  if (rows.length) {
    panel.renderList(rows);
  } else {
    // 没数据时给一个明确的操作指引
    panel.renderList([{ name: '点击右下角「标签」→ 设置 → 测试数据源连通性', status: 'miss', code: '参考' }]);
  }

  // 关键失败用红色 toast
  const isError = [FAIL.NO_DOM, FAIL.NO_VIDEO, FAIL.NO_SOURCE, FAIL.ALL_BLOCKED, FAIL.ERROR].includes(reason);
  toast(msg.replace(/^[❌⚠️]\s*/, ''), isError ? 'err' : '');
  console.warn('[jv115-tagger] 失败原因:', reason, ctx);
}

let panel = null;
let resolver = null;
let settings = null;
let stopObserve = null;

/** 根据设置构建 Provider 链（顺序即优先级） */
function buildResolver(cfg) {
  const providers = [];
  if (cfg.enableJavbus !== false) {
    providers.push(new JavbusProvider({
      javbusBaseUrl: cfg.javbusBaseUrl,
      enableJavbus: true
    }));
  }
  if (cfg.enableJavlibrary !== false) {
    providers.push(new JavlibraryProvider({
      javlibraryBaseUrl: cfg.javlibraryBaseUrl,
      javlibraryLang: cfg.javlibraryLang || 'cn',
      enableJavlibrary: true
    }));
  }
  if (cfg.enableDmm && cfg.dmmApiId && cfg.dmmAffiliateId) {
    providers.push(new DmmProvider({
      dmmApiId: cfg.dmmApiId,
      dmmAffiliateId: cfg.dmmAffiliateId,
      enableDmm: true
    }));
  }
  return new MetaResolver(providers, cfg.useCache !== false ? metaCache : null);
}

/**
 * 兜底判定：当前 frame 是否含视频文件名。
 * 有些列表 frame 的 URL 可能不含 ct=file（嵌套更深），
 * 用实际内容判定更可靠。
 */
function frameHasVideo() {
  try {
    return scanVideoItems(document).length > 0;
  } catch (e) {
    return false;
  }
}

/** 扫描当前页视频并抓取元数据（结果只进本地库与面板，不再往页面注入标记） */
async function scanAndTag(force = false) {
  if (!panel) return;

  try {
    panel.setBusy(true, '正在初始化…');

    // ---------- 阶段 0：环境与配置检查 ----------
    settings = await loadSettings();
    resolver = buildResolver(settings);

    if (resolver.providers.length === 0) {
      renderFailure(panel, FAIL.NO_SOURCE);
      panel.open();
      return;
    }

    // ---------- 阶段 1：页面 DOM 检查 ----------
    if (document.readyState === 'loading') {
      renderFailure(panel, FAIL.NO_DOM);
      return;
    }

    panel.setHint('正在扫描页面文件…（含 iframe）');
    let items = scanAllFrames().items;
    let stats = getScanStats();

    // 首次扫不到 → 可能是 SPA 还在渲染，等待并重试
    if (items.length === 0) {
      panel.setHint('首次未扫到文件，正在等待列表渲染…（最多 8 秒）');
      const waited = await waitForVideoItems(8000, 400);
      if (waited.items.length > 0) {
        items = waited.items;
        stats = getScanStats();
        panel.setHint(`等待 ${Math.round(waited.waited / 1000)} 秒后扫到 ${items.length} 个视频`);
      }
    }

    console.log('[jv115-tagger] 扫描统计', stats, '跨frame收录:', items.length);

    if (items.length === 0) {
      // 顶层扫不到 → 让子 frame（列表 frame）自己去扫
      const frameScan = scanAllFrames();
      const listFrames = frameScan.frames.filter((f) => !f.self);

      if (listFrames.length > 0) {
        panel.setHint(`顶层无文件，已向 ${listFrames.length} 个子 frame 广播扫描指令…`);
        broadcast('scan', { force });
        // 结果会通过 postMessage 回报（done / stats / need-query）
        // 设一个兜底超时，避免一直转圈
        setTimeout(() => {
          panel.setBusy(false, '扫描指令已发送。若标签未出现，请点「📋 复制诊断摘要」发我');
        }, 3000);
        return;
      }

      // 连子 frame 都没有 → 做框架体检给出结论
      let extra = '';
      try {
        const ins = inspectPage();
        const containers = ins.可能的列表容器 || [];
        if (containers.length === 0) {
          extra = '；页面里没有任何「列表容器」，说明文件列表没有渲染出来';
        } else {
          extra = `；发现 ${containers.length} 个疑似列表容器（最大 ${containers[0].childCount} 项），但内容不含视频扩展名`;
        }
      } catch (e) { /* 忽略 */ }

      renderFailure(panel, FAIL.NO_VIDEO, {
        totalElements: stats.totalElements,
        videoLike: stats.videoLike,
        extra,
        rows: stats.rejected?.slice(0, 10).map((r) => ({
          name: r.text, status: 'err', code: '未通过'
        })) || []
      });
      return;
    }

    panel.setBusy(true, `检测到 ${items.length} 个视频，开始处理…`);
    panel.setStats({ videos: items.length, matched: 0, miss: 0 });

    const minConf = settings.minConfidence ?? 60;

    // ---------- 阶段 2：番号提取 ----------
    const parsed = items.map((it) => ({ item: it, ex: extractCode(it.name) }));
    const valid = parsed.filter((p) => p.ex && p.ex.confidence >= minConf);
    const lowConf = parsed.filter((p) => p.ex && p.ex.confidence < minConf);
    const noCode = parsed.filter((p) => !p.ex);

    panel.setHint(`番号提取：识别 ${valid.length} / 低置信 ${lowConf.length} / 无番号 ${noCode.length}`);

    // 全部没有番号 → 明确失败
    if (valid.length === 0) {
      renderFailure(panel, FAIL.NO_CODE, {
        videoCount: items.length,
        rows: parsed.slice(0, 30).map(({ item, ex }) => ({
          name: item.name,
          status: 'miss',
          code: ex ? `${ex.code} 低置信(${ex.confidence})` : '无番号'
        }))
      });
      return;
    }

    // ---------- 阶段 3：查询元数据 ----------
    const codes = [...new Set(valid.map((p) => p.ex.code))];
    const resultMap = new Map();
    let done = 0;

    await resolver.resolveBatch(codes, {
      concurrency: settings.concurrency || 3,
      force,
      onProgress: ({ code, meta }) => {
        done++;
        panel.setProgress(done, codes.length);
        resultMap.set(code, meta);
        const tag = meta?.notFound ? '未找到' : `✓ ${meta?.source || ''}`;
        panel.setHint(`查询中 ${done}/${codes.length} — ${code} ${tag}`);
      }
    });

    // ---------- 阶段 4：落库 ----------
    // 注意：这里不再往 115 列表里注入任何标记（去掉了蓝点方案），
    // 结果统一进「资料库」页签展示。
    let matched = 0;
    let miss = 0;
    const rows = [];
    const mapRecords = [];
    const metaRecords = [];

    parsed.forEach(({ item, ex }) => {
      if (!ex || ex.confidence < minConf) {
        rows.push({ name: item.name, status: 'miss', code: ex ? `${ex.code} 低置信` : '无番号' });
        miss++;
        return;
      }

      const meta = resultMap.get(ex.code);
      if (meta && !meta.notFound) {
        matched++;
        rows.push({ name: item.name, status: 'ok', code: ex.code });
        mapRecords.push({ fileId: item.key, code: ex.code, fileName: item.name, confidence: ex.confidence });
        metaRecords.push(meta);
      } else {
        miss++;
        rows.push({ name: item.name, status: 'miss', code: ex.code });
      }
    });

    try {
      if (mapRecords.length) await putFileMapBatch(mapRecords);
      if (metaRecords.length) await putMetaBatch(metaRecords);
    } catch (e) {
      console.warn('[jv115] 落库失败', e);
    }

    // ---------- 阶段 5：结果判定 ----------
    const blocked = [...new Set(resolver.blockedHints.map((h) => h.provider))];

    panel.setStats({ videos: items.length, matched, miss });
    panel.renderList(rows);

    if (matched > 0) {
      panel.setBusy(false, `✅ 完成：成功匹配 ${matched} 个（未匹配 ${miss}，共 ${items.length}）`);
      toast(`处理完成 — 匹配 ${matched} 个`, 'ok');
    } else if (blocked.length) {
      renderFailure(panel, FAIL.ALL_BLOCKED, { blocked: blocked.join('、'), rows });
    } else {
      renderFailure(panel, FAIL.ALL_MISS, { codeCount: codes.length, rows });
    }
  } catch (e) {
    console.error('[jv115-tagger] 扫描异常:', e);
    renderFailure(panel, FAIL.ERROR, { error: e.message });
  }
}

/** 只用本地缓存渲染（不请求网络），用于列表变动时快速重绘 */
async function renderFromCacheOnly() {
  // 列表 frame 里跑 → 扫本 frame 的 document；
  // 顶层跑 → 扫所有同源 frame（覆盖两种调用场景）
  const items = isTopFrame() ? scanAllFrames().items : scanVideoItems(document);
  let hit = 0;
  for (const item of items) {
    const ex = extractCode(item.name);
    if (!ex) continue;
    const meta = await getMeta(ex.code);
    if (meta) {
      hit++;
    }
  }
  return { total: items.length, hit };
}

/** 测试各数据源连通性 */
async function testSources() {
  const cfg = await loadSettings();
  const testCode = 'SSNI-730';
  const out = [];

  if (cfg.enableJavbus !== false) {
    out.push(await probe('JavBus', () => new JavbusProvider({
      javbusBaseUrl: cfg.javbusBaseUrl, enableJavbus: true
    }), testCode));
  }
  if (cfg.enableJavlibrary !== false) {
    out.push(await probe('javlibrary', () => new JavlibraryProvider({
      javlibraryBaseUrl: cfg.javlibraryBaseUrl,
      javlibraryLang: cfg.javlibraryLang || 'cn',
      enableJavlibrary: true
    }), testCode));
  }
  if (cfg.enableDmm && cfg.dmmApiId && cfg.dmmAffiliateId) {
    out.push(await probe('DMM', () => new DmmProvider({
      dmmApiId: cfg.dmmApiId, dmmAffiliateId: cfg.dmmAffiliateId, enableDmm: true
    }), testCode));
  }

  if (out.length === 0) out.push({ name: '—', ok: false, msg: '没有启用任何数据源' });
  return out;
}

/** 单个数据源探测：能拿到结果或至少能正常访问即算通过 */
async function probe(name, factory, code) {
  try {
    const p = factory();
    const meta = await p.search(code);
    if (meta && meta.title) return { name, ok: true, msg: '可用' };
    if (meta) return { name, ok: true, msg: '可访问(该测试番号无数据)' };
    return { name, ok: false, msg: '可访问但未找到测试番号' };
  } catch (e) {
    if (e.code === 'BLOCKED') return { name, ok: false, msg: '被拦截，请先手动打开该站点' };
    return { name, ok: false, msg: e.message };
  }
}

/**
 * 顶部窗口专用：请求指定番号的元数据、写入缓存，然后通知列表 frame 重绘。
 *
 * 为什么放在顶层：数据源请求只需要做一次，不该在每个 frame 里重复。
 */
async function queryAndCache(codes, force = false) {
  if (!panel) return;
  const uniq = [...new Set(codes)].filter(Boolean);
  if (uniq.length === 0) return;

  try {
    settings = await loadSettings();
    resolver = buildResolver(settings);

    if (resolver.providers.length === 0) {
      renderFailure(panel, FAIL.NO_SOURCE);
      panel.open();
      return;
    }

    panel.setBusy(true, `正在查询 ${uniq.length} 个番号…`);
    panel.setProgress(0, uniq.length);

    const metaRecords = [];
    let done = 0;

    await resolver.resolveBatch(uniq, {
      concurrency: settings.concurrency || 3,
      force,
      onProgress: ({ code, meta }) => {
        done++;
        panel.setProgress(done, uniq.length);
        const tag = meta?.notFound ? '未找到' : `✓ ${meta?.source || ''}`;
        panel.setHint(`查询中 ${done}/${uniq.length} — ${code} ${tag}`);
        if (meta && !meta.notFound) metaRecords.push(meta);
      }
    });

    if (metaRecords.length) {
      try { await putMetaBatch(metaRecords); } catch (e) { console.warn('[jv115] 落库失败', e); }
    }

    // 通知列表 frame 用刚写入的缓存重绘
    broadcast('render-cache');

    const blocked = [...new Set(resolver.blockedHints.map((h) => h.provider))];
    const hit = metaRecords.length;

    if (hit > 0) {
      panel.setBusy(false, `✅ 查询完成：${hit}/${uniq.length} 个命中，标签已渲染到列表`);
      toast(`匹配到 ${hit} 个影片信息`, 'ok');
    } else if (blocked.length) {
      renderFailure(panel, FAIL.ALL_BLOCKED, { blocked: blocked.join('、') });
    } else {
      renderFailure(panel, FAIL.ALL_MISS, { codeCount: uniq.length });
    }
  } catch (e) {
    console.error('[jv115-tagger] 查询异常:', e);
    renderFailure(panel, FAIL.ERROR, { error: e.message });
  }
}

/** 启动 */
async function bootstrap() {
  const role = {
    isTop: isTopFrame(),
    isListFrameByUrl: isFileListFrame(),
    href: location.href
  };
  // 兜底：URL 不像列表 frame，但内容里有视频 → 也当列表 frame
  const isListFrame = role.isListFrameByUrl || (!role.isTop && frameHasVideo());

  console.log('%c[jv115-tagger] 脚本已注入', 'color:#2b5cff;font-weight:bold', {
    ...role,
    isListFrame,
    readyState: document.readyState
  });

  if (!isStoragePage()) {
    console.warn('[jv115-tagger] 当前页面不是 115 域名，跳过挂载', location.hostname);
    return;
  }

  /*
   * 当前打开的就是「播放页」（115Master 注册的虚拟路由）时，
   * 本页只做一件事：自检播放器到底起没起来，把结果写进 localStorage 供列表页复用。
   * 不挂控制面板 —— 播放页上挂面板没意义，还挡视线。
   */
  if (isMasterPlayerPage()) {
    probePlayerPage();
    return;
  }

  try {
    settings = await loadSettings();
    resolver = buildResolver(settings);
    console.log('[jv115-tagger] 数据源:', resolver.providers.map((p) => p.name));

    // ============================================================
    // 角色 A：文件列表 frame（115 把列表渲染在 iframe 里）
    //   职责：扫描本 frame 的视频 + 渲染标签 + 响应顶层广播
    // ============================================================
    if (isListFrame) {
      console.log('%c[jv115-tagger] 识别为「文件列表 frame」，本 frame 负责扫描与渲染标签',
        'color:#1a7f45;font-weight:bold');

      // 响应顶层广播的指令
      onBroadcast(async (type, payload) => {
        console.log('[jv115-tagger][list-frame] 收到指令:', type);
        if (type === 'scan') {
          await listFrameScan(payload.force === true);
        } else if (type === 'clear') {
          clearTagPills();
        } else if (type === 'render-cache') {
          await renderFromCacheOnly();
        } else if (type === 'probe-library') {
          // 在本 frame（真正能看到文件列表的一侧）跑探针，结果回传顶层
          runProbeAndReport();
        } else if (type === 'harvest') {
          // 顶层点了「收录本目录」→ 本 frame 扫描并回报文件清单
          harvestLocalDir();
        } else if (type === 'sample-row') {
          // 采样第一个视频行的结构（排查「自动播放不生效」）
          runSampleRowAndReport();
        } else if (type === 'play-now') {
          // 顶层说「目标就在当前目录」→ 就地打开，不必刷新页面
          await runPlayAndReport(payload.fileName);
        }
      });

      // 列表变化（翻页/切换目录）→ 用本地缓存重绘
      observeList(async () => {
        if (settings?.autoInjectColumn === false) return;
        await renderFromCacheOnly();
      });

      // 首屏：等列表渲染后自动尝试用缓存打标签
      setTimeout(async () => {
        const r = await renderFromCacheOnly();
        console.log('[jv115-tagger][list-frame] 首屏缓存命中', r);
        broadcast('list-frame-ready', { url: location.href.slice(0, 100) });
        // 若刚从资料库点过「播放」，这里负责定位到位
        checkPendingPlay();
      }, 1200);

      return;
    }

    // ============================================================
    // 角色 B：非列表 frame（顶层或其它 frame）→ 挂控制面板
    //   职责：UI + 广播指令给列表 frame
    // ============================================================
    if (!role.isTop) {
      // 既不是顶层也不是列表 frame → 稍后复查一次（列表可能延迟渲染）
      setTimeout(() => {
        if (frameHasVideo()) {
          console.log('[jv115-tagger] 延迟复查：本 frame 出现视频，启动列表 frame 逻辑');
          onBroadcast(async (type, payload) => {
            if (type === 'scan') await listFrameScan(payload.force === true);
            else if (type === 'clear') clearTagPills();
            else if (type === 'render-cache') await renderFromCacheOnly();
            else if (type === 'probe-library') runProbeAndReport();
            else if (type === 'harvest') harvestLocalDir();
            else if (type === 'sample-row') runSampleRowAndReport();
            else if (type === 'play-now') await runPlayAndReport(payload.fileName);
          });
          observeList(async () => { await renderFromCacheOnly(); });
          renderFromCacheOnly();
          broadcast('list-frame-ready', { url: location.href.slice(0, 100) });
          checkPendingPlay();
        } else {
          console.log('[jv115-tagger] 非顶层非列表 frame，跳过', location.href.slice(0, 80));
        }
      }, 2500);
      return;
    }

    panel = createPanel({
      onScan: (force) => scanAndTag(force),
      onClearTags: () => {
        clearTagPills();
        broadcast('clear');
        toast('已清除本页标签');
      },
      onSettingsChanged: async () => {
        settings = await loadSettings();
        resolver = buildResolver(settings);
        clearTagPills();
        broadcast('clear');
      },
      onTestSources: () => testSources(),
      onDiagnose: () => {
        try {
          return diagnose();
        } catch (e) {
          console.error('[jv115-tagger] 诊断失败', e);
          toast(`诊断出错：${e.message}`, 'err');
          return null;
        }
      },
      onDiagnoseText: () => {
        try {
          return diagnoseText();
        } catch (e) {
          console.error('[jv115-tagger] 诊断摘要失败', e);
          toast(`诊断出错：${e.message}`, 'err');
          return null;
        }
      },
      onDumpDom: () => {
        try {
          const hits = dumpRawDom(3);
          return { hits: hits.length, samples: hits };
        } catch (e) {
          console.error('[jv115-tagger] DOM 采样失败', e);
          toast(`采样出错：${e.message}`, 'err');
          return null;
        }
      },
      onProbeLibrary: () => {
        try {
          /*
           * 探针必须跑在「真正渲染文件列表」的那一侧。
           *
           * ⚠️ 不要用 scanAllFrames().items.length 来判断 ——
           * 顶层 DOM 里偶尔会残留/误抓到文件名，导致 length > 0，
           * 于是顶层抢着自己跑，拿到的全是导航区的东西（fileId 全空、
           * 没有白名单里的任何 ID 属性、也没有播放入口）→ 结论完全错误。
           *
           * 正确做法：面板在顶层 → 一律广播给列表 frame 执行，
           * 由它把结果文本用 postMessage 回传，顶层再写剪贴板。
           */
          if (isTopFrame()) {
            broadcast('probe-library');
            return '__PENDING__';    // 结果稍后由列表 frame 回传
          }
          // 非顶层（本身就是列表 frame）→ 直接跑
          return probeLibrary();
        } catch (e) {
          console.error('[jv115-tagger] 探针失败', e);
          toast(`探针出错：${e.message}`, 'err');
          return null;
        }
      },
      /*
       * 「采样视频行结构」——和探针一样必须跑在列表 frame，
       * 结果同样走 probe-result 回传，顶层写剪贴板。
       */
      onSampleRow: () => {
        try {
          if (isTopFrame()) {
            broadcast('sample-row');
            return '__PENDING__';
          }
          return sampleRowStructure();
        } catch (e) {
          console.error('[jv115-tagger] 结构采样失败', e);
          toast(`采样出错：${e.message}`, 'err');
          return null;
        }
      },
      /* 「收录本目录」：优先走 115 官方接口拿全量，失败才回退页面扫描。
         默认是**增量**：已收录且标签完好的文件不会重新请求数据源。
         目录以后新增了视频，再点一次这个按钮就行。 */
      onHarvest: () => harvestCurrentDir(false),
      /* 「全量重抓本目录」：忽略已有记录，所有番号重新查一遍 */
      onHarvestFull: () => harvestCurrentDir(true),
      /* 资料库：清理「文件已从 115 目录消失」的失效条目 */
      onPurgeGone: async () => {
        try {
          const n = await deleteLibraryGone();
          toast(n ? `已清理 ${n} 条失效记录` : '没有需要清理的失效记录', n ? 'ok' : 'err');
          return n;
        } catch (e) {
          toast(`清理失败：${e.message}`, 'err');
          return 0;
        }
      },
      /* 资料库列表里点「播放」 */
      onPlay: (row) => {
        try {
          playLibraryItem(row);
        } catch (e) {
          console.error('[jv115-tagger] 播放失败', e);
          toast(`播放失败：${e.message}`, 'err');
        }
      }
    });

    console.log('%c[jv115-tagger] 面板已挂载，右下角应出现「标签」按钮', 'color:#1a7f45;font-weight:bold');

    // 顶层：监听 iframe 回报
    onBroadcast(async (type, payload) => {
      if (type === 'progress') {
        panel.setHint(payload.text || '');
      } else if (type === 'stats') {
        panel.setStats(payload);
      } else if (type === 'done') {
        panel.setBusy(false, payload.text || '完成');
        panel.renderList(payload.rows || []);
      } else if (type === 'list-frame-ready') {
        console.log('[jv115-tagger] 列表 frame 已就绪，稍后重绘');
      } else if (type === 'need-query') {
        // 列表 frame 报告有待查询番号 → 顶层负责请求数据源
        await queryAndCache(payload.codes || [], payload.force === true);
      } else if (type === 'probe-result') {
        // 列表 frame 回传的探针结果 → 顶层写剪贴板
        await panel.setProbeResult(payload.text);
      } else if (type === 'harvest-items') {
        // 列表 frame 回报的当前目录文件清单 → 顶层查数据源并入库
        if (payload.error) {
          panel.setBusy(false, `❌ 收录扫描失败：${payload.error}`);
          toast(`收录扫描失败：${payload.error}`, 'err');
        } else {
          await doHarvest(payload.cid, payload.rows);
        }
      }
    });

    // 首屏：等一会儿让列表 frame 加载完后触发一次缓存重绘
    setTimeout(() => broadcast('render-cache'), 2000);

    // 首屏：如果当前目录以前收录过，提示一下可以直接增量更新
    showDirMemo();
  } catch (e) {
    console.error('[jv115-tagger] 挂载失败:', e);
  }
}

/**
 * 进到「以前收录过」的目录时，在面板上提示上次收录的时间和条数。
 *
 * 这是「增量更新」的入口提示：目录里加了新视频后，不需要任何额外操作，
 * 回到这个目录点一次「📥 收录本目录」就会只抓新增的部分。
 * 只读本地 dirs 表，不发任何网络请求。
 */
async function showDirMemo() {
  if (!panel) return;
  const cid = getCurrentCid();
  if (!cid || cid === '0') return;
  try {
    const memo = await getDirMeta(cid);
    if (!memo || !memo.harvestedAt) return;
    const days = Math.floor((Date.now() - memo.harvestedAt) / 86400000);
    const when = days <= 0 ? '今天' : (days === 1 ? '昨天' : `${days} 天前`);
    panel.setHint(
      `本目录上次收录于${when}（${memo.videoCount || 0} 个视频）。` +
      `目录里新增了视频的话，再点一次「📥 收录本目录」即可增量更新 —— ` +
      `已收录且标签完好的文件会跳过，只抓新的。`
    );
  } catch (e) { /* dirs 表读不到就当没收录过，不影响主流程 */ }
}

/* ==================================================================
 * 「收录本目录」—— 把当前 115 目录下的番号视频抓进资料库
 * ------------------------------------------------------------------
 * 为什么要跨 frame：
 *   文件列表渲染在 iframe 里，只有列表 frame 看得到真实的文件行。
 *   顶层面板点按钮后广播 harvest，由列表 frame 扫描并回报，
 *   顶层再统一查数据源、组装记录、写入 IndexedDB。
 *
 * 为什么要顶层查数据源：
 *   同一个番号可能在多个目录出现，顶层集中查询能最大化利用缓存，
 *   避免每个 frame 各查一遍。
 * ================================================================== */

/** 列表 frame 侧：扫描本目录 → 提取番号 → 回报给顶层 */
function harvestLocalDir() {
  try {
    const cid = getCurrentCid();
    const items = scanVideoItems(document);
    const stats = getScanStats();

    const rows = items.map((it) => {
      const ex = extractCode(it.name);
      return {
        name: it.name,
        fileId: it.fileId || null,
        pickcode: it.pickcode || null,
        size: it.size || '',
        code: ex ? ex.code : null,
        confidence: ex ? ex.confidence : 0
      };
    });

    console.log('[jv115-tagger][list-frame] 收录扫描', { cid, count: rows.length, stats });
    broadcast('harvest-items', { cid, rows });
  } catch (e) {
    console.error('[jv115-tagger][list-frame] 收录失败', e);
    broadcast('harvest-items', { cid: '', rows: [], error: e.message });
  }
}

/**
 * 顶层侧：「收录本目录」的总入口。
 *
 * 两条路：
 *   ① 首选 115 官方 webapi —— 一次就能拿到整个目录（内部自动翻页），
 *      而且返回值里直接带 pickcode。
 *      网页版列表每页只渲染 24 条，78 页的目录靠 DOM 扫描永远只能收到第一页，
 *      所以接口是主力路径。
 *   ② 兜底 DOM 扫描 —— 接口不可用（未登录 / 改版 / 网络）时，
 *      广播给列表 frame 扫当前页（**只能收当前页**，会明确告知用户）。
 */
async function harvestCurrentDir(force = false) {
  if (!panel) return;

  const cid = getCurrentCid();
  panel.setBusy(true, force ? '正在全量重抓本目录…' : '正在读取当前目录…');
  panel.setProgress(0, 1);
  panel.setHint(
    cid && cid !== '0'
      ? `目录 cid=${cid}，正在通过 115 接口拉取全部文件…`
      : '正在尝试读取目录…'
  );

  // ---------- ① 115 官方接口（主力） ----------
  if (cid && cid !== '0') {
    try {
      // includeDirs=true：清单里带上文件夹，这样每条文件的位置（dirIndex）
      // 才和网页里看到的顺序一致 —— 播放时要靠它算「该翻到第几页」。
      const { rows, total } = await apiFetchDirAll(cid, {
        includeDirs: true,
        onProgress: (got, all) => {
          panel.setProgress(got, all || got);
          panel.setHint(`正在拉取目录清单 ${got}/${all || '?'} …`);
        }
      });

      const videos = pickVideoRows(rows, { withIndex: true });
      console.log(
        `[jv115-tagger] 接口拉取完成：目录共 ${rows.length} 项（接口报总数 ${total}），其中视频 ${videos.length} 个`
      );

      if (videos.length) {
        panel.setHint(`接口拿到 ${videos.length} 个视频，正在和资料库比对…`);
        await doHarvest(cid, videos.map(toHarvestRow), { full: force });
        return;
      }
      panel.setHint(`接口返回 ${rows.length} 项但没有视频文件，改用页面扫描兜底…`);
    } catch (e) {
      console.warn('[jv115-tagger] 接口拉取失败，回退页面扫描', e);
      panel.setHint(
        `接口拉取失败（${e.message}），改用页面扫描 —— 注意这种方式只能收当前页。`
      );
    }
  } else {
    panel.setHint('没能从地址栏识别出目录 ID，改用页面扫描（只能收当前页）。');
  }

  // ---------- ② DOM 扫描兜底 ----------
  try {
    broadcast('harvest');
  } catch (e) {
    panel.setBusy(false, `❌ 收录失败：${e.message}`);
    toast(`收录失败：${e.message}`, 'err');
    return;
  }
  setTimeout(() => {
    if (panel) {
      panel.setBusy(false, '收录指令已发送。若没反应，请点「📋 复制诊断摘要」发我');
    }
  }, 8000);
}

/** 把接口文件转成 doHarvest 需要的行结构（顺带提取番号） */
function toHarvestRow(v) {
  const ex = extractCode(v.name);
  return {
    name: v.name,
    fileId: v.fileId || null,
    pickcode: v.pickcode || null,
    size: v.size || '',
    // 该文件在整个目录清单里的位置（含文件夹），播放时用来算页码
    dirIndex: Number.isFinite(v.dirIndex) ? v.dirIndex : null,
    code: ex ? ex.code : null,
    confidence: ex ? ex.confidence : 0
  };
}

/**
 * 顶层侧：拿到文件清单后，
 * 查数据源 → 组装 library 记录 → 写库。
 *
 * ⚠️ cid 必须用「顶层 URL」里的值，不能用列表 frame 报上来的。
 *    实测：顶层 URL 是 ?cid=3527255730090411997（正确），
 *    而列表 frame 的 URL 是  ...&aid=1&cid=0&offset=0&limit=24（cid=0）。
 *    早期版本在列表 frame 里取 cid，结果全库 cid=0，
 *    点播放就跳到 ?cid=0 —— 也就是网盘根目录。
 */
async function doHarvest(frameCid, rows, opts = {}) {
  if (!panel) return;

  const full = opts.full === true;
  const topCid = getCurrentCid();
  const cid = topCid && topCid !== '0' ? topCid : (frameCid && frameCid !== '0' ? frameCid : '');
  console.log('[jv115-tagger] 收录：顶层 cid =', topCid, '| 列表 frame cid =', frameCid, '| 采用 =', cid);

  if (!rows || rows.length === 0) {
    panel.setBusy(false, '❌ 当前目录没扫到视频文件');
    toast('当前目录没扫到视频文件', 'err');
    panel.setHint(
      '当前目录没扫到视频文件。请确认：① 已经进入有视频的目录；' +
      '② 列表已加载出来再点一次。若反复如此，请点「📋 复制诊断摘要」发我。'
    );
    return;
  }

  if (!cid) {
    panel.setHint('⚠️ 没能识别当前目录 ID（cid），播放时可能定位不准。建议刷新页面后重试。');
  }

  settings = await loadSettings();
  resolver = buildResolver(settings);
  const minConf = settings.minConfidence ?? 60;

  /* ==================================================================
   * 增量收录
   * ------------------------------------------------------------------
   * 目录会不断增加新视频，不可能每次都重抓全部标签（耗时且容易被风控）。
   * 所以先读「本目录已收录的记录」，把这次接口拿到的文件分成三类：
   *
   *   未变 unchanged —— 库里有、上次拿到了标签、番号也没变
   *                     → **完全不请求数据源**，沿用已有记录
   *   待补 refresh  —— 库里有但上次没拿到标签（数据源当时抽风 / 番号没识别出）
   *                     → 只重查这些番号
   *   新增 added     —— 库里没有的新文件 → 查
   *
   * 另外还要识别「已失效」：库里记着、但这次目录里已经没有的文件。
   * 这种不删除，只打 gone 标记 —— 万一是临时移动，别把数据弄丢了。
   * ================================================================== */
  const existing = await getLibraryByCid(cid).catch(() => []);
  const prevByName = new Map(existing.map((r) => [r.fileName, r]));

  const classify = rows.map((r) => {
    const prev = prevByName.get(r.name) || null;
    const hasCode = !!(r.code && r.confidence >= minConf);
    const unchanged = !full && !!prev && prev.matched === true && hasCode && prev.code === r.code;
    return { row: r, prev, hasCode, unchanged };
  });

  const needCodes = [...new Set(
    classify.filter((c) => !c.unchanged && c.hasCode).map((c) => c.row.code)
  )];
  const addedCount = classify.filter((c) => !c.prev).length;
  const noCodeCount = classify.filter((c) => !c.hasCode).length;

  if (existing.length) {
    panel.setHint(
      `本目录此前已收录 ${existing.length} 条；本次 ${rows.length} 个视频 → ` +
      `新增 ${addedCount} 个、需补查 ${needCodes.length} 个番号` +
      `${full ? '（全量模式，忽略已有记录）' : ''}…`
    );
  }

  // 查数据源（未命中的会拿到 { notFound: true }，也照样入库，方便之后手动补）
  const resultMap = new Map();
  let done = 0;
  if (needCodes.length) {
    panel.setProgress(0, needCodes.length);
    await resolver.resolveBatch(needCodes, {
      concurrency: settings.concurrency || 3,
      force: false,
      onProgress: ({ code, meta }) => {
        done++;
        panel.setProgress(done, needCodes.length);
        resultMap.set(code, meta);
        panel.setHint(`查询中 ${done}/${needCodes.length} — ${code} ${meta?.notFound ? '未找到' : '✓'}`);
      }
    });
  }

  const now = Date.now();
  const records = classify.map(({ row, prev, hasCode, unchanged }) => {
    // 未变的记录：一个字节都不动数据源结果，只刷新文件层面的元信息
    // （pickcode / 大小 / fileId 可能因为 115 改版而变得能挖到了）
    if (unchanged && prev) {
      return {
        ...prev,
        fileId: row.fileId ? String(row.fileId) : prev.fileId,
        pickcode: row.pickcode ? String(row.pickcode) : prev.pickcode,
        size: row.size || prev.size,
        // 目录里加了新文件后，老文件的位置会整体后移，所以每次都要刷新
        dirIndex: Number.isFinite(row.dirIndex) ? row.dirIndex : (prev.dirIndex ?? null),
        gone: false,
        lastSeenAt: now,
        updatedAt: now
      };
    }
    return buildLibraryRecord({
      cid,
      fileName: row.name,
      fileId: row.fileId,
      pickcode: row.pickcode,
      size: row.size,
      dirIndex: row.dirIndex,
      code: row.code,
      confidence: row.confidence,
      meta: hasCode ? (resultMap.get(row.code) || null) : null,
      prev
    });
  });

  await putLibraryBatch(records);
  // 清掉「同一文件、旧 id」的残留（例如修好 cid 取值后重新收录）
  const pruned = await pruneLibraryDuplicates(records);

  // ---------- 标记失效：库里有、这次目录里没有 ----------
  const seenNames = new Set(rows.map((r) => r.name));
  const goneRecords = existing
    .filter((r) => !seenNames.has(r.fileName) && !r.gone)
    .map((r) => ({ ...r, gone: true, goneAt: now, updatedAt: now }));
  if (goneRecords.length) await putLibraryBatch(goneRecords);

  // ---------- 记录目录汇总（下次增量收录的依据） ----------
  try {
    await putDirMeta({
      cid,
      path: getCurrentPath(),
      videoCount: records.length,
      added: addedCount,
      gone: goneRecords.length,
      harvestedAt: now
    });
  } catch (e) { /* 目录汇总只是辅助信息，失败不影响主流程 */ }

  const stats = {
    total: records.length,
    added: addedCount,
    refreshed: classify.filter((c) => c.prev && !c.unchanged).length,
    unchanged: classify.filter((c) => c.unchanged).length,
    gone: goneRecords.length,
    noCode: noCodeCount,
    tagged: records.filter((x) => x.matched).length,
    withPc: records.filter((x) => x.pickcode).length,
    kept: records.filter((x) => x.keptPrev).length
  };
  console.log('[jv115-tagger] 收录完成', stats, `| 清理旧重复 ${pruned} 条`);

  panel.setStats({ videos: stats.total, matched: stats.tagged, miss: stats.total - stats.tagged });
  panel.setBusy(false, harvestSummary(stats, full));
  panel.setHint(harvestDetail(stats));
  panel.renderList(records.slice(0, 50).map((x) => ({
    name: x.fileName,
    status: x.matched ? 'ok' : 'miss',
    code: x.code ? `${x.code}${x.matched ? '' : ' 未获取'}` : '无番号'
  })));
  toast(
    `收录完成：新增 ${stats.added}，补查 ${stats.refreshed}，未变 ${stats.unchanged}` +
    (stats.gone ? `，失效 ${stats.gone}` : ''),
    'ok'
  );

  // 直接带用户去资料库看结果
  await panel.showLibrary();
}

/** 收录结果的一行摘要（面板按钮文字） */
function harvestSummary(s, full) {
  const parts = [`✅ 新增 ${s.added}`];
  if (s.refreshed) parts.push(`补查 ${s.refreshed}`);
  parts.push(`未变 ${s.unchanged}`);
  if (s.gone) parts.push(`⚠️ 失效 ${s.gone}`);
  parts.push(`| 本目录共 ${s.total} 条`);
  if (full) parts.push('(全量)');
  return parts.join(' · ');
}

/** 收录结果的详细提示（面板 hint 区） */
function harvestDetail(s) {
  const lines = [];
  lines.push(
    `新增 ${s.added} 个新文件；补查 ${s.refreshed} 个（上次没抓到标签的）；` +
    `未变 ${s.unchanged} 个（已跳过，未请求数据源）。`
  );
  if (s.kept) lines.push(`${s.kept} 个这次没查到，已保留上次的标签（不让信息退化）。`);
  if (s.noCode) lines.push(`${s.noCode} 个文件名里没有可识别番号。`);
  if (s.gone) lines.push(`${s.gone} 个条目的文件已从目录里消失，标记为「失效」（资料库里可一键清理）。`);
  lines.push(`本目录已拿到标签 ${s.tagged}/${s.total}。`);
  lines.push('目录以后新增视频，直接再点一次「📥 收录本目录」即可增量更新。');
  return lines.join(' ');
}

/* ==================================================================
 * 播放 / 定位
 * ------------------------------------------------------------------
 * 资料库里的每条记录都带 cid（收录时从**顶层 URL** 取，一定有），
 * pickcode 则要看 115 列表 DOM 里有没有暴露（通常有，从行内 <a href> 挖）。
 *
 * 播放走三级策略：
 *   ① 有 pickcode → 直接开 115 播放页（一步直达）
 *   ② 只有 cid   → 跳回该文件所在目录，落地后自动定位并尝试播放
 *   ③ 都没有     → 明确告知，让用户手动搜番号
 *
 * 播放页地址来自 115Master 公开的唤起接口：
 *     https://115.com/web/lixian/master/video/?pick_code={提取码}&cid={目录ID}
 *   pick_code 必填，cid 选填（为空时拿不到播放列表）。
 * 地址模板做成了设置项，环境不同可以自己改，见「设置」页。
 * ================================================================== */

const PENDING_PLAY_KEY = 'jv115-pending-play';

/** 115Master 项目主页（播放页打不开时给用户的指引） */
const MASTER_REPO = 'https://github.com/zhuzi6/115master';

/** 按模板拼播放地址（模板填充的纯逻辑在 storage.js，那边有单测） */
function buildPlayerUrl(row, cfg) {
  const tpl = cfg?.playerUrlTemplate || DEFAULT_PLAYER_URL;
  return fillPlayerTemplate(tpl, playerTemplateVars(row));
}

/* ==================================================================
 * 播放页自检
 * ------------------------------------------------------------------
 * 为什么需要它：
 *   我们默认播放方式就是「直接开播放页」，地址是 115Master 注册的虚拟路由。
 *   没装 115Master 时，115 服务器会返回一个几乎空白的壳 —— 用户看到白屏，
 *   但完全不知道是「没装插件」还是「文件坏了」。
 *
 * 为什么检测要放在播放页做：
 *   115Master 的 DOM 标记（#master-app / x-player）**只在播放页挂载**。
 *   在文件列表页上做检测永远返回 false（这正是旧版 auto 模式失效的原因）。
 *   而我们的脚本因为 @match 覆盖 115.com/*，在播放页同样会被注入 ——
 *   所以那一侧才是唯一能准确判断的地方。
 *
 * 结论回传：写进 localStorage，列表页下次点播放前先读一眼；
 *           如果上次是白屏，就先提醒，而不是让用户对着空白页发呆。
 * ================================================================== */

/** 读上次的自检结果（没有 / 结构不对 / 已过期 → null） */
function readPlayerProbe() {
  try {
    const raw = localStorage.getItem(PLAYER_PROBE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (!p || typeof p.ok !== 'boolean') return null;
    if (!Number.isFinite(p.ts) || Date.now() - p.ts > PLAYER_PROBE_TTL) return null;
    return p;
  } catch (e) { return null; }
}

function writePlayerProbe(ok, detail = '') {
  try {
    localStorage.setItem(PLAYER_PROBE_KEY, JSON.stringify({
      ok, detail, ts: Date.now(), href: location.href.slice(0, 160)
    }));
  } catch (e) { /* 隐私模式可能禁用 */ }
}

/** 播放页白屏时，在页面上直接说清原因和出路 */
function showPlayerPageHelp(hasMaster) {
  if (document.getElementById('jv115-player-help')) return;
  const box = document.createElement('div');
  box.id = 'jv115-player-help';
  box.style.cssText = [
    'position:fixed', 'z-index:2147483647', 'left:50%', 'top:80px',
    'transform:translateX(-50%)', 'max-width:560px', 'width:calc(100% - 48px)',
    'background:#fff', 'color:#222', 'border:1px solid #e3e6eb', 'border-radius:12px',
    'box-shadow:0 12px 40px rgba(0,0,0,.16)', 'padding:18px 20px',
    'font:13px/1.75 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif'
  ].join(';');
  box.innerHTML =
    '<div style="font-size:15px;font-weight:600;margin-bottom:10px">' +
    '这个播放页是空的 —— 它需要 115Master</div>' +
    '<div>地址里的 <code style="background:#f4f6f8;padding:1px 4px;border-radius:3px">' +
    '/web/lixian/master/video/</code> 是 115Master 脚本注册的路由，115 服务器本身不认识它。' +
    (hasMaster
      ? '检测到 115Master 正在运行，但播放器一直没挂上 —— 可能是文件不支持在线预览，或网络较慢。'
      : '当前页面上<b>没有</b>检测到 115Master。') +
    '</div>' +
    '<div style="margin-top:10px">两种出路：</div>' +
    '<ol style="margin:6px 0 0;padding-left:20px">' +
    '<li>安装 115Master 后重试：' +
    '<a href="' + MASTER_REPO + '" target="_blank" rel="noreferrer" ' +
    'style="color:#2b5cff;word-break:break-all">' + MASTER_REPO + '</a></li>' +
    '<li>回到 115 列表页，在脚本面板「设置 → 播放方式」选「回到目录、页面内打开」，' +
    '它不依赖任何插件。</li>' +
    '</ol>' +
    '<div style="margin-top:14px;text-align:right">' +
    '<button id="jv115-help-close" style="cursor:pointer;border:1px solid #d7dbe0;' +
    'background:#fff;border-radius:7px;padding:5px 14px;font:inherit">知道了</button></div>';
  document.body.appendChild(box);
  document.getElementById('jv115-help-close')?.addEventListener('click', () => box.remove());
}

/**
 * 若当前就是播放页，轮询等播放器起来；超时仍未起来 → 记一笔「白屏」并给出提示。
 *
 * 注意：脚本被注入到播放页，**不代表** 115Master 装了 ——
 *       Tampermonkey 的 @match 是 115.com/*，两个脚本互不依赖、都会被注入。
 *       所以「本函数能跑起来」不能当作 115Master 存在的证据，必须实测 DOM。
 */
function probePlayerPage() {
  if (!isMasterPlayerPage()) return;

  const started = Date.now();
  /*
   * ⚠️ 时序上的坑：播放页是用 window.open 打开的 —— 它默认落在**后台标签**，
   *    而浏览器会把后台标签的定时器节流到 ≥1 秒/次，甚至整个冻结。
   *    所以这里的超时要给得宽一些，并且额外接一个 visibilitychange：
   *    用户切过来看见白屏的那一刻，才是我们该下结论的时刻。
   */
  const TIMEOUT = 20000;
  const already = readPlayerProbe();
  if (already && already.ok === true) {
    console.log('[jv115-tagger] 播放页自检：已有「正常」结论，跳过');
    return;
  }

  let finished = false;
  const finish = (ok, detail) => {
    if (finished) return;
    finished = true;
    writePlayerProbe(ok, detail);
    if (ok) {
      console.log('[jv115-tagger] 播放页自检 ✅ 播放器已就绪（' + detail + '）');
    } else {
      const hasMaster = detect115MasterAnywhere();
      const blank = looksBlank(document);
      console.warn('[jv115-tagger] 播放页自检 ❌ 没等到播放器',
        { hasMaster, blank, url: location.href });
      if (blank) showPlayerPageHelp(hasMaster);
    }
  };

  const evaluate = (final = false) => {
    if (finished) return;
    const ready = detectPlayerReady(document);
    if (ready.ok) { finish(true, ready.via); return; }
    if (final) {
      finish(false, detect115MasterAnywhere() ? 'player-not-mounted' : 'master-missing');
      return;
    }
    if (Date.now() - started >= TIMEOUT) { evaluate(true); return; }
    setTimeout(() => evaluate(false), 800);
  };

  document.addEventListener('visibilitychange', () => {
    // 标签被切到前台：如果已经加载了一会儿，直接定论（后台节流下定时器可能没跑够）
    if (!document.hidden && !finished && Date.now() - started > 4000) evaluate(true);
  });

  setTimeout(() => evaluate(false), 1200);
}

/**
 * 打开播放页后「盯着」自检结果。
 *
 * 播放页那一侧一旦判定白屏，会把结果写进 localStorage；
 * 这里轮询读回来、立刻提醒 —— **首次使用时缓存还是空的**，
 * 这条路径是唯一能及时给反馈的通道，缺了它用户就只能对着白屏自己猜。
 *
 * 用 ts >= openedAt 区分「这次打开产生的结论」和「上一次留下的旧结论」。
 */
function watchPlayerProbe(openedAt, label, timeout = 26000) {
  const t0 = Date.now();
  const tick = () => {
    const p = readPlayerProbe();
    if (p && p.ts >= openedAt) {
      if (p.ok === false) {
        console.warn('[jv115-tagger] 播放页自检回报：白屏', p);
        toast(`「${label}」的播放页是空白的`, 'err');
        panel?.setHint(
          '❌ 打开的播放页是空白的 —— 这个地址需要 115Master 脚本才有播放器。' +
          '① 装 115Master 即可一步直达播放；' +
          '② 或者把「设置 → 播放方式」改成「回到目录、页面内打开」，它不依赖任何插件。' +
          `115Master 参考：${MASTER_REPO}`
        );
      } else {
        console.log('[jv115-tagger] 播放页自检回报：播放器已就绪', p);
      }
      return;
    }
    if (Date.now() - t0 < timeout) setTimeout(tick, 1500);
  };
  setTimeout(tick, 3000); // 让播放页那边先跑起来
}

/**
 * 面板侧：点「播放」。
 *
 *   'page'（默认）—— 直接开播放页，一步到位
 *      地址 = 设置里的 playerUrlTemplate，默认取 115Master 的唤起路由。
 *      ⚠️ 没装 115Master 会白屏 —— 所以打开前先读「播放页自检」的缓存：
 *         上次如果是白屏，这次就先提醒一句，而不是让用户对着空白页猜。
 *   'inpage' —— 跳回该文件所在目录，在网页列表里定位并模拟点击（不依赖插件）
 *
 * 为什么不再做「自动检测」：
 *   115Master 的 DOM 只在**播放页**挂载，在文件列表页检测必然返回 false。
 *   旧版的 auto 模式于是被静默降级成「回目录模拟点击」——
 *   表现就是用户看到的「点播放却跳回目录，还提示找不到视频」。
 *   既然检测不可靠，就按用户选择的策略直着走，别在中间偷偷改道。
 */
function playLibraryItem(row) {
  if (!row) return;

  const mode = settings?.playMode || PLAY_MODES.PAGE;

  // ---------- ① 直接打开播放页 ----------
  if (mode !== PLAY_MODES.INPAGE) {
    if (!row.pickcode) {
      /*
       * 播放页地址里 pick_code 是**必填**项（cid 才是选填），缺了它必然打不开。
       * 缺的一般是旧版本收录的老记录 —— v1.2.3 之前的版本没挖到 pick_code 属性名。
       */
      console.warn('[jv115-tagger] 该记录没有 pickcode，无法拼播放地址', row);
      panel?.setHint(
        '❌ 这条记录没有「提取码」（pickcode），拼不出播放页地址。' +
        '多半是旧版本收录的（那时属性名还没修对）。' +
        '请进入该文件所在目录，点一次「📥 收录本目录」把它补全 —— 增量收录只会补这一条，很快。'
      );
      toast('这条记录缺少提取码，重新收录一次即可补全', 'err');
      return;
    }

    const url = buildPlayerUrl(row, settings);
    const label = row.code || row.fileName;
    console.log('[jv115-tagger] 打开播放页', url);
    const openedAt = Date.now();
    const win = window.open(url, '_blank');
    if (!win) {
      toast('播放页被浏览器拦截了，请允许本站弹窗后重试', 'err');
      return;
    }
    // 打开后盯一眼自检结果：播放页那边一旦判定白屏，这里立刻给出解释
    watchPlayerProbe(openedAt, label);

    // 上一次在这台机器上打开播放页是白屏 → 先把原因说在前面
    const probe = readPlayerProbe();
    if (probe && probe.ok === false) {
      toast(`已打开 ${label} 的播放页（注意：上次这里是空白）`, 'err');
      panel?.setHint(
        '这个播放地址是 115Master 注册的，没装它打开就是空白页。' +
        '装了 115Master 即可正常播放；不想装就把它改成「回到目录、页面内打开」。' +
        `给个参考：${MASTER_REPO}`
      );
    } else {
      toast(`已打开播放页：${label}`, 'ok');
      panel?.setHint(
        `已在新标签页打开 ${label} 的播放页。` +
        '若页面是空白的，说明该地址需要 115Master（设置页可切换播放方式）。'
      );
    }
    return;
  }

  // ---------- ② 页面内打开：目标就在当前目录 → 就地点击（不刷新页面） ----------
  // 用户多半刚在这个目录里收录完，此时文件行往往已经在 DOM 里，
  // 直接点开最省事，也避免了「整页重载 → 列表还没渲染 → 定位失败」。
  if (row.cid && getCurrentCid() === row.cid) {
    panel?.setHint('目标就在当前目录，正在定位并就地触发播放…');
    // 异步；内部已 try/catch，任何失败都会自动退回「跳回目录」
    playInPlace(row).catch((e) => {
      console.warn('[jv115-tagger] 就地播放异常，退回跳转策略', e);
      jumpAndPlay(row);
    });
    return;
  }

  jumpAndPlay(row);
}

/** 就地打开：问列表 frame 要点开哪个文件，成功就结束，失败退回跳转 */
async function playInPlace(row) {
  const waiter = waitForBroadcast('play-done', 6000);
  broadcast('play-now', { fileName: row.fileName });
  const res = await waiter;

  if (res && res.ok) {
    toast(`已触发播放（${res.via || '就地点击'}）`, 'ok');
    panel?.setHint(`已在当前页面打开 ${row.fileName}。`);
    return;
  }

  if (res) {
    console.warn(
      '[jv115-tagger] 就地触发没生效，退回「跳回目录」策略。\n试过：\n  ' +
      (res.tried || []).join('\n  ') + `\n原因：${res.reason || '(未知)'}`
    );
  } else {
    console.warn('[jv115-tagger] 列表 frame 没有应答（可能不在当前页），退回「跳回目录」策略');
  }
  jumpAndPlay(row);
}

/** 跳回该文件所在目录，落地后由列表 frame 自动定位并触发播放 */
function jumpAndPlay(row) {
  if (!row.cid) {
    toast('这条记录缺少目录信息，无法定位。可在 115 里手动搜索番号。', 'err');
    return;
  }

  /*
   * 115 网页列表每页只渲染 24 条。目标文件如果排在很后面，
   * 只跳 ?cid=x 会落在第一页、根本看不到它。所以用收录时记下的位置算页码。
   *
   * ⚠️ 两个已知坑：
   *   ① dirIndex 是 v1.2.3 起才记的。老记录为 null → 只能落第一页，
   *      这时与其装作能定位，不如直接告诉用户「重新收录一次就能精确定位」。
   *   ② 这个下标来自 115 接口的排序（含文件夹，与网页顺序一致）。
   *      万一不一致会落到「不对但也不是第一页」的位置 —— 所以只尝试一次。
   */
  const PAGE = 24;
  const hasIndex = Number.isFinite(row.dirIndex) && row.dirIndex >= 0;
  const offset = hasIndex ? Math.floor(row.dirIndex / PAGE) * PAGE : 0;

  try {
    sessionStorage.setItem(PENDING_PLAY_KEY, JSON.stringify({
      cid: row.cid,
      fileName: row.fileName,
      code: row.code || '',
      pickcode: row.pickcode || '',
      offset,
      hasIndex,
      triedOffset: offset > 0
    }));
  } catch (e) { /* 隐私模式下可能禁用 */ }

  toast(
    hasIndex && offset > 0
      ? `正跳到该文件所在目录第 ${offset / PAGE + 1} 页…`
      : '正在跳回该文件所在目录…',
    'ok'
  );
  if (!hasIndex) {
    panel?.setHint(
      '⚠️ 这条记录是旧版本收录的，没记下它在目录里的位置 → 只能落到第一页，' +
      '大概率定位不到。重新点一次「📥 收录本目录」就能补上位置信息。'
    );
  }
  location.href = `https://115.com/?cid=${encodeURIComponent(row.cid)}` +
    (offset > 0 ? `&offset=${offset}` : '') + '&mode=wangpan';
}

/** 短暂高亮一个元素，便于用户一眼看到定位结果 */
function flashEl(el) {
  const prev = el.style.outline;
  const prevOff = el.style.outlineOffset;
  el.style.outline = '2px solid #2b5cff';
  el.style.outlineOffset = '2px';
  setTimeout(() => {
    el.style.outline = prev;
    el.style.outlineOffset = prevOff;
  }, 2500);
}

/**
 * 列表 frame 侧：页面加载后检查是否有「待定位播放」的目标。
 *
 * ⚠️ 这里**不能**再用 cid 判断「是不是已经跳到目标目录」。
 *    实测列表 frame 的 URL 是 ...&aid=1&cid=0&offset=0&limit=24，
 *    它的 cid 恒为 0，和收录时记下的真实 cid 永远不相等 ——
 *    结果整个定位逻辑从不执行（表现为「回到目录但没有任何反应」）。
 *    现在改成「页面上出现同名文件就触发」，cid 只留在日志里。
 */
function checkPendingPlay() {
  let target = null;
  try {
    const raw = sessionStorage.getItem(PENDING_PLAY_KEY);
    if (!raw) return;
    target = JSON.parse(raw);
  } catch (e) { return; }

  if (!target?.fileName) return;

  try { sessionStorage.removeItem(PENDING_PLAY_KEY); } catch (e) { /* 忽略 */ }
  console.log('[jv115-tagger][list-frame] 有待播放目标', target, '| 本 frame cid =', getCurrentCid());

  /** 目标不在当前页时，跳到它真正所在的那一页再试一次 */
  const jumpToOffsetPage = () => {
    const off = Number(target.offset) || 0;
    if (!(off > 0) || target.triedOffset) return false;
    const url = `https://115.com/?cid=${encodeURIComponent(target.cid)}&offset=${off}&mode=wangpan`;
    console.log('[jv115-tagger][list-frame] 第一页没有该文件，跳到 offset=' + off, url);
    try {
      sessionStorage.setItem(PENDING_PLAY_KEY, JSON.stringify({ ...target, triedOffset: true }));
    } catch (e) { /* 忽略 */ }
    try {
      // 同源 → 可以直接驱动顶层窗口导航（列表 frame 自己的 URL 里 cid=0 不可用）
      (window.top || window).location.href = url;
      return true;
    } catch (e) {
      console.warn('[jv115-tagger] 无法驱动顶层跳转', e);
      return false;
    }
  };

  const tryFind = (attempt) => {
    const items = scanVideoItems(document);
    const hit = items.find((it) => it.name === target.fileName);
    if (!hit) {
      // 列表可能还在渲染，最多重试 16 次（约 8 秒）
      if (attempt === 12 && jumpToOffsetPage()) {
        toast('该文件不在第一页，正在跳到它所在的那一页…', 'ok');
        return;
      }
      if (attempt < 16) { setTimeout(() => tryFind(attempt + 1), 500); return; }

      /*
       * 两轮都没找到。这里必须分清是「哪种找不到」——
       * 旧版只有一句「没找到，请手动点击播放」，用户完全无从下手。
       */
      if (target.hasIndex === false) {
        toast(`已回到目录，但没找到「${target.fileName}」`, 'err');
        panel?.setHint(
          '❌ 这条记录是旧版本收录的，库里没记下它在目录里的位置 → 脚本只能落在第一页，' +
          '排在后面的文件自然找不到。' +
          '解决：进入该目录点一次「📥 收录本目录」补上位置信息，再点播放即可。'
        );
      } else {
        const page = (Number(target.offset) || 0) / 24 + 1;
        toast(`第 ${page} 页里也没找到「${target.fileName}」`, 'err');
        panel?.setHint(
          `⚠️ 目标不在第 ${page} 页 —— 多半是 115 网页排序和接口排序不完全一致。` +
          '受分页和排序影响的定位本来就不可靠，' +
          '建议在「设置 → 播放方式」里改成「直接打开播放页」，一步直达、不受分页影响。'
        );
      }
      return;
    }

    try { hit.nameEl.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { /* 忽略 */ }
    flashEl(hit.rowEl || hit.nameEl);
    toast(`已定位 ${target.fileName}，正在触发播放…`, 'ok');

    setTimeout(async () => {
      const r = await triggerRowOpen(target.fileName);
      console.log('[jv115-tagger][list-frame] 页面内触发播放结果', r);
      if (r.ok) {
        toast(`已触发播放（方式：${r.via}）`, 'ok');
      } else {
        console.warn(
          '[jv115-tagger] 自动触发播放没生效。\n试过：\n  ' + (r.tried || []).join('\n  ') +
          '\n该行 HTML：\n' + (r.html || '(空)')
        );
        toast('没能自动打开播放。请点面板「🎬 采样视频行结构」把结果发我', 'err');
      }
    }, 600);
  };

  setTimeout(() => tryFind(0), 900);
}

/**
 * 列表 frame 内执行探针，并把结果文本回传顶层。
 *
 * 为什么要回传：面板挂在顶层，但探针只有在列表 frame 里跑才有意义。
 * 顶层拿到文本后写剪贴板（子 frame 直接写剪贴板可能被浏览器策略拦截）。
 */
function runProbeAndReport() {
  runAndReport(probeLibrary, '探针');
}

/** 列表 frame 侧：采样第一个视频行的结构，回传顶层（排查「自动播放不生效」用） */
function runSampleRowAndReport() {
  runAndReport(sampleRowStructure, '视频行结构采样');
}

/**
 * 列表 frame 侧：**就地**打开某个文件（不刷新页面），并把结果回报顶层。
 *
 * 「就地」的意义：用户通常刚收录完就在这个目录里，此时目标文件
 * 可能已经在 DOM 里了 —— 那就没必要跳转 + 重载整个网盘页面，
 * 直接点开就行。顶层会等这个回报，收不到才退回到「跳回目录」那条路。
 */
async function runPlayAndReport(fileName) {
  try {
    const r = await triggerRowOpen(fileName);
    console.log('[jv115-tagger][list-frame] 就地播放结果', r);
    broadcast('play-done', {
      fileName,
      ok: !!r.ok,
      via: r.via || '',
      reason: r.reason || '',
      tried: r.tried || []
    });
  } catch (e) {
    console.error('[jv115-tagger][list-frame] 就地播放失败', e);
    broadcast('play-done', { fileName, ok: false, reason: e.message });
  }
}

/**
 * 等一条指定类型的广播回来（用于「问列表 frame 一个问题」这种请求-响应场景）。
 * 超时返回 null，让调用方走兜底路径。
 */
function waitForBroadcast(type, timeoutMs = 6000) {
  return new Promise((resolve) => {
    let off = null;
    const timer = setTimeout(() => {
      try { off?.(); } catch (e) { /* 忽略 */ }
      resolve(null);
    }, timeoutMs);
    off = onBroadcast((t, p) => {
      if (t !== type) return;
      clearTimeout(timer);
      try { off?.(); } catch (e) { /* 忽略 */ }
      resolve(p || {});
    });
  });
}

/**
 * 通用：在列表 frame 里跑一个「返回文本」的诊断函数，并把文本回传顶层。
 * 顶层收到后写剪贴板（子 frame 直接写剪贴板可能被浏览器策略拦截）。
 */
function runAndReport(fn, label) {
  try {
    const text = fn();
    broadcast('probe-result', { text: text || `(${label}返回空)` });
  } catch (e) {
    console.error(`[jv115-tagger][list-frame] ${label}失败`, e);
    broadcast('probe-result', {
      text: `${label}在列表 frame 内报错：${e.message}\nURL: ${location.href}`
    });
  }
}

/**
 * 列表 frame 内的扫描 + 渲染。
 * 由顶层面板通过 postMessage 触发。
 *
 * 与顶层 scanAndTag 的区别：
 *   - 数据源查询统一在顶层做（避免每个 frame 重复请求）
 *   - 本函数只负责「扫描本 frame → 提取番号 → 把结果回报顶层」
 */
async function listFrameScan(force = false) {
  try {
    const items = scanVideoItems(document);
    const stats = getScanStats();
    console.log('[jv115-tagger][list-frame] 扫描统计', stats);

    if (items.length === 0) {
      broadcast('done', {
        text: `❌ 列表 frame 内没找到视频（扫描 ${stats.totalElements} 个元素）`,
        rows: []
      });
      return;
    }

    const cfg = await loadSettings();
    const minConf = cfg.minConfidence ?? 60;

    // 提取番号
    const parsed = items.map((it) => ({ item: it, ex: extractCode(it.name) }));
    const valid = parsed.filter((p) => p.ex && p.ex.confidence >= minConf);
    const codes = [...new Set(valid.map((p) => p.ex.code))];

    if (codes.length === 0) {
      broadcast('done', {
        text: `找到 ${items.length} 个视频，但文件名里没有可识别番号`,
        rows: parsed.slice(0, 30).map(({ item, ex }) => ({
          name: item.name, status: 'miss', code: ex ? `${ex.code} 低置信` : '无番号'
        }))
      });
      return;
    }

    // 只有本地缓存能直接用；未命中的回报顶层去查
    const rows = [];
    const needQuery = [];
    let hit = 0;

    for (const { item, ex } of parsed) {
      if (!ex || ex.confidence < minConf) {
        rows.push({ name: item.name, status: 'miss', code: ex ? `${ex.code} 低置信` : '无番号' });
        continue;
      }
      const meta = await getMeta(ex.code);
      if (meta) {
        rows.push({ name: item.name, status: 'ok', code: ex.code });
        hit++;
      } else {
        needQuery.push(ex.code);
        rows.push({ name: item.name, status: 'miss', code: ex.code });
      }
    }

    broadcast('stats', { videos: items.length, matched: hit, miss: items.length - hit });
    broadcast('done', {
      text: `列表 frame：${items.length} 个视频，本地命中 ${hit} 个，待查询 ${[...new Set(needQuery)].length} 个`,
      rows
    });
    // 把待查询番号交给顶层（顶层负责请求数据源并回写缓存）
    broadcast('need-query', { codes: [...new Set(needQuery)], force });
  } catch (e) {
    console.error('[jv115-tagger][list-frame] 扫描异常', e);
    broadcast('done', { text: `❌ 列表 frame 扫描出错：${e.message}`, rows: [] });
  }
}

/** 兜底：DOM 就绪后再挂载，防止 115 是 SPA 异步渲染 */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}


})();
