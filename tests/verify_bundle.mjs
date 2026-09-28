import fs from 'node:fs';

const f = fs.readFileSync('D:/WorkBuddyData/2026-09-27-17-54-27/dist/jv115-tagger.user.js', 'utf8');

const keys = ['inspectPage', 'inspectAllFrames', 'surveyContainers', 'waitForVideoItems', 'scanAllFrames', 'isFileListFrame', 'broadcast', 'onBroadcast', 'diagnoseText', 'dumpRawDom', 'collectOwnText', 'surveyExtensions', 'listFrameScan', 'queryAndCache'];
for (const k of keys) {
  const n = (f.match(new RegExp(k, 'g')) || []).length;
  console.log(k + ' 出现 ' + n + ' 次 ' + (n > 0 ? 'OK' : 'MISSING'));
}

console.log('');
console.log('@noframes: ' + (f.includes('@noframes') ? '存在(会阻止iframe注入!)' : '已移除(可注入iframe)'));
console.log('文件大小: ' + (f.length / 1024).toFixed(1) + ' KB');
