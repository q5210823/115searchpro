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

export const VARIANT_SAMPLES = [
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
export function normalizeCode(prefix, digits) {
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
export function extractCode(filename) {
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
export function extractBatch(files) {
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
export function selfTest() {
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
