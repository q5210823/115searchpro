/**
 * 构建脚本：把 src/ 下的 ES 模块打包成单个 Tampermonkey 用户脚本。
 *
 * 策略：手写一个极简 bundler —— 按依赖顺序拼接模块，去掉 import/export 语句。
 * 这样产出无依赖、零 npm 安装、可直接粘贴进 Tampermonkey。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.dirname(__filename);
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');

const VERSION = '1.4.2';

/**
 * 依赖顺序（被依赖的放前面）
 * ★ 注意：storage.js 的统计口径要用 glossary.js 的 FULL_COVERAGE 常量，
 *   所以 glossary 必须排在 storage 前面（同一作用域里 const 有暂时性死区）。
 */
const MODULE_ORDER = [
  'core/frames.js',
  'core/tag-extractor.js',
  'core/providers.js',
  'core/glossary.js',    // 标题中译术语表（v1.4.0，纯函数 + 词典数据）
  'core/storage.js',
  'core/paging.js',      // 资料库列表分批渲染（v1.3.1）
  'core/ui.js',
  'core/site-115.js',
  'core/panel.js',
  'main.js'
];

const BANNER = `// ==UserScript==
// @name         115 网盘 JAV 标签助手
// @namespace    https://github.com/jv115-tagger
// @version      ${VERSION}
// @description  读取 115 网盘视频文件名，自动提取番号，从 JavBus / javlibrary 拉取影片信息，在文件列表上以「标题+演员+类别」标签形式展示。纯本地标签库，不改动 115 任何原始文件，无需 API key。
// @author       jv115-tagger
// @match        *://*.115.com/*
// @match        *://*.115cdn.com/*
// @match        *://*.115vod.com/*
// @include      *://*.115.com/*
// @include      *://*.115cdn.com/*
// @updateURL    https://raw.githubusercontent.com/q5210823/115searchpro/main/dist/jv115-tagger.user.js
// @downloadURL  https://raw.githubusercontent.com/q5210823/115searchpro/main/dist/jv115-tagger.user.js
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_log
// @connect      javbus.com
// @connect      www.javbus.com
// @connect      javlibrary.com
// @connect      www.javlibrary.com
// @connect      dmm.co.jp
// @connect      api.dmm.com
// @connect      *
// @run-at       document-idle
// ==/UserScript==
`;

/**
 * 去掉模块的 import / export 语法，保留函数与常量定义。
 * bundler 内部已按顺序拼接，所以这些语句不再需要。
 */
function stripModuleSyntax(code) {
  let out = code;

  // 1. 多行 import { ... } from '...';
  out = out.replace(/^\s*import\s+\{[\s\S]*?\}\s+from\s+['"][^'"]+['"];?\s*$/gm, '');
  // 2. 单行 import X from '...'; / import * as X from '...';
  out = out.replace(/^\s*import\s+.*?from\s+['"][^'"]+['"];?\s*$/gm, '');
  // 3. 副作用导入 import '...';
  out = out.replace(/^\s*import\s+['"][^'"]+['"];?\s*$/gm, '');

  // 4. export class / export function / export const / export let / export async function
  out = out.replace(/^\s*export\s+(async\s+function|function|class|const|let|var)\s/gm, '$1 ');
  // 5. export { a, b };  / export default X;
  out = out.replace(/^\s*export\s+\{[\s\S]*?\};?\s*$/gm, '');
  out = out.replace(/^\s*export\s+default\s+/gm, '');

  return out;
}

/** 生成模块间的命名空间隔离注释 */
function section(title) {
  const line = '='.repeat(66);
  return `\n/* ${line}\n * ${title}\n * ${line} */\n`;
}

function build() {
  const parts = [];

  for (const rel of MODULE_ORDER) {
    const full = path.join(SRC, rel);
    if (!fs.existsSync(full)) {
      throw new Error(`缺少模块：${rel}`);
    }
    const code = fs.readFileSync(full, 'utf8');
    parts.push(section(rel));
    parts.push(stripModuleSyntax(code));
  }

  const body = parts.join('\n');

  const script = `${BANNER}
(function () {
  'use strict';

  // ---- 立即探针：脚本一被注入就打印，用于区分「未运行」和「运行后失败」 ----
  try {
    console.log('%c[jv115-tagger] ✅ 脚本已注入并开始执行', 'color:#1a7f45;font-size:13px;font-weight:bold');
    console.log('%c[jv115-tagger]', 'color:#888', 'URL =', location.href);
  } catch (e) { /* 忽略 */ }

  // 避免重复注入（同一页面被多次加载时）
  if (window.__JV115_TAGGER_LOADED__) {
    console.log('[jv115-tagger] 已加载，跳过重复注入');
    return;
  }
  window.__JV115_TAGGER_LOADED__ = true;

${body}

})();
`;

  if (!fs.existsSync(DIST)) fs.mkdirSync(DIST, { recursive: true });

  const outFile = path.join(DIST, 'jv115-tagger.user.js');
  fs.writeFileSync(outFile, script, 'utf8');

  const kb = (Buffer.byteLength(script, 'utf8') / 1024).toFixed(1);
  console.log(`✅ 构建完成: ${path.relative(ROOT, outFile)} (${kb} KB)`);

  // 语法自检
  try {
    new Function(script.replace(/^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/m, ''));
    console.log('✅ 语法自检通过');
  } catch (e) {
    console.error('❌ 语法错误:', e.message);
    process.exit(1);
  }

  return outFile;
}

build();
