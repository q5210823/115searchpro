// ==UserScript==
// @name         115 网盘 JAV 标签助手
// @namespace    https://github.com/jv115-tagger
// @version      1.4.2
// @description  读取 115 网盘视频文件名，自动提取番号，从 JavBus / javlibrary 拉取影片信息，在文件列表上以「标题+演员+类别」标签形式展示。纯本地标签库，不改动 115 任何原始文件，无需 API key。
// @author       jv115-tagger
// @match        *://*.115.com/*
// @match        *://*.115cdn.com/*
// @match        *://*.115vod.com/*
// @include      *://*.115.com/*
// @include      *://*.115cdn.com/*
// @updateURL    https://raw.githubusercontent.com/q5210823/115searchpro/main/dist/jv115-tagger.user.js
// @downloadURL  https://raw.githubusercontent.com/q5210823/115searchpro/main/dist/jv115-tagger.user.js
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
 * core/glossary.js
 * ================================================================== */

/* ==================================================================
 * 本地术语表 —— 把日文番号标题译成中文
 * ------------------------------------------------------------------
 * 设计原则（这几条决定了「能不能用」）：
 *
 * ① **纯本地、不联网、零成本。**
 *    没有 API key、没有配额、没有请求延迟，也不会有内容审核问题。
 *    代价是长句不会通顺 —— 所以目标定成「看得懂」，不是「信达雅」。
 *
 * ② **专名先占位，翻完再回填。**
 *    番号和演员名绝不能参与翻译：演员名会被逐字替换成毫无意义的汉字，
 *    番号会被拆开。做法是先把它们换成占位符，翻完再原样换回来。
 *    这是整个模块最要紧的一步，省掉它标题立刻变得不可读。
 *
 * ③ **最长优先。**
 *    「独占配信」必须整体命中，不能被拆成「独占」+「配信」。
 *    做法是把词条按长度倒序拼成一个正则，靠 alternation 的顺序取胜。
 *    （这也是为什么最短的词条要有 2 个字：单字词条会把别的词撕开。）
 *
 * ④ **残留的汉字要归一化字形。**
 *    术语表只收「整词」，剩下的汉字会原样流下来，而它们是**日文写法**：
 *    `夫婦交換`「夫婦交換」/ `家庭教師の誘惑`「家庭教師の誘惑」。
 *    所以回填专名之前要过一遍字形表（日文旧字形 → 简体）。
 *    这张表和术语表同样重要，缺了它译文里到处夹着旧字形。
 *
 * ⑤ **没译到的地方不要装。**
 *    翻完之后仍残留的假名会统计出来（`unmapped` / `coverage`），
 *    界面上如实展示 —— 用户看到哪块没译到，才好回来补词条。
 *    悄悄糊过去比留个尾巴更糟。
 *
 * ⑤ **词典是可维护的数据，不是代码。**
 *    加词只需要往下面的表里加一行。改完记得把 GLOSSARY_VERSION +1，
 *    缓存哈希会跟着变，已译条目才会自动重译。
 * ================================================================== */

/**
 * 词典版本号。
 * ★ 只要改了下面的词条表，就必须把它 +1 ——
 *   翻译缓存用 `hash(原文 + 版本号)` 判断是否需要重译，
 *   不升版本的话，老条目的译文会一直停在旧规则上。
 *
 * v1 → v2：词条没动，但翻译结果里多存了「覆盖率」一项。
 *   不升版本的话已译条目不会重算，界面就永远拿不到
 *   「译得动 / 只译了一半」的区分。
 */
const GLOSSARY_VERSION = 2;

/**
 * 「译得动」的覆盖率门槛。
 *
 * ★ 为什么需要这个数：v1.4.0 只要译文与原文有**一个词**不同就标「译」，
 *   于是一条只把「同窓会」换成「同窗会」、其余全是日文的标题也挂着「译」角标。
 *   面板上于是显示「已译 3293 条」，用户看列表却觉得「大部分没生效」——
 *   两边都没说谎，是指标本身没意义。
 *   低于这个门槛的标「半」（只译到一部分），别冒充完整译名。
 */
const FULL_COVERAGE = 0.75;

/* ------------------------------------------------------------------
 * 1. 厂商 / 系列：日文写法 → 通用中文/官方写法
 * ------------------------------------------------------------------ */
const BRANDS = [
  ['アイデアポケット', 'IDEA POCKET'],
  ['エスワン', 'S1'],
  ['ムーディーズ', 'MOODYZ'],
  ['マドンナ', 'Madonna'],
  ['ワンズファクトリー', 'Wanz Factory'],
  ['プレステージ', 'PRESTIGE'],
  ['アタッカーズ', 'Attackers'],
  ['マキシング', 'MAXING'],
  ['エムズビデオグループ', "M's Video Group"],
  ['ソフト・オン・デマンド', 'SOD'],
  ['ケイ・エム・プロデュース', 'KMP']
];

/* ------------------------------------------------------------------
 * 2. 通用词：发行 / 规格 / 系列
 * ------------------------------------------------------------------ */
const COMMON = [
  ['デビュー', '出道'],
  ['初撮り', '首次拍摄'],
  ['初撮影', '首次拍摄'],
  ['初登場', '首次登场'],
  ['初めて', '第一次'],
  ['新人', '新人'],
  ['専属', '专属'],
  ['専属女優', '专属女优'],
  ['独占配信', '独播'],
  ['独占', '独占'],
  ['限定', '限定'],
  ['永久保存版', '永久收藏版'],
  ['保存版', '收藏版'],
  ['完全版', '完整版'],
  ['総集編', '总集篇'],
  ['コレクション', '合集'],
  ['ベスト', '精选集'],
  ['リメイク', '重制'],
  ['続編', '续篇'],
  ['新作', '新作'],
  ['発売', '发售'],
  ['配信', '上线'],
  ['無修正', '无修正'],
  ['モザイク', '马赛克'],
  ['高画質', '高画质'],
  ['ハイビジョン', '高清'],
  ['フルHD', '全高清'],
  ['ノーカット', '无删减'],
  ['未公開', '未公开'],
  ['特典', '特典'],
  ['映像', '影像'],
  ['前編', '前篇'],
  ['後編', '后篇'],
  ['上巻', '上卷'],
  ['下巻', '下卷'],
  ['記念作品', '纪念作品'],
  ['記念', '纪念'],
  ['解禁', '解禁'],
  ['登場', '登场'],
  ['復活', '复出'],
  ['引退', '引退'],
  ['卒業', '毕业'],
  ['移籍', '转会'],
  ['周年', '周年']
];

/* ------------------------------------------------------------------
 * 3. 人物 / 属性
 * ------------------------------------------------------------------ */
const PEOPLE = [
  ['美少女', '美少女'],
  ['単体作品', '单体作品'],
  ['単体', '单体'],
  ['巨乳', '巨乳'],
  ['爆乳', '爆乳'],
  ['美乳', '美乳'],
  ['美女', '美女'],
  ['美脚', '美腿'],
  ['人妻', '人妻'],
  ['若妻', '年轻妻子'],
  ['熟女', '熟女'],
  ['痴女', '痴女'],
  ['素人', '素人'],
  ['女優', '女优'],
  ['未亡人', '遗孀'],
  ['義母', '继母'],
  ['姉妹', '姐妹'],
  ['家庭教師', '家教'],
  // ナース 归在片假名组，别在这里重复收录（词典重复项有测试拦着）
  ['オフィス', '办公室'],
  ['上司', '上司'],
  ['部下', '下属'],
  ['同僚', '同事'],
  ['同級生', '同学'],
  ['彼氏', '男友'],
  ['彼女', '女友'],
  ['夫婦', '夫妻'],
  // 称呼：日文的「お姉さん」直译成「姐姐」会丢掉语感，中文习惯叫「大姐姐」
  ['お姉さん', '大姐姐'],
  ['お姉ちゃん', '大姐姐'],
  ['お姉様', '大姐姐'],
  ['おばさん', '阿姨'],
  ['おばあちゃん', '奶奶'],
  ['奥さん', '太太'],
  ['奥様', '太太'],
  ['お客様', '客人'],
  ['女の子', '女孩'],
  ['男の子', '男孩'],
  ['おじさん', '大叔'],
  ['おじいちゃん', '爷爷']
];

/* ------------------------------------------------------------------
 * 4. 场景 / 情节（术语化的简短对应，不做发挥）
 * ------------------------------------------------------------------ */
const SCENES = [
  ['中出し', '内射'],
  ['顔射', '颜射'],
  ['ごっくん', '吞精'],
  ['潮吹き', '潮吹'],
  ['調教', '调教'],
  ['催眠', '催眠'],
  ['洗脳', '洗脑'],
  ['痴漢', '痴汉'],
  ['電車', '电车'],
  ['尾行', '跟踪'],
  ['盗撮', '偷拍'],
  ['露出', '露出'],
  ['野外', '野外'],
  ['密室', '密室'],
  ['縛り', '绳缚'],
  ['奴隷', '奴隶'],
  ['玩具', '玩具'],
  ['巨根', '巨根'],
  ['童貞', '处男'],
  ['筆おろし', '破处'],
  ['筆下ろし', '破处'],
  ['ナンパ', '搭讪'],
  ['逆ナン', '女方搭讪'],
  ['合コン', '联谊'],
  ['不倫', '出轨'],
  ['浮気', '外遇'],
  ['寝取られ', '被夺爱'],
  ['本番', '实战'],
  ['温泉', '温泉'],
  ['旅行', '旅行'],
  ['密着', '贴身跟拍'],
  ['ドキュメント', '纪录片'],
  ['リアル', '真实']
];

/* ------------------------------------------------------------------
 * 5. 形容词 / 宣传语
 * ------------------------------------------------------------------ */
const PRAISE = [
  ['大人気', '超人气'],
  ['人気', '人气'],
  ['極上', '极品'],
  ['究極', '究极'],
  ['最高', '最高'],
  ['話題', '话题'],
  ['衝撃', '冲击'],
  ['完全', '完全']
];

/* ------------------------------------------------------------------
 * 7. 常见片假名外来语
 * 片假名是纯表音文字，必须整词收录 —— 逐字转换是不可能的。
 * 这里只收标题里高频的那些；漏掉的会在预览里以「未译」列出来。
 * ------------------------------------------------------------------ */
const KATAKANA = [
  ['アイドル', '偶像'],
  ['コスプレ', '角色扮演'],
  ['ランジェリー', '内衣'],
  ['マッサージ', '按摩'],
  ['エステ', '美容'],
  ['ヨガ', '瑜伽'],
  ['メイド', '女仆'],
  ['ウェディング', '婚纱'],
  ['ドレス', '礼服'],
  ['ナース', '护士'],
  ['スレンダー', '苗条'],
  ['スタイル', '身材'],
  ['キス', '亲吻'],
  ['ベロ', '舌'],
  ['スマホ', '手机'],
  ['カメラ', '相机'],
  ['ホテル', '酒店'],
  ['ラブホテル', '情侣酒店'],
  ['ビジネス', '商务'],
  ['オナニー', '自慰'],
  ['フェラ', '口交'],
  ['パイズリ', '乳交'],
  ['ローション', '润滑液'],
  ['バイブ', '震动棒'],
  ['ローター', '跳蛋'],
  ['おもちゃ', '玩具'],
  ['ドキュメンタリー', '纪录'],
  ['インタビュー', '访谈'],
  ['コンプリート', '完整收录'],
  ['リクエスト', '点播'],
  ['アンケート', '问卷'],
  ['ファン', '粉丝'],
  ['デート', '约会'],
  ['ラブラブ', '甜蜜'],
  ['ドキドキ', '心跳'],
  ['ハメ撮り', '手持自拍'],
  ['オフ会', '线下聚会'],
  ['パパ活', '包养约会'],
  ['ママ活', '被包养'],
  ['ノーブラ', '不穿内衣'],
  ['パンスト', '丝袜'],
  ['ニーハイ', '过膝袜'],
  ['スクール', '校园'],
  ['セーラー服', '水手服'],
  ['ブルマ', '运动短裤'],
  ['水着', '泳装'],
  ['ランキング', '排行榜'],
  ['サンプル', '样品']
];

/* ------------------------------------------------------------------
 * 6. 量词 / 时间
 * ★ 「時間 → 小时」必须在「分 → 分钟」之前，否则「4時間」会被拆成「4时」+「间」
 * ------------------------------------------------------------------ */
const UNITS = [
  ['時間', '小时'],
  ['枚組', '张套装'],
  ['分間', '分钟']
];

/**
 * 助词。
 * ⚠️ 单字词条很危险 —— 它们会把别的词撕开（`はじめ` 被「は」咬掉就废了）。
 *    所以这里只收助词，而且除了 `の` 之外都要求「左边紧邻中日文字符」才替换，
 *    避免误伤词首。
 *    值给空串 = 直接丢掉（中文里没有对应虚词，留着反而是乱码）。
 */
const PARTICLES = [
  ['の', '的'],
  ['と', '与'],
  ['や', '与'],
  ['を', ''],
  ['が', ''],
  ['は', ''],
  ['に', ''],
  ['へ', '向'],
  ['で', ''],
  ['も', '也'],
  // 敬称/接尾：中文里没有对应成分，留着只是乱码，直接丢掉
  ['さん', ''],
  ['ちゃん', ''],
  ['様', ''],
  ['君', '']
];

/* ------------------------------------------------------------------
 * 8. 假名词（平假名/片假名混写的小词）
 *
 * ⚠️ 这一组必须**整词收录**。反例：`昼下がり` 里的 `が` 会被助词规则当虚词删掉
 *    →「昼下り」。助词规则无论如何都会误伤一部分词，补救办法只有把词收进来
 *    （术语替换在长度上优先于助词）。
 * ------------------------------------------------------------------ */
const KANA_WORDS = [
  ['昼下がり', '午后'],
  ['夕暮れ', '黄昏'],
  ['真夜中', '深夜'],
  ['はじめて', '第一次'],
  ['かわいい', '可爱'],
  ['きれい', '漂亮'],
  ['すごい', '厉害'],
  ['いっぱい', '满满'],
  ['たくさん', '很多'],
  ['ください', '请'],
  ['お願い', '拜托'],
  ['いやらしい', '淫荡'],
  ['感じる', '感受'],
  ['イク', '高潮'],
  ['おっぱい', '胸部'],
  ['お尻', '臀部'],
  ['あそこ', '私处'],
  ['エッチ', '色色']
];

/**
 * 日文旧字形 / 繁体 → 简体字形表。
 *
 * ★ 为什么必须有这张表：
 *   术语表只能收录「整词」。标题里剩下的汉字会原样留在译文里，
 *   而它们用的是**日文写法**：
 *       専属決定 → 读者看到的是「専属決定」，而中文应当写「专属决定」
 *       夫婦交換 → 「夫妇交换」   家庭教師の誘惑 → 「家教的诱惑」
 *   不做这一步，译文里就会到处夹着旧字形，一眼就看出是半成品。
 *
 * ⚠️ 只收「日文这么写、中文不这么写」的字。中日写法相同的字一个都不能放进来，
 *   否则会把本来正确的字改错。测试里对这张表做了格式校验。
 *
 * 格式：`日文写法:简体写法`，用空白分隔，`#` 开头是注释。
 */
const KANJI_J2S = `
  # ── 日文新字体（战后自行简化）──
  # 这一批才是标题里真正会出现的：日文把舊字體简化成了自己的写法，
  # 和中文的简化方案不一定相同（例：日文「図」中文「图」）。
  発:发 髪:发 髮:发 専:专 決:决 極:极 読:读 撃:击 対:对 関:关 楽:乐 様:样
  説:说 実:实 戦:战 顔:颜 辺:边 顕:显 観:观 売:卖 転:转 軽:轻 銭:钱
  録:录 鉄:铁 駅:站 産:产 権:权 従:从 円:圆 囲:围 団:团 壊:坏 聴:听
  脳:脑 臓:脏 挙:举 処:处 覚:觉 証:证 賛:赞 釈:释 隠:隐 歴:历 広:广
  応:应 慶:庆 懐:怀 栄:荣 検:检 浄:净 満:满 済:济 獣:兽 穏:稳 競:竞
  節:节 縁:缘 継:继 絶:绝 聡:聪 粛:肃 譲:让 価:价 児:儿 暁:晓 図:图
  厳:严 剣:剑 繊:纤 総:总 徳:德 恵:惠 稲:稻 亜:亚 営:营 衛:卫 塩:盐
  桜:樱 犠:牺 戯:戏 拠:据 挟:夹 蛍:萤 渓:溪 鶏:鸡 芸:艺 県:县 圏:圈
  鉱:矿 効:效 黒:黑 砕:碎 剤:剂 糸:丝 舎:舍 収:收 渋:涩 縦:纵 諸:诸
  奨:奖 剰:剩 畳:叠 縄:绳 壌:壤 嬢:娘 錠:锭 粋:粹 酔:醉 穂:穗 髄:髓
  枢:枢 瀬:濑 畝:亩 製:制 併:并 倹:俭 剝:剥 罵:骂 賄:贿 稜:棱 箇:个
  籠:笼 繕:缮 脈:脉 腳:脚 脫:脱 艦:舰 粧:妆 繭:茧 與:与 參:参 圖:图
  嚴:严 擴:扩 攝:摄 戶:户 執:执 兒:儿 齒:齿 龍:龙 齊:齐 價:价 傳:传
  # ── 舊字體（日文与繁体同形，中文已简化）──
  屬:属 換:换 誘:诱 婦:妇 畫:画 號:号 場:场 現:现 學:学 體:体 際:际
  護:护 險:险 驗:验 點:点 過:过 進:进 遠:远 適:适 選:选 達:达 連:连
  開:开 間:间 問:问 隊:队 難:难 電:电 願:愿 類:类 語:语 課:课 記:记
  認:认 識:识 談:谈 論:论 買:买 賣:卖 質:质 費:费 資:资 車:车 較:较
  輪:轮 載:载 鐘:钟 鋼:钢 錯:错 鏡:镜 長:长 門:门 頁:页 頂:顶 順:顺
  須:须 題:题 額:额 風:风 飛:飞 飯:饭 館:馆 馬:马 惡:恶 壓:压 變:变
  練:练 毎:每 氣:气 焼:烧 經:经 絵:绘 給:给 結:结 續:续 網:网 線:线
  習:习 職:职 誰:谁 調:调 講:讲 謝:谢 議:议 豊:丰 貯:贮 貸:贷 購:购
  遅:迟 遊:游 運:运 郵:邮 郷:乡 醸:酿 鈴:铃 鍋:锅 閉:闭 陸:陆 陽:阳
  陰:阴 陣:阵 雑:杂 雲:云 飲:饮 飼:饲 見:见 貝:贝 員:员 園:园 膚:肤
  華:华 葉:叶 術:术 衝:冲 補:补 親:亲 討:讨 訓:训 訊:讯 訪:访 訴:诉
  診:诊 詐:诈 評:评 詞:词 試:试 詩:诗 詳:详 誠:诚 誕:诞 誌:志 實:实
  貫:贯 責:责 貴:贵 貿:贸 貼:贴 賀:贺 賓:宾 賭:赌 贈:赠 跡:迹 軌:轨
  軟:软 輝:辉 輸:输 農:农 針:针 釣:钓 鈍:钝 銀:银 銅:铜 鎖:锁 閃:闪
  閣:阁 閲:阅 階:阶 韓:韩 項:项 預:预 領:领 頭:头 頸:颈 頻:频 顆:颗
  顧:顾 飾:饰 飽:饱 養:养 駐:驻 騎:骑 驚:惊 魚:鱼 鳥:鸟 鳴:鸣 麗:丽
  為:为 爭:争 卻:却 應:应 懸:悬 樹:树 橫:横 標:标 橋:桥 機:机 殺:杀
  沒:没 溫:温 濕:湿 災:灾 獨:独 獻:献 猶:犹 獄:狱 環:环 畢:毕 疊:叠
  盡:尽 監:监 盤:盘 矯:矫 礦:矿 禪:禅 積:积 窮:穷 竊:窃 筆:笔 範:范
  築:筑 簡:简 籃:篮 緊:紧 緒:绪 織:织 繪:绘 羅:罗 聖:圣 聞:闻 聯:联
  脅:胁 艱:艰 壽:寿 夢:梦 覺:觉 計:计 訂:订 話:话 該:该 誤:误 請:请
  財:财 愛:爱 損:损 數:数 斷:断 時:时 書:书 復:复 戲:戏 優:优 備:备
  勝:胜 務:务 動:动 勢:势 億:亿 個:个 們:们 兩:两 單:单 區:区 協:协
  堅:坚 奪:夺 奧:奥 敵:敌 於:于 細:细 統:统 總:总 聯:联 腦:脑 歐:欧
`;

/** 全部词条（顺序不影响结果，构造时会按长度重排） */
const GLOSSARY = [].concat(
  BRANDS, COMMON, PEOPLE, KATAKANA, KANA_WORDS, SCENES, PRAISE, UNITS
);

/** 助词表单独导出，方便测试「单字只允许出现在这里」 */
const GLOSSARY_PARTICLES = PARTICLES;

/* ------------------------------------------------------------------
 * 字形归一化：日文旧字形 → 简体
 * ------------------------------------------------------------------ */

/**
 * 解析字形表。
 * 忽略：注释、格式不对的条目、以及左右相同的条目（同形字本来就不需要映射）。
 * 这样即使表里手滑写了一两条错的，也只是被跳过，不会改错字。
 */
function buildKanjiMap() {
  const m = new Map();
  for (const tok of KANJI_J2S.split(/\s+/)) {
    if (!tok || tok[0] === '#') continue;
    if (tok.length !== 3 || tok[1] !== ':') continue;   // 只接受「一个字:一个字」
    const from = tok[0];
    const to = tok[2];
    if (from === to) continue;
    if (m.has(from) && m.get(from) !== to) {
      // 同一个字被映射成两个结果 → 表写错了，保留先出现的那个并报警
      console.warn(`[jv115-tagger] 字形表冲突：${from} → ${m.get(from)} / ${to}，已忽略后者`);
      continue;
    }
    m.set(from, to);
  }
  return m;
}

let _kanjiMap = null;

/**
 * 逐字把残留的日文旧字形换成简体。
 * ★ 必须在**专名回填之前**调用 —— 否则会把演员名里的字也改掉。
 */
function normalizeKanji(s) {
  if (!_kanjiMap) _kanjiMap = buildKanjiMap();
  let out = '';
  for (const ch of String(s == null ? '' : s)) out += _kanjiMap.get(ch) || ch;
  return out;
}

/** 供测试与文档用：字形表的有效条目数 */
function kanjiTableSize() {
  return buildKanjiMap().size;
}

/* ------------------------------------------------------------------
 * 词典构建（惰性，只做一次）
 * ------------------------------------------------------------------ */

/** 全角转半角等统一处理：`ＡＶ`→`AV`、`４時間`→`4時間` */
function norm(s) {
  const t = String(s ?? '');
  try { return t.normalize('NFKC'); } catch (e) { return t; }
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

let _glossaryRe = null;
let _glossaryMap = null;

function buildGlossary() {
  if (_glossaryRe) return { re: _glossaryRe, map: _glossaryMap };
  // 去重：同一条词条只保留第一次出现的译法
  const map = new Map();
  for (const [ja, zh] of GLOSSARY) {
    const k = norm(ja).trim();
    if (!k || map.has(k)) continue;
    map.set(k, zh);
  }
  // ★ 最长优先：按长度倒序拼 alternation，长的排在前面才会先命中
  const keys = [...map.keys()].sort((a, b) => b.length - a.length);
  _glossaryMap = map;
  _glossaryRe = keys.length
    ? new RegExp(keys.map(escapeRe).join('|'), 'g')
    : /(?!)/g;
  return { re: _glossaryRe, map: _glossaryMap };
}

/** 供测试与文档用：返回「去重后」的词条数量 */
function glossarySize() {
  return buildGlossary().map.size;
}

/* ------------------------------------------------------------------
 * 专名保护
 * ------------------------------------------------------------------ */

/** 会把标题撕开、且绝不该翻译的东西，全部换成占位符 */
function protectSpecials(text, ctx = {}) {
  const slots = [];
  const patterns = [];

  const pushLiteral = (v) => {
    const s = norm(v).trim();
    if (s.length < 2) return;
    // 名字里的空格可能被网页改写成不同宽度 → 用 \s* 串起来匹配
    const loose = s.split('').map(escapeRe).join('\\s*');
    patterns.push(loose);
  };

  // ① 番号：优先用收录时已经提取好的 code（最准）
  if (ctx.code) pushLiteral(String(ctx.code).toUpperCase());
  // ② 兜底：形如 ABCD-123 的番号（NFKC 之后连字符只剩半角一种）
  patterns.push('[A-Z]{2,8}-\\d{2,6}');
  // ③ 演员名：一个都不许翻
  for (const a of Array.isArray(ctx.actresses) ? ctx.actresses : []) pushLiteral(a);

  if (!patterns.length) return { text, slots };

  const re = new RegExp(patterns.join('|'), 'gi');
  const out = text.replace(re, (m) => {
    const i = slots.length;
    slots.push(m);
    return `\u0001${i}\u0002`;
  });
  return { text: out, slots };
}

function restoreSpecials(text, slots) {
  if (!slots.length) return text;
  return text.replace(/\u0001(\d+)\u0002/g, (m, i) => {
    const v = slots[Number(i)];
    return v == null ? m : v;
  });
}

/* ------------------------------------------------------------------
 * 清洗
 * ------------------------------------------------------------------ */

function polish(s) {
  let t = String(s);

  // 标点统一
  t = t.replace(/[～〜]/g, '~');
  t = t.replace(/[・･]{2,}/g, '·');
  t = t.replace(/[、]{2,}/g, '、');
  t = t.replace(/[ ]{2,}/g, ' ');
  // 标点两侧不要空格
  t = t.replace(/\s*([、，。！？：；·])\s*/g, '$1');
  // 空括号直接清掉
  t = t.replace(/[（(]\s*[）)]/g, '');
  t = t.replace(/([（(])\s+/g, '$1').replace(/\s+([）)])/g, '$1');
  // 重复词合并：中出し中出し → 内射内射 → 内射
  t = t.replace(/([\u4e00-\u9fa5]{2,6})\1/g, '$1');
  t = t.replace(/的{2,}/g, '的');
  // 中英之间补一个空格，读起来才不像连在一起
  t = t.replace(/([\u4e00-\u9fa5])([A-Za-z0-9])/g, '$1 $2');
  t = t.replace(/([A-Za-z0-9])([\u4e00-\u9fa5])/g, '$1 $2');
  // 首尾多余的分隔符
  t = t.replace(/^[\s·、,，\-–—~]+/, '').replace(/[\s·、,，\-–—~]+$/, '');
  t = t.replace(/\s{2,}/g, ' ').trim();
  return t;
}

/** 助词替换：除 `の` 外都要求左边紧邻中日文字符，避免咬到词首 */
function applyParticles(s) {
  let t = String(s);
  for (const [ja, zh] of PARTICLES) {
    if (ja === 'の') {
      t = t.replace(/の/g, zh);
    } else {
      const re = new RegExp(`([\\u4e00-\\u9fa5\\u3040-\\u30ff])${escapeRe(ja)}`, 'g');
      t = t.replace(re, (m, p1) => p1 + zh);
    }
  }
  return t;
}

/* ------------------------------------------------------------------
 * 主函数
 * ------------------------------------------------------------------ */

/**
 * 把一个日文标题译成中文。
 *
 * @param {string} jaTitle 原始标题
 * @param {object} [ctx]    { code, actresses }
 * @returns {{zh:string, ja:string, changed:boolean, coverage:number,
 *            unmapped:string[], bad:number, translated:number}}
 *   - `zh`        译文；**没译到任何东西时返回空串**（交给调用方决定回退原文）
 *   - `changed`   是否真的改动过
 *   - `coverage`  0~1，粗略表示「有多少内容被译到」
 *   - `unmapped`  残留的假名片段（界面上如实提示，方便回来补词条）
 *   - `translated` 命中的词条数，`bad` 保护掉的专名数
 */
function translateTitle(jaTitle, ctx = {}) {
  const raw = String(jaTitle ?? '').trim();
  const empty = {
    zh: '', ja: raw, changed: false, coverage: 0, unmapped: [], bad: 0, translated: 0
  };
  if (!raw) return empty;

  // ① 专名占位
  const guarded = protectSpecials(norm(raw), ctx);

  // ② 词条替换（最长优先），顺便数一下命中次数
  const { re, map } = buildGlossary();
  let hits = 0;
  let out = guarded.text.replace(re, (m) => {
    hits++;
    return map.get(m);
  });

  // ③ 助词
  out = applyParticles(out);

  /*
   * ④ 字形归一化。
   * 术语表只能收「整词」，剩下的汉字会原样流下来 —— 而那些是**日文写法**
   * （夫婦交換 / 家庭教師の誘惑 / 専属決定）。不做这一步，译文里就到处是旧字形，
   * 一眼看出是半成品。这一步和专名保护一样，必须排在回填之前。
   */
  out = normalizeKanji(out);

  // ⑤ 清洗（此时专名还是占位符，不会被清洗规则碰到）
  out = polish(out);

  /*
   * ⑥ 统计残留假名。
   * ★ 必须放在**回填之前** —— 演员名本身是日文，
   *   回填后再数假名会把「被保护起来的专名」也算成「没译到」，
   *   于是每条带演员名的标题 coverage 都会虚低，这个指标就废了。
   */
  const kana = out.match(/[\u3040-\u309f\u30a0-\u30ff]+/g) || [];
  const unmapped = [...new Set(kana.map((x) => x.trim()).filter(Boolean))];
  const body = out.replace(/[\s\u0001\u0002\d]/g, '');
  const kanaLen = kana.join('').length;
  const coverage = body.length ? Math.max(0, Math.min(1, 1 - kanaLen / body.length)) : 0;

  // ⑦ 专名回填（番号 / 演员名原样换回来）
  out = restoreSpecials(out, guarded.slots);

  const changed = out !== raw;
  if (!changed) return { ...empty, bad: guarded.slots.length };

  return {
    zh: out,
    ja: raw,
    changed: true,
    coverage: Number(coverage.toFixed(3)),
    unmapped,
    bad: guarded.slots.length,
    translated: hits
  };
}

/**
 * 缓存用哈希。
 * ★ 把 GLOSSARY_VERSION 混进去是**必须的**：
 *   这样一改词典，所有已译条目的哈希都对不上，会被自动重译。
 *   否则用户加了词条却发现老标题纹丝不动，只会以为功能坏了。
 */
function hashTitle(jaTitle) {
  const s = `${norm(jaTitle)}#v${GLOSSARY_VERSION}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/* ------------------------------------------------------------------
 * 展示：中文一行 + 原文放悬停
 * ------------------------------------------------------------------ */

/**
 * 算出列表里该显示什么。
 *
 * ★ 默认只显示**一行中文**，原文放进 `hover`（鼠标悬停才看）。
 *   早先默认是「中文主行 + 原文副行」两行，实测列表太挤、每条都占两行，
 *   反而不好扫 —— 原文不是不用，是不该常驻占位。
 *
 * @param {object} rec  资料库记录（用到 title / titleZh / titleCoverage / titleSrc / fileName）
 * @param {string} mode 'zh' 只中文（默认，原文放悬停）
 *                      'zh-ja' 中文一行 + 原文一行（想看原文时再切）
 *                      'ja' 只原文
 * @returns {{main:string, sub:string, hover:string, badge:string, translated:boolean}}
 *          badge: '' 无译文 / 'full' 译得动 / 'part' 只译到一部分
 */
function titleDisplayParts(rec, mode = 'zh') {
  const ja = String(rec?.title || '').trim();
  const zh = String(rec?.titleZh || '').trim();
  const fallback = String(rec?.fileName || '');
  const hasZh = !!zh && zh !== ja;

  if (mode === 'ja') {
    return { main: ja || fallback, sub: '', hover: '', badge: '', translated: false };
  }
  // 没有译文就老实显示原文，**不要留空白**
  if (!hasZh) {
    return { main: ja || fallback, sub: '', hover: '', badge: '', translated: false };
  }

  const hover = ja && ja !== zh ? ja : '';
  /*
   * 覆盖率缺失时（老记录、或从备份导入的）按「译得动」算 ——
   * 宁可多标一个「译」，也不要给用户一堆没来由的「半」。
   */
  const cov = Number(rec?.titleCoverage);
  const full = Number.isFinite(cov) ? cov >= FULL_COVERAGE : true;
  // 只有术语表产出的译文才挂角标；将来若支持手工译名，手工的不该标成「机器译」
  const badge = rec?.titleSrc === 'glossary' ? (full ? 'full' : 'part') : '';

  if (mode === 'zh-ja') {
    return { main: zh, sub: ja, hover, badge, translated: true };
  }
  return { main: zh, sub: '', hover, badge, translated: true };
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

// 统计口径要用到「译得动」的覆盖率门槛（bundler 会把 glossary.js 排在前面）

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
    /*
     * 中文标题（术语表翻译）。跟 title 一样从元数据抄一份到条目上 ——
     * 列表渲染读的是 library 记录，不抄的话译文要等下次收录才看得到。
     * 翻译本身是按「番号」缓存在 meta 表里的，这里只是个副本。
     */
    titleZh: src ? (src.titleZh || (keepPrev ? prev.titleZh || '' : '')) : (keepPrev ? prev.titleZh || '' : ''),
    titleSrc: src ? (src.titleSrc || (keepPrev ? prev.titleSrc || '' : '')) : (keepPrev ? prev.titleSrc || '' : ''),
    /*
     * 译文覆盖率（0~1）。用来区分「译得动」和「只译到一两个词」——
     * 没有这个数就只能知道「有没有译文」，而一条 56% 覆盖率的标题
     * 在界面上看起来和完整译名没区别，用户只会觉得「根本没翻译」。
     */
    titleCoverage: Number.isFinite(src?.titleCoverage)
      ? src.titleCoverage
      : (keepPrev ? prev.titleCoverage : undefined),
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
 * 取一条记录的译文覆盖率。
 *
 * 没这个字段的记录（v1.4.0 存下来的，当时只存了译文本身）按「译得动」算 ——
 * 不确定的时候宁可归到「能读」，也不要凭空给用户一堆「半译」。
 * 升到 GLOSSARY_VERSION 2 之后重译一次，这个字段就会补齐。
 */
function covOf(r) {
  const c = Number(r?.titleCoverage);
  return Number.isFinite(c) ? c : 1;
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
    /*
     * 标题中译的完成度分档。
     * ★ v1.4.0 用的是「只要有改动就算已译」，结果一条只译对一个词的标题
     *   也计入「已译」，面板显示「已译 3293 条」而列表看着像没生效。
     *   现在按覆盖率分三档，让用户一眼看出真正能读的有多少。
     */
    trFull: all.filter((r) => r.titleZh && covOf(r) >= FULL_COVERAGE).length,
    trPart: all.filter((r) => r.titleZh && covOf(r) < FULL_COVERAGE).length,
    trNone: all.filter((r) => !r.titleZh).length,
    actresses: tally((r) => r.actresses || []),
    genres: tally((r) => r.genres || []),
    cids: tally((r) => (r.cid ? [r.cid] : []))
  };
}

/**
 * 把「番号 → 中文标题」写回 meta，并同步到所有引用它的资料库条目。
 *
 * 为什么必须同步两处：
 *   - `meta` 是翻译的**存放处**（按番号缓存，同一部片只译一次）
 *   - `library` 是列表**渲染时的数据源**（它存的是副本）
 *   只写 meta 的话，列表里看不到译文，得重收一次目录才生效 —— 那个体验很差。
 */
async function applyTitleZhBatch(entries) {
  if (!entries || !entries.length) return { meta: 0, library: 0 };
  const db = await openDB();
  const byCode = new Map();
  for (const e of entries) if (e && e.code) byCode.set(String(e.code), e);
  if (!byCode.size) return { meta: 0, library: 0 };

  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_META, STORE_LIBRARY], 'readwrite');
    const metaStore = tx.objectStore(STORE_META);
    const libStore = tx.objectStore(STORE_LIBRARY);
    let metaHits = 0;
    let libHits = 0;

    // ① 元数据：按 code 取回来合并。取不到就跳过 —— 不凭空造记录
    for (const [code, e] of byCode) {
      const req = metaStore.get(code);
      req.onsuccess = () => {
        const cur = req.result;
        if (cur) { metaStore.put(Object.assign({}, cur, e)); metaHits++; }
      };
    }

    // ② 资料库：把译文抄到每个同番号的条目上
    const all = libStore.getAll();
    all.onsuccess = () => {
      for (const r of all.result || []) {
        const e = byCode.get(String(r.code || ''));
        if (!e) continue;
        /*
         * 原文没变、译名和覆盖率也没变 → 不必写回（省 I/O）。
         * ★ 覆盖率也要比：只比译文的话，老记录补覆盖率这一步会被跳过，
         *   列表就永远拿不到「译得动 / 只译了一半」的区分。
         */
        if (
          r.titleZh === e.titleZh &&
          r.titleHash === e.titleHash &&
          r.titleCoverage === e.titleCoverage
        ) continue;
        libStore.put(Object.assign({}, r, {
          titleZh: e.titleZh,
          titleSrc: e.titleSrc,
          titleHash: e.titleHash,
          titleCoverage: e.titleCoverage
        }));
        libHits++;
      }
    };

    tx.oncomplete = () => resolve({ meta: metaHits, library: libHits });
    tx.onerror = () => reject(tx.error);
  });
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
  playerUrlTemplate: DEFAULT_PLAYER_URL,
  /**
   * 标题中译（见 core/glossary.js）。
   * 纯本地术语表，不联网、不花钱、没有内容审核问题。
   * 自动模式：每次查询元数据后顺手把新标题译掉，用户不用手动点。
   */
  autoTranslateTitles: true,
  /**
   * 资料库列表里标题怎么显示：
   *   'zh'    只显示中文一行，原文放到鼠标悬停（默认）
   *   'zh-ja' 中文一行 + 原文一行（想常驻对照时再切）
   *   'ja'    只显示原文
   */
  titleDisplay: 'zh'
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
 * core/paging.js
 * ================================================================== */

/**
 * 资料库列表的分批渲染（懒加载）
 * ------------------------------------------------------------------
 * 为什么需要它：
 *   命中几千条时一次性塞进 DOM 会卡；更要命的是**用户看不见「下面还有多少」** ——
 *   旧实现是 `rows.slice(0, 300)` 静默截断，既不说截断了、也没法继续看，
 *   观感就是「筛选完显示不全，也没有翻页」。
 *
 * 现在的做法：
 *   · 先渲染前 LIB_PAGE_SIZE 条；
 *   · 滚到底部（footer 进入视口）自动追加下一批；
 *   · 底部常驻一行状态，写明「已显示 X / 共 Y 条」或「已全部显示」。
 *
 * 这里只放**纯计算**（方便单测）；DOM 操作在 panel.js 里。
 * ⚠️ 打包器把所有模块拼进同一作用域，常量名全局唯一。
 */

/** 每批渲染多少条（用户要求：默认显示 50 条） */
const LIB_PAGE_SIZE = 50;

/**
 * 算出下一批要渲染的区间。
 *
 * @param {number} total 本次筛选命中的总条数
 * @param {number} shown 已经渲染了多少条
 * @param {number} [size] 每批条数
 * @returns {{from:number, to:number, added:number, hasMore:boolean}}
 *          from/to 为 [from, to) 左闭右开区间；added 是本批新增条数
 */
function libPageWindow(total, shown, size = LIB_PAGE_SIZE) {
  // 容错：任何非数字/负数/越界的输入都要夹到合法区间，绝不能算出 NaN 让 slice 静默返回空数组
  const t = Math.max(0, Math.floor(Number(total)) || 0);
  const s = Math.min(Math.max(0, Math.floor(Number(shown)) || 0), t);

  /*
   * size 非法（NaN / 0 / 负数）一律**回落默认值**。
   * ⚠️ 不能写成 `Math.max(1, size || DEFAULT)`：负数是 truthy，
   *    会被 max 抬成 1 —— 退化成「一次一条」，比报错还难发现。
   */
  const rawStep = Math.floor(Number(size));
  const step = Number.isFinite(rawStep) && rawStep > 0 ? rawStep : LIB_PAGE_SIZE;

  const from = s;
  const to = Math.min(from + step, t);
  return { from, to, added: to - from, hasMore: to < t };
}

/**
 * 底部状态行文案。
 *
 * 关键点：**加载完必须明确说「已全部显示」**。
 * 否则用户滚到底看到没有新内容，仍会怀疑「是不是还有没加载出来的」——
 * 这正是这次要修的观感问题。
 *
 * @param {number} total 命中总数
 * @param {number} shown 已渲染条数
 * @param {boolean} [loading] 是否正在加载
 * @returns {string} 空串表示不需要 footer
 */
function libFootText(total, shown, loading = false) {
  const t = Math.max(0, Math.floor(Number(total)) || 0);
  const s = Math.min(Math.max(0, Math.floor(Number(shown)) || 0), t);

  if (t === 0) return '';
  if (loading) return `正在加载… 已显示 ${s} / ${t} 条`;
  if (s >= t) return `已全部显示（共 ${t} 条）`;
  return `已显示 ${s} / 共 ${t} 条 · 继续下滑自动加载`;
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
  /*
   * v1.4.2：74vh → 80vh。
   * 抽屉越矮，「资料库」列表能分到的高度就越少（筛选区 + 底部按钮是固定开销）。
   * 抽屉 bottom 固定 84px，80vh 在 768px 高的窗口上顶部仍留 54px，
   * 不会顶出屏幕；其它页签本来就能滚动，不受影响。
   */
  max-height: 80vh;
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

/*
 * .body 是抽屉的内容区（flex column）。绝大多数页签内容超出时由它滚动；
 * 但「资料库」页例外 —— 见下面的 #pane-library 规则。
 */
.body { padding: 12px 14px; overflow-y: auto; flex: 1; display: flex; flex-direction: column; }
.pane { display: none; }
.pane.active { display: block; flex-shrink: 0; }

/*
 * 资料库页：让列表吃满抽屉的剩余高度，滚动**只发生在列表内部**。
 *
 * 为什么必须单独处理：旧版 .lib-list 被限死在 max-height 320px，
 * 而外层 .body 又是个滚动容器 —— 两层嵌套滚动。43 条结果挤在巴掌大的
 * 窗口里滚，用户看到的就是「筛选完显示不全，也没有翻页」。
 * flex: 1 1 auto + min-height: 0 是让它在抽屉高度内收缩的关键。
 */
#pane-library.active {
  display: flex; flex-direction: column;
  flex: 1 1 auto; min-height: 0;
}

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
.lib-search { display: flex; gap: 8px; margin-bottom: 8px; }
.lib-search input { flex: 1; min-width: 0; }

/*
 * 筛选区：演员 / 类别 并排各占一半（v1.4.2）。
 * 竖着排要吃掉 84px，并排只要 34px —— 列表因此能多显示一条结果。
 * 抽屉宽度固定 380px，所以这里不存在窄屏挤坏的问题。
 */
.lib-filters { display: flex; gap: 8px; }
.lib-filters .dd { flex: 1; min-width: 0; margin-bottom: 0; }
.lib-filters .dd-btn { padding: 6px 9px; gap: 6px; }
/*
 * 面板要给个最小宽度：按钮只有半宽（172px），演员列表塞在里面没法用。
 * 右半边的面板必须往左展开，否则会顶出抽屉边界。
 */
.lib-filters .dd-panel { min-width: 258px; }
.lib-filters .dd:last-child .dd-panel { left: auto; right: 0; }

/*
 * 统计行：钉死单行。
 * 原来「资料库共 3869 条 · 当前筛选命中 59 条 · 其中 59 条有标签 · 中译译得动 560 …」
 * 在 352px 内必然折成两行，白占 18px。文案缩短 + nowrap + 省略号，
 * 无论后面再拼多少段都只占一行；完整含义放进 title。
 */
.lib-stat {
  margin: 6px 0; font-size: 11px; line-height: 1.5;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

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

/*
 * 列表区：吃满资料库页的剩余高度（原来写死 max-height: 320px）。
 * min-height 兜底，避免抽屉很矮时列表被压成一条缝。
 */
.lib-list {
  flex: 1 1 auto; min-height: 180px; overflow-y: auto;
  border: 1px solid #eef0f3; border-radius: 8px;
}
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
/* 标题主行：v1.4.0 起这里是**中文**（没译出时退回原文） */
.lib-item .ttl {
  font-size: 12.5px; color: #1f2329; margin-top: 2px; line-height: 1.45;
  overflow: hidden; display: -webkit-box;
  -webkit-line-clamp: 2; -webkit-box-orient: vertical;
}
/*
 * 原日文副行：机器译名只当索引用，原文才是权威，所以保留但压暗。
 * v1.4.1 起默认不再显示这一行（原文改到鼠标悬停），只有把显示方式切成
 * 「中文一行 + 原文一行」时才用得上。
 */
.lib-item .ttl-ja {
  font-size: 11px; color: #9aa3b2; margin-top: 1px; line-height: 1.4;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* 「译」= 这份译文基本能读；「半」= 只译到一部分，剩下的还是日文 */
.lib-item .badge.tr { background: #eef2ff; color: #2b5cff; border: 1px solid #ccd8ff; }
.lib-item .badge.tr.half { background: #fdf6e8; color: #8a6d3b; border-color: #f0e0c0; }
.lib-item .tags {
  font-size: 11px; color: #8a94a6; margin-top: 3px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.lib-item .tags b { color: #2b5cff; font-weight: 500; }
.lib-item .act { flex-shrink: 0; display: flex; flex-direction: column; gap: 4px; }
.lib-empty { text-align: center; color: #a8b0bd; padding: 30px 0; font-size: 12.5px; }
/*
 * 列表底部状态行。作用不只是好看 —— 它要明确告诉用户
 * 「已显示 X / 共 Y 条」，加载完则写「已全部显示」。
 * 少了这句，用户滚到底没看到新内容，仍会怀疑「是不是还有没加载出来的」。
 */
.lib-foot {
  display: flex; align-items: center; justify-content: center; gap: 8px;
  padding: 10px 8px; font-size: 11.5px; color: #a8b0bd; text-align: center;
}
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

// v1.3.1：资料库列表改分批渲染（懒加载），窗口计算是纯函数、有单测

// v1.4.0：标题中译的展示规则（同样是纯函数、有单测）


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
        <button class="btn" id="btnTitleSample">🈶 译名对照（看哪条没译好）</button>
      </div>

      <div class="list" id="scanList" style="margin-top:12px"></div>
    </div>

    <!-- 资料库 -->
    <div class="pane" id="pane-library">
      <div class="lib-search">
        <input type="text" class="grow" id="libKw" placeholder="搜索番号 / 标题 / 演员 / 类别…">
        <button class="btn sm" id="btnLibReload">刷新</button>
      </div>

      <!--
        筛选区从四行压成两行（原来约 171px，现在约 98px）。
        抽屉是固定 380px 宽、74vh 高，筛选区每让出 1px，下面的列表就多 1px ——
        这是「想一眼看到更多结果」最划算的地方。

        两行布局：
          第一行 [搜索] [刷新]
          第二行 [演员 ▾] [类别 ▾]   ← 并排各占一半
        统计行挪到最下面，并用 CSS 钉成**单行不折行**（原来要折两行，白占 18px）。
      -->
      <div class="lib-filters">
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
      </div>

      <div class="hint lib-stat" id="libStat">资料库为空，先到「扫描」页签点「📥 收录本目录」。</div>

      <div class="lib-list" id="libList"></div>

      <!--
        按钮文案刻意压短：原来四条会折成两行（多占 34px 列表高度），
        现在能排在一行。详细说明都在 title 里。
      -->
      <div class="btnrow">
        <button class="btn sm primary" id="btnTranslate" title="用本地术语表把日文标题译成中文（不联网、免费）">🌐 翻译</button>
        <button class="btn sm" id="btnLibClearFilter" title="清空关键词与演员 / 类别筛选">清空筛选</button>
        <button class="btn sm" id="btnLibExport" title="把整个资料库导出成 JSON 备份">导出资料库</button>
        <button class="btn sm" id="btnPurgeGone" title="把已失效（网盘里已不存在）的条目从资料库移除">🗑 清理失效</button>
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

      <div style="border-top:1px solid #eef0f3;margin:14px 0 12px"></div>
      <div class="hint" style="margin-bottom:8px">
        <b>标题中译</b>。用本地术语表把日文片名译成中文 ——
        <b>不联网、不花钱、无内容审核问题</b>。
      </div>
      <div class="row">
        <label style="width:96px">标题显示</label>
        <select class="grow" id="cfgTitleDisplay">
          <option value="zh">只显示中文（原文放悬停，推荐）</option>
          <option value="zh-ja">中文一行 + 原文一行</option>
          <option value="ja">只显示原文</option>
        </select>
      </div>
      <div class="row">
        <label class="grow">查询后自动翻译新标题</label>
        <input type="checkbox" id="cfgAutoTranslate" style="width:auto">
      </div>
      <div class="hint" style="margin:8px 0">
        词典 <b id="cfgGlossaryVer">—</b>。
        想提高命中率就编辑 <code>src/core/glossary.js</code> 的词条表，
        再把 <code>GLOSSARY_VERSION</code> 加一后重新构建 ——
        <b>已译条目会自动重译</b>（缓存哈希里含词典版本）。
        哪些词没译到，点「数据/排障」里的<b>🈶 译名对照</b>一看便知。
      </div>
      <div class="row">
        <button class="btn" id="btnRetranslate" style="width:100%">🔄 用当前词典全部重译</button>
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
    // 标题中译
    const modes = ['zh', 'zh-ja', 'ja'];
    $('#cfgTitleDisplay').value = modes.includes(cfg.titleDisplay) ? cfg.titleDisplay : 'zh';
    $('#cfgAutoTranslate').checked = cfg.autoTranslateTitles !== false;
    const gv = $('#cfgGlossaryVer');
    if (gv) gv.textContent = `v${GLOSSARY_VERSION} · ${glossarySize()} 词条`;
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
    // 标题中译
    const td = $('#cfgTitleDisplay').value;
    await setSetting('titleDisplay', ['zh', 'zh-ja', 'ja'].includes(td) ? td : 'zh');
    await setSetting('autoTranslateTitles', $('#cfgAutoTranslate').checked);
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
  // titleMode：标题显示方式，渲染前从设置里读一次（见 applyLibFilter）
  const libState = { kw: '', actresses: [], genres: [], rows: [], facets: null, titleMode: 'zh' };

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

  /* ---- 资料库列表：分批渲染（懒加载） ----
   * 命中几千条时一次性渲染会卡，更要命的是**用户看不见「下面还有多少」**：
   * 旧实现是 `slice(0, 300)` 静默截断 —— 既不说被截断了、也没法继续看，
   * 观感就是「筛选完显示不全，又没有翻页」。
   * 现在：先渲染 50 条，滚到底部自动追加，底部常驻「已显示 X / 共 Y 条」。
   * 窗口计算在 core/paging.js（纯函数、有单测），这里只管 DOM。
   */
  let libShown = 0;        // 已渲染条数
  let libObserver = null;  // 底部哨兵观察器

  function libItemHtml(r) {
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

    /*
     * v1.4.1：默认只显示**一行中文**，原文放进 `title` 属性（鼠标悬停才看）。
     * 术语表翻译是机器产物、只当索引用，原文才是权威 —— 但让原文常驻第二行，
     * 列表每条都占两行，扫起来反而费劲（v1.4.0 就是这么做的，实测不好用）。
     * 没有译文时老实退回原文（`titleDisplayParts` 里保证不留空白）。
     *
     * 角标分「译 / 半」：只译到一两个词的标题不再冒充完整译名。
     * v1.4.0 一律标「译」，于是 56% 覆盖率的标题看着和译好的没区别，
     * 用户的结论只能是「根本没翻译」。
     */
    const t = titleDisplayParts(r, libState.titleMode);
    const cov = Number(r.titleCoverage);
    const pct = Number.isFinite(cov) ? Math.round(cov * 100) : null;
    const zhBadge = t.badge === 'full'
      ? '<span class="badge tr" title="本地术语表翻译，非官方译名">译</span>'
      : t.badge === 'part'
        ? `<span class="badge tr half" title="只译到一部分${pct == null ? '' : `（约 ${pct}%）`}，剩下的仍是日文 —— 术语表翻不掉长句里的动词活用和助词">半</span>`
        : '';
    const subLine = t.sub
      ? `<div class="ttl-ja" title="原日文标题">${escapeHtml(t.sub)}</div>`
      : '';
    const ttlTip = t.hover ? `原日文标题：${t.hover}` : t.main;

    const playTitle = r.pickcode
      ? '在新标签页打开播放页'
      : '这条记录没有提取码，点「收录本目录」补全后才能直接播放';

    return `<div class="lib-item" data-id="${escapeHtml(r.id)}">
      <div class="mid">
        <div class="code">${escapeHtml(r.code || '—')}${badge}</div>
        <div class="ttl" title="${escapeHtml(ttlTip)}">${escapeHtml(t.main)}${zhBadge}</div>
        ${subLine}
        <div class="tags">${tagLine}</div>
      </div>
      <div class="act">
        <button class="btn sm primary" data-act="play" title="${escapeHtml(playTitle)}">▶ 播放</button>
        <button class="btn sm" data-act="del">移除</button>
      </div>
    </div>`;
  }

  /** 刷新底部状态行（含「加载更多」兜底按钮） */
  function renderLibFoot() {
    const list = $('#libList');
    const total = libState.rows.length;
    let foot = $('#libFoot');
    if (!foot) {
      list.insertAdjacentHTML('beforeend', '<div class="lib-foot" id="libFoot"></div>');
      foot = $('#libFoot');
    }
    const txt = libFootText(total, libShown);
    const more = libShown < total;
    foot.innerHTML =
      (txt ? `<span>${escapeHtml(txt)}</span>` : '') +
      // 兜底：IntersectionObserver 不可用（或没触发）时，用户也能手动继续
      (more ? '<button class="btn sm" data-act="more">加载更多</button>' : '');
  }

  /** 追加下一批；返回是否还有剩余 */
  function appendLibChunk() {
    const list = $('#libList');
    const rows = libState.rows;
    const w = libPageWindow(rows.length, libShown, LIB_PAGE_SIZE);
    if (w.added > 0) {
      const html = rows.slice(w.from, w.to).map(libItemHtml).join('');
      const foot = $('#libFoot');
      // 新内容插在 footer 之前，footer 始终垫底
      if (foot) foot.insertAdjacentHTML('beforebegin', html);
      else list.insertAdjacentHTML('beforeend', html);
      libShown = w.to;
    }
    renderLibFoot();
    return w.hasMore;
  }

  /** 盯住底部 footer：进入视口就自动追加下一批 */
  function armLibObserver() {
    if (libObserver) { libObserver.disconnect(); libObserver = null; }
    if (typeof IntersectionObserver !== 'function') return;   // 老浏览器走「加载更多」按钮
    const list = $('#libList');
    const foot = $('#libFoot');
    if (!foot) return;
    libObserver = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      if (libShown >= libState.rows.length) {
        libObserver?.disconnect();
        return;
      }
      appendLibChunk();
      // ⚠️ 追加后 footer 被顶下去，但元素本身没变，无需重新 observe
    }, {
      root: list,
      // 提前 160px 开始加载，滚动更连贯（不会看到明显的「转圈」）
      rootMargin: '0px 0px 160px 0px',
      threshold: 0
    });
    libObserver.observe(foot);
  }

  function renderLibList(rows) {
    const list = $('#libList');
    if (libObserver) { libObserver.disconnect(); libObserver = null; }
    libState.rows = rows;      // 与调用方保持一致（applyLibFilter 也会赋值）
    libShown = 0;
    if (!rows.length) {
      list.innerHTML = '<div class="lib-empty">没有匹配的条目</div>';
      return;
    }
    list.innerHTML = '';       // 清掉上一轮内容（含旧 footer）
    appendLibChunk();          // 第一批 50 条（内部会建 footer）
    armLibObserver();
    list.scrollTop = 0;        // 换了筛选条件 → 列表回到顶部
  }

  async function applyLibFilter() {
    let rows;
    try {
      rows = await queryLibrary({
        keyword: libState.kw,
        actresses: libState.actresses,
        genres: libState.genres
      });
      // 每次渲染前读一次显示方式：用户在设置里改完，回到列表就能生效
      const cfg = await loadSettings();
      libState.titleMode = cfg.titleDisplay || 'zh';
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
    /*
     * 标题中译的完成度按三档报。
     * ★ 别退回「已译 N 条」这种口径 —— 只要有一处改动就算「已译」的话，
     *   一条只把「同窓会」译成「同窗会」、其余全是日文的标题也算译好了，
     *   面板显示「已译 3293 条」而列表看着像没生效，两边都没说谎。
     */
    const trFull = libState.facets ? (libState.facets.trFull || 0) : 0;
    const trPart = libState.facets ? (libState.facets.trPart || 0) : 0;
    /*
     * 统计行现在被 CSS 钉成**单行**（`.lib-stat`），所以文案必须短，
     * 否则会被省略号截掉。完整说法放 title，悬停可看。
     * 术语也保持简短：「译好 / 半译」对应原来的「译得动 / 半译」。
     */
    const statShort = [
      `共 ${total} 条`,
      filtered ? `命中 ${rows.length}` : '',
      `标签 ${tagged}`,
      (trFull || trPart)
        ? `译好 <span style="color:#2b5cff">${trFull}</span>`
          + ` / 半译 <span style="color:#8a6d3b">${trPart}</span>`
        : '',
      noPc ? `<span style="color:#a06a00">缺提取码 ${noPc}</span>` : '',
      gone ? `<span style="color:#c0322b">已失效 ${gone}</span>` : ''
    ].filter(Boolean);

    const statFull = [
      `资料库共 ${total} 条`,
      filtered ? `当前筛选命中 ${rows.length} 条` : '',
      `其中 ${tagged} 条有标签`,
      (trFull || trPart) ? `中译：译好（能读）${trFull} 条 · 半译 ${trPart} 条` : '',
      noPc ? `缺提取码 ${noPc} 条` : '',
      gone ? `已失效 ${gone} 条` : ''
    ].filter(Boolean).join(' · ');

    $('#libStat').innerHTML = statShort.join(' · ');
    $('#libStat').title = statFull;
    const pg = $('#btnPurgeGone');
    if (pg) {
      pg.disabled = !gone;
      pg.textContent = gone ? `🗑 清理失效 (${gone})` : '🗑 清理失效';
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

    // 「加载更多」不属于任何条目（在 footer 里），先单独处理
    if (btn.dataset.act === 'more') {
      appendLibChunk();
      return;
    }

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

  /* ---- 标题中译（v1.4.0） ---- */
  $('#btnTranslate').addEventListener('click', async () => {
    const r = await handlers.onTranslateTitles?.();
    // 译完立刻重跑一次筛选：列表读的是 library 里的副本，不重查就看不到新译文
    await loadLibrary();
    if (r && r.changed === 0 && r.total) {
      api.setHint(`没有新的标题需要翻译（词典 v${GLOSSARY_VERSION}）。`
        + '如果标题还是日文，用「🈶 译名对照」看看哪些词没收录。');
    }
  });

  $('#btnRetranslate').addEventListener('click', async () => {
    const r = await handlers.onRetranslateTitles?.();
    await loadLibrary();
    if (r) api.setHint(`已按当前词典 v${GLOSSARY_VERSION} 重译 ${r.done} 条，其中 ${r.changed} 条有译文。`);
  });

  $('#btnTitleSample').addEventListener('click', async () => {
    const text = await handlers.onTitleSample?.();
    if (!text) { api.setHint('对照表生成失败，请看控制台'); return; }
    console.log(text);
    try {
      await navigator.clipboard.writeText(text);
      toast('译名对照已复制到剪贴板', 'ok');
      api.setHint('对照表已复制。最前面那批就是「词典里缺的词」，照着补词条即可。');
    } catch (e) {
      toast('复制失败（浏览器限制），已输出到控制台', 'err');
      api.setHint('对照表请看控制台（F12）。');
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



// 标题中译：纯本地术语表，不联网、零成本、无审核问题

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

    /*
     * 标题中译：跟着查询顺手做掉。
     * 纯本地计算（术语表替换），不联网、不花钱、毫秒级，所以可以默认开着；
     * 但它是增量的 —— 已经译过且原文没变的条目会被哈希挡掉，不会重复算。
     */
    if (settings?.autoTranslateTitles !== false) {
      try {
        await translateTitles(false, { silent: true });
      } catch (e) {
        console.warn('[jv115-tagger] 标题中译失败（不影响查询结果）', e);
      }
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

/* ==================================================================
 * 标题中译（v1.4.0）
 * ------------------------------------------------------------------
 * 纯本地：一张术语表 + 专名保护，不联网、零成本、没有内容审核问题。
 * 目标定成「看得懂」，不是「信达雅」—— 这是路线选择的前提。
 *
 * 三件事保证它长期可用：
 *   ① 翻译**按番号**缓存进 meta，同一部片只算一次
 *   ② 缓存键 = hash(原文 + 词典版本)，**改了词典就自动重译**
 *   ③ 没命中的假名如实统计出来，用户照着补词条即可
 *
 * 全部逻辑都在 core/glossary.js（纯函数、有单测），这里只负责批量与落库。
 * ================================================================== */

/**
 * 把库里还没有中文标题的条目补上译文（增量）。
 * @param {boolean} force             忽略缓存全部重译（改完词条后用）
 * @param {{silent?:boolean}} [opt]   silent = 由查询流程顺手调用，不弹提示
 */
async function translateTitles(force = false, { silent = false } = {}) {
  const all = await getAllMeta();
  const withTitle = all.filter((m) => m && m.code && m.title);
  const todo = withTitle.filter((m) => force || !m.titleZh || m.titleHash !== hashTitle(m.title));

  if (!todo.length) {
    const msg = withTitle.length
      ? `标题中译：${withTitle.length} 条已是最新（词典 v${GLOSSARY_VERSION}）`
      : '标题中译：库里还没有元数据，先查询一次再试';
    if (!silent) toast(msg, 'ok');
    panel?.setHint(msg);
    return { total: withTitle.length, done: 0, changed: 0 };
  }

  if (!silent) panel?.setBusy(true, `正在翻译 ${todo.length} 条标题…`);

  const entries = [];
  let changed = 0;
  let missed = 0;
  let full = 0;

  for (let i = 0; i < todo.length; i++) {
    const m = todo[i];
    const r = translateTitle(m.title, { code: m.code, actresses: m.actresses });
    /*
     * 只要有一处改动就存译文 —— 这是有意的：
     * 半译总比不译强，用户至少能认出「同窓会」是「同窗会」。
     * 但**必须同时存覆盖率**，否则界面上分不出「译得动」和「只译到一两个词」，
     * 一条 56% 的标题会和完整译名长得一模一样。
     */
    entries.push({
      code: m.code,
      // 没译出来就存空串，让列表老实回退到原文，而不是存一份和原文一样的「译文」
      titleZh: r.changed ? r.zh : '',
      titleSrc: r.changed ? 'glossary' : '',
      titleCoverage: r.changed ? Math.round(r.coverage * 1000) / 1000 : 0,
      // ★ 没命中也要记哈希：否则每次都会把同一批「没命中」的条目重新算一遍
      titleHash: hashTitle(m.title),
      titleZhAt: Date.now()
    });
    if (r.changed) {
      changed++;
      if (r.coverage >= FULL_COVERAGE) full++;
    } else missed++;
    if (i % 200 === 199) {
      if (!silent) panel?.setProgress(i + 1, todo.length);
      // 让出主线程：几千条时不能把页面卡死
      await new Promise((res) => setTimeout(res, 0));
    }
  }

  await applyTitleZhBatch(entries);
  broadcast('render-cache');

  /*
   * 报数要如实：只说「N 条译出」会让人以为有 N 条可用，
   * 实际其中不少只译到一两个词。所以把「译得动」单独拎出来说。
   */
  const part = changed - full;
  const msg = `✅ 标题中译：${full} 条译得动 · ${part} 条只译到一部分 · ${missed} 条未命中`
    + ` · 词典 v${GLOSSARY_VERSION}（${glossarySize()} 词条）`;
  if (silent) {
    panel?.setHint(msg);
  } else {
    panel?.setBusy(false, msg);
    panel?.setHint(
      part || missed
        ? '术语表是「词对词替换」，长句里剩下的动词活用和助词它翻不掉，'
          + '所以会有「一半中文一半日文」的条目 —— 这是纯本地方案的天花板，不是没生效。'
          + '想提高覆盖率：把常用词补进 core/glossary.js，把 GLOSSARY_VERSION +1 后重新构建，已译条目会自动重译。'
        : '全部译出，没有残留日文。'
    );
    toast(`标题中译完成：${full} 条译得动 · ${part} 条半译`, 'ok');
  }
  return { total: withTitle.length, done: todo.length, changed, full, missed };
}

/**
 * 生成「译名对照 + 待补词条清单」文本。
 *
 * 为什么把**译得最差的排在最前**：
 *   这个功能的日常维护就是「补词条」。用户需要一眼看到哪些标题还剩日文，
 *   而不是看一堆已经译好的。所以按覆盖率升序，直接把缺口怼到脸上。
 */
async function titleSampleText() {
  const all = (await getAllMeta()).filter((m) => m && m.title);
  if (!all.length) return '库里还没有元数据。先到「扫描」页签查询一次，再来看对照表。';

  const rows = all.map((m) => {
    const r = translateTitle(m.title, { code: m.code, actresses: m.actresses });
    return {
      code: m.code, ja: m.title, zh: r.changed ? r.zh : '',
      coverage: r.coverage, unmapped: r.unmapped, bad: r.bad
    };
  });
  const ok = rows.filter((x) => x.zh).length;
  const avg = Math.round((rows.reduce((s, x) => s + x.coverage, 0) / rows.length) * 100);

  const worst = [...rows].sort((a, b) => a.coverage - b.coverage || a.code.localeCompare(b.code)).slice(0, 25);

  const L = [];
  L.push(`===== 标题中译对照（词典 v${GLOSSARY_VERSION} · ${glossarySize()} 词条）=====`);
  L.push(`元数据 ${rows.length} 条 · 已译出 ${ok} 条 · 平均覆盖率 ${avg}%`);
  L.push('');
  L.push('--- 最需要补词条的 25 条（「未译」就是词典里没有的词）---');
  worst.forEach((x, i) => {
    L.push(`[${i + 1}] ${x.code}   覆盖率 ${Math.round(x.coverage * 100)}%${x.bad ? `（保护专名 ${x.bad} 个）` : ''}`);
    L.push(`    原文: ${x.ja}`);
    L.push(`    译文: ${x.zh || '(未命中，保留原文)'}`);
    if (x.unmapped.length) L.push(`    未译: ${x.unmapped.join(' / ')}`);
  });
  L.push('');
  L.push('补词方法：编辑 src/core/glossary.js 的词典表 → GLOSSARY_VERSION +1 → 重新构建，已译条目会自动重译。');
  return L.join('\n');
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
      /* 标题中译（v1.4.0，纯本地术语表）：只补还没译过的 */
      onTranslateTitles: () => translateTitles(false),
      /* 改完词典后强制全部重译（缓存哈希里含词典版本，其实会自动失效，
         这个按钮是给「我就想立刻全刷一遍」用的） */
      onRetranslateTitles: () => translateTitles(true),
      /* 「译名对照」：输出前 25 条译得最差的，方便照着补词条 */
      onTitleSample: () => titleSampleText(),
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
