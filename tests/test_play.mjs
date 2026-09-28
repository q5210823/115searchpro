/**
 * 播放逻辑单元测试（v1.3.0）
 * ------------------------------------------------------------------
 * 覆盖：
 *   normalizePlayMode     —— 历史值 'auto'/'master' 必须迁移成 'page'
 *   playerTemplateVars    —— 从资料库记录里取模板变量
 *   fillPlayerTemplate    —— 模板填充（含未定义变量保持原样）
 *   isMasterPlayerPage    —— 播放页 URL 识别
 *   detectPlayerReady     —— ★核心：空 <video> 骨架不能算「播放器已就绪」
 *   looksBlank            —— 播放页白屏判定
 *
 * 为什么要专门测 detectPlayerReady：
 *   115 的页面骨架里常驻一个没有 src 的空 <video>，如果判据写成
 *   「存在 <video> 就算就绪」，它会恒真 —— 于是白屏永远检测不出来，
 *   用户的观感就是「脚本说没问题，但页面就是白的」。这里把它钉死。
 *
 * 加载方式沿用其它测试：剥掉 export，用 new Function 注入。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC_STORAGE = fs.readFileSync(path.join(ROOT, '..', 'src', 'core', 'storage.js'), 'utf8');
const SRC_115 = fs.readFileSync(path.join(ROOT, '..', 'src', 'core', 'site-115.js'), 'utf8');

let pass = 0, fail = 0;

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const good = a === e;
  console.log(`${good ? '✅' : '❌'} ${name}\n     实际=${a}\n     期望=${e}`);
  if (good) pass++; else fail++;
}

function truthy(name, actual) {
  const good = !!actual && actual !== '' && actual !== 'null';
  console.log(`${good ? '✅' : '❌'} ${name}\n     实际=${JSON.stringify(actual)}`);
  if (good) pass++; else fail++;
}

/* ---------- 加载 storage.js 的纯函数 ---------- */
const stripExports = (s) => s
  // ⚠️ import 必须剥掉：storage.js 依赖 glossary.js 的 FULL_COVERAGE，
  //    留着 `import ... from` 就会 SyntaxError → 整个测试文件静默崩溃
  .replace(/^\s*import\s+\{[\s\S]*?\}\s+from\s+['"][^'"]+['"];?\s*$/gm, '')
  .replace(/^\s*import\s+.*?from\s+['"][^'"]+['"];?\s*$/gm, '')
  // ⚠️ 必须同时处理 export function 和 export async function，
  //    只替换前者会让源码残留 `export` → SyntaxError → 整个测试静默崩溃
  .replace(/^export (async )?function /gm, '$1function ')
  .replace(/^export const /gm, 'const ');

// 按 bundler 的顺序把 glossary.js 拼在 storage.js 前面（同一个作用域）
const SRC_GLOSSARY = fs.readFileSync(path.join(ROOT, '..', 'src', 'core', 'glossary.js'), 'utf8');

const storageMod = new Function(
  `"use strict";
   ${stripExports(SRC_GLOSSARY)}
   ${stripExports(SRC_STORAGE)}
   return { normalizePlayMode, playerTemplateVars, fillPlayerTemplate,
            PLAY_MODES, DEFAULT_PLAYER_URL, PLAYER_PROBE_KEY, PLAYER_PROBE_TTL };
  `
)();

const {
  normalizePlayMode, playerTemplateVars, fillPlayerTemplate,
  PLAY_MODES, DEFAULT_PLAYER_URL, PLAYER_PROBE_KEY, PLAYER_PROBE_TTL
} = storageMod;

/* ---------- 加载 site-115.js 的相关函数（用极简 DOM 桩） ---------- */
const code115 = stripExports(SRC_115)
  .replace(/if \(typeof window !== 'undefined'\)[\s\S]*$/m, '');

const siteMod = new Function(
  'document', 'location', 'MutationObserver', 'window', 'console',
  `"use strict";
   ${code115}
   return { isMasterPlayerPage, detectPlayerReady, looksBlank };
  `
)(
  { querySelectorAll: () => [], querySelector: () => null, body: null, readyState: 'complete' },
  { href: 'https://115.com/', hostname: '115.com' },
  class { observe() {} disconnect() {} },
  {},
  { log() {}, warn() {}, error() {}, info() {} }
);

const { isMasterPlayerPage, detectPlayerReady, looksBlank } = siteMod;

/** 造一个假 document：videoSelector 返回视频元素数组 */
function fakeDoc({ videos = [], hasMasterHost = false, body = null } = {}) {
  return {
    querySelectorAll: (sel) => (sel === 'video' ? videos : []),
    querySelector: (sel) => {
      if (/x-player|master-app/.test(sel)) return hasMasterHost ? {} : null;
      if (/vjs-control-bar|dplayer/.test(sel)) return null;
      return null;
    },
    body,
    readyState: 'complete'
  };
}

/** 一个没有 src 的空 <video> —— 115 骨架里常驻的那种 */
const bareVideo = {
  currentSrc: '', src: '', readyState: 0, videoWidth: 0,
  querySelector: () => null
};

console.log('===== 1. normalizePlayMode（历史值迁移） =====');
check("'inpage' 保留", normalizePlayMode('inpage'), 'inpage');
check("'page' 保留", normalizePlayMode('page'), 'page');
check("历史值 'auto' → 'page'（旧版在列表页恒判 false，等于强制模拟点击）",
  normalizePlayMode('auto'), 'page');
check("历史值 'master' → 'page'", normalizePlayMode('master'), 'page');
check('undefined → 默认 page', normalizePlayMode(undefined), 'page');
check('垃圾值 → 默认 page', normalizePlayMode('!!!'), 'page');
check('PLAY_MODES 常量', PLAY_MODES, { PAGE: 'page', INPAGE: 'inpage' });

console.log('\n===== 2. playerTemplateVars =====');
check('完整记录', playerTemplateVars({
  pickcode: 'bi0izro13wfpq8syt', cid: '3527255730090411997',
  fileId: '3527247704331650213', fileName: 'SONE-119.mp4'
}), {
  pickcode: 'bi0izro13wfpq8syt', cid: '3527255730090411997',
  fileId: '3527247704331650213', name: 'SONE-119'
});
check('空记录 → 全空串', playerTemplateVars(), { pickcode: '', cid: '', fileId: '', name: '' });
check('多段扩展名只去掉最后一段',
  playerTemplateVars({ fileName: 'ABP-456.part1.mkv' }).name, 'ABP-456.part1');
check('没有扩展名时原样保留',
  playerTemplateVars({ fileName: 'SONE-119' }).name, 'SONE-119');
check('pickcode 为 null 时转成空串',
  playerTemplateVars({ pickcode: null, fileName: 'x.mp4' }).pickcode, '');

console.log('\n===== 3. fillPlayerTemplate =====');
check('默认模板 + 真机数据',
  fillPlayerTemplate(DEFAULT_PLAYER_URL, {
    pickcode: 'bi0izro13wfpq8syt', cid: '3527255730090411997'
  }),
  'https://115.com/web/lixian/master/video/?pick_code=bi0izro13wfpq8syt&cid=3527255730090411997');

check('变量做 URL 编码', fillPlayerTemplate('?p={pickcode}', { pickcode: 'a b&c' }), '?p=a%20b%26c');
check('未提供的变量保持原样（不变成空串，方便看出模板写错）',
  fillPlayerTemplate('?a={pickcode}&b={nope}', { pickcode: 'x' }), '?a=x&b={nope}');
check('空模板 → 空串', fillPlayerTemplate('', { pickcode: 'x' }), '');
check('undefined 模板 → 空串', fillPlayerTemplate(undefined, { pickcode: 'x' }), '');
check('同一变量出现多次都要替换',
  fillPlayerTemplate('{cid}-{cid}', { cid: '9' }), '9-9');
check('{name} 会被替换（自定义模板用）',
  fillPlayerTemplate('search?q={name}', { name: 'SONE-119' }), 'search?q=SONE-119');
check('cid 为空串时拼出空参数（115Master 允许 cid 缺省）',
  fillPlayerTemplate(DEFAULT_PLAYER_URL, { pickcode: 'abc', cid: '' }),
  'https://115.com/web/lixian/master/video/?pick_code=abc&cid=');

console.log('\n===== 4. isMasterPlayerPage =====');
truthy('播放页 URL 识别',
  isMasterPlayerPage('https://115.com/web/lixian/master/video/?pick_code=x&cid=y'));
truthy('大写路径也能识别（正则带 i）',
  isMasterPlayerPage('https://115.com/WEB/LIXIAN/MASTER/VIDEO/?pick_code=x'));
check('文件列表页不是播放页',
  isMasterPlayerPage('https://115.com/?cid=123&mode=wangpan'), false);
check('115 首页不是播放页', isMasterPlayerPage('https://115.com/'), false);

console.log('\n===== 5. detectPlayerReady（★ 空骨架不能算就绪） =====');
check('空 <video>（无 src / readyState=0）→ 不就绪',
  detectPlayerReady(fakeDoc({ videos: [bareVideo] })), { ok: false, via: '' });
check('有 currentSrc → 就绪',
  detectPlayerReady(fakeDoc({
    videos: [{ currentSrc: 'https://x.com/a.mp4', src: '', readyState: 0, videoWidth: 0, querySelector: () => null }]
  })), { ok: true, via: 'video.src' });
check('只有 src 属性 → 就绪',
  detectPlayerReady(fakeDoc({
    videos: [{ currentSrc: '', src: 'https://x.com/b.mp4', readyState: 0, videoWidth: 0, querySelector: () => null }]
  })), { ok: true, via: 'video.src' });
check('readyState>0 且有画面尺寸 → 就绪',
  detectPlayerReady(fakeDoc({
    videos: [{ currentSrc: '', src: '', readyState: 4, videoWidth: 1920, querySelector: () => null }]
  })), { ok: true, via: 'video.meta' });
check('只有 <source src> 子元素 → 就绪',
  detectPlayerReady(fakeDoc({
    videos: [{
      currentSrc: '', src: '', readyState: 0, videoWidth: 0,
      querySelector: (s) => (s === 'source[src]' ? {} : null)
    }]
  })), { ok: true, via: 'video.source' });
check('空 video + 115Master 容器 → 就绪（容器已渲染也算起来）',
  detectPlayerReady(fakeDoc({ videos: [bareVideo], hasMasterHost: true })),
  { ok: true, via: 'master-app' });
check('什么都没有 → 不就绪',
  detectPlayerReady(fakeDoc({})), { ok: false, via: '' });
check('about:blank 的 src 不算数',
  detectPlayerReady(fakeDoc({
    videos: [{ currentSrc: 'about:blank', src: '', readyState: 0, videoWidth: 0, querySelector: () => null }]
  })), { ok: false, via: '' });

console.log('\n===== 6. looksBlank =====');
check('有实质文本 → 不空白',
  looksBlank({ body: {
    innerText: '这是一个正常渲染出来的页面，文本长度早就超过四十个字符了，所以不应该被判定成空白页。',
    querySelectorAll: () => []
  } }), false);
check('无文本无可见块 → 空白',
  looksBlank({ body: { innerText: '', querySelectorAll: () => [] } }), true);
check('body 不存在 → 当作空白',
  looksBlank({ body: null }), true);
check('文本很短且没有大块 → 空白',
  looksBlank({ body: { innerText: '加载中', querySelectorAll: () => [] } }), true);

console.log('\n===== 7. 自检缓存的键与有效期 =====');
check('缓存键名', PLAYER_PROBE_KEY, 'jv115-player-probe');
truthy('有效期是个正数', Number.isFinite(PLAYER_PROBE_TTL) && PLAYER_PROBE_TTL > 0);

console.log(`\n===== 结果：通过 ${pass} · 失败 ${fail} =====`);
process.exit(fail === 0 ? 0 : 1);
