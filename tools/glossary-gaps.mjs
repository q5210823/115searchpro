/**
 * 术语表缺词统计（数据驱动补词）
 * ------------------------------------------------------------------
 * 为什么要有它：
 *   纯本地术语表能不能用，全看**词典收没收下真实标题里的词**。
 *   靠肉眼翻列表猜「该补哪个词」效率极低，而且容易补错优先级 ——
 *   补了十个只出现一次的冷门词，不如补一个出现在 800 条标题里的常用词。
 *   所以直接统计：把库里的标题全跑一遍，按**未译词出现次数**排序。
 *
 * 用法：
 *   node tools/glossary-gaps.mjs 备份.json          # 面板「导出资料库」的 JSON
 *   node tools/glossary-gaps.mjs --stdin < titles.txt
 *   node tools/glossary-gaps.mjs "标题1" "标题2"
 *
 * ⚠️ 读管道必须显式加 --stdin：自动探测 stdin 在 Windows/Git Bash 下不可靠，
 *    探测失败会一直卡住等输入。
 *
 * 输出里「出现次数」最高的那些词，就是补进 src/core/glossary.js 的首选。
 * 补完把 GLOSSARY_VERSION 加一，已译条目会自动重译。
 * 重复标题只算一次（同一部片常有多份文件），否则比例会被重复项带偏。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(ROOT, '..', 'src', 'core', 'glossary.js'), 'utf8');

// ⚠️ import 也要剥（storage.js 那类文件里有），不留下来就是 SyntaxError
const strip = (s) => s
  .replace(/^\s*import\s+\{[\s\S]*?\}\s+from\s+['"][^'"]+['"];?\s*$/gm, '')
  .replace(/^\s*import\s+.*?from\s+['"][^'"]+['"];?\s*$/gm, '')
  .replace(/^export (async )?function /gm, '$1function ')
  .replace(/^export const /gm, 'const ');

const mod = new Function(
  `"use strict";
   ${strip(SRC)}
   return { translateTitle, GLOSSARY_VERSION, glossarySize, FULL_COVERAGE };
  `
)();

const { translateTitle, GLOSSARY_VERSION, glossarySize, FULL_COVERAGE } = mod;

/* ---------------- 收集标题 ---------------- */

/** 从备份 JSON 里把标题捞全（meta / library 两处都可能有） */
function titlesFromJson(obj) {
  const out = [];
  for (const key of ['meta', 'library']) {
    const arr = obj && obj[key];
    if (!Array.isArray(arr)) continue;
    for (const r of arr) {
      if (r && typeof r.title === 'string' && r.title.trim()) {
        out.push({ title: r.title.trim(), code: r.code || '', actresses: r.actresses || [] });
      }
    }
  }
  return out;
}

function collect() {
  const argv = process.argv.slice(2);
  const useStdin = argv.includes('--stdin');
  const args = argv.filter((a) => a && !a.startsWith('-'));

  if (useStdin) {
    const text = fs.readFileSync(0, 'utf8');
    return text.split(/\r?\n/).filter(Boolean).map((t) => ({ title: t.trim(), code: '', actresses: [] }));
  }
  if (args.length === 1 && fs.existsSync(args[0])) {
    const raw = fs.readFileSync(args[0], 'utf8');
    if (args[0].toLowerCase().endsWith('.json') || raw.trimStart().startsWith('{')) {
      return titlesFromJson(JSON.parse(raw));
    }
    return raw.split(/\r?\n/).filter(Boolean).map((t) => ({ title: t.trim(), code: '', actresses: [] }));
  }
  return args.map((t) => ({ title: t, code: '', actresses: [] }));
}

/* ---------------- 统计 ---------------- */

const rows = collect();
if (!rows.length) {
  console.error('没有拿到标题。用法：');
  console.error('  node tools/glossary-gaps.mjs 备份.json');
  console.error('  node tools/glossary-gaps.mjs --stdin < titles.txt');
  process.exit(2);
}

// 同一个标题只统计一次（同一部片往往有多份文件，重复会放大比例）
const uniq = new Map();
for (const r of rows) if (!uniq.has(r.title)) uniq.set(r.title, r);
const list = [...uniq.values()];

const counts = new Map();
const buckets = [0, 0, 0, 0, 0]; // <20% / 20-40 / 40-60 / 60-80 / >=80
let covSum = 0;
let full = 0;
let none = 0;

for (const r of list) {
  const t = translateTitle(r.title, { code: r.code, actresses: r.actresses });
  covSum += t.coverage || 0;
  if (!t.changed) none++;
  else if (t.coverage >= FULL_COVERAGE) full++;
  const b = Math.min(4, Math.floor((t.coverage || 0) * 5));
  buckets[b]++;
  for (const w of t.unmapped || []) counts.set(w, (counts.get(w) || 0) + 1);
}

const pct = (n) => `${String(Math.round((n / list.length) * 100)).padStart(3)}%`;
const bar = (n) => '█'.repeat(Math.round((n / list.length) * 30));

console.log(`术语表 v${GLOSSARY_VERSION} · ${glossarySize()} 词条 · 共 ${rows.length} 条文件 / ${list.length} 个不同标题\n`);

console.log('覆盖率分布');
const labels = [' 0-20%', '20-40%', '40-60%', '60-80%', '80-100%'];
buckets.forEach((n, i) => console.log(`  ${labels[i]} ${pct(n)} ${bar(n)} ${n}`));
console.log(`\n  平均覆盖率 ${(covSum / list.length * 100).toFixed(1)}%`);
console.log(`  译得动(≥${FULL_COVERAGE * 100}%) ${full} 条 · 半译 ${list.length - full - none} 条 · 完全没译 ${none} 条`);

const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

/*
 * 关键区分：未译的东西分两类，别混在一起报。
 *
 *   ① 可补的**词**：含汉字，或长度 ≥3 的假名词（「同窓会」「イキづらい」）
 *      —— 这些加进词典就有用，是最该补的。
 *
 *   ② 补不了的**语法碎片**：单字假名、以及长度 2 的纯假名（`い` `が` `く`
 *      `った` `かれた`）。它们不是词，是动词活用和助词被切剩下的尾巴 ——
 *      术语表是「词对词替换」，对它无能为力（词典也明文禁收单字词条，
 *      否则会把别的词撕开）。
 *
 * 分开报很重要：混在一起会让人误以为「再补几个词就好了」，
 * 于是反复补词却看不到提升 —— 天花板不在词典大小，在「词表换词」这个方法本身。
 */
const isWordy = (w) => /[\u4e00-\u9fff]/.test(w) || w.length >= 3;
const wordy = top.filter(([w]) => isWordy(w));
const fragile = top.filter(([w]) => !isWordy(w));

const LIMIT = 40;
console.log(`\n① 可补的词（含汉字 / 长度≥3，补了就有用）—— 按出现的标题数排序`);
if (!wordy.length) {
  console.log('  （没有。说明剩下的全是语法碎片，补词已经救不了）');
} else {
  const w = Math.max(...wordy.slice(0, LIMIT).map(([k]) => k.length));
  for (const [word, n] of wordy.slice(0, LIMIT)) {
    console.log(`  ${word.padEnd(w)}  ${String(n).padStart(5)} 条  ${'█'.repeat(Math.min(30, n))}`);
  }
  console.log('\n  粘进 src/core/glossary.js（补上译法），然后把 GLOSSARY_VERSION +1：');
  console.log(wordy.slice(0, 20).map(([k]) => `  ['${k}', ''],`).join('\n'));
}

console.log(`\n② 语法碎片（单字假名 / 两字纯假名，共 ${fragile.length} 个）—— **补不了，别补**`);
if (fragile.length) {
  console.log('  ' + fragile.slice(0, 30).map(([w, n]) => `${w}(${n})`).join('  '));
  console.log(
    '  这些是动词活用与助词被切剩下的尾巴，不是词。术语表是「词对词替换」，'
    + '对它无能为力；\n  词典也明文禁收单字词条（会把别的词撕开）。'
    + '它们占比高 = 这个方法的**天花板**到了，\n  再往词典里堆词也不会变好，得换思路（见 README「中文标题」一节）。'
  );
}

console.log(`\n汇总：不同标题 ${list.length} 个 · 平均覆盖率 ${(covSum / list.length * 100).toFixed(1)}%`
  + ` · 译得动 ${full} · 半译 ${list.length - full - none} · 完全没译 ${none}`);
console.log(`术语表 v${GLOSSARY_VERSION} · ${glossarySize()} 词条`);
