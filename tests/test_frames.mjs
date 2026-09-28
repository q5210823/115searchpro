/**
 * frames.js 单元测试
 * 目标：验证 frame 角色判定与跨 frame 扫描逻辑。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(ROOT, '..', 'src', 'core', 'frames.js'), 'utf8');

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  console.log(`${ok ? '✅' : '❌'} ${name}  实际=${actual} 期望=${expected}`);
  if (ok) pass++; else fail++;
}

// ---- 加载 frames.js 的纯函数 ----
function loadFrames(loc, isTop) {
  const code = SRC
    .replace(/^const CHANNEL = .*$/m, "const CHANNEL = 'jv115-tagger';")
    .replace(/export function /g, 'function ');

  const factory = new Function(
    'location', 'window', 'document', 'URL', 'console',
    `"use strict";
     ${code}
     return { isTopFrame, isFileListFrame };
    `
  );

  const win = {
    get top() { return isTop ? win : { postMessage() {} }; },
    get self() { return win; },
    addEventListener() {},
    removeEventListener() {}
  };

  return factory(loc, win, { querySelectorAll: () => [] }, URL, console);
}

// ---- 1. 顶层判定 ----
{
  const m = loadFrames({ href: 'https://115.com/?cid=1', searchParams: new URLSearchParams('cid=1') }, true);
  check('顶层窗口识别为 isTopFrame', m.isTopFrame(), true);
}
{
  const m = loadFrames({ href: 'https://115.com/x', searchParams: new URLSearchParams('') }, false);
  check('子窗口不识别为 isTopFrame', m.isTopFrame(), false);
}

// ---- 2. 列表 frame 判定（用真实 URL） ----
const LIST_URL = 'https://115.com/?ct=file&ac=userfile&tpl=view_large&s=0&is_wl_tpl=1&aid=1&cid=3063507687632273050&offset=0&limit=24';
{
  const u = new URL(LIST_URL);
  const m = loadFrames({ href: LIST_URL, searchParams: u.searchParams }, false);
  check('真实列表 iframe URL 识别为列表 frame', m.isFileListFrame(), true);
}
{
  const url = 'https://115.com/?cid=1&offset=0&mode=wangpan';
  const u = new URL(url);
  const m = loadFrames({ href: url, searchParams: u.searchParams }, true);
  check('顶层面板 URL 不识别为列表 frame', m.isFileListFrame(), false);
}
{
  const url = 'https://webapi.115.com/bridge_2.0.html?namespace=Core.DataAccess';
  const u = new URL(url);
  const m = loadFrames({ href: url, searchParams: u.searchParams }, false);
  check('bridge.html 不识别为列表 frame', m.isFileListFrame(), false);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
