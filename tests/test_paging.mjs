/**
 * 资料库列表分批渲染（懒加载）单元测试（v1.3.1）
 * ------------------------------------------------------------------
 * 覆盖：
 *   LIB_PAGE_SIZE   —— 默认每批 50 条
 *   libPageWindow   —— ★核心：窗口计算（不能漏条 / 不能重复 / 越界输入不能出 NaN）
 *   libFootText     —— ★核心：加载完必须明说「已全部显示」
 *
 * 为什么要专门测这两条：
 *   这次要修的是「筛选完显示不全、又没有翻页」的观感问题。
 *   旧实现 `rows.slice(0, 300)` 是**静默截断** —— 既不说截断了、也没法继续看，
 *   用户根本不知道还有 3500 条没显示。
 *   新实现必须保证两件事，否则等于没修：
 *     ① 窗口算得准：一直滚到底，所有条目恰好被覆盖一次；
 *     ② 底部文案在加载完时明确说「已全部显示」，否则用户滚到底没等到新内容，
 *        依然会怀疑「是不是还有没加载出来的」。
 *
 * 加载方式沿用其它测试：剥掉 export，用 new Function 注入。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC_PAGING = fs.readFileSync(path.join(ROOT, '..', 'src', 'core', 'paging.js'), 'utf8');

let pass = 0, fail = 0;

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const good = a === e;
  console.log(`${good ? '✅' : '❌'} ${name}\n     实际=${a}\n     期望=${e}`);
  if (good) pass++; else fail++;
}

/* ---------- 加载 paging.js 的纯函数 ---------- */
const stripExports = (s) => s
  // ⚠️ 必须同时处理 export function 和 export async function，
  //    只替换前者会让源码残留 `export` → SyntaxError → 整个测试静默崩溃
  .replace(/^export (async )?function /gm, '$1function ')
  .replace(/^export const /gm, 'const ');

const pagingMod = new Function(
  `"use strict";
   ${stripExports(SRC_PAGING)}
   return { LIB_PAGE_SIZE, libPageWindow, libFootText };
  `
)();

const { LIB_PAGE_SIZE, libPageWindow, libFootText } = pagingMod;

console.log('===== 每批条数 =====');
check('默认每批 50 条（用户要求）', LIB_PAGE_SIZE, 50);

console.log('\n===== libPageWindow：窗口计算 =====');
check('空结果 → 全零窗口', libPageWindow(0, 0), { from: 0, to: 0, added: 0, hasMore: false });

// 用户截图里的场景：命中 43 条，应一次全显示（43 < 50），且明说没有更多
check('43 条 → 一次全出，无更多',
  libPageWindow(43, 0), { from: 0, to: 43, added: 43, hasMore: false });

check('3869 条 · 首批',
  libPageWindow(3869, 0), { from: 0, to: 50, added: 50, hasMore: true });
check('3869 条 · 第二批',
  libPageWindow(3869, 50), { from: 50, to: 100, added: 50, hasMore: true });
check('3869 条 · 末尾不足一批',
  libPageWindow(3869, 3850), { from: 3850, to: 3869, added: 19, hasMore: false });
check('3869 条 · 已全部渲染',
  libPageWindow(3869, 3869), { from: 3869, to: 3869, added: 0, hasMore: false });

console.log('\n===== libPageWindow：越界 / 非法输入（必须夹紧，不能出 NaN）=====');
check('shown 超过 total → 夹到 total',
  libPageWindow(10, 99), { from: 10, to: 10, added: 0, hasMore: false });
check('负数 → 归零',
  libPageWindow(-5, -3), { from: 0, to: 0, added: 0, hasMore: false });
check('NaN → 归零',
  libPageWindow(NaN, NaN), { from: 0, to: 0, added: 0, hasMore: false });
check('undefined → 归零',
  libPageWindow(undefined, undefined), { from: 0, to: 0, added: 0, hasMore: false });
check('字符串数字 → 正常解析',
  libPageWindow('100', '50'), { from: 50, to: 100, added: 50, hasMore: false });
/*
 * NaN 是最危险的输入：`slice(NaN, NaN)` 不报错，直接返回空数组，
 * 表现就是「列表一片空白但没有任何报错」—— 正是最难查的那种 bug。
 */
check('非法输入不会产生 NaN',
  Object.values(libPageWindow(NaN, NaN)).some((v) => Number.isNaN(v)), false);

console.log('\n===== libPageWindow：自定义批量 =====');
check('每批 30 条',
  libPageWindow(100, 0, 30), { from: 0, to: 30, added: 30, hasMore: true });
check('size 非法(0) → 回落到默认 50',
  libPageWindow(100, 0, 0), { from: 0, to: 50, added: 50, hasMore: true });
check('size 负数 → 回落到默认 50',
  libPageWindow(100, 0, -7), { from: 0, to: 50, added: 50, hasMore: true });

console.log('\n===== ★ 一直滚到底：不重不漏 =====');
{
  const total = 3869;
  const seen = [];
  let shown = 0;
  let batches = 0;
  let w;
  do {
    w = libPageWindow(total, shown);
    for (let i = w.from; i < w.to; i++) seen.push(i);
    shown = w.to;
    batches++;
    if (batches > 5000) break;   // 死循环保护：窗口算错时给个明确失败，而不是挂住
  } while (w.hasMore);

  const unique = new Set(seen);
  check('覆盖条数 = total（没有漏条）', seen.length, total);
  check('无重复渲染', unique.size, total);
  check('首尾下标正确', [seen[0], seen[seen.length - 1]], [0, total - 1]);
  check('批次数 = ceil(total/size)', batches, Math.ceil(total / 50));
}

console.log('\n===== libFootText：底部文案 =====');
/*
 * 这几条是本次修复的重点：加载完必须**明确说已到底**。
 * 只说「已显示 43 条」是不够的 —— 用户仍会怀疑下面还有。
 */
check('空结果 → 不显示 footer', libFootText(0, 0), '');
check('43 条全出 → 明说已全部显示',
  libFootText(43, 43), '已全部显示（共 43 条）');
check('刚到 50 → 提示还能继续加载',
  libFootText(3869, 50), '已显示 50 / 共 3869 条 · 继续下滑自动加载');
check('加载中',
  libFootText(3869, 50, true), '正在加载… 已显示 50 / 3869 条');
check('shown 越界 → 也按已全部显示',
  libFootText(43, 999), '已全部显示（共 43 条）');
check('刚好一批的量',
  libFootText(50, 50), '已全部显示（共 50 条）');
check('非法输入不产生 NaN 字样',
  libFootText(NaN, NaN).includes('NaN'), false);

console.log(`\n===== 结果：通过 ${pass} · 失败 ${fail} =====`);
process.exit(fail === 0 ? 0 : 1);
