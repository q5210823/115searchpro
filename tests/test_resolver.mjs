// 用 mock 数据验证 MetaResolver 的降级链路与缓存行为
import { MetaResolver } from '../src/core/providers.js';
import { extractCode } from '../src/core/tag-extractor.js';

// 模拟失败的主源 + 成功的备用源
class FailProvider {
  constructor(){ this.name='primary-fail'; this.enabled=true; }
  async search(){ throw new Error('模拟主源超时'); }
}
class OkProvider {
  constructor(){ this.name='backup-ok'; this.enabled=true; }
  async search(code){
    if (code === 'MISS-999') return null;
    return { code, title:`标题 ${code}`, actresses:['演员A'], studio:'厂商X', releaseDate:'2024-01-01', source:'backup-ok', fetchedAt:Date.now() };
  }
}
// 内存缓存
const memCache = new Map();
const cache = {
  async get(c){ return memCache.get(c) || null; },
  async put(m){ memCache.set(m.code, m); }
};

const r = new MetaResolver([new FailProvider(), new OkProvider()], cache);

const t1 = await r.resolve('SSNI-730');
console.log('降级测试 =>', t1.title, '| source =', t1.source);

const t2 = await r.resolve('SSNI-730');
console.log('缓存命中 =>', t2.title, '| fromCache =', t2.fromCache);

const t3 = await r.resolve('MISS-999');
console.log('未命中测试 =>', t3.notFound ? 'notFound ✓' : '异常');

console.log('统计 =>', JSON.stringify(r.stats));

// 批量 + 进度
const codes = ['ABP-456','SSNI-730','JUQ-434','XYZ-001'];
const prog = [];
const res = await r.resolveBatch(codes, { concurrency:2, force:true, onProgress:({done,total,code})=>prog.push(`${done}/${total}:${code}`) });
console.log('\n批量结果 =>', [...res.keys()].join(', '));
console.log('进度回调 =>', prog.join(' | '));

// 端到端：文件名 -> 番号 -> 查询
console.log('\n=== 端到端 ===');
for (const fn of ['ABP-456 中文字幕.mp4','h_123.mp4','[高清]JUQ-434.mp4']) {
  const ex = extractCode(fn);
  if (!ex) { console.log(fn, '=> 无番号'); continue; }
  const m = await r.resolve(ex.code, {force:true});
  console.log(`${fn}  =>  ${ex.code} (${ex.confidence})  =>  ${m.title}`);
}
