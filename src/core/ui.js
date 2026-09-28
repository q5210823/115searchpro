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
export function ensureTagStyles(doc) {
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
export function ensureHost() {
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
export function toast(message, type = '') {
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
export function renderTagPill(nameEl, meta, opts = {}) {
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
export const renderTag = renderTagPill;

/** 清除所有已注入的标记点与浮层 */
export function clearTagPills(root = document) {
  const doc = root.ownerDocument || document;
  root.querySelectorAll('.jv-dot').forEach(cleanupDot);
  root.querySelectorAll('.jv-tip').forEach((el) => el.remove());
  // 浮层是挂到 body 的，可能不在传入的 root 子树内
  doc.querySelectorAll?.('.jv-tip').forEach((el) => el.remove());
}
