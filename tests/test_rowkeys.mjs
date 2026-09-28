/**
 * 115 真实文件行结构 → 属性挖掘 / 行定位 / 点击目标
 * ------------------------------------------------------------------
 * 这个测试用的 DOM **直接照抄 2026-09 真机采样的 115 列表行**：
 *
 *   <li rel="item" title="hmpd-10044.mp4" file_id="3527247704331650213"
 *       pick_code="bi0izro13wfpq8syt" file_size="6984372848"
 *       cid="3063507687632273050" ico="mp4" file_type="1">
 *     …
 *     <a class="name" href="javascript:;" menu="view_file_one"
 *        title="hmpd-10044.mp4" rel="file" field="file_name">
 *       <span>hmpd</span><span>-10044.mp4</span>
 *     </a>
 *     …
 *   </li>
 *
 * 它固化三个曾经踩过的坑：
 *   ① 属性名带下划线（file_id / pick_code / file_size）——
 *      早期只找 pickcode / data-id，覆盖率 0，于是「播放」永远走不到直开。
 *   ② 行容器是 <li>，它的父节点 <ul> 装着**所有行** ——
 *      早期上溯逻辑把 <ul> 当行容器，大小取到第一行、pickcode 还会串号。
 *   ③ 打开动作绑在 <a class="name" menu="view_file_one"> 上，
 *      点 <li> 毫无反应 —— 所以必须给出 clickEl。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(ROOT, '..', 'src', 'core', 'site-115.js'), 'utf8');

/* ==================== 极简 DOM 桩（带选择器匹配） ==================== */

function matchesOne(el, sel) {
  // 只支持「简单选择器」；遇到后代/兄弟组合器等复杂写法就退化为全匹配
  if (!sel || /[\s>+~]/.test(sel.trim())) return true;
  const tagM = sel.match(/^([a-zA-Z][\w-]*|\*)/);
  const tag = tagM ? tagM[0] : '';
  if (tag && tag !== '*' && String(el.tagName).toUpperCase() !== tag.toUpperCase()) return false;

  const rest = sel.slice(tag.length);
  const parts = rest.match(/\[[^\]]*\]|\.[\w-]+|#[\w-]+|:not\([^)]*\)/g) || [];
  for (const p of parts) {
    if (p[0] === '.') {
      const cls = Array.isArray(el.className) ? el.className.join(' ') : String(el.className || '');
      if (!String(cls).split(/\s+/).includes(p.slice(1))) return false;
    } else if (p[0] === '#') {
      if (String(el.id || '') !== p.slice(1)) return false;
    } else if (p.startsWith(':not(')) {
      if (matchesOne(el, p.slice(5, -1))) return false;
    } else if (p[0] === '[') {
      const body = p.slice(1, -1);
      const mm = body.match(/^([\w-]+)(?:([*^$~|]?=)"?([^"]*)"?)?$/);
      if (!mm) return false;
      const attr = mm[1];
      const op = mm[2];
      const val = mm[3];
      const av = el.getAttribute ? el.getAttribute(attr) : null;
      if (av == null) return false;
      if (!op) continue;
      const s = String(av);
      if (op === '=' && s !== val) return false;
      if (op === '*=' && !s.includes(val)) return false;
    }
  }
  return true;
}

function matches(el, sel) {
  return String(sel).split(',').map((s) => s.trim()).filter(Boolean).some((one) => matchesOne(el, one));
}

class El {
  constructor(tag, opts = {}) {
    this.tagName = tag.toUpperCase();
    this.nodeType = 1;
    this.children = [];
    this.childNodes = [];
    this.attrs = { ...(opts.attrs || {}) };
    this.className = opts.className || '';
    this.id = opts.id || '';
    this.parentElement = null;
    this.parentNode = null;
  }
  append(...nodes) {
    for (const n of nodes) {
      if (typeof n === 'string') {
        this.childNodes.push({ nodeType: 3, nodeValue: n });
      } else {
        n.parentElement = this;
        n.parentNode = this;
        this.childNodes.push(n);
        this.children.push(n);
      }
    }
    return this;
  }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? String(this.attrs[k]) : null; }
  get textContent() {
    let s = '';
    for (const n of this.childNodes) s += n.nodeType === 3 ? n.nodeValue : n.textContent;
    return s;
  }
  querySelectorAll(sel) {
    const out = [];
    const walk = (el) => {
      for (const c of el.children) { if (matches(c, sel)) out.push(c); walk(c); }
    };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  contains(node) {
    for (const c of this.children) if (c === node || c.contains?.(node)) return true;
    return false;
  }
}

function makeDocument(root) {
  return {
    querySelectorAll: (sel) => (sel === '*' ? [root, ...root.querySelectorAll('*')] : root.querySelectorAll(sel)),
    querySelector: (sel) => (sel === '*' ? root : root.querySelector(sel)),
    body: root,
    readyState: 'complete'
  };
}

function loadScanner(doc) {
  const code = SRC
    .replace(/export function /g, 'function ')
    .replace(/export async function /g, 'async function ')
    .replace(/export const /g, 'const ')
    .replace(/if \(typeof window !== 'undefined'\)[\s\S]*$/m, '');

  const factory = new Function(
    'document', 'location', 'MutationObserver', 'window', 'console',
    `"use strict";
     ${code}
     return { scanVideoItems, getScanStats };
    `
  );
  return factory(
    doc,
    { href: 'https://115.com/?ct=file&ac=userfile&tpl=view_large&cid=0&limit=24', hostname: '115.com', search: '' },
    class { observe() {} disconnect() {} },
    { __JV115_TAGGER_LOADED__: true },
    console
  );
}

/* ==================== 构造真实形态的 115 列表 ==================== */

/** 照着真机采样拼一行；字段名一个都不改 */
function build115Row({ name, fileId, pickCode, sizeBytes, cid, ptime }) {
  const li = new El('li', {
    attrs: {
      iv: '1', c: '0', vdi: '4', rel: 'item', title: name, hdf: '0',
      file_type: '1', cid, file_mode: '9', user_ptime: ptime,
      file_size: String(sizeBytes), is_top: '0', file_id: fileId,
      file_status: '1', area_id: '1', p_id: cid, ico: 'mp4',
      pick_code: pickCode, is_collect: '0', score: '0', has_desc: '0'
    }
  });

  const wrap = new El('div', { className: 'file-name-wrap' });
  wrap.append(new El('i', { className: 'file-type tp-mp4 tp-video-1080p' }));

  const spanName = new El('span', { className: 'file-name', attrs: { rel: 'file_name' } });
  const em = new El('em');
  const a = new El('a', {
    className: 'name',
    attrs: {
      href: 'javascript:;', menu: 'view_file_one', title: name,
      rel: 'file', field: 'file_name'
    }
  });
  // 115 把文件名拆成两段 span 渲染：hmpd + -10044.mp4
  const dash = name.indexOf('-');
  a.append(
    new El('span').append(name.slice(0, dash)),
    new El('span').append(name.slice(dash))
  );
  const star = new El('a', { className: 'icon-star', attrs: { href: 'javascript:;', menu: 'star', data_title: '星标' } });
  star.append('星标');
  em.append(a, star);
  spanName.append(em);
  wrap.append(spanName);

  const labels = new El('div', { className: 'labels-text', attrs: { rel: 'label_box' } });
  const tag = new El('i', { className: 'txt-labels il-purple', attrs: { menu: 'label_btn', id: '3065373494322658712' } });
  tag.append('#纪录片');
  labels.append(tag);
  wrap.append(labels);

  const size = new El('div', { className: 'file-size' });
  size.append(new El('span').append('6.50GB'));

  const opr = new El('div', { className: 'file-opr', attrs: { rel: 'menu' } });
  for (const [label, menu] of [['置顶', 'setTop'], ['星标', 'star'], ['下载', 'download_one'],
    ['移动', 'move'], ['标签', 'edit_file_label'], ['重命名', 'edit_name'],
    ['备注', 'edit'], ['删除', 'delete'], ['分享', 'public_share'], ['更多', 'more']]) {
    const link = new El('a', { attrs: { href: 'javascript:;', menu } });
    link.append(label);
    opr.append(link);
  }

  li.append(wrap, size, opr);
  return li;
}

const ROWS = [
  { name: 'hmpd-10044.mp4', fileId: '3527247704331650213', pickCode: 'bi0izro13wfpq8syt', sizeBytes: 6984372848, cid: '3063507687632273050', ptime: '昨天 21:42' },
  { name: 'PIYO-046.mp4', fileId: '3527255729897474011', pickCode: 'akakyaxcd6fimhfvo', sizeBytes: 9401255990, cid: '3063507687632273050', ptime: '昨天 16:27' }
];

const root = new El('body');
const ul = new El('ul');
ul.append(...ROWS.map(build115Row));
root.append(ul);

const mod = loadScanner(makeDocument(root));
const items = mod.scanVideoItems();
const stats = mod.getScanStats();

/* ==================== 断言 ==================== */

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  console.log(`${ok ? '✅' : '❌'} ${name}\n     实际=${a}\n     期望=${e}`);
  if (ok) pass++; else fail++;
}

console.log('\n=== 扫描结果 ===');
console.log(`元素总数=${stats.totalElements} 像视频=${stats.videoLike} 收录=${items.length}`);
items.forEach((it) => console.log(
  `  → ${it.name} | pickcode=${it.pickcode} | fileId=${it.fileId} | size=${it.size} | ` +
  `rowEl=${it.rowEl?.tagName} | clickEl=${it.clickEl?.tagName}.${it.clickEl?.className}`
));
console.log('');

check('两个文件各扫出一条（不重复、不漏）', items.length, 2);

const hmpd = items.find((i) => i.name === 'hmpd-10044.mp4');
const piyo = items.find((i) => i.name === 'PIYO-046.mp4');

console.log('\n=== ① 属性挖掘：属性名带下划线也能挖到 ===');
check('pickcode 从 pick_code 挖到', hmpd.pickcode, 'bi0izro13wfpq8syt');
check('fileId 从 file_id 挖到', hmpd.fileId, '3527247704331650213');
check('size 从 file_size 属性算（不是从文本猜）', hmpd.size, '6.50GB');
check('key 优先用 fileId', hmpd.key, '3527247704331650213');

console.log('\n=== ② 行定位：必须是 <li>，不能上溯到装着所有行的 <ul> ===');
check('rowEl 是 LI', hmpd.rowEl.tagName, 'LI');
check('rowEl 的父节点是 UL（说明没人把 UL 当行容器）', hmpd.rowEl.parentElement.tagName, 'UL');
check('rowEl 带 115 的行标记 rel=item', hmpd.rowEl.getAttribute('rel'), 'item');

console.log('\n=== ③ 点击目标：必须是带 menu 的那个 <a> ===');
check('clickEl 是 A 标签', hmpd.clickEl.tagName, 'A');
check('clickEl 带 menu=view_file_one', hmpd.clickEl.getAttribute('menu'), 'view_file_one');
check('clickEl 的 title 就是文件名', hmpd.clickEl.getAttribute('title'), 'hmpd-10044.mp4');
check('clickEl 不是行容器本身', hmpd.clickEl !== hmpd.rowEl, true);

console.log('\n=== ④ 防串号：两条记录的属性不能互相污染 ===');
check('第二个文件的 pickcode 是自己的', piyo.pickcode, 'akakyaxcd6fimhfvo');
check('第二个文件的 fileId 是自己的', piyo.fileId, '3527255729897474011');
check('两个 pickcode 不相同', hmpd.pickcode !== piyo.pickcode, true);
check('第二个文件的 size 来自自己的行', piyo.size, '8.76GB');

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
