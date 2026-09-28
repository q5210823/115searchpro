/**
 * 跑全部测试，并把「崩溃」和「断言失败」分开报。
 * ------------------------------------------------------------------
 * 为什么需要它：
 *   之前用一个 grep "❌" 的 shell 循环做汇总，
 *   结果 test_scanner2.mjs 因为加载期 SyntaxError 直接崩溃 ——
 *   崩了就不会打印任何 ❌，于是被误判成「通过」，
 *   连着一个版本号都没发现（v1.2.2 → v1.2.3）。
 *
 *   结论：**测试的判据必须是进程退出码，不是输出里有没有 ❌**。
 *
 * 用法：node tests/run_all.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// 自身不跑
const files = fs.readdirSync(ROOT)
  .filter((f) => f.endsWith('.mjs') && f !== 'run_all.mjs')
  .sort();

let crashed = 0;
let failed = 0;
let ok = 0;
const crashedList = [];

for (const f of files) {
  let out = '';
  let code = 0;
  try {
    out = execFileSync(process.execPath, [path.join(ROOT, f)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (e) {
    code = e.status ?? 1;
    out = `${e.stdout || ''}${e.stderr || ''}`;
  }

  const tail = out.trim().split('\n').filter(Boolean);
  const summary = [...tail].reverse().find((l) => /通过|失败|OK|PASS|❌/.test(l)) || '';
  const hasAssertFail = /❌/.test(out);

  let mark = '✅';
  if (code !== 0 && hasAssertFail) { mark = '❌'; failed++; }
  else if (code !== 0) { mark = '💥'; crashed++; crashedList.push(f); }
  else ok++;

  console.log(`${mark} ${f.padEnd(24)} ${summary.slice(0, 80)}`);

  // 崩溃的把关键错误行打出来，方便一眼定位
  if (mark === '💥') {
    const errLines = out.split('\n').filter((l) => /Error|error:|SyntaxError|Cannot find/.test(l)).slice(0, 3);
    errLines.forEach((l) => console.log(`      ${l.trim().slice(0, 140)}`));
  }
}

console.log('');
console.log(`文件数 ${files.length}：通过 ${ok} · 断言失败 ${failed} · 崩溃 ${crashed}`);
if (crashedList.length) console.log(`崩溃文件：${crashedList.join(', ')}`);

const bad = failed + crashed;
console.log(bad === 0 ? '✅ 全部通过' : `❌ 有 ${bad} 个文件不健康`);
process.exit(bad === 0 ? 0 : 1);
