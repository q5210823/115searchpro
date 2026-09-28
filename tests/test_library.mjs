/**
 * library（资料库）单元测试
 * ------------------------------------------------------------------
 * 覆盖两块纯逻辑：
 *   buildLibraryRecord   —— 把「文件 + 元数据」组装成入库记录
 *   filterLibraryRows    —— 关键词 / 演员 / 类别 筛选
 *
 * 为什么不用真 IndexedDB：
 *   这两个函数都不碰数据库（queryLibrary 只是它们的包装），
 *   所以直接把源码里的 export 去掉、用 new Function 加载即可。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(ROOT, '..', 'src', 'core', 'storage.js'), 'utf8');
// storage.js 依赖 glossary.js 的 FULL_COVERAGE（统计口径），
// 单测里要按 bundler 的顺序把两个文件拼进同一作用域
const SRC_GLOSSARY = fs.readFileSync(path.join(ROOT, '..', 'src', 'core', 'glossary.js'), 'utf8');

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  console.log(`${ok ? '✅' : '❌'} ${name}\n     实际=${a}\n     期望=${e}`);
  if (ok) pass++; else fail++;
}

// ---- 加载纯函数（去掉 export / import 关键字） ----
// ⚠️ import 也要剥：storage.js 里有 `import { FULL_COVERAGE }`，
//    留着就是 SyntaxError（"Cannot use import statement outside a module"），
//    整个测试文件会静默崩溃 —— 这正是「判据必须是退出码」的原因。
const strip = (s) => s
  .replace(/^\s*import\s+\{[\s\S]*?\}\s+from\s+['"][^'"]+['"];?\s*$/gm, '')
  .replace(/^\s*import\s+.*?from\s+['"][^'"]+['"];?\s*$/gm, '')
  .replace(/^export (async )?function /gm, '$1function ')
  .replace(/^export const /gm, 'const ');

const code = strip(SRC_GLOSSARY) + '\n' + strip(SRC);

const mod = new Function(
  `"use strict";
   ${code}
   return { buildLibraryRecord, filterLibraryRows };
  `
)();

const { buildLibraryRecord, filterLibraryRows } = mod;

/* ==================== 1. buildLibraryRecord ==================== */

console.log('\n=== buildLibraryRecord：组装入库记录 ===');

{
  const r = buildLibraryRecord({
    cid: '3527255730090411997',
    fileName: 'PIYO-046.mp4',
    fileId: '1234567890',
    pickcode: 'fati8bfcghfrjo4fvo',
    size: '8.76GB',
    code: 'PIYO-046',
    confidence: 99,
    meta: {
      code: 'PIYO-046',
      title: '测试标题',
      actresses: ['演员A', '演员B'],
      genres: ['类别1', '类别2'],
      cover: 'https://x/c.jpg',
      source: 'javbus'
    }
  });

  check('id 用 cid@@fileName 组成',
    r.id, '3527255730090411997@@PIYO-046.mp4');
  check('matched 为 true', r.matched, true);
  check('标题写入', r.title, '测试标题');
  check('演员数组写入', r.actresses, ['演员A', '演员B']);
  check('类别数组写入', r.genres, ['类别1', '类别2']);
  check('fileId 转字符串', r.fileId, '1234567890');
  check('pickcode 写入（播放必需）', r.pickcode, 'fati8bfcghfrjo4fvo');
}

{
  // 没挖到 pickcode → 存 null，不能存成空串（空串会骗过 !row.pickcode 判断）
  const r = buildLibraryRecord({ cid: 'c9', fileName: 'N.mp4', code: 'N-1' });
  check('无 pickcode 时存 null', r.pickcode, null);
}

{
  // 回归：cid 取值错误（0）也照原样存，方便事后看出是哪批数据有问题
  const r = buildLibraryRecord({ cid: '0', fileName: 'Z.mp4', code: 'Z-1' });
  check('cid=0 原样保留（便于识别脏数据）', r.cid, '0');
  check('cid=0 时 id 前缀也是 0', r.id, '0@@Z.mp4');
}

{
  // 未命中数据源：记录仍要入库，方便之后补
  const r = buildLibraryRecord({
    cid: 'c1', fileName: 'ABC-123.mp4', code: 'ABC-123', confidence: 90,
    meta: { code: 'ABC-123', notFound: true }
  });
  check('notFound 时 matched=false', r.matched, false);
  check('notFound 时标题为空', r.title, '');
  check('notFound 时演员为空数组', r.actresses, []);
  check('notFound 时仍保留番号', r.code, 'ABC-123');
}

{
  // 元数据脏数据：重复、带空格、混入空值
  const r = buildLibraryRecord({
    cid: 'c2', fileName: 'X.mp4', code: 'X-1', confidence: 80,
    meta: {
      title: 'T',
      actresses: ['演员A', ' 演员A ', '', null, undefined, '演员B'],
      genres: ['G1', 'G1']
    }
  });
  check('演员去重 + trim + 过滤空值', r.actresses, ['演员A', '演员B']);
  check('类别去重', r.genres, ['G1']);
}

{
  const r = buildLibraryRecord({ cid: '', fileName: 'Y.mp4', meta: null });
  check('无 meta 时不炸', r.matched, false);
  check('无 meta 时演员为空数组', r.actresses, []);
  check('无 fileId 时存 null', r.fileId, null);
}

/* ==================== 2. filterLibraryRows ==================== */

console.log('\n=== filterLibraryRows：搜索与筛选 ===');

const ROWS = [
  { id: 'a', cid: 'dir1', code: 'AAA-001', title: '校园故事', fileName: 'AAA-001.mp4',
    actresses: ['演员甲', '演员乙'], genres: ['校园', '剧情'] },
  { id: 'b', cid: 'dir1', code: 'BBB-002', title: '办公室恋曲', fileName: 'BBB-002.mp4',
    actresses: ['演员乙', '演员丙'], genres: ['职场', '剧情'] },
  { id: 'c', cid: 'dir2', code: 'CCC-003', title: '夏日回忆', fileName: 'CCC-003.mp4',
    actresses: ['演员甲'], genres: ['校园'] }
];

check('无任何条件 → 全部', filterLibraryRows(ROWS, {}).length, 3);

// 关键词
check('关键词命中番号', filterLibraryRows(ROWS, { keyword: 'BBB' }).map((r) => r.code), ['BBB-002']);
check('关键词大小写不敏感', filterLibraryRows(ROWS, { keyword: 'bbb-002' }).map((r) => r.code), ['BBB-002']);
check('关键词命中标题', filterLibraryRows(ROWS, { keyword: '夏日' }).map((r) => r.code), ['CCC-003']);
check('关键词命中演员', filterLibraryRows(ROWS, { keyword: '演员丙' }).map((r) => r.code), ['BBB-002']);
check('关键词命中类别', filterLibraryRows(ROWS, { keyword: '职场' }).map((r) => r.code), ['BBB-002']);
check('关键词前后空格被忽略', filterLibraryRows(ROWS, { keyword: '  校园  ' }).length, 2);
check('关键词无命中 → 空', filterLibraryRows(ROWS, { keyword: '不存在的东西' }).length, 0);

// 演员
check('演员单选', filterLibraryRows(ROWS, { actresses: ['演员甲'] }).map((r) => r.code), ['AAA-001', 'CCC-003']);
check('演员多选是 AND（同时具备）',
  filterLibraryRows(ROWS, { actresses: ['演员甲', '演员乙'] }).map((r) => r.code), ['AAA-001']);
check('演员多选无交集 → 空',
  filterLibraryRows(ROWS, { actresses: ['演员甲', '演员丙'] }).length, 0);

// 类别
check('类别单选', filterLibraryRows(ROWS, { genres: ['剧情'] }).map((r) => r.code), ['AAA-001', 'BBB-002']);
check('类别多选是 AND',
  filterLibraryRows(ROWS, { genres: ['校园', '剧情'] }).map((r) => r.code), ['AAA-001']);

// 目录
check('按 cid 过滤', filterLibraryRows(ROWS, { cid: 'dir2' }).map((r) => r.code), ['CCC-003']);

// 组合
check('关键词 + 演员 组合',
  filterLibraryRows(ROWS, { keyword: '剧情', actresses: ['演员丙'] }).map((r) => r.code), ['BBB-002']);

// 排序
check('结果按番号排序',
  filterLibraryRows(ROWS, {}).map((r) => r.code), ['AAA-001', 'BBB-002', 'CCC-003']);

// 脏数据
check('空数组输入不炸', filterLibraryRows(null, {}).length, 0);
check('记录缺 actresses 字段不炸',
  filterLibraryRows([{ id: 'x', code: 'X-1', fileName: 'x.mp4' }], { actresses: ['演员甲'] }).length, 0);

/* ==================== 3. 表结构变更的静态检查 ==================== */

console.log('\n=== 表结构 ===');
check('DB_VERSION 已升到 3（新增 dirs 表）', /const DB_VERSION = 3;/.test(SRC), true);
check('library 表已创建', /createObjectStore\(STORE_LIBRARY/.test(SRC), true);
check('dirs 表已创建（增量收录的目录汇总）', /createObjectStore\(STORE_DIRS/.test(SRC), true);
check('actresses 建了 multiEntry 索引',
  /createIndex\('actresses', 'actresses', \{ unique: false, multiEntry: true \}\)/.test(SRC), true);
check('genres 建了 multiEntry 索引',
  /createIndex\('genres', 'genres', \{ unique: false, multiEntry: true \}\)/.test(SRC), true);
check('clearAll 会清 library 表', /objectStore\(STORE_LIBRARY\)\.clear\(\)/.test(SRC), true);
check('clearAll 会清 dirs 表', /objectStore\(STORE_DIRS\)\.clear\(\)/.test(SRC), true);
check('有 pruneLibraryDuplicates（cid 修正后防重复）',
  /export async function pruneLibraryDuplicates/.test(SRC), true);
check('pickcode 字段在 buildLibraryRecord 里落库',
  /pickcode: pickcode \? String\(pickcode\)/.test(SRC), true);
check('导出了 DEFAULT_PLAYER_URL 常量',
  /export const DEFAULT_PLAYER_URL =\s*\n?\s*'https:\/\/115\.com\/web\/lixian\/master\/video\/\?pick_code=\{pickcode\}&cid=\{cid\}'/.test(SRC), true);
check('DEFAULT_SETTINGS 引用该常量（避免两处硬编码）',
  /playerUrlTemplate: DEFAULT_PLAYER_URL/.test(SRC), true);

/* ==================== 4. 增量收录相关 API ==================== */

console.log('\n=== 增量收录 ===');
check('有 getLibraryByCid（读同目录已有记录）',
  /export async function getLibraryByCid/.test(SRC), true);
check('有 putDirMeta（记录目录收录状态）',
  /export async function putDirMeta/.test(SRC), true);
check('有 deleteLibraryGone（清理失效条目）',
  /export async function deleteLibraryGone/.test(SRC), true);

// gone 条目默认被过滤掉
const WITH_GONE = [
  { id: 'g1', cid: 'd1', code: 'AAA-001', fileName: 'AAA-001.mp4', actresses: [], genres: [] },
  { id: 'g2', cid: 'd1', code: 'BBB-002', fileName: 'BBB-002.mp4', actresses: [], genres: [], gone: true }
];
check('失效条目默认隐藏', filterLibraryRows(WITH_GONE, {}).map((r) => r.id), ['g1']);
check('hideGone=false 时能看到失效条目',
  filterLibraryRows(WITH_GONE, { hideGone: false }).map((r) => r.id), ['g1', 'g2']);

// buildLibraryRecord 的增量语义
{
  const prev = {
    id: 'c1@@X-1.mp4', cid: 'c1', fileName: 'X-1.mp4', code: 'X-1',
    matched: true, title: '旧标题', actresses: ['演员A'], genres: ['类别A'],
    pickcode: 'pc12345678', fileId: '111', size: '1.00GB',
    firstSeenAt: 1000, harvestedAt: 1000
  };
  // 这次没抓到标签（数据源抽风）→ 必须保留上次的数据，不能退化
  const r1 = buildLibraryRecord({
    cid: 'c1', fileName: 'X-1.mp4', code: 'X-1', confidence: 99,
    fileId: '111', pickcode: 'pc12345678', size: '1.00GB', meta: { code: 'X-1', notFound: true },
    prev
  });
  check('这次没查到标签 → 保留上次的标题', r1.title, '旧标题');
  check('这次没查到标签 → 保留上次的演员', r1.actresses, ['演员A']);
  check('保留上次记录时 matched 仍为 true', r1.matched, true);
  check('keptPrev 标记为 true（便于统计）', r1.keptPrev, true);
  check('firstSeenAt 沿用首次见到的时间', r1.firstSeenAt, 1000);

  // 正常抓到标签 → 覆盖
  const r2 = buildLibraryRecord({
    cid: 'c1', fileName: 'X-1.mp4', code: 'X-1', confidence: 99,
    fileId: '111', pickcode: 'pc12345678', size: '1.00GB',
    meta: { code: 'X-1', title: '新标题', actresses: ['演员B'], genres: ['类别B'] },
    prev
  });
  check('抓到新标签 → 覆盖标题', r2.title, '新标题');
  check('抓到新标签 → keptPrev 为 false', r2.keptPrev, false);

  // 新文件（没有 prev）
  const r3 = buildLibraryRecord({
    cid: 'c1', fileName: 'Y-2.mp4', code: 'Y-2', confidence: 99, meta: null
  });
  check('新文件 gone 为 false', r3.gone, false);
  check('新文件 lastSeenAt 已写入', typeof r3.lastSeenAt, 'number');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
