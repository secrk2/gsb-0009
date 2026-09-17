// 甘特时间/坐标工具：全链路固定东八区墙钟，与后端 parseLocalDateTime 一致。
export const HOUR_MS = 3600 * 1000;
export const DAY_MS = 24 * HOUR_MS;
export const SNAP_MIN_WEEK = 30;
export const SNAP_MIN_DAY = 15;

// 周视图每天像素 / 日视图每小时像素（<1280 平板由 CSS 缩放，JS 用同一基准）
export const DAY_W = 168;
export const HOUR_W = 72;
export const ROW_H = 46;
export const LABEL_W = 150;
export const HEAD_H = 44;
export const DRAG_THRESHOLD = 6;

export const weekAxisW = 7 * DAY_W;
export const dayAxisW = 24 * HOUR_W;

const pad = (n) => String(n).padStart(2, '0');

/** 任意时间 → 东八区 datetime-local 值（YYYY-MM-DDTHH:mm），供 <input type="datetime-local"> */
export function toLocalInput(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const bj = new Date(d.getTime() + 8 * HOUR_MS);
  return `${bj.getUTCFullYear()}-${pad(bj.getUTCMonth() + 1)}-${pad(bj.getUTCDate())}`
    + `T${pad(bj.getUTCHours())}:${pad(bj.getUTCMinutes())}`;
}

/** 东八区当日零点 */
export function startOfDayBeijing(value = Date.now()) {
  const bj = new Date(new Date(value).getTime() + 8 * HOUR_MS);
  bj.setUTCHours(0, 0, 0, 0);
  return new Date(bj.getTime() - 8 * HOUR_MS);
}

/** 东八区周一零点 */
export function startOfWeekBeijing(value = Date.now()) {
  const day = startOfDayBeijing(value);
  const bj = new Date(day.getTime() + 8 * HOUR_MS);
  const wd = (bj.getUTCDay() + 6) % 7; // 周一=0
  return new Date(day.getTime() - wd * DAY_MS);
}

export const addDays = (t, n) => new Date(+t + n * DAY_MS);

/** 周/日窗口 */
export function windowOf(viewMode, anchor) {
  const start = viewMode === 'week' ? startOfWeekBeijing(anchor) : startOfDayBeijing(anchor);
  return { start, end: addDays(start, viewMode === 'week' ? 7 : 1) };
}

export const axisWidth = (viewMode) => (viewMode === 'week' ? weekAxisW : dayAxisW);
export const windowMs = (viewMode) => (viewMode === 'week' ? 7 * DAY_MS : DAY_MS);

export function timeToX(t, winStart, viewMode) {
  return (new Date(t).getTime() - +winStart) / windowMs(viewMode) * axisWidth(viewMode);
}

export function xToTime(x, winStart, viewMode) {
  const ms = x / axisWidth(viewMode) * windowMs(viewMode);
  return new Date(+winStart + ms);
}

/** 吸附到网格 */
export function snapTime(t, viewMode) {
  const d = new Date(t);
  const snapMin = viewMode === 'week' ? SNAP_MIN_WEEK : SNAP_MIN_DAY;
  const bj = new Date(d.getTime() + 8 * HOUR_MS);
  const min = bj.getUTCHours() * 60 + bj.getUTCMinutes();
  const snapped = Math.round(min / snapMin) * snapMin;
  bj.setUTCMinutes(0, 0, 0);
  return new Date(bj.getTime() + snapped * 60000 - 8 * HOUR_MS);
}

const WEEK_CN = ['日', '一', '二', '三', '四', '五', '六'];
export function weekdayCn(t) {
  return WEEK_CN[new Date(+t + 8 * HOUR_MS).getUTCDay()];
}
export function labelDay(t) {
  const bj = new Date(+t + 8 * HOUR_MS);
  return `${bj.getUTCMonth() + 1}/${bj.getUTCDate()}`;
}
export const isSameBeijingDay = (a, b) => startOfDayBeijing(a).getTime() === startOfDayBeijing(b).getTime();

export function fmtMinutes(min) {
  if (!Number.isFinite(min)) return '—';
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m ? `${h}小时${m}分` : `${h}小时`;
}

export function fmtRate(rate) {
  if (rate === null || rate === undefined) return '—';
  return `${(rate * 100).toFixed(1)}%`;
}

/** 区间文案 */
export function fmtRangeCN(s, e) {
  const f = (v) => {
    const bj = new Date(+v + 8 * HOUR_MS);
    return `${bj.getUTCMonth() + 1}月${bj.getUTCDate()}日 ${pad(bj.getUTCHours())}:${pad(bj.getUTCMinutes())}`;
  };
  return `${f(s)}–${f(e)}`;
}
