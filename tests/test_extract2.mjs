import { extractCode } from '../src/core/tag-extractor.js';
const edge = ['EP01.mp4','EP1.mkv','SP-01.mp4','S01E05.mp4','SSIS-001.mp4','SSIS001.mp4','JUL-00123.mp4'];
for (const e of edge) {
  const r = extractCode(e);
  console.log(e.padEnd(20), '=>', r ? `${r.code} (${r.confidence})` : 'null');
}
