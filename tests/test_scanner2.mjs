/**
 * 扫描器回归测试 v2
 * 目标：验证在多种「真实 115 DOM 形态」下都能扫出视频文件。
 *
 * 因为 src/core/site-115.js 依赖 document / window / MutationObserver，
 * 这里用一个极简 DOM 桩来模拟，只测 findVideoLikeNodes 的匹配逻辑。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(ROOT, '..', 'src', 'core', 'site-115.js'), 'utf8');

// ---- 极简 DOM 桩 ----
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
  getAttribute(k) { return this.attrs[k] ?? null; }
  get textContent() {
    let s = '';
    for (const n of this.childNodes) {
      s += n.nodeType === 3 ? n.nodeValue : n.textContent;
    }
    return s;
  }
  querySelectorAll() {
    const out = [];
    const walk = (el) => { for (const c of el.children) { out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  contains(node) {
    for (const c of this.children) {
      if (c === node || c.contains?.(node)) return true;
    }
    return false;
  }
}

function makeDocument(root) {
  return {
    querySelectorAll: (sel) => (sel === '*' ? [root, ...root.querySelectorAll()] : root.querySelectorAll(sel)),
    body: root,
    readyState: 'complete'
  };
}

// ---- 加载扫描器模块（剥掉 export / 全局挂载） ----
function loadScanner(doc) {
  // ⚠️ 必须同时处理 `export function` 和 `export async function`。
  //    只替换前者的话，新增一个 async 导出就会让整个测试**静默崩溃**
  //    （报 SyntaxError，但不打印 ❌，只看「有没有 ❌」的脚本会误判为通过）。
  const code = SRC
    .replace(/^export (async )?function /gm, '$1function ')
    .replace(/^export const /gm, 'const ')
    .replace(/if \(typeof window !== 'undefined'\)[\s\S]*$/m, '');

  const factory = new Function(
    'document', 'location', 'MutationObserver', 'window', 'console',
    `"use strict";
     ${code}
     return { scanVideoItems, getScanStats, findVideoLikeNodes };
    `
  );
  return factory(doc, { href: 'https://115.com/?cid=123', hostname: '115.com', search: '?cid=123' },
    class { observe() {} disconnect() {} },
    { __JV115_TAGGER_LOADED__: true }, console);
}

// ---- 构造 3 种真实形态 ----
const CASES = [
  {
    name: '① 文件名是独立叶子节点（最简单）',
    build() {
      const root = new El('body');
      const list = new El('div', { className: 'file-list' });
      for (const f of ['SONE-119.mp4', 'PRED-501.mkv', 'ABP-456.mp4']) {
        const row = new El('div', { className: 'file-item', attrs: { 'data-id': '1234567890123456789' } });
        const name = new El('div', { className: 'file-name' });
        name.append(f);
        row.append(name, new El('div', { className: 'file-size' }).append('1.5 GB'));
        list.append(row);
      }
      root.append(list);
      return root;
    },
    expect: 3
  },
  {
    name: '② 文件名带高亮子 span（之前会漏）',
    build() {
      const root = new El('body');
      const list = new El('div', { className: 'file-list' });
      const files = ['SONE-119.mp4', 'PRED-501.mkv', 'ABP-456.mp4'];
      files.forEach((f, idx) => {
        const row = new El('div', { className: 'file-item', attrs: { 'data-fid': `98765432109876543${idx}` } });
        const name = new El('div', { className: 'file-name' });
        // 文本被拆成多段 + 高亮 span（模拟真实高亮/分段渲染）
        const dash = f.indexOf('-');
        const dot = f.lastIndexOf('.');
        name.append(
          f.slice(0, dash),
          new El('span', { className: 'hl' }).append(f.slice(dash, dot)),
          f.slice(dot)
        );
        row.append(name, new El('div', { className: 'file-size' }).append('2.1 GB'));
        list.append(row);
      });
      root.append(list);
      return root;
    },
    expect: 3,
    expectNames: ['SONE-119.mp4', 'PRED-501.mkv', 'ABP-456.mp4']
  },
  {
    name: '③ 文件名只在 title 属性里（文本被截断）',
    build() {
      const root = new El('body');
      const list = new El('div', { className: 'file-list' });
      for (const f of ['SONE-119.mp4', 'PRED-501.mkv']) {
        const row = new El('div', { className: 'file-item', attrs: { 'data-id': '1111222233334444555' } });
        const name = new El('a', {
          className: 'file-name',
          attrs: { title: f, 'data-name': f }
        });
        name.append('SONE-119...');   // 显示文本被截断
        row.append(name, new El('div', { className: 'file-size' }).append('900 MB'));
        list.append(row);
      }
      root.append(list);
      return root;
    },
    expect: 2
  },
  {
    name: '④ 文件名同时挂在「外层容器 + 内层节点」上（会出两个圆点）',
    build() {
      const root = new El('body');
      const list = new El('div', { className: 'file-list' });
      for (const f of ['SONE-119.mp4', 'PRED-501.mkv']) {
        const row = new El('div', { className: 'file-item', attrs: { 'data-id': '5555666677778888999' } });
        // 外层包裹层也带 title（115 真实行为）
        const wrap = new El('div', { className: 'name-wrap', attrs: { title: f } });
        const name = new El('div', { className: 'file-name' });
        name.append(f);
        wrap.append(name);
        row.append(wrap, new El('div', { className: 'file-size' }).append('1.2 GB'));
        list.append(row);
      }
      root.append(list);
      return root;
    },
    expect: 2,
    expectNames: ['SONE-119.mp4', 'PRED-501.mkv']
  },
  {
    name: '⑤ 面包屑里也显示当前文件名（不应被当成第二个文件）',
    build() {
      const root = new El('body');
      // 顶部面包屑：云下载 > PIYO-046.mp4
      const crumb = new El('div', { className: 'breadcrumb' });
      crumb.append(
        new El('span').append('云下载'),
        new El('span').append('PIYO-046.mp4')
      );
      const list = new El('div', { className: 'file-list' });
      const row = new El('div', { className: 'file-item', attrs: { 'data-id': '9999888877776666555' } });
      const name = new El('div', { className: 'file-name' });
      name.append('PIYO-046.mp4');
      row.append(name, new El('div', { className: 'file-size' }).append('8.76 GB'));
      list.append(row);
      root.append(crumb, list);
      return root;
    },
    expect: 1,
    expectNames: ['PIYO-046.mp4']
  },
  {
    name: '⑥ 文件名被拆成多段，其中一段单独也像视频名（应合并成 1 个）',
    build() {
      const root = new El('body');
      const list = new El('div', { className: 'file-list' });
      const row = new El('div', { className: 'file-item', attrs: { 'data-id': '1234123412341234123' } });
      const name = new El('div', { className: 'file-name' });
      // PIYO-046.mp4 被拆成 "PI" + span("YO-046") + ".mp4"
      // 内层 span 单独会拼出 / 文本上出现 "YO-046.mp4"
      const inner = new El('span', { className: 'hl' });
      inner.append('YO-046.mp4');
      name.append('PI', inner);
      row.append(name, new El('div', { className: 'file-size' }).append('8.76 GB'));
      list.append(row);
      root.append(list);
      return root;
    },
    expect: 1,
    expectNames: ['PIYO-046.mp4']
  },
  {
    name: '⑦ 完整名与残片是「兄弟节点」（只能靠文本包含规则合并）',
    build() {
      const root = new El('body');
      const list = new El('div', { className: 'file-list' });
      const row = new El('div', { className: 'file-item', attrs: { 'data-id': '7777888899990000111' } });
      const nameWrap = new El('div', { className: 'file-name-wrap' });
      // 两个平级节点：一个完整、一个只有残片
      const full = new El('div', { className: 'file-name' });
      full.append('PIYO-046.mp4');
      const frag = new El('div', { className: 'file-name-frag' });
      frag.append('YO-046.mp4');
      nameWrap.append(full, frag);
      row.append(nameWrap, new El('div', { className: 'file-size' }).append('8.76 GB'));
      list.append(row);
      root.append(list);
      return root;
    },
    expect: 1,
    expectNames: ['PIYO-046.mp4']
  }
];

let pass = 0, fail = 0;
for (const c of CASES) {
  const root = c.build();
  const doc = makeDocument(root);
  const mod = loadScanner(doc);
  const items = mod.scanVideoItems();
  const stats = mod.getScanStats();

  const ok = items.length === c.expect;
  let nameOk = true;
  if (c.expectNames) {
    const got = items.map((i) => i.name).sort();
    const want = [...c.expectNames].sort();
    nameOk = JSON.stringify(got) === JSON.stringify(want);
    if (!nameOk) console.log(`   文件名不匹配 期望=${JSON.stringify(want)} 实际=${JSON.stringify(got)}`);
  }
  const allOk = ok && nameOk;
  console.log(`${allOk ? '✅' : '❌'} ${c.name}`);
  console.log(`   期望 ${c.expect} 个，实际 ${items.length} 个 | 元素总数=${stats.totalElements} 像视频=${stats.videoLike}`);
  items.forEach((it) => console.log(`     → key=${it.key}  name=${it.name}`));
  if (allOk) pass++; else fail++;
  console.log('');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
