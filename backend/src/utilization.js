// 车辆利用率（时间口径）—— 纯函数，作战台 / 排班详情 / CSV 导出三处共用，保证咬死一致。
//
// 口径（界面原文照抄）：
//   利用率 = 窗口内「已排班占用时长」÷「可用时长」
//   分子：该资源窗口内状态为 已派车/运输中/已完成 的运单计划区间，与窗口求交后
//         按分钟合并去重（同资源重叠不双算）；
//   分母：按每周可用时段规则在窗口内裁剪出的分钟数，再扣除不可用窗口（维保/请假）。
//   异常中止、待派车（填报/自审/待核验）一律不计分子。
// 区间一律左闭右开 [start,end)，单位 epoch 毫秒。

const DAY_MS = 24 * 3600 * 1000;
const MIN_MS = 60 * 1000;

export const OCCUPIED_STATUSES = ['DISPATCHED', 'IN_TRANSIT', 'COMPLETED'];

/** 与窗口求交；不相交返回 null */
export function clipRange(winStart, winEnd, start, end) {
  const lo = Math.max(+winStart, +start);
  const hi = Math.min(+winEnd, +end);
  return lo < hi ? [lo, hi] : null;
}

/** 合并重叠或首尾相接的区间（相接即合并，分钟不双算也不留缝） */
export function mergeRanges(ranges) {
  const list = ranges
    .filter((r) => r && Number.isFinite(+r[0]) && Number.isFinite(+r[1]) && +r[1] > +r[0])
    .map((r) => [+r[0], +r[1]])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const r of list) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/** 从 base 区间集合中挖去 cuts（cuts 会先被合并）；每段可能被劈成两半 */
export function subtractRanges(base, cuts) {
  const cutMerged = mergeRanges(cuts || []);
  const out = [];
  for (let [s, e] of mergeRanges(base)) {
    for (const [cs, ce] of cutMerged) {
      if (ce <= s || cs >= e) continue;
      if (cs > s) out.push([s, Math.min(cs, e)]);
      s = Math.max(s, ce);
      if (s >= e) break;
    }
    if (s < e) out.push([s, e]);
  }
  return mergeRanges(out);
}

export function sumMinutes(ranges) {
  return mergeRanges(ranges).reduce((acc, [s, e]) => acc + (e - s) / MIN_MS, 0);
}

/**
 * 把每周可用时段规则展开为窗口内的具体区间。
 * @param winStart,winEnd epoch 毫秒
 * @param rules [{ weekday: 0=周日…6=周六, start_min: 当日分钟(0..1439), end_min: 当日分钟(1..1440) }]
 *   不支持跨夜规则（end_min > start_min，由建表/写入保证）；rules 为空 => 该资源无可用时间
 * 注：按东八区墙钟划分自然日。service 层已将时间规整到本地零点，这里以 winStart 为日界逐天展开。
 */
export function expandAvailability(winStart, winEnd, rules, dayStartMs = DAY_MS) {
  const ws = +winStart; const we = +winEnd;
  if (!rules?.length || !Number.isFinite(ws) || !Number.isFinite(we) || we <= ws) return [];
  const byWeekday = new Map();
  for (const r of rules) {
    if (!byWeekday.has(r.weekday)) byWeekday.set(r.weekday, []);
    byWeekday.get(r.weekday).push(r);
  }
  const out = [];
  // 以 winStart 当地零点为步进基准（service 传入窗口均对齐到东八区零点）
  const firstDay = new Date(ws);
  firstDay.setHours(0, 0, 0, 0);
  for (let day = firstDay.getTime(); day < we; day += dayStartMs) {
    const wd = new Date(day).getDay();
    const dayRules = byWeekday.get(wd);
    if (!dayRules) continue;
    for (const r of mergeDayRules(dayRules)) {
      const s = day + r[0] * MIN_MS;
      const e = day + r[1] * MIN_MS;
      const hit = clipRange(ws, we, s, e);
      if (hit) out.push(hit);
    }
  }
  return mergeRanges(out);
}

function mergeDayRules(rules) {
  return mergeRanges(rules.map((r) => [r.start_min, r.end_min]));
}

/**
 * 计算一组资源的利用率（车/驾/押同构）。
 * @param window { from, to }
 * @param tasks  [{ resource_id, status, start, end }]（resource_id 由调用方按维度映射好）
 * @param rulesByResource { [id]: rules[] }
 * @param unavailByResource { [id]: [{start,end}] }
 * @returns [{ resource_id, available_min, occupied_min, rate, waybill_count }]
 *   rate=null 表示分母为 0（无可排班时间），前端显示「—」；rate 允许 >1（超排，不截断）
 */
export function computeUtilization({ window: win, tasks, rulesByResource = {}, unavailByResource = {} }) {
  const ws = +win.from; const we = +win.to;
  const ids = new Set();
  Object.keys(rulesByResource).forEach((id) => ids.add(Number(id)));
  const occByRes = new Map();
  const countByRes = new Map();
  for (const t of tasks || []) {
    const rid = Number(t.resource_id);
    if (!Number.isInteger(rid) || !OCCUPIED_STATUSES.includes(t.status)) continue;
    ids.add(rid);
    const hit = clipRange(ws, we, +t.start, +t.end);
    if (!hit) continue;
    if (!occByRes.has(rid)) occByRes.set(rid, []);
    occByRes.get(rid).push(hit);
    countByRes.set(rid, (countByRes.get(rid) || 0) + 1);
  }

  const items = [];
  for (const rid of [...ids].sort((a, b) => a - b)) {
    const occupied = sumMinutes(occByRes.get(rid) || []);
    const rawAvailable = expandAvailability(ws, we, rulesByResource[rid] || []);
    const unavailClipped = (unavailByResource[rid] || [])
      .map((u) => clipRange(ws, we, +u.start, +u.end))
      .filter(Boolean);
    const available = sumMinutes(subtractRanges(rawAvailable, unavailClipped));
    items.push({
      resource_id: rid,
      available_min: Math.round(available),
      occupied_min: Math.round(occupied),
      rate: available > 0 ? occupied / available : null,
      waybill_count: countByRes.get(rid) || 0,
    });
  }
  return items;
}

/** 口径文案（三处界面统一引用，禁止各处各写一份） */
export const UTILIZATION_CALIBER = '时间口径：利用率 = 已排班占用时长 ÷ 可用时长';
export const UTILIZATION_CALIBER_DETAIL = '分子为窗口内已派车/运输中/已完成运单的计划区间与窗口求交后、按分钟合并去重的总时长；分母为每周可用时段裁剪窗口后再扣除维保/请假的总时长。';
export const UTILIZATION_FOOTNOTE = '注：临时改派频繁的月份，本口径可能与「已执行单数÷派单数」方向相反，本系统统一采用时间口径。';
