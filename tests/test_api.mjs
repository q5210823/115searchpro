/**
 * 115 官方接口层单元测试
 * ------------------------------------------------------------------
 * 覆盖：
 *   humanSize          字节 → 可读大小
 *   apiFileToRow       webapi 原始对象 → 内部 row 结构
 *   pickVideoRows      只留视频文件
 *   apiFetchDirAll     自动翻页（最容易写错的地方）+ 错误处理
 *
 * 为什么能这么测：
 *   这几个函数只依赖 fetch（可注入 mock），不碰 document。
 *   源码里引用 document / window 的部分都在别的函数体里，
 *   只要不调用它们就不会执行。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(ROOT, '..', 'src', 'core', 'site-115.js'), 'utf8');

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  console.log(`${ok ? '✅' : '❌'} ${name}\n     实际=${a}\n     期望=${e}`);
  if (ok) pass++; else fail++;
}
function checkMatch(name, actual, re) {
  const ok = re.test(String(actual));
  console.log(`${ok ? '✅' : '❌'} ${name}\n     实际=${JSON.stringify(String(actual))}\n     期望匹配=${re}`);
  if (ok) pass++; else fail++;
}

// ---- 加载纯函数（去掉 export） ----
const code = SRC
  .replace(/^export (async )?function /gm, '$1function ')
  .replace(/^export const /gm, 'const ');

/** 用 mock fetch 构造模块 */
function load(mockFetch) {
  return new Function(
    'fetch', 'GM_xmlhttpRequest',
    `"use strict";
     ${code}
     return { humanSize, apiFileToRow, pickVideoRows, apiFetchDirAll, API_PAGE_SIZE };`
  )(mockFetch, undefined);
}

/** 造一个假 fetch：按 offset 返回分页数据，并记录调用过的 URL */
function makeFetch(handler) {
  const calls = [];
  const fn = async (url) => {
    calls.push(String(url));
    const u = new URL(String(url));
    const r = handler({
      offset: Number(u.searchParams.get('offset')),
      limit: Number(u.searchParams.get('limit')),
      cid: u.searchParams.get('cid'),
      showDir: u.searchParams.get('show_dir'),
      raw: String(url)
    });
    if (r && r.__error) throw new Error(r.__error);
    if (r && r.__status) return { ok: false, status: r.__status };
    return { ok: true, status: 200, text: async () => JSON.stringify(r) };
  };
  fn.calls = calls;
  return fn;
}

/** 造一批文件对象 */
function files(from, n) {
  return Array.from({ length: n }, (_, i) => ({
    fid: String(1000 + from + i),
    n: `PIYO-${String(from + i).padStart(3, '0')}.mp4`,
    s: 1024 * 1024 * 100,
    pc: `pc${from + i}abcdefgh`,
    fc: '1'
  }));
}

/* ==================== 1. humanSize ==================== */

console.log('\n=== humanSize：字节 → 可读大小 ===');

{
  const mod = load(makeFetch(() => ({ state: true, count: 0, data: [] })));
  check('0 → 空串', mod.humanSize(0), '');
  check('1024 → 1.00KB', mod.humanSize(1024), '1.00KB');
  check('1048576 → 1.00MB', mod.humanSize(1048576), '1.00MB');
  check('1073741824 → 1.00GB', mod.humanSize(1073741824), '1.00GB');
  check('8.76GB 级别', mod.humanSize(9405797171), '8.76GB');
  check('500 字节不带小数', mod.humanSize(500), '500B');
}

/* ==================== 2. apiFileToRow ==================== */

console.log('\n=== apiFileToRow：webapi 对象 → 内部结构 ===');

{
  const mod = load(makeFetch(() => ({ state: true, count: 0, data: [] })));

  check('视频文件字段映射',
    mod.apiFileToRow({
      fid: '1935066538753108146',
      n: 'PIYO-046.mp4',
      s: 9405797171,
      pc: 'fati8bfcghfrjo4fvo',
      fc: '1',
      upt: 1700000000
    }),
    {
      name: 'PIYO-046.mp4',
      fileId: '1935066538753108146',
      pickcode: 'fati8bfcghfrjo4fvo',
      size: '8.76GB',
      sizeRaw: 9405797171,
      isDir: false,
      updatedAt: 1700000000
    });

  check('文件夹（fc=0）→ isDir=true',
    mod.apiFileToRow({ n: '某个文件夹', fc: '0' }).isDir, true);

  check('缺字段不炸，给安全默认值',
    mod.apiFileToRow({}),
    { name: '', fileId: null, pickcode: null, size: '', sizeRaw: 0, isDir: false, updatedAt: 0 });

  check('没有 pc 时 pickcode 为 null',
    mod.apiFileToRow({ n: 'a.mp4', fc: '1' }).pickcode, null);
}

/* ==================== 3. pickVideoRows ==================== */

console.log('\n=== pickVideoRows：只留视频文件 ===');

{
  const mod = load(makeFetch(() => ({ state: true, count: 0, data: [] })));
  const rows = [
    mod.apiFileToRow({ n: 'PIYO-046.mp4', fc: '1' }),
    mod.apiFileToRow({ n: 'SONE-119.mkv', fc: '1' }),
    mod.apiFileToRow({ n: '说明.txt', fc: '1' }),
    mod.apiFileToRow({ n: '子文件夹', fc: '0' }),
    mod.apiFileToRow({ n: 'ABF-171.mp4', fc: '1' })
  ];
  check('过滤掉文件夹与非视频，保留 3 个', mod.pickVideoRows(rows).map((r) => r.name),
    ['PIYO-046.mp4', 'SONE-119.mkv', 'ABF-171.mp4']);
  check('空输入不炸', mod.pickVideoRows(null), []);

  /*
   * withIndex：dirIndex 必须是「在**整个目录清单**里的位置（含文件夹）」。
   * 它只有一个用途 —— 点播放时算该翻到第几页。78 页的目录里，
   * 目标文件很可能不在第一页，所以这个下标算错 = 「跳回目录但找不到」。
   */
  const withIdx = mod.pickVideoRows(rows, { withIndex: true });
  check('withIndex 保留 3 条', withIdx.length, 3);
  check('dirIndex 用的是原始下标（含文件夹）', withIdx.map((r) => r.dirIndex), [0, 1, 4]);
  check('withIndex 不污染原数组', rows.every((r) => r.dirIndex === undefined), true);
}

/* ==================== 4. apiFetchDirAll 分页 ==================== */

console.log('\n=== apiFetchDirAll：自动翻页 ===');

{
  // 2500 条：1000 + 1000 + 500
  const total = 2500;
  const f = makeFetch(({ offset, limit }) => {
    const n = Math.max(0, Math.min(limit, total - offset));
    if (n === 0) return { state: true, count: total, data: [] };
    return { state: true, count: total, data: files(offset, n) };
  });
  const mod = load(f);

  const progress = [];
  const r = await mod.apiFetchDirAll('3527255730090411997', {
    onProgress: (got, all) => progress.push([got, all])
  });

  check('拿齐 2500 条', r.rows.length, 2500);
  check('total 正确', r.total, 2500);
  check('只请求了 3 次（1000/1000/500）', f.calls.length, 3);
  checkMatch('单次 limit = 1000', f.calls[0], /limit=1000/);
  checkMatch('cid 正确传递', f.calls[0], /cid=3527255730090411997/);
  checkMatch('show_dir=0（不要文件夹）', f.calls[0], /show_dir=0/);
  checkMatch('第 1 次 offset=0', f.calls[0], /offset=0/);
  checkMatch('第 2 次 offset=1000', f.calls[1], /offset=1000/);
  checkMatch('第 3 次 offset=2000', f.calls[2], /offset=2000/);
  check('进度回调拿到 3 次且末次是 2500/2500',
    progress[progress.length - 1], [2500, 2500]);
  check('首条数据映射正确', r.rows[0].name, 'PIYO-000.mp4');
  check('末条数据映射正确', r.rows[2499].name, 'PIYO-2499.mp4');
}

{
  // 78 页 × 24 条 = 1872 条 —— 正好是用户那个目录的规模
  const total = 1872;
  const f = makeFetch(({ offset, limit }) => {
    const n = Math.max(0, Math.min(limit, total - offset));
    return n ? { state: true, count: total, data: files(offset, n) } : { state: true, count: total, data: [] };
  });
  const mod = load(f);
  const r = await mod.apiFetchDirAll('1');
  check('1872 条（78 页的目录）只请求 2 次', f.calls.length, 2);
  check('1872 条全部拿到', r.rows.length, 1872);
}

{
  // 恰好整除：1000 + 1000，count=2000，第二次拿完后 rows.length >= total → 停
  const total = 2000;
  const f = makeFetch(({ offset, limit }) => {
    const n = Math.max(0, Math.min(limit, total - offset));
    return n ? { state: true, count: total, data: files(offset, n) } : { state: true, count: total, data: [] };
  });
  const mod = load(f);
  const r = await mod.apiFetchDirAll('1');
  check('整除场景不空转第 3 次', f.calls.length, 2);
  check('整除场景条数正确', r.rows.length, 2000);
}

{
  // 空目录
  const f = makeFetch(() => ({ state: true, count: 0, data: [] }));
  const mod = load(f);
  const r = await mod.apiFetchDirAll('1');
  check('空目录返回 0 条', r.rows.length, 0);
  check('空目录只请求 1 次', f.calls.length, 1);
}

{
  // count 缺失时退化为「拿到空为止」
  const total = 1500;
  const f = makeFetch(({ offset, limit }) => {
    const n = Math.max(0, Math.min(limit, total - offset));
    return { state: true, data: n ? files(offset, n) : [] };
  });
  const mod = load(f);
  const r = await mod.apiFetchDirAll('1');
  check('count 缺失也能拿全（靠空页终止）', r.rows.length, 1500);
  check('count 缺失时请求 3 次（1000/500/空）', f.calls.length, 3);
}

/* ==================== 5. apiFetchDirAll 错误处理 ==================== */

console.log('\n=== apiFetchDirAll：错误处理 ===');

{
  const f = makeFetch(() => ({ state: false, error: 'not_login' }));
  const mod = load(f);
  let msg = '';
  try { await mod.apiFetchDirAll('1'); } catch (e) { msg = e.message; }
  checkMatch('state=false 时抛出并带上接口错误', msg, /not_login/);
}

{
  const f = makeFetch(() => ({ state: false }));
  const mod = load(f);
  let msg = '';
  try { await mod.apiFetchDirAll('1'); } catch (e) { msg = e.message; }
  checkMatch('state=false 无 error 时给出可读提示', msg, /登录态/);
}

{
  // fetch 抛错 + GM 不可用 → 抛错，且错误里带上 fetch 的失败原因
  const f = makeFetch(() => ({ __error: '网络断了' }));
  const mod = load(f);
  let msg = '';
  try { await mod.apiFetchDirAll('1'); } catch (e) { msg = e.message; }
  checkMatch('fetch 失败且无 GM 兜底 → 抛错', msg, /网络断了/);
}

{
  const f = makeFetch(() => ({ __status: 403 }));
  const mod = load(f);
  let msg = '';
  try { await mod.apiFetchDirAll('1'); } catch (e) { msg = e.message; }
  checkMatch('HTTP 403 → 抛错并带上状态码', msg, /403/);
}

/* ==================== 6. 每页条数常量 ==================== */

console.log('\n=== 常量 ===');
{
  const mod = load(makeFetch(() => ({ state: true, count: 0, data: [] })));
  check('API_PAGE_SIZE 为 1000（115 上限约 1150）', mod.API_PAGE_SIZE, 1000);
}

/* ==================== 汇总 ==================== */

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
