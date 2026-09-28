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
export class JavbusProvider extends BaseProvider {
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
export class JavlibraryProvider extends BaseProvider {
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
export class DmmProvider extends BaseProvider {
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
export class MetaResolver {
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
export function buildManualLinks(code, cfg = {}) {
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
