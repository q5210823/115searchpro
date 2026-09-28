/**
 * 主入口
 * ------------------------------------------------------------------
 * 串联：页面适配 -> 番号提取 -> 数据源查询 -> 本地存储 -> UI 渲染
 *
 * 数据源全部走浏览器直连（GM_xmlhttpRequest），不需要任何 API key。
 * 抓取失败时提供手动搜索链接兜底。
 */

import { extractCode } from './core/tag-extractor.js';
import {
  JavbusProvider,
  JavlibraryProvider,
  DmmProvider,
  MetaResolver
} from './core/providers.js';
import {
  metaCache,
  putFileMapBatch,
  putMetaBatch,
  putLibraryBatch,
  buildLibraryRecord,
  pruneLibraryDuplicates,
  loadSettings,
  getMeta,
  // v1.2.3：增量收录（对照同目录已有记录，只对新文件发请求）
  getLibraryByCid,
  putDirMeta,
  getDirMeta,
  deleteLibraryGone,
  DEFAULT_PLAYER_URL,
  // v1.3.0：播放方式语义化 + 模板填充 + 播放页自检结果缓存
  PLAY_MODES,
  PLAYER_PROBE_KEY,
  PLAYER_PROBE_TTL,
  playerTemplateVars,
  fillPlayerTemplate
} from './core/storage.js';
// 注意：不再 import renderTagPill —— 蓝点/悬停方案已弃用，
// 标签统一展示在面板的「资料库」页签里。
// clearTagPills 保留，用于清除历史版本残留在页面上的旧标记。
import { clearTagPills, toast } from './core/ui.js';
import { createPanel } from './core/panel.js';
import {
  scanVideoItems,
  scanAllFrames,
  waitForVideoItems,
  getScanStats,
  observeList,
  isStoragePage,
  getCurrentPath,
  diagnose,
  diagnoseText,
  inspectPage,
  dumpRawDom,
  probeLibrary,
  getCurrentCid,
  // v1.2.2：115 官方接口（一次拿全目录，自带 pickcode）
  apiFetchDirAll,
  pickVideoRows,
  // v1.2.2：页面内触发播放 + 结构采样
  triggerRowOpen,
  sampleRowStructure,
  surveyGlobalOpeners,
  detect115MasterAnywhere,
  // v1.3.0：播放页识别与「播放器是否真的起来了」的判定
  isMasterPlayerPage,
  detectPlayerReady,
  looksBlank
} from './core/site-115.js';
import {
  isTopFrame,
  isFileListFrame,
  broadcast,
  onBroadcast
} from './core/frames.js';

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
