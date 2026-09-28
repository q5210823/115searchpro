/**
 * 资料库列表的分批渲染（懒加载）
 * ------------------------------------------------------------------
 * 为什么需要它：
 *   命中几千条时一次性塞进 DOM 会卡；更要命的是**用户看不见「下面还有多少」** ——
 *   旧实现是 `rows.slice(0, 300)` 静默截断，既不说截断了、也没法继续看，
 *   观感就是「筛选完显示不全，也没有翻页」。
 *
 * 现在的做法：
 *   · 先渲染前 LIB_PAGE_SIZE 条；
 *   · 滚到底部（footer 进入视口）自动追加下一批；
 *   · 底部常驻一行状态，写明「已显示 X / 共 Y 条」或「已全部显示」。
 *
 * 这里只放**纯计算**（方便单测）；DOM 操作在 panel.js 里。
 * ⚠️ 打包器把所有模块拼进同一作用域，常量名全局唯一。
 */

/** 每批渲染多少条（用户要求：默认显示 50 条） */
export const LIB_PAGE_SIZE = 50;

/**
 * 算出下一批要渲染的区间。
 *
 * @param {number} total 本次筛选命中的总条数
 * @param {number} shown 已经渲染了多少条
 * @param {number} [size] 每批条数
 * @returns {{from:number, to:number, added:number, hasMore:boolean}}
 *          from/to 为 [from, to) 左闭右开区间；added 是本批新增条数
 */
export function libPageWindow(total, shown, size = LIB_PAGE_SIZE) {
  // 容错：任何非数字/负数/越界的输入都要夹到合法区间，绝不能算出 NaN 让 slice 静默返回空数组
  const t = Math.max(0, Math.floor(Number(total)) || 0);
  const s = Math.min(Math.max(0, Math.floor(Number(shown)) || 0), t);

  /*
   * size 非法（NaN / 0 / 负数）一律**回落默认值**。
   * ⚠️ 不能写成 `Math.max(1, size || DEFAULT)`：负数是 truthy，
   *    会被 max 抬成 1 —— 退化成「一次一条」，比报错还难发现。
   */
  const rawStep = Math.floor(Number(size));
  const step = Number.isFinite(rawStep) && rawStep > 0 ? rawStep : LIB_PAGE_SIZE;

  const from = s;
  const to = Math.min(from + step, t);
  return { from, to, added: to - from, hasMore: to < t };
}

/**
 * 底部状态行文案。
 *
 * 关键点：**加载完必须明确说「已全部显示」**。
 * 否则用户滚到底看到没有新内容，仍会怀疑「是不是还有没加载出来的」——
 * 这正是这次要修的观感问题。
 *
 * @param {number} total 命中总数
 * @param {number} shown 已渲染条数
 * @param {boolean} [loading] 是否正在加载
 * @returns {string} 空串表示不需要 footer
 */
export function libFootText(total, shown, loading = false) {
  const t = Math.max(0, Math.floor(Number(total)) || 0);
  const s = Math.min(Math.max(0, Math.floor(Number(shown)) || 0), t);

  if (t === 0) return '';
  if (loading) return `正在加载… 已显示 ${s} / ${t} 条`;
  if (s >= t) return `已全部显示（共 ${t} 条）`;
  return `已显示 ${s} / 共 ${t} 条 · 继续下滑自动加载`;
}
