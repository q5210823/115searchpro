const VIDEO_EXT = /\.(mp4|mkv|avi|wmv|mov|ts|m2ts|rmvb|flv|webm|iso|mpg|mpeg|m4v)$/i;

console.log('=== 视频扩展名匹配测试 ===');
const cases = [
  ['SSNI-730.mp4', true],
  ['ABP-456 中文字幕.MP4', true],
  ['h_123.mkv', true],
  ['视频.ts', true],
  ['封面.jpg', false],
  ['说明.txt', false],
  ['SONE-119[中文字幕].mkv', true],
  ['a.b.c.d.mp4', true],
  ['noext', false]
];
let pass = 0;
cases.forEach(function(pair){
  const name = pair[0], expect = pair[1];
  const got = VIDEO_EXT.test(name);
  const ok = got === expect;
  if (ok) pass++;
  console.log((ok ? '[OK] ' : '[FAIL] ') + name.padEnd(30) + ' expect=' + expect + ' got=' + got);
});
console.log('passed ' + pass + '/' + cases.length);

console.log('\n=== 尺寸提取 ===');
const sizeRe = /(\d+(?:\.\d+)?)\s*(KB|MB|GB|TB)/i;
['1.5GB', '700 MB', 'file 2.3GB size', '12345'].forEach(function(t){
  const m = t.match(sizeRe);
  console.log(t.padEnd(20) + ' => ' + (m ? m[0] : 'null'));
});

console.log('\n=== 元信息行识别 ===');
const metaRe = /(\d+(?:\.\d+)?)\s*(KB|MB|GB|TB)|刚刚|\d{4}-\d{2}-\d{2}/i;
['abc.mp4 1.2GB 2024-01-01', 'abc.mp4 just now', 'abc.mp4', 'abc.mp4 500MB'].forEach(function(t){
  console.log(t.padEnd(26) + ' => ' + (metaRe.test(t) ? 'row-container' : 'no'));
});
