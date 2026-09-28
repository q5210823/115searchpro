/**
 * 术语表翻译预览（命令行调试工具）
 * ------------------------------------------------------------------
 * 为什么要有它：
 *   这个功能的日常维护就是「看效果 → 补词条」。
 *   每次都要开浏览器、进面板、点按钮看对照表太慢，所以在命令行里直接看。
 *
 * 用法：
 *   node tools/preview-translate.mjs                    # 跑内置样例
 *   node tools/preview-translate.mjs "専属 巨乳の中出し" "人妻の浮気"
 *   node tools/preview-translate.mjs --stdin < titles.txt   # 一行一个标题
 *
 * ⚠️ 读管道必须显式加 --stdin。自动探测「stdin 是不是管子」在 Windows/Git Bash
 *    下不可靠，探测失败就会**一直卡住等输入** —— 一个会挂住的工具比没有更糟。
 *
 * 输出里「未译」那一列就是词典缺的词 —— 把它们加进
 * src/core/glossary.js，再把 GLOSSARY_VERSION 加一即可。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(ROOT, '..', 'src', 'core', 'glossary.js'), 'utf8');

const stripExports = (s) => s
  .replace(/^export (async )?function /gm, '$1function ')
  .replace(/^export const /gm, 'const ');

const mod = new Function(
  `"use strict";
   ${stripExports(SRC)}
   return { translateTitle, GLOSSARY_VERSION, glossarySize };
  `
)();

const { translateTitle, GLOSSARY_VERSION, glossarySize } = mod;

/**
 * 内置样例：覆盖几种典型写法（长标题 / 术语密集 / 带番号 / 带演员名）。
 * 第三项是演员名 —— 专门放进来验证「专名绝不被翻译」：
 * 例子里的 `倉本すみれ` 必须在译文里一字不改。
 */
const SAMPLES = [
  ['SONE-119', 'SONE-119 新人NO.1STYLE 倉本すみれ AVデビュー', ['倉本すみれ']],
  ['MIDV-001', '専属決定 巨乳お姉さんの初めての中出し 4時間', []],
  ['ADN-500', '人妻の浮気 ～昼下がりの不倫旅行～', []],
  ['SSIS-999', '痴女ナースの密室調教', []],
  ['ABW-300', '独占配信 美少女アイドル 完全版', []],
  ['PRED-450', '夫婦交換 寝取られ温泉旅行 前編', []],
  ['FSDSS-700', '素人ナンパ 逆ナン合コン', []],
  ['IPX-800', '極上美脚 高画質 4時間 永久保存版', []],
  ['JUQ-250', '童貞筆おろし 家庭教師の誘惑', []],
  ['MIAA-600', '盗撮電車痴漢 露出尾行', []]
];

function collect() {
  const argv = process.argv.slice(2);
  const args = argv.filter((a) => a && !a.startsWith('-'));
  if (args.length) return args.map((t) => ['', t, []]);
  if (argv.includes('--stdin')) {
    try {
      const raw = fs.readFileSync(0, 'utf8');
      const lines = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      if (lines.length) return lines.map((t) => ['', t, []]);
    } catch (e) { /* 读不到就走样例 */ }
  }
  return SAMPLES;
}

const rows = collect();
const bar = (n) => {
  const full = Math.round(n * 10);
  return '█'.repeat(full) + '░'.repeat(10 - full);
};

console.log(`术语表 v${GLOSSARY_VERSION} · ${glossarySize()} 词条 · 共 ${rows.length} 条\n`);

let ok = 0;
let sum = 0;
rows.forEach(([code, ja, actresses], i) => {
  const r = translateTitle(ja, { code, actresses });
  sum += r.coverage;
  if (r.changed) ok++;
  console.log(`[${String(i + 1).padStart(2)}] ${bar(r.coverage)} ${String(Math.round(r.coverage * 100)).padStart(3)}%`);
  console.log(`     原文 ${ja}`);
  console.log(`     译文 ${r.changed ? r.zh : '（未命中，保留原文）'}`);
  if (r.bad) console.log(`     保护 ${r.bad} 个专名（番号/演员名，原样保留）`);
  if (r.unmapped.length) console.log(`     未译 ${r.unmapped.join(' / ')}   ← 词典缺这些词`);
  console.log('');
});

console.log(`汇总：${ok}/${rows.length} 条有译文 · 平均覆盖率 ${Math.round((sum / rows.length) * 100)}%`);
console.log('补词条：编辑 src/core/glossary.js → GLOSSARY_VERSION +1 → 重新构建（已译条目会自动重译）');
