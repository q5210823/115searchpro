/**
 * 控制面板
 * ------------------------------------------------------------------
 * 悬浮按钮 + 抽屉式面板，三个页签：
 *   扫描   读取当前目录视频、提取番号、查询元数据、注入标签
 *   设置   DMM key、数据源开关、并发数等
 *   数据   本地库统计、导出/导入、清理
 */

import { ensureHost, toast } from './ui.js';
import {
  loadSettings,
  setSetting,
  getStats,
  exportAll,
  importAll,
  clearAll,
  purgeExpired,
  getLibraryFacets,
  queryLibrary,
  deleteLibrary,
  DEFAULT_PLAYER_URL
} from './storage.js';

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
export function createPanel(handlers = {}) {
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
