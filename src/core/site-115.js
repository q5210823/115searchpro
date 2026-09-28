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
 */

export const VIDEO_EXT = /\.(mp4|mkv|avi|wmv|mov|ts|m2ts|rmvb|flv|webm|iso|mpg|mpeg|m4v)$/i;

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
 */
export function scanVideoItems(root = document) {
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

/** 获取上次扫描的统计信息（用于诊断） */
export function getScanStats() {
  return { ...lastScanStats };
}

/** 页面当前路径 */
export function getCurrentPath() {
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
 */
export function waitForVideoItems(timeoutMs = 8000, intervalMs = 400) {
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
 */
export function observeList(onChange, debounceMs = 600) {
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

/** 判断当前是否在 115 文件列表页 */
export function isStoragePage() {
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
 */
export function scanAllFrames() {
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
 */
export function inspectPage(doc = document) {
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
 */
export function inspectAllFrames() {
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
 */
export function diagnose() {
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
 */
export function diagnoseText() {
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

/** 调试：dump 扫描到的条目 */
export function dumpItems() {
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

/** 调试：输出页面上所有带扩展名的节点，用于发现选择器盲区 */
export function dumpFileLikeNodes() {
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
 */
export function dumpRawDom(limit = 3) {
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

/** 从 URL 里取当前目录 cid（建库时作为文件归属目录记录） */
export function getCurrentCid() {
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
 */
export function probeLibrary() {
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

/** 字节数 → 可读大小（和 115 页面上显示的风格一致） */
export function humanSize(bytes) {
  const b = Number(bytes) || 0;
  if (!b) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let v = b;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const digits = i === 0 ? 0 : (v >= 100 ? 1 : 2);
  return `${v.toFixed(digits)}${units[i]}`;
}

/** 把 webapi 返回的文件对象转成内部统一的 row 结构 */
export function apiFileToRow(f) {
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
 */
export async function apiFetchDirAll(cid, { onProgress, includeDirs = false, maxItems = 100000 } = {}) {
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
 */
export function pickVideoRows(rows, opts = {}) {
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

/** 页面上是否装了 115Master（它的播放页路由是 /web/lixian/master/video/） */
export function detect115Master(doc = document) {
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

/** 顶层调用：把顶层和所有同源 iframe 都探一遍 */
export function detect115MasterAnywhere() {
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
 */
export function isMasterPlayerPage(url = location.href) {
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
 */
export function detectPlayerReady(doc = document) {
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

/** 页面整体是不是「几乎空白」（用来判定播放页是不是白屏） */
export function looksBlank(doc = document) {
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
 */
export async function triggerRowOpen(fileName) {
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
 */
export function sampleRowStructure() {
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

/** 检测是否有 115 全局的播放/打开函数可调（有时比模拟点击可靠） */
export function surveyGlobalOpeners() {
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
