import { JavbusProvider, JavlibraryProvider, buildManualLinks } from '../src/core/providers.js';

console.log('=== Provider 构建 ===');
const jb = new JavbusProvider({ javbusBaseUrl: 'https://www.javbus.com' });
console.log('JavBus  baseUrl =', jb.baseUrl, '| enabled =', jb.enabled);

const jl = new JavlibraryProvider({ javlibraryBaseUrl: 'https://www.javlibrary.com', javlibraryLang: 'cn' });
console.log('javlibrary baseUrl =', jl.baseUrl, '| lang =', jl.lang, '| enabled =', jl.enabled);

console.log('\n=== 搜索 URL 生成 ===');
const code = 'SSNI-730';
console.log('JavBus 搜索: ' + jb.baseUrl + '/search/' + encodeURIComponent(code) + '/1');
console.log('javlib 搜索: ' + jl.baseUrl + '/' + jl.lang + '/vl_searchbyid.php?keyword=' + encodeURIComponent(code));

console.log('\n=== 番号从文本提取 ===');
['SSNI-730 作品标题', 'abc-123-c', 'https://www.javbus.com/SSNI-730'].forEach(function(t){
  console.log('"' + t + '" => ' + jb.extractCodeFromText(t));
});

console.log('\n=== 手动兜底链接 ===');
buildManualLinks(code, { javbusBaseUrl: 'https://www.javbus.com', javlibraryBaseUrl: 'https://www.javlibrary.com' })
  .forEach(function(l){ console.log('  ' + l.name.padEnd(12) + ' ' + l.url); });

console.log('\n模块导入 ✓');
