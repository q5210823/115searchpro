/**
 * 本地术语表中译 —— 单元测试
 * ------------------------------------------------------------------
 * 覆盖：
 *   词典完整性       —— 不许有单字词条 / 重复词条 / 空译法
 *   专名保护         —— 番号、演员名绝不能被翻译（含「名字里带空格」的变体）
 *   最长优先         —— 「独占配信」整体命中，不被拆成「独占」+「配信」
 *   助词处理         —— の→的；其他助词要求左边紧邻中日文，词首不许被吞
 *   统计口径         —— 专名回填**之前**统计残留假名，否则 coverage 会虚低
 *   hashTitle        —— 必须把词典版本混进哈希（改词典才能自动重译）
 *   titleDisplayParts—— 中文主行 + 原文副行 + 「译」角标
 *
 * 加载方式沿用其它测试：剥掉 export，用 new Function 注入。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(ROOT, '..', 'src', 'core', 'glossary.js'), 'utf8');

let pass = 0, fail = 0;

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const good = a === e;
  console.log(`${good ? '✅' : '❌'} ${name}\n     实际=${a}\n     期望=${e}`);
  if (good) pass++; else fail++;
}

function truthy(name, actual) {
  const good = !!actual && actual !== '' && actual !== 'null';
  console.log(`${good ? '✅' : '❌'} ${name}\n     实际=${JSON.stringify(actual)}`);
  if (good) pass++; else fail++;
}

const stripExports = (s) => s
  // ⚠️ 必须同时处理 export function 和 export async function
  .replace(/^export (async )?function /gm, '$1function ')
  .replace(/^export const /gm, 'const ');

const mod = new Function(
  `"use strict";
   ${stripExports(SRC)}
   return { translateTitle, hashTitle, titleDisplayParts, glossarySize,
            normalizeKanji, kanjiTableSize,
            GLOSSARY, GLOSSARY_PARTICLES, GLOSSARY_VERSION };
  `
)();

const {
  translateTitle, hashTitle, titleDisplayParts, glossarySize,
  normalizeKanji, kanjiTableSize,
  GLOSSARY, GLOSSARY_PARTICLES, GLOSSARY_VERSION
} = mod;

const norm = (s) => String(s).normalize('NFKC');

/* ================================================================== */
console.log('===== 1. 词典完整性 =====');

const shortKeys = GLOSSARY.filter(([ja]) => String(ja).trim().length < 2).map(([ja]) => ja);
check('词条表里没有单字词条（单字会把别的词撕开）', shortKeys, []);

const emptyVals = GLOSSARY.filter(([, zh]) => typeof zh !== 'string' || !zh).map(([ja]) => ja);
check('没有空译法', emptyVals, []);

const seen = new Set();
const dups = [];
for (const [ja] of GLOSSARY) {
  const k = norm(ja);
  if (seen.has(k)) dups.push(ja);
  seen.add(k);
}
check('没有重复词条', dups, []);

const spaced = GLOSSARY.filter(([ja]) => /\s/.test(ja)).map(([ja]) => ja);
check('词条里不带空格', spaced, []);

truthy(`词条数量够用（当前 ${glossarySize()} 条）`, glossarySize() >= 100);
truthy('词典版本号是正整数', Number.isInteger(GLOSSARY_VERSION) && GLOSSARY_VERSION >= 1);
truthy('助词表非空且都是短词条',
  GLOSSARY_PARTICLES.length > 0 && GLOSSARY_PARTICLES.every(([ja]) => String(ja).length <= 3));

/* ================================================================== */
console.log('\n===== 2. 专名保护（最要紧的一步） =====');

check('番号原样保留（用收录时已提取的 code）',
  translateTitle('SONE-119 デビュー', { code: 'SONE-119' }).zh, 'SONE-119 出道');

check('番号原样保留（没有 code 时靠正则兜底）',
  translateTitle('ABC-123 デビュー', {}).zh, 'ABC-123 出道');

check('兜底保护的专名会被计数',
  translateTitle('ABC-123 デビュー', {}).bad, 1);

check('演员名绝不被翻译',
  translateTitle('新人 倉本すみれ 中出し', { actresses: ['倉本すみれ'] }).zh,
  '新人 倉本すみれ 内射');

check('演员名被网页加了空格也要保护住',
  translateTitle('倉本 すみれ デビュー', { actresses: ['倉本すみれ'] }).zh,
  '倉本 すみれ 出道');

/*
 * 「同形词」：有些词日文汉字和中文写法一样（新人 / 巨乳 / 人妻），
 * 替换前后完全相同 → 不算译过。
 * 这条必须成立，否则列表里会挂出一堆名不副实的「译」角标。
 */
check('同形词不算译过（不产生假「译」角标）',
  translateTitle('新人', {}).changed, false);

check('番号 + 演员名 + 术语同时出现',
  translateTitle('SONE-119 新人 倉本すみれ 中出し', {
    code: 'SONE-119', actresses: ['倉本すみれ']
  }).zh, 'SONE-119 新人 倉本すみれ 内射');

/*
 * ★ 这条是「统计口径」的防回归：
 *   演员名本身是日文，如果在回填之后才统计残留假名，
 *   专名就会被算成「没译到」，每条带演员名的标题 coverage 都虚低。
 */
check('统计口径：被保护的专名不算「没译到」',
  translateTitle('デビュー 倉本すみれ', { actresses: ['倉本すみれ'] }).coverage, 1);

check('统计口径：被保护的专名不出现在 unmapped 里',
  translateTitle('デビュー 倉本すみれ', { actresses: ['倉本すみれ'] }).unmapped, []);

/* ================================================================== */
console.log('\n===== 3. 术语替换 =====');

check('基本术语', translateTitle('新人デビュー', {}).zh, '新人出道');
check('最长优先：独占配信 不被拆开', translateTitle('独占配信', {}).zh, '独播');
check('最长优先：永久保存版 不被拆开', translateTitle('永久保存版', {}).zh, '永久收藏版');
check('最长优先：記念作品 不被拆开', translateTitle('記念作品', {}).zh, '纪念作品');
check('命中计数', translateTitle('新人デビュー', {}).translated, 2);
check('单位：時間 → 小时', translateTitle('4時間', {}).zh, '4 小时');
check('尺寸/规格词', translateTitle('高画質 4K', {}).zh, '高画质 4K');

console.log('\n----- 全角与大小写 -----');
check('全角字母先做 NFKC 归一', translateTitle('ＡＶデビュー', {}).zh, 'AV 出道');

console.log('\n----- 助词 -----');
check('の → 的', translateTitle('巨乳の女優', {}).zh, '巨乳的女优');
check('を 直接丢掉（中文没有对应虚词）', translateTitle('人妻を調教', {}).zh, '人妻调教');
check('と → 与', translateTitle('人妻と上司', {}).zh, '人妻与上司');
/*
 * 词首的助词不能被吞掉 —— 助词规则要求「左边紧邻中日文字符」正是为了这个。
 * 否则 `はな` 会被啃成 `な`，词首直接烂掉。
 */
check('词首助词不许被吞（は 保留）', translateTitle('はな デビュー', {}).zh, 'はな 出道');
check('整个标题都是未知假名 → 视为没译到，回退原文',
  translateTitle('ピカピカ', {}).changed, false);

/* ================================================================== */
console.log('\n===== 3.5 字形归一化（日文旧字形 → 简体）=====');

/*
 * 这一节是「可读性」的命门。
 * 术语表只能收整词，剩下的汉字会原样流下来，而它们是日文写法 ——
 * 不做字形归一化，译文里就到处是「夫婦交換」「家庭教師の誘惑」。
 */
check('舊字體逐字归一：夫婦交換 → 夫妻交换', translateTitle('夫婦交換', {}).zh, '夫妻交换');
check('舊字體逐字归一：家庭教師の誘惑 → 家教的诱惑',
  translateTitle('家庭教師の誘惑', {}).zh, '家教的诱惑');
check('日文新字体逐字归一：専属決定 → 专属决定',
  translateTitle('専属決定', {}).zh, '专属决定');

check('纯字形归一化函数', normalizeKanji('図書館'), '图书馆');
check('不改中日同形字（人妻 两边写法一样）', normalizeKanji('人妻'), '人妻');
check('日文新字体的旧字也归一', normalizeKanji('実話'), '实话');
check('不误改已输出的简体（防「二次转换」）',
  normalizeKanji('专属决定'), '专属决定');
check('逐字遍历（同一个字出现多次都要换）', normalizeKanji('発発髪'), '发发发');
check('空输入', normalizeKanji(''), '');
check('null 输入不崩', normalizeKanji(null), '');

truthy(`字形表条目够用（当前 ${kanjiTableSize()} 条）`, kanjiTableSize() >= 200);

// 字形归一化必须发生在专名回填**之前**，否则演员名里的字会被改掉
check('字形归一化不碰被保护的专名',
  translateTitle('倉本すみれ 夫婦交換', { actresses: ['倉本すみれ'] }).zh,
  '倉本すみれ 夫妻交换');

/* ================================================================== */
console.log('\n===== 4. 清洗与健壮性 =====');

check('重复词合并', translateTitle('中出し中出し', {}).zh, '内射');
check('多余空格收拢', translateTitle('新人   デビュー', {}).zh, '新人 出道');
check('空标题', translateTitle('', {}).zh, '');
check('空标题 changed=false', translateTitle('', {}).changed, false);
check('null 输入不崩', translateTitle(null, {}).zh, '');
check('undefined 输入不崩', translateTitle(undefined, {}).changed, false);
check('非字符串输入不崩（数字）', translateTitle(12345, {}).changed, false);
check('没有词条命中时 changed=false（交给调用方回退原文）',
  translateTitle('NO.1 STYLE PREMIUM', {}).changed, false);

// 对已经译好的中文再跑一次，应当「什么都不做」—— 否则用户重复点翻译会越译越乱
check('对已译结果再跑一次是幂等的',
  translateTitle('SONE-119 新人 倉本すみれ 内射', {
    code: 'SONE-119', actresses: ['倉本すみれ']
  }).changed, false);

console.log('\n----- coverage（没译到的地方如实报告） -----');
check('全部命中 → coverage = 1', translateTitle('デビュー中出し', {}).coverage, 1);

const partial = translateTitle('デビューとモフモフ', {});
truthy('部分命中 → 0 < coverage < 1', partial.coverage > 0 && partial.coverage < 1);
check('未命中的假名会被列出来（方便回来补词条）', partial.unmapped, ['モフモフ']);
check('未命中时仍然给出译文（残余假名留着，不假装翻好了）',
  partial.zh, '出道与モフモフ');

/* ================================================================== */
console.log('\n===== 5. hashTitle（缓存失效的关键） =====');

const djb2 = (s) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
};

truthy('同一标题哈希稳定', hashTitle('新人デビュー') === hashTitle('新人デビュー'));
truthy('不同标题哈希不同', hashTitle('新人デビュー') !== hashTitle('新人中出し'));
truthy('返回非空字符串', typeof hashTitle('X') === 'string' && hashTitle('X').length > 0);
/*
 * ★ 必须把词典版本混进哈希。
 *   否则用户加了词条，老条目的哈希没变 → 永远不会被重译，
 *   用户只会觉得「我加了词还是没用，功能坏了」。
 */
truthy('词典版本参与哈希（改词典就能自动重译）', hashTitle('X') !== djb2('X'));

/* ================================================================== */
console.log('\n===== 6. titleDisplayParts（中文主行 + 原文副行） =====');

const rec = { title: '新人デビュー', titleZh: '新人出道', titleSrc: 'glossary' };

check('默认（中文主行 + 原文副行）',
  titleDisplayParts(rec), { main: '新人出道', sub: '新人デビュー', badge: '译', translated: true });

check("模式 'zh' 只显示中文",
  titleDisplayParts(rec, 'zh'), { main: '新人出道', sub: '', badge: '译', translated: true });

check("模式 'ja' 只显示原文",
  titleDisplayParts(rec, 'ja'), { main: '新人デビュー', sub: '', badge: '', translated: false });

check('没有译文 → 老实显示原文，不留空白',
  titleDisplayParts({ title: '新人デビュー' }),
  { main: '新人デビュー', sub: '', badge: '', translated: false });

check('连原文都没有 → 退回文件名',
  titleDisplayParts({ fileName: 'SONE-119.mp4' }),
  { main: 'SONE-119.mp4', sub: '', badge: '', translated: false });

check('译文与原文相同时视为没译（不显示「译」角标）',
  titleDisplayParts({ title: 'X', titleZh: 'X' }).badge, '');

check('非 glossary 来源不挂「译」角标（手动改过的译名）',
  titleDisplayParts({ title: 'X', titleZh: 'Y', titleSrc: 'manual' }).badge, '');

check('空记录不崩', titleDisplayParts(null).main, '');

/* ================================================================== */
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
