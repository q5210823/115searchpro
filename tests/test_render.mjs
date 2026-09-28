/**
 * ui.js 标签渲染测试
 * 核心契约：**注入标签后，文件名节点的文本内容必须完全不变**。
 *
 * 这是本轮修复的核心目标 —— 旧版把标签塞进文件名里导致乱码。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(ROOT, '..', 'src', 'core', 'ui.js'), 'utf8');

// 取 TAG_STYLES + ensureTagStyles + renderTagPill 及其依赖 + clearTagPills
function extractRenderer() {
  const start = SRC.indexOf('const TAG_STYLES');
  let code = SRC.slice(start);

  // 剔除测试中不需要、且会依赖真实 DOM/Shadow 的 ensureHost / toast
  code = code.replace(/export function ensureHost\(\)[\s\S]*?\n\}\n/, '');
  code = code.replace(/export function toast\([\s\S]*?\n\}\n/, '');

  code = code.replace(/export function /g, 'function ');
  code = code.replace(/export const renderTag = renderTagPill;?/g, '');
  return code;
}

// ---- DOM 桩 ----
class Node {
  constructor(tag) {
    this.tagName = (tag || '').toUpperCase();
    this.nodeType = tag ? 1 : 3;
    this.children = [];
    this.childNodes = [];
    this.dataset = {};
    this.listeners = {};
    this.className = '';
    this._text = '';
    this.parentElement = null;
    this.style = {};
    this._attrs = {};
    this.isConnected = true;
    // 每个节点都指向同一个假 document（在 makeEnv 里回填 ownerDocument）
    this.ownerDocument = null;
  }
  get classList() {
    const self = this;
    return {
      add(...cs) {
        const set = new Set(String(self.className || '').split(/\s+/).filter(Boolean));
        cs.forEach((c) => set.add(c));
        self.className = [...set].join(' ');
      },
      remove(...cs) {
        const set = new Set(String(self.className || '').split(/\s+/).filter(Boolean));
        cs.forEach((c) => set.delete(c));
        self.className = [...set].join(' ');
      },
      contains(c) {
        return String(self.className || '').split(/\s+/).includes(c);
      }
    };
  }
  get textContent() {
    let s = '';
    for (const n of this.childNodes) {
      s += n.nodeType === 3 ? n.nodeValue : n.textContent;
    }
    return s;
  }
  set textContent(v) { this.childNodes = [{ nodeType: 3, nodeValue: String(v) }]; this.children = []; }
  appendChild(c) { c.parentElement = this; this.childNodes.push(c); this.children.push(c); return c; }
  append(...cs) { cs.forEach((c) => this.appendChild(c)); }
  addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
  removeEventListener() {}
  remove() {
    if (this.parentElement) {
      this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
      this.parentElement.childNodes = this.parentElement.childNodes.filter((c) => c !== this);
    }
  }
  contains(n) { return this.children.some((c) => c === n || c.contains?.(n)); }
  // ---- 属性 ----
  setAttribute(k, v) { this._attrs[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; }
  removeAttribute(k) { delete this._attrs[k]; }
  querySelectorAll(sel) {
    const out = [];
    const all = sel === '*' || sel === '* ';
    const cls = sel.replace(/^\./, '');
    const walk = (el) => {
      for (const c of el.children) {
        if (all || String(c.className || '').split(/\s+/).includes(cls)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  getBoundingClientRect() { return { left: 100, top: 100, right: 200, bottom: 112, width: 100, height: 12 }; }
  get offsetWidth() { return 280; }
  get offsetHeight() { return 150; }
}

function makeEnv() {
  const body = new Node('body');
  const head = new Node('head');
  const byId = new Map();
  const doc = {
    body,
    head,
    documentElement: head,
    createElement: (t) => {
      const n = new Node(t);
      n.ownerDocument = doc;
      // 拦截 id 属性赋值，让 getElementById 能找到（模拟真实 DOM 行为）
      let _id = '';
      Object.defineProperty(n, 'id', {
        get() { return _id; },
        set(v) { _id = v; if (v) byId.set(v, n); },
        configurable: true
      });
      const origSet = n.setAttribute.bind(n);
      n.setAttribute = (k, v) => { origSet(k, v); if (k === 'id') byId.set(v, n); };
      return n;
    },
    getElementById: (id) => byId.get(id) || null,
    querySelectorAll: () => []
  };
  body.ownerDocument = doc;
  head.ownerDocument = doc;
  const win = {
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener() {},
    removeEventListener() {}
  };
  doc.defaultView = win;
  return { doc, win, body, head, byId };
}

const { doc, win } = makeEnv();
const code = extractRenderer();
const factory = new Function('document', 'window', 'console',
  `"use strict"; ${code} return { renderTagPill, clearTagPills, ensureTagStyles };`);
const mod = factory(doc, win, console);

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`);
  if (cond) pass++; else fail++;
}

// ============ 测试 1：命中时文件名不变 ============
{
  const nameEl = new Node('div');
  nameEl.textContent = 'SONE-119.mp4';
  const before = nameEl.textContent;

  mod.renderTagPill(nameEl, {
    code: 'SONE-119',
    title: '某作品标题',
    actresses: ['演员A', '演员B'],
    genres: ['类别1', '类别2'],
    studio: '厂商X',
    releaseDate: '2024-01-01',
    source: 'javbus'
  }, {});

  const after = nameEl.textContent;
  check('命中：文件名文本不变', after === before, `"${before}" → "${after}"`);

  const dots = nameEl.querySelectorAll('.jv-dot');
  check('命中：注入了 1 个标记点', dots.length === 1, `实际 ${dots.length}`);

  // 浮层内容正确
  const tip = dots[0].__jvTip;
  check('命中：浮层已构建', !!tip);
  if (tip) {
    const t = tip.textContent;
    check('命中：浮层含标题', t.includes('某作品标题'));
    check('命中：浮层含演员', t.includes('演员A') && t.includes('演员B'));
    check('命中：浮层含类别', t.includes('类别1') && t.includes('类别2'));
    check('命中：浮层含番号', t.includes('SONE-119'));
  }
}

// ============ 测试 2：未匹配时文件名也不变 ============
{
  const nameEl = new Node('div');
  nameEl.textContent = 'ABC-123.mkv';
  const before = nameEl.textContent;

  mod.renderTagPill(nameEl, { notFound: true, code: 'ABC-123' }, {
    manualLinks: [{ name: 'JavBus', url: 'https://example.com' }]
  });

  check('未匹配：文件名文本不变', nameEl.textContent === before, `"${nameEl.textContent}"`);
  const dots = nameEl.querySelectorAll('.jv-dot');
  check('未匹配：注入了 1 个标记点', dots.length === 1);
  check('未匹配：标记点带 miss 类', dots[0]?.className.includes('miss'));
}

// ============ 测试 3：重复渲染不累积 ============
{
  const nameEl = new Node('div');
  nameEl.textContent = 'XYZ-999.mp4';

  const meta = { code: 'XYZ-999', title: 'T', actresses: [], genres: [] };
  mod.renderTagPill(nameEl, meta, {});
  mod.renderTagPill(nameEl, meta, {});
  mod.renderTagPill(nameEl, meta, {});

  const dots = nameEl.querySelectorAll('.jv-dot');
  check('重复渲染 3 次：仍只有 1 个标记点', dots.length === 1, `实际 ${dots.length}`);
  check('重复渲染：文件名仍不变', nameEl.textContent === 'XYZ-999.mp4');
}

// ============ 测试 4：clearTagPills 清理干净 ============
{
  const nameEl = new Node('div');
  nameEl.textContent = 'QQQ-001.mp4';
  mod.renderTagPill(nameEl, { code: 'QQQ-001', title: 'T' }, {});

  // clearTagPills 需要 root 支持 querySelectorAll
  const root = new Node('div');
  root.appendChild(nameEl);
  root.querySelectorAll = (sel) => {
    const cls = sel.replace(/^\./, '');
    const out = [];
    const walk = (el) => {
      for (const c of el.children) {
        if (String(c.className || '').split(/\s+/).includes(cls)) out.push(c);
        walk(c);
      }
    };
    walk(root);
    return out;
  };

  mod.clearTagPills(root);
  check('清理后：标记点已移除', root.querySelectorAll('.jv-dot').length === 0);
  check('清理后：文件名不变', nameEl.textContent === 'QQQ-001.mp4');
}

// ============ 测试 5：长标题不污染文件名 ============
{
  const nameEl = new Node('div');
  nameEl.textContent = 'LONG-123.mp4';
  const longTitle = '这是一个非常非常长的作品标题'.repeat(5);

  mod.renderTagPill(nameEl, {
    code: 'LONG-123',
    title: longTitle,
    actresses: Array.from({ length: 15 }, (_, i) => `演员${i + 1}`),
    genres: Array.from({ length: 20 }, (_, i) => `类别${i + 1}`)
  }, {});

  check('长内容：文件名仍完全不变', nameEl.textContent === 'LONG-123.mp4',
    `长度 ${nameEl.textContent.length}`);
  const tip = nameEl.querySelectorAll('.jv-dot')[0]?.__jvTip;
  check('长内容：浮层含全部 15 个演员',
    tip && Array.from({ length: 15 }, (_, i) => `演员${i + 1}`).every((a) => tip.textContent.includes(a)));
}

// ============ 测试 6：样式注入到宿主 document（本轮修复的核心） ============
{
  // 注意：这里复用同一个 doc（模块级 doc），所以第一次注入后应幂等。
  const before = doc.head.children.length;
  const nameEl = new Node('div');
  nameEl.ownerDocument = doc;
  nameEl.textContent = 'STY-001.mp4';
  mod.renderTagPill(nameEl, { code: 'STY-001', title: 'T' }, {});

  const styles = doc.head.children.filter((s) => s.id === 'jv115-tag-styles');
  check('样式：注入到宿主 document.head', styles.length === 1, `实际 ${styles.length}`);
  check('样式：样式表里含 .jv-dot 规则',
    styles[0] && /\.jv-dot\s*\{/.test(styles[0].textContent));
  check('样式：样式表里含 .jv-tip 规则',
    styles[0] && /\.jv-tip\s*\{/.test(styles[0].textContent));

  // 幂等：再渲染一次不应重复注入
  const nameEl2 = new Node('div');
  nameEl2.ownerDocument = doc;
  nameEl2.textContent = 'STY-002.mp4';
  mod.renderTagPill(nameEl2, { code: 'STY-002', title: 'T' }, {});
  const styles2 = doc.head.children.filter((s) => s.id === 'jv115-tag-styles');
  check('样式：幂等（重复渲染只注入 1 次）', styles2.length === 1, `实际 ${styles2.length}`);
}

// ============ 测试 7：原生 title tooltip 抑制 ============
{
  const nameEl = new Node('div');
  nameEl.ownerDocument = doc;
  nameEl.textContent = 'TTL-001.mp4';
  nameEl.setAttribute('title', 'TTL-001.mp4');

  mod.renderTagPill(nameEl, { code: 'TTL-001', title: 'T' }, {});
  const dot = nameEl.querySelectorAll('.jv-dot')[0];

  check('title：初始保留原生 title', nameEl.getAttribute('title') === 'TTL-001.mp4');

  // 触发 mouseenter → 应摘掉 title
  dot.listeners.mouseenter.forEach((fn) => fn());
  check('title：悬停时 title 被摘除', nameEl.getAttribute('title') === null);

  // 触发 mouseleave → 应还原
  dot.listeners.mouseleave.forEach((fn) => fn());
  // hide 有 140ms 延时，手动跑掉
  await new Promise((r) => setTimeout(r, 200));
  check('title：离开时 title 被还原', nameEl.getAttribute('title') === 'TTL-001.mp4');
}

// ============ 测试 8：父子节点都渲染时，一行只留一个圆点 ============
{
  // 模拟 115 真实结构：外层 wrap（带 title）+ 内层 name（显示文件名）
  const row = new Node('div');
  row.ownerDocument = doc;
  const wrap = new Node('div');
  wrap.ownerDocument = doc;
  const nameEl = new Node('div');
  nameEl.ownerDocument = doc;
  nameEl.textContent = 'DUP-001.mp4';
  wrap.appendChild(nameEl);
  row.appendChild(wrap);

  const meta = { code: 'DUP-001', title: 'T' };

  // 第一次：给外层 wrap 渲染（扫描器可能先命中父容器）
  mod.renderTagPill(wrap, meta, {});
  // 第二次：给内层 nameEl 渲染（扫描器也可能命中真正的文件名节点）
  mod.renderTagPill(nameEl, meta, {});

  const rowDots = row.querySelectorAll('.jv-dot');
  check('父子都渲染：整行只有 1 个圆点', rowDots.length === 1, `实际 ${rowDots.length}`);
  check('父子都渲染：圆点直接挂在文件名节点下（不是外层容器）',
    rowDots[0] && rowDots[0].parentElement === nameEl,
    rowDots[0] ? `parent=${rowDots[0].parentElement === nameEl ? 'nameEl' : 'other'}` : '无圆点');
  check('父子都渲染：文件名文本不变', nameEl.textContent === 'DUP-001.mp4');
}

// ============ 测试 9：多行渲染互不干扰（回归保护） ============
{
  // 真实结构：list > row*3，每个 row > name
  // 这个用例专门盯住一个回归：行级清理若「越界」到列表容器，
  // 会把前面所有行的圆点一起清掉（表现为「一个圆点都没有」）。
  const list = new Node('div');
  list.ownerDocument = doc;
  const rows = [];
  for (let i = 0; i < 3; i++) {
    const row = new Node('div');
    row.ownerDocument = doc;
    const name = new Node('div');
    name.ownerDocument = doc;
    name.textContent = `ROW-${i + 1}01.mp4`;
    row.appendChild(name);
    list.appendChild(row);
    rows.push({ row, name });
  }

  rows.forEach(({ name }, i) => {
    mod.renderTagPill(name, { code: `ROW-${i + 1}01`, title: 'T' }, {});
  });

  const total = list.querySelectorAll('.jv-dot').length;
  check('多行渲染：列表内共 3 个圆点（不被后面的行清掉）', total === 3, `实际 ${total}`);
  rows.forEach(({ row }, i) => {
    const n = row.querySelectorAll('.jv-dot').length;
    check(`多行渲染：第 ${i + 1} 行保留 1 个圆点`, n === 1, `实际 ${n}`);
  });
  check('多行渲染：文件名文本均不变',
    rows.every(({ name }, i) => name.textContent === `ROW-${i + 1}01.mp4`));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
