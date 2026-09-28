/**
 * 本地标签库（IndexedDB 存储层）
 * ------------------------------------------------------------------
 * 方案 C 的核心：标签不打回 115，而是存在浏览器本地。
 *
 * 五张表：
 *   meta     番号 -> 影片元数据（标题/演员/厂商/封面/标签）
 *   fileMap  115 文件 ID -> 番号 的映射（含文件名快照，用于变更检测）
 *   library  「收录」结果：一个视频文件一条，含 cid / 番号 / 演员 / 类别
 *            —— 这是「资料库」页签的数据源，支持按演员、类别筛选
 *   dirs     每个收录过的目录的汇总（收录时间 / 条目数 / 上次新增多少）
 *            —— 「增量收录」的依据：同一目录再收一次时，靠它和 library
 *               对照，只对「新文件」和「上次没抓到标签的」发请求
 *   settings 键值配置（api key、并发数、数据源开关等）
 *
 * 数据完全本地，支持导出/导入 JSON 备份，清缓存前请先导出。
 */

const DB_NAME = 'jv115-tagger';
/**
 * ⚠️ 升级版本号时，onupgradeneeded 会整体重跑。
 * 里面每个建表动作都用 `contains` 包住，所以老表及其数据不受影响，
 * 只有新增的表会被创建。绝对不要在 upgrade 里 drop 既有表。
 */
const DB_VERSION = 3;
const STORE_META = 'meta';
const STORE_FILEMAP = 'fileMap';
const STORE_LIBRARY = 'library';
const STORE_DIRS = 'dirs';
const STORE_SETTINGS = 'settings';

let _dbPromise = null;

/** 打开数据库（单例） */
export function openDB() {
  if (_dbPromise) return _dbPromise;

  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains(STORE_META)) {
        const s = db.createObjectStore(STORE_META, { keyPath: 'code' });
        s.createIndex('title', 'title', { unique: false });
        s.createIndex('fetchedAt', 'fetchedAt', { unique: false });
        s.createIndex('source', 'source', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORE_FILEMAP)) {
        const s = db.createObjectStore(STORE_FILEMAP, { keyPath: 'fileId' });
        s.createIndex('code', 'code', { unique: false });
        s.createIndex('updatedAt', 'updatedAt', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORE_LIBRARY)) {
        const s = db.createObjectStore(STORE_LIBRARY, { keyPath: 'id' });
        s.createIndex('code', 'code', { unique: false });
        s.createIndex('cid', 'cid', { unique: false });
        // multiEntry：一个文件可以有多个演员 / 多个类别，
        // 建多值索引后可以直接按「演员A」查出所有含该演员的记录。
        s.createIndex('actresses', 'actresses', { unique: false, multiEntry: true });
        s.createIndex('genres', 'genres', { unique: false, multiEntry: true });
        s.createIndex('updatedAt', 'updatedAt', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORE_DIRS)) {
        const s = db.createObjectStore(STORE_DIRS, { keyPath: 'cid' });
        s.createIndex('harvestedAt', 'harvestedAt', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
        db.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  return _dbPromise;
}

/** 通用事务包装 */
async function withStore(storeName, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let result;
    try {
      result = fn(store);
    } catch (e) {
      reject(e);
      return;
    }
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('事务被中止'));
  });
}

/** 把 IDBRequest 转成 Promise */
function reqToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/* ==================== meta 表操作 ==================== */

/** 缓存实现，供 MetaResolver 使用 */
export const metaCache = {
  async get(code) {
    const db = await openDB();
    const tx = db.transaction(STORE_META, 'readonly');
    return reqToPromise(tx.objectStore(STORE_META).get(code));
  },
  async put(meta) {
    return putMeta(meta);
  }
};

export async function putMeta(meta) {
  if (!meta || !meta.code) throw new Error('meta 缺少 code 字段');
  const record = { ...meta, fetchedAt: meta.fetchedAt || Date.now() };
  await withStore(STORE_META, 'readwrite', (s) => s.put(record));
  return record;
}

export async function putMetaBatch(list) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_META, 'readwrite');
    const store = tx.objectStore(STORE_META);
    list.forEach((m) => m && m.code && store.put({ ...m, fetchedAt: m.fetchedAt || Date.now() }));
    tx.oncomplete = () => resolve(list.length);
    tx.onerror = () => reject(tx.error);
  });
}

export async function getMeta(code) {
  const db = await openDB();
  const tx = db.transaction(STORE_META, 'readonly');
  return reqToPromise(tx.objectStore(STORE_META).get(code));
}

export async function getAllMeta() {
  const db = await openDB();
  const tx = db.transaction(STORE_META, 'readonly');
  return reqToPromise(tx.objectStore(STORE_META).getAll());
}

export async function countMeta() {
  const db = await openDB();
  const tx = db.transaction(STORE_META, 'readonly');
  return reqToPromise(tx.objectStore(STORE_META).count());
}

export async function deleteMeta(code) {
  return withStore(STORE_META, 'readwrite', (s) => s.delete(code));
}

/* ==================== fileMap 表操作 ==================== */

/**
 * 记录「115 文件 -> 番号」映射。
 * 存 nameSnapshot 是为了检测文件是否被改名/替换。
 */
export async function putFileMap({ fileId, code, fileName, confidence }) {
  const record = {
    fileId: String(fileId),
    code,
    fileName,
    nameSnapshot: fileName,
    confidence: confidence ?? 0,
    updatedAt: Date.now()
  };
  await withStore(STORE_FILEMAP, 'readwrite', (s) => s.put(record));
  return record;
}

export async function putFileMapBatch(list) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_FILEMAP, 'readwrite');
    const store = tx.objectStore(STORE_FILEMAP);
    list.forEach((r) => {
      store.put({
        fileId: String(r.fileId),
        code: r.code,
        fileName: r.fileName,
        nameSnapshot: r.fileName,
        confidence: r.confidence ?? 0,
        updatedAt: Date.now()
      });
    });
    tx.oncomplete = () => resolve(list.length);
    tx.onerror = () => reject(tx.error);
  });
}

export async function getFileMap(fileId) {
  const db = await openDB();
  const tx = db.transaction(STORE_FILEMAP, 'readonly');
  return reqToPromise(tx.objectStore(STORE_FILEMAP).get(String(fileId)));
}

export async function getAllFileMap() {
  const db = await openDB();
  const tx = db.transaction(STORE_FILEMAP, 'readonly');
  return reqToPromise(tx.objectStore(STORE_FILEMAP).getAll());
}

export async function countFileMap() {
  const db = await openDB();
  const tx = db.transaction(STORE_FILEMAP, 'readonly');
  return reqToPromise(tx.objectStore(STORE_FILEMAP).count());
}

/* ==================== library 表操作（资料库） ==================== */

/**
 * 把 meta（可能是 null / notFound）+ 文件信息组装成一条 library 记录。
 *
 * id 用 `cid@@fileName`：
 *   - 同名的文件在不同目录下是两个条目，不会被互相覆盖
 *   - 目录内改名会变成新条目（旧的留给用户手动清理）
 *
 * @param {object} p
 * @param {object|null} p.prev 同一文件的**上一条记录**（增量收录时传入）。
 *   作用：① 保留 firstSeenAt（首次见到的时间）；② 新一次没抓到标签时
 *   不把已有的标签覆盖掉（数据源偶尔抽风不该让库里的信息变少）。
 */
export function buildLibraryRecord({ cid, fileName, fileId, pickcode, size, dirIndex, code, meta, confidence, prev = null }) {
  const cleanArr = (v) => {
    if (!Array.isArray(v)) return [];
    return [...new Set(v.map((x) => String(x ?? '').trim()).filter(Boolean))];
  };
  const now = Date.now();

  const fresh = meta && !meta.notFound;
  // 同一个番号、上次拿到了标签、这次却没拿到 → 保留旧数据，别让信息退化
  const keepPrev = !fresh && prev && prev.matched && prev.code === (code || '');
  const src = fresh ? meta : (keepPrev ? prev : null);

  return {
    id: `${cid || ''}@@${fileName}`,
    cid: String(cid || ''),
    fileName: String(fileName || ''),
    fileId: fileId ? String(fileId) : (keepPrev ? prev.fileId : null),
    // pickcode 是 115 播放接口唯一需要的参数，收录时能挖到就一定要存下来
    pickcode: pickcode ? String(pickcode) : (keepPrev ? prev.pickcode : null),
    size: size || (keepPrev ? prev.size : ''),
    // 该文件在整个目录清单里的位置（含文件夹）。
    // 115 网页每页只渲染 24 条，点播放时要靠它算「该翻到第几页」，
    // 否则 78 页的目录里点一条第 50 页的文件会「跳回目录但找不到」。
    dirIndex: Number.isFinite(dirIndex) ? dirIndex : (prev && Number.isFinite(prev.dirIndex) ? prev.dirIndex : null),
    code: code || '',
    confidence: confidence ?? 0,
    title: src ? (src.title || '') : '',
    actresses: src ? cleanArr(src.actresses) : [],
    genres: src ? cleanArr(src.genres) : [],
    cover: src ? (src.cover || '') : '',
    source: src ? (src.source || '') : '',
    matched: !!(fresh || keepPrev),
    keptPrev: keepPrev,
    // 增量收录用：gone=true 表示「上次收录过，这次目录里已经没有了」
    gone: false,
    firstSeenAt: (prev && prev.firstSeenAt) || now,
    lastSeenAt: now,
    harvestedAt: (prev && prev.harvestedAt) || now,
    updatedAt: now
  };
}

export async function putLibraryBatch(list) {
  if (!list || !list.length) return 0;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_LIBRARY, 'readwrite');
    const store = tx.objectStore(STORE_LIBRARY);
    list.forEach((r) => r && r.id && store.put(r));
    tx.oncomplete = () => resolve(list.length);
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAllLibrary() {
  const db = await openDB();
  const tx = db.transaction(STORE_LIBRARY, 'readonly');
  return reqToPromise(tx.objectStore(STORE_LIBRARY).getAll());
}

export async function countLibrary() {
  const db = await openDB();
  const tx = db.transaction(STORE_LIBRARY, 'readonly');
  return reqToPromise(tx.objectStore(STORE_LIBRARY).count());
}

/**
 * 取某个目录下已经收录的条目（走 cid 索引）。
 * 增量收录的第一步：拿它和接口返回的当前文件清单对照，
 * 就能算出「新增 / 未变 / 已失效」三类。
 */
export async function getLibraryByCid(cid) {
  const key = String(cid || '');
  if (!key) return [];
  const db = await openDB();
  const tx = db.transaction(STORE_LIBRARY, 'readonly');
  const idx = tx.objectStore(STORE_LIBRARY).index('cid');
  return reqToPromise(idx.getAll(key));
}

/** 统计「已失效」条目数（文件已从 115 目录里消失） */
export async function countLibraryGone() {
  const all = await getAllLibrary();
  return all.filter((r) => r.gone).length;
}

/** 删除全部「已失效」条目，返回删掉的条数 */
export async function deleteLibraryGone() {
  const all = await getAllLibrary();
  const gone = all.filter((r) => r.gone);
  if (!gone.length) return 0;
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_LIBRARY, 'readwrite');
    const store = tx.objectStore(STORE_LIBRARY);
    gone.forEach((r) => store.delete(r.id));
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  return gone.length;
}

/* ==================== dirs 表操作 ==================== */

/**
 * 记录/更新一个目录的收录汇总。
 * 只存「轻量元信息」，不存文件清单本身（清单就在 library 表里）。
 */
export async function putDirMeta(rec) {
  if (!rec || !rec.cid) throw new Error('dirs 记录缺少 cid');
  return withStore(STORE_DIRS, 'readwrite', (s) => s.put({
    ...rec,
    cid: String(rec.cid),
    harvestedAt: rec.harvestedAt || Date.now()
  }));
}

export async function getDirMeta(cid) {
  const db = await openDB();
  const tx = db.transaction(STORE_DIRS, 'readonly');
  return reqToPromise(tx.objectStore(STORE_DIRS).get(String(cid || '')));
}

export async function getAllDirs() {
  const db = await openDB();
  const tx = db.transaction(STORE_DIRS, 'readonly');
  return reqToPromise(tx.objectStore(STORE_DIRS).getAll());
}

export async function countDirs() {
  const db = await openDB();
  const tx = db.transaction(STORE_DIRS, 'readonly');
  return reqToPromise(tx.objectStore(STORE_DIRS).count());
}

export async function deleteLibrary(id) {
  return withStore(STORE_LIBRARY, 'readwrite', (s) => s.delete(id));
}

export async function clearLibrary() {
  return withStore(STORE_LIBRARY, 'readwrite', (s) => s.clear());
}

/**
 * 清理「同一个文件但 id 不同」的旧记录，返回删掉的条数。
 *
 * 为什么需要：id = `cid@@fileName`，所以 cid 一旦变化，同一部片会算出两个 id。
 * 典型场景就是「cid 取值方式修好后重新收录」—— 旧记录里带着错的 cid
 * （比如 0），不清理就会同一部片在资料库里出现两条。
 *
 * @param {Array} keepRecords 本次刚写入的记录，它们的 id 视为最新
 */
export async function pruneLibraryDuplicates(keepRecords) {
  if (!keepRecords || !keepRecords.length) return 0;
  const keepIds = new Set(keepRecords.map((r) => r.id));
  const names = new Set(keepRecords.map((r) => r.fileName).filter(Boolean));
  if (!names.size) return 0;

  const all = await getAllLibrary();
  const stale = all.filter((r) => names.has(r.fileName) && !keepIds.has(r.id));
  if (!stale.length) return 0;

  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_LIBRARY, 'readwrite');
    const store = tx.objectStore(STORE_LIBRARY);
    stale.forEach((r) => store.delete(r.id));
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  return stale.length;
}

/**
 * 汇总可筛选的维度：演员 / 类别 / 目录。
 * 供资料库页签生成筛选 chips（带出现次数，按次数降序）。
 */
export async function getLibraryFacets() {
  const allRaw = await getAllLibrary();
  // 失效条目（文件已不在 115 目录里）默认不参与筛选维度统计
  const gone = allRaw.filter((r) => r.gone).length;
  const all = allRaw.filter((r) => !r.gone);
  const tally = (pick) => {
    const m = new Map();
    all.forEach((r) => {
      pick(r).forEach((v) => m.set(v, (m.get(v) || 0) + 1));
    });
    return [...m.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  };
  return {
    total: all.length,
    gone,
    actresses: tally((r) => r.actresses || []),
    genres: tally((r) => r.genres || []),
    cids: tally((r) => (r.cid ? [r.cid] : []))
  };
}

/**
 * 纯函数版筛选 —— 不碰数据库，便于单元测试。
 * 规则：
 *   - 关键词：大小写不敏感，命中番号/标题/文件名/演员/类别 任一即可
 *   - 演员/类别：多选时是 **AND**（要同时满足所有选中项）
 *     —— 选「演员A」+「演员B」表示「同时有这两个演员的作品」
 *   - hideGone：默认隐藏「已失效」条目（文件已从 115 目录消失）
 */
export function filterLibraryRows(all, {
  keyword = '', actresses = [], genres = [], cid = '', hideGone = true
} = {}) {
  const kw = String(keyword || '').trim().toLowerCase();

  return (all || []).filter((r) => {
    if (hideGone && r.gone) return false;
    if (cid && r.cid !== cid) return false;
    if (actresses.length && !actresses.every((a) => (r.actresses || []).includes(a))) return false;
    if (genres.length && !genres.every((g) => (r.genres || []).includes(g))) return false;
    if (!kw) return true;
    const hay = [r.code, r.title, r.fileName, ...(r.actresses || []), ...(r.genres || [])]
      .join(' ')
      .toLowerCase();
    return hay.includes(kw);
  }).sort((a, b) =>
    String(a.code || '').localeCompare(String(b.code || '')) ||
    String(a.fileName || '').localeCompare(String(b.fileName || ''))
  );
}

/** 在库内按关键词 + 演员/类别筛选（先从 IDB 取全量，再走纯函数过滤） */
export async function queryLibrary(filters = {}) {
  const all = await getAllLibrary();
  return filterLibraryRows(all, filters);
}

/* ==================== settings 表操作 ==================== */

export async function setSetting(key, value) {
  return withStore(STORE_SETTINGS, 'readwrite', (s) => s.put({ key, value }));
}

export async function getSetting(key, defaultValue = null) {
  const db = await openDB();
  const tx = db.transaction(STORE_SETTINGS, 'readonly');
  const row = await reqToPromise(tx.objectStore(STORE_SETTINGS).get(key));
  return row ? row.value : defaultValue;
}

export async function getAllSettings() {
  const db = await openDB();
  const tx = db.transaction(STORE_SETTINGS, 'readonly');
  const rows = await reqToPromise(tx.objectStore(STORE_SETTINGS).getAll());
  return rows.reduce((acc, r) => ({ ...acc, [r.key]: r.value }), {});
}

/**
 * 「播放」按钮的默认地址模板（唯一权威定义，main.js / panel.js 都从这里引）。
 * 可用变量：{pickcode} {cid} {fileId} {name}
 *
 * 取值来源：115Master 公开的播放器唤起接口。
 * 若在未安装 115Master 的环境下打不开，可在「设置」页改成自己环境可用的地址。
 *
 * ⚠️ 打包器会把所有模块拼进同一个作用域，所以这个名字全局只能出现一次。
 */
export const DEFAULT_PLAYER_URL =
  'https://115.com/web/lixian/master/video/?pick_code={pickcode}&cid={cid}';

/**
 * 播放方式。
 *
 *   PAGE   —— 点「播放」直接开播放页（一步直达，默认）
 *   INPAGE —— 跳回该文件所在目录，在网页列表里定位并模拟点击播放
 *
 * 为什么默认是 PAGE 而不是「自动检测」：
 *   115Master 的 DOM 标记（#master-app / x-player）**只在播放页挂载**，
 *   文件列表页上根本不存在。所以在列表页做「装没装 115Master」的检测
 *   必然返回 false —— 旧版的 auto 模式等于被强制降级成 INPAGE，
 *   用户看到的现象就是「点了播放却跳回目录，还找不到视频」。
 *   与其猜，不如直接开播放页；开出来是不是空白由「播放页自检」事后判定。
 */
export const PLAY_MODES = { PAGE: 'page', INPAGE: 'inpage' };

/** 把历史/非法值归一化为当前支持的播放方式 */
export function normalizePlayMode(v) {
  if (v === PLAY_MODES.INPAGE) return PLAY_MODES.INPAGE;
  // 历史值：'auto'（在列表页恒判 false，等于强制模拟点击）、'master'（开播放页）
  return PLAY_MODES.PAGE;
}

/**
 * 从一条资料库记录里取模板变量（纯函数，便于单测）。
 *
 * {name} = 去掉扩展名的文件名。留给「用搜索页接文件」这类自定义模板，
 * 默认模板用不到它。
 */
export function playerTemplateVars(row = {}) {
  return {
    pickcode: row.pickcode || '',
    cid: row.cid || '',
    fileId: row.fileId || '',
    name: String(row.fileName || '').replace(/\.[a-z0-9]{2,5}$/i, '')
  };
}

/**
 * 按模板拼播放地址（纯函数，便于单测）。
 *
 * 模板里写了但没提供的变量**保持原样**，不替换成空串 ——
 * 这样用户一眼就能看出「{foo} 这个变量不存在」，比拼出一个残缺 URL 好排查。
 */
export function fillPlayerTemplate(tpl, vars = {}) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (m, k) =>
    Object.prototype.hasOwnProperty.call(vars, k) ? encodeURIComponent(vars[k]) : m
  );
}

/**
 * 播放页自检结果的存放键。
 *
 * 脚本在**播放页**里也会运行，那一侧才检测得准。
 * 判定结果写进 localStorage，列表页打开播放页前先读一眼：
 * 上次如果是空白页，就先提醒用户，不要让他对着白屏发呆。
 */
export const PLAYER_PROBE_KEY = 'jv115-player-probe';
/** 自检结果的有效期（ms）：超过就重新判一次，避免用户后来装了 115Master 还一直报错 */
export const PLAYER_PROBE_TTL = 10 * 60 * 1000;

export const DEFAULT_SETTINGS = {
  // 数据源（默认全部走网页直连，不需要任何 key）
  enableJavbus: true,
  javbusBaseUrl: 'https://www.javbus.com',
  enableJavlibrary: true,
  javlibraryBaseUrl: 'https://www.javlibrary.com',
  javlibraryLang: 'cn',
  // DMM 可选（有 key 才启用）
  enableDmm: false,
  dmmApiId: '',
  dmmAffiliateId: '',
  // 行为
  concurrency: 3,
  useCache: true,
  autoInjectColumn: true,
  cacheTTLDays: 30,
  minConfidence: 60,
  showCover: false,
  // 悬停浮层空间充裕 → 0 表示全显示，不截断
  maxActress: 0,
  maxGenres: 0,
  /**
   * 点「播放」时怎么打开（取值见上方 PLAY_MODES）：
   *   'page'   直接打开播放页（一步直达，默认）
   *   'inpage' 跳回目录 + 页面内模拟点击播放（不依赖任何插件，但受分页/渲染影响）
   */
  playMode: PLAY_MODES.PAGE,
  /** 「播放」按钮的地址模板，见文件上方 DEFAULT_PLAYER_URL 的说明 */
  playerUrlTemplate: DEFAULT_PLAYER_URL,
  /**
   * 资料库列表里标题最多显示几行：1（默认）或 2。
   * 一行到底时光标悬停能看全文，面板宽 380px 下比两行多放出约 1.3 条。
   */
  titleLines: 1
};

export async function loadSettings() {
  const saved = await getAllSettings();
  const merged = { ...DEFAULT_SETTINGS, ...saved };
  // 历史存档里可能是 'auto'/'master'，这里统一迁移，面板上的下拉才不会空掉
  merged.playMode = normalizePlayMode(merged.playMode);
  if (!merged.playerUrlTemplate) merged.playerUrlTemplate = DEFAULT_PLAYER_URL;
  return merged;
}

/* ==================== 导出 / 导入 ==================== */

/** 导出全部数据为 JSON 字符串 */
export async function exportAll() {
  const [meta, fileMap, library, dirs, settings] = await Promise.all([
    getAllMeta(),
    getAllFileMap(),
    getAllLibrary(),
    getAllDirs(),
    getAllSettings()
  ]);
  return JSON.stringify(
    {
      _format: 'jv115-tagger-backup',
      _version: DB_VERSION,
      _exportedAt: new Date().toISOString(),
      meta,
      fileMap,
      library,
      dirs,
      settings
    },
    null,
    2
  );
}

/**
 * 导入备份。默认合并（同 key 覆盖）。
 * @param {string} jsonText
 * @param {{merge?: boolean}} opts merge=false 时先清空
 */
export async function importAll(jsonText, opts = {}) {
  const data = JSON.parse(jsonText);
  if (data._format !== 'jv115-tagger-backup') {
    throw new Error('备份文件格式不匹配');
  }

  if (opts.merge === false) {
    await clearAll();
  }

  const metaCount = await putMetaBatch(data.meta || []);
  const mapCount = await putFileMapBatch(data.fileMap || []);
  const libCount = await putLibraryBatch(data.library || []);

  let dirCount = 0;
  for (const d of data.dirs || []) {
    if (d && d.cid) { await putDirMeta(d); dirCount++; }
  }

  let settingCount = 0;
  if (data.settings) {
    for (const [key, value] of Object.entries(data.settings)) {
      await setSetting(key, value);
      settingCount++;
    }
  }

  return { metaCount, mapCount, libCount, dirCount, settingCount };
}

/** 清空所有业务数据（不含设置） */
export async function clearAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_META, STORE_FILEMAP, STORE_LIBRARY, STORE_DIRS], 'readwrite');
    tx.objectStore(STORE_META).clear();
    tx.objectStore(STORE_FILEMAP).clear();
    tx.objectStore(STORE_LIBRARY).clear();
    tx.objectStore(STORE_DIRS).clear();
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

/** 清理超过 TTL 的缓存条目 */
export async function purgeExpired(ttlDays = 30) {
  const cutoff = Date.now() - ttlDays * 86400 * 1000;
  const all = await getAllMeta();
  const expired = all.filter((m) => (m.fetchedAt || 0) < cutoff);
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_META, 'readwrite');
    const store = tx.objectStore(STORE_META);
    expired.forEach((m) => store.delete(m.code));
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  return expired.length;
}

/** 获取统计信息 */
export async function getStats() {
  const [metaCount, mapCount, libCount, dirCount] = await Promise.all([
    countMeta(),
    countFileMap(),
    countLibrary(),
    countDirs()
  ]);
  const all = await getAllMeta();
  const bySource = all.reduce((acc, m) => {
    acc[m.source] = (acc[m.source] || 0) + 1;
    return acc;
  }, {});
  const goneCount = await countLibraryGone();
  return { metaCount, mapCount, libCount, dirCount, goneCount, bySource };
}
