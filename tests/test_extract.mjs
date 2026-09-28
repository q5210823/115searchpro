import { selfTest, extractCode } from '../src/core/tag-extractor.js';
const rows = selfTest();
console.log('文件名'.padEnd(34), '番号'.padEnd(14), '置信度'.padEnd(8), '模式');
console.log('-'.repeat(78));
for (const r of rows) {
  console.log(String(r.文件名).padEnd(32), String(r.番号).padEnd(14), String(r.置信度).padEnd(8), r.模式);
}
console.log('\n--- 边界用例 ---');
const edge = ['1080P.mp4','4K_HD.mkv','x264-1080.mkv','SONE-119.mp4','abc 123.mp4','2020.01.01.mp4','EP01.mp4','SSNI730.mp4'];
for (const e of edge) {
  const r = extractCode(e);
  console.log(e.padEnd(22), '=>', r ? `${r.code} (${r.confidence})` : 'null');
}
