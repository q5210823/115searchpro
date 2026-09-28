/**
 * 跨 frame 通信
 * ------------------------------------------------------------------
 * 115 的文件列表渲染在 iframe 里（tpl=view_large&ct=file），
 * 而控制面板挂在顶层窗口。两者需要协作：
 *
 *   顶层面板 ──(广播指令)──> 列表 iframe（执行扫描/渲染标签）
 *   列表 iframe ──(回报结果)──> 顶层面板（更新进度/统计）
 *
 * 由于是同源（都是 115.com），用 postMessage 最简单可靠。
 */

const CHANNEL = 'jv115-tagger';

/** 判断当前是否顶层窗口 */
export function isTopFrame() {
  try {
    return window.top === window.self;
  } catch (e) {
    return false;
  }
}

/**
 * 判断当前 frame 是否是「文件列表 frame」。
 * 115 的列表 iframe URL 特征：ct=file & ac=userfile & tpl=view_large
 */
export function isFileListFrame() {
  try {
    const u = new URL(location.href);
    const ct = u.searchParams.get('ct');
    const ac = u.searchParams.get('ac');
    return ct === 'file' && (ac === 'userfile' || ac === 'userfiles');
  } catch (e) {
    return false;
  }
}

/** 广播指令给所有 frame（含自身） */
export function broadcast(type, payload = {}) {
  const msg = { __jv115: CHANNEL, type, payload, ts: Date.now() };
  try {
    if (window.top === window.self) {
      // 顶层：发给所有子 frame
      for (const f of document.querySelectorAll('iframe')) {
        try { f.contentWindow?.postMessage(msg, '*'); } catch (e) { /* 跨域忽略 */ }
      }
    } else {
      // 子 frame：发给顶层
      try { window.top.postMessage(msg, '*'); } catch (e) { /* 忽略 */ }
    }
  } catch (e) { /* 忽略 */ }
}

/**
 * 监听广播。
 * @param {(type: string, payload: object) => void} handler
 * @returns {() => void} 取消监听
 */
export function onBroadcast(handler) {
  const listener = (ev) => {
    const d = ev.data;
    if (!d || d.__jv115 !== CHANNEL) return;
    try {
      handler(d.type, d.payload || {});
    } catch (e) {
      console.warn('[jv115-tagger] 广播处理异常', e);
    }
  };
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}

/** 枚举当前页面所有同源 iframe 的 document（用于跨 frame 扫描兜底） */
export function collectSameOriginDocuments() {
  const docs = [document];
  for (const f of document.querySelectorAll('iframe')) {
    try {
      const d = f.contentDocument;
      if (d && d.body) docs.push(d);
    } catch (e) { /* 跨域忽略 */ }
  }
  return docs;
}
