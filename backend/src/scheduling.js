// 运输排班引擎 —— 纯函数模块，不依赖数据库/Express，便于 node --test。
//
// 三大职责：
//   1. 冲突检测：车辆同段被两单占、驾驶员/押运员同时落两单、证照（驾驶证/从业资格证/
//      车辆道路运输证）过期或缺失、车辆维修时段、人员请假时段；
//   2. 改派链式重排：目标单解绑换车/换人后，原车与新车（及驾驶员/押运员）后续单按
//      "只顺延、不提前" 链式重排；运输中/已完成锁定不动；依赖边按原始时刻排序生成，
//      DAG 无环（结构上不可能出现环形依赖）；
//   3. 车辆利用率（时间口径，全平台唯一口径，作战台/排班详情/导出共用）：
//      利用率 = 已排班任务占用区间的并集时长 ÷（窗口自然时长 − 已登记车辆不可用时长）。

export const CHAINABLE_STATUSES = ['DISPATCHED']; // 仅"已派车待发车"可拖动/改派/顺延
export const LOCKED_STATUSES = ['IN_TRANSIT', 'COMPLETED']; // 运输中/已完成：时间与资源锁定
export const OCCUPYING_STATUSES = ['DISPATCHED', 'IN_TRANSIT', 'COMPLETED']; // 占用车辆/人员的状态
// 车辆/人员连续两单之间的最小周转间隔（还车、交接、安检）
export const TURNAROUND_MS = 30 * 60 * 1000;

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

export const toMs = (v) => (v instanceof Date ? v.getTime() : (v == null ? null : Number(v)));

const overlap = (s1, e1, s2, e2) => s1 < e2 && e1 > s2;
const overlapLen = (s1, e1, s2, e2) => Math.max(0, Math.min(e1, e2) - Math.max(s1, s2));
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function fmtDT(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtDur(ms) {
  const h = ms / HOUR;
  return h >= 1 ? `${Math.round(h * 10) / 10} 小时` : `${Math.round(ms / 60000)} 分钟`;
}

/** 任务在资源上实际占用的时间区间（运输中用实发起点，已完成用实际区间） */
export function occupiedInterval(task) {
  const dep = toMs(task.planned_departure);
  const arr = toMs(task.planned_arrival);
  if (task.status === 'IN_TRANSIT') return [toMs(task.actual_departure) || dep, arr];
  if (task.status === 'COMPLETED') return [toMs(task.actual_departure) || dep, toMs(task.actual_arrival) || arr];
  return [dep, arr];
}

function isOccupying(t) {
  return OCCUPYING_STATUSES.includes(t.status);
}

/**
 * 全量冲突检测。
 * @param tasks 运单（含 planned/actual 时间、vehicle_id、driver_id、escort_id、status、label）
 * @param resources {
 *   vehicles: [{id,label,status,license_until(ms, 当日有效到 23:59:59.999)}],
 *   vehicleBlocks: [{vehicle_id,start,end,reason}],
 *   quals: [{user_id,cert_type:'DRIVING_LICENSE'|'QUALIFICATION_CARD',valid_until}],
 *   leaves: [{user_id,start,end,reason}],
 *   people: [{id,label,role}]
 * }
 * @returns 冲突数组，每条 {code,waybill_id,resource_type,resource_id,resource_label,title,message,detail,conflicting_waybill_id}
 */
export function detectConflicts(tasks, resources = {}) {
  const vehicles = new Map((resources.vehicles || []).map((v) => [v.id, v]));
  const people = new Map((resources.people || []).map((p) => [p.id, p]));
  const blocks = resources.vehicleBlocks || [];
  const quals = resources.quals || [];
  const leaves = resources.leaves || [];
  const active = tasks.filter(isOccupying);
  const conflicts = [];

  const personName = (id) => people.get(id)?.label || `#${id}`;

  // 1) 两两占用冲突（车辆 / 驾驶员 / 押运员）
  for (let i = 0; i < active.length; i += 1) {
    for (let j = i + 1; j < active.length; j += 1) {
      const a = active[i];
      const b = active[j];
      const [as, ae] = occupiedInterval(a);
      const [bs, be] = occupiedInterval(b);
      if (!overlap(as, ae, bs, be)) continue;
      const len = overlapLen(as, ae, bs, be);
      const pair = (resourceType, resourceId, resourceLabel, code, title) => {
        for (const [t, other] of [[a, b], [b, a]]) {
          conflicts.push({
            code,
            waybill_id: t.id,
            waybill_label: t.label,
            resource_type: resourceType,
            resource_id: resourceId,
            resource_label: resourceLabel,
            title,
            conflicting_waybill_id: other.id,
            message: `${resourceLabel}在 ${fmtDT(Math.max(as, bs))}–${fmtDT(Math.min(ae, be))} 同时被运单 ${t.label} 与 ${other.label} 占用，重叠 ${fmtDur(len)}。同一资源同一时段只能排一单。`,
          });
        }
      };
      if (a.vehicle_id && a.vehicle_id === b.vehicle_id) {
        const v = vehicles.get(a.vehicle_id);
        pair('VEHICLE', a.vehicle_id, v?.label ? `车辆 ${v.label}` : `车辆 #${a.vehicle_id}`,
          'VEHICLE_DOUBLE_BOOKED', '车辆同一时段被两单占用');
      }
      if (a.driver_id && a.driver_id === b.driver_id) {
        pair('DRIVER', a.driver_id, `驾驶员 ${personName(a.driver_id)}`,
          'DRIVER_DOUBLE_BOOKED', '驾驶员同一时段落两单');
      }
      if (a.escort_id && a.escort_id === b.escort_id) {
        pair('ESCORT', a.escort_id, `押运员 ${personName(a.escort_id)}`,
          'ESCORT_DOUBLE_BOOKED', '押运员同一时段落两单');
      }
    }
  }

  // 2) 单车/单人维度的冲突（证照、维修、请假）
  for (const t of active) {
    const [s, e] = occupiedInterval(t);

    // 车辆维修状态 / 不可用时段
    const veh = vehicles.get(t.vehicle_id);
    if (veh) {
      if (veh.status === 'MAINTENANCE') {
        conflicts.push({
          code: 'VEHICLE_MAINTENANCE', waybill_id: t.id, waybill_label: t.label,
          resource_type: 'VEHICLE', resource_id: veh.id, resource_label: `车辆 ${veh.label}`,
          title: '车辆处于维修/停运状态',
          message: `车辆 ${veh.label} 当前登记为「维修中/停运」，不能承运 ${t.label}（计划 ${fmtDT(s)} 发车），请改派其他车辆。`,
        });
      }
      for (const b of blocks.filter((x) => x.vehicle_id === veh.id)) {
        const bs = toMs(b.start);
        const be = toMs(b.end);
        if (overlap(s, e, bs, be)) {
          conflicts.push({
            code: 'VEHICLE_UNAVAILABLE', waybill_id: t.id, waybill_label: t.label,
            resource_type: 'VEHICLE', resource_id: veh.id, resource_label: `车辆 ${veh.label}`,
            title: '车辆不可用时段被排班',
            message: `车辆 ${veh.label} 在 ${fmtDT(bs)}–${fmtDT(be)} 登记不可用（${b.reason || '未填原因'}），与 ${t.label}（${fmtDT(s)}–${fmtDT(e)}）重叠 ${fmtDur(overlapLen(s, e, bs, be))}。`,
          });
        }
      }
      if (veh.license_until != null && s > toMs(veh.license_until)) {
        conflicts.push({
          code: 'VEHICLE_LICENSE_EXPIRED', waybill_id: t.id, waybill_label: t.label,
          resource_type: 'VEHICLE', resource_id: veh.id, resource_label: `车辆 ${veh.label}`,
          title: '车辆道路运输证过期',
          message: `车辆 ${veh.label} 的道路运输证有效期至 ${fmtDay(veh.license_until)}，${t.label} 计划 ${fmtDT(s)} 发车时证件已过期，不得排班。`,
        });
      }
    }

    // 驾驶员：驾驶证 + 危货从业资格证；押运员：押运从业资格证
    const certCheck = (personId, role, certType, certLabel, code, title) => {
      const name = personName(personId);
      const valid = quals
        .filter((q) => q.user_id === personId && q.cert_type === certType)
        .some((q) => toMs(q.valid_until) >= startOfDay(s));
      if (!valid) {
        conflicts.push({
          code, waybill_id: t.id, waybill_label: t.label,
          resource_type: role, resource_id: personId, resource_label: `${role === 'DRIVER' ? '驾驶员' : '押运员'} ${name}`,
          title,
          message: `${role === 'DRIVER' ? '驾驶员' : '押运员'} ${name} 的${certLabel}在 ${fmtDT(s)} 发车前已过期或未登记，按规定不得执行 ${t.label}，请更换持证人员或办理换证。`,
        });
      }
    };
    if (t.driver_id) {
      certCheck(t.driver_id, 'DRIVER', 'DRIVING_LICENSE', '驾驶证', 'DRIVER_CERT_EXPIRED', '驾驶员驾驶证过期/缺失');
      certCheck(t.driver_id, 'DRIVER', 'QUALIFICATION_CARD', '危货运输从业资格证', 'DRIVER_CERT_EXPIRED', '驾驶员从业资格证过期/缺失');
    }
    if (t.escort_id) {
      certCheck(t.escort_id, 'ESCORT', 'QUALIFICATION_CARD', '押运从业资格证', 'ESCORT_CERT_EXPIRED', '押运员证照过期/缺失');
    }

    // 请假
    for (const role of ['DRIVER', 'ESCORT']) {
      const pid = role === 'DRIVER' ? t.driver_id : t.escort_id;
      if (!pid) continue;
      for (const lv of leaves.filter((x) => x.user_id === pid)) {
        const ls = toMs(lv.start);
        const le = toMs(lv.end);
        if (overlap(s, e, ls, le)) {
          conflicts.push({
            code: role === 'DRIVER' ? 'DRIVER_ON_LEAVE' : 'ESCORT_ON_LEAVE',
            waybill_id: t.id, waybill_label: t.label,
            resource_type: role, resource_id: pid, resource_label: `${role === 'DRIVER' ? '驾驶员' : '押运员'} ${personName(pid)}`,
            title: `${role === 'DRIVER' ? '驾驶员' : '押运员'}请假时段被排班`,
            message: `${role === 'DRIVER' ? '驾驶员' : '押运员'} ${personName(pid)} 在 ${fmtDT(ls)}–${fmtDT(le)} 请假（${lv.reason || '未填原因'}），与 ${t.label} 重叠 ${fmtDur(overlapLen(s, e, ls, le))}，请改派。`,
          });
        }
      }
    }
  }

  // 去重（同一 waybill+code+resource+conflicting 组合只保留一条）
  const seen = new Set();
  return conflicts.filter((c) => {
    const key = [c.waybill_id, c.code, c.resource_type, c.resource_id, c.conflicting_waybill_id || ''].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function fmtDay(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 改派 + 链式重排（只顺延、不提前；锁单不动）。
 *
 * @param tasks 全部相关运单（调用方按企业取数）
 * @param params {
 *   targetId,                       被改派的运单
 *   newVehicleId, newDriverId?, newEscortId?,  新资源（人员缺省=沿用原人员）
 *   newDeparture,                   目标单新计划发车时刻（ms）
 *   resources,                      同 detectConflicts 的资源对象
 * }
 * @returns {
 *   ok, error?,
 *   changes: [{waybill_id, kind, old/new_planned_departure/arrival, vehicle/driver/escort 变更, reasons:[]}],
 *   finalTasks: 重排后的任务时间（不写库，供调用方落库与前端预览）,
 *   conflicts: 落定后仍然存在的冲突（调用方应据此拒绝提交）
 * }
 */
export function planReassign(tasks, params) {
  const { targetId, newVehicleId, newDeparture, resources = {} } = params;
  const newDriverId = params.newDriverId ?? null;
  const newEscortId = params.newEscortId ?? null;
  const depMs = toMs(newDeparture);

  const target = tasks.find((t) => t.id === targetId);
  if (!target) return { ok: false, error: { code: 'NOT_FOUND', message: '被改派的运单不存在' } };
  if (!CHAINABLE_STATUSES.includes(target.status)) {
    return { ok: false, error: { code: 'ORDER_LOCKED', message: `运单当前为「${target.status}」，运输中或已完成的单不允许改派与链式重排。` } };
  }
  if (!newVehicleId) return { ok: false, error: { code: 'BAD_REQUEST', message: '改派必须指定新的车辆' } };
  if (!Number.isFinite(depMs)) return { ok: false, error: { code: 'BAD_REQUEST', message: '新的计划发车时间格式不正确' } };

  const veh = (resources.vehicles || []).find((v) => v.id === newVehicleId);
  if (!veh) return { ok: false, error: { code: 'VEHICLE_NOT_FOUND', message: '目标车辆不存在' } };

  // 工作集：可顺延的已派车单 + 锁定单（作为不可移动的锚点）；异常中止单不参与
  const work = tasks
    .filter((t) => CHAINABLE_STATUSES.includes(t.status) || LOCKED_STATUSES.includes(t.status))
    .map((t) => ({ ...t }));
  const cur = new Map(work.map((t) => [t.id, t]));

  const durationOf = (t) => {
    const d = toMs(t.planned_arrival) - toMs(t.planned_departure);
    return d > 0 ? d : HOUR;
  };

  // 应用目标单的新绑定与新起点
  const t0 = cur.get(targetId);
  const oldDriver = t0.driver_id;
  const oldEscort = t0.escort_id;
  const oldVehicle = t0.vehicle_id;
  const finalDriver = newDriverId || oldDriver;
  const finalEscort = newEscortId || oldEscort;
  if (finalDriver === finalEscort) {
    return { ok: false, error: { code: 'SAME_PERSON', message: '驾驶员与押运员不得为同一人' } };
  }
  const t0Duration = durationOf(t0);
  t0.vehicle_id = newVehicleId;
  t0.driver_id = finalDriver;
  t0.escort_id = finalEscort;
  t0.planned_departure = depMs;
  t0.planned_arrival = depMs + t0Duration;

  // 原始时刻（改派后的目标单用新起点）决定资源上的先后顺序 —— 边恒由早指向晚，结构无环
  const baseStart = (t) => (t.id === targetId ? depMs : toMs(t.planned_departure));
  const locked = (t) => LOCKED_STATUSES.includes(t.status);

  const resources3 = ['vehicle_id', 'driver_id', 'escort_id'];
  const timeline = (key) =>
    work.filter((t) => t[key] != null)
      .sort((a, b) => baseStart(a) - baseStart(b) || a.id - b.id);

  // 不可用区间（车辆维修登记 / 人员请假）：某资源的任务起点不得落入
  const blockedRanges = (key, id) => {
    if (key === 'vehicle_id') {
      return (resources.vehicleBlocks || [])
        .filter((b) => b.vehicle_id === id)
        .map((b) => [toMs(b.start), toMs(b.end), b.reason || '车辆不可用']);
    }
    return (resources.leaves || [])
      .filter((l) => l.user_id === id)
      .map((l) => [toMs(l.start), toMs(l.end), l.reason || '人员请假']);
  };

  // 迭代松弛：每个可移动单的起点 = max(原计划起点, 各资源前序单结束+周转, 避开不可用区间)。
  // 前序关系固定（按 baseStart 排序），只从早→晚传播，故不可能出现环形依赖。
  const startAfterBlocks = (idVal, key, wantStart, dur) => {
    let s = wantStart;
    let guard = 0;
    const ranges = blockedRanges(key, idVal);
    while (guard < 64) {
      guard += 1;
      const hit = ranges.find(([bs, be]) => overlap(s, s + dur, bs, be));
      if (!hit) break;
      s = hit[1] + TURNAROUND_MS; // 落入不可用段 → 顺延到该段结束后
    }
    return s;
  };

  const computeEarliest = (t, key, predecessorEnd) => {
    let s = baseStart(t); // 只顺延不提前：不得早于原计划
    if (predecessorEnd != null) s = Math.max(s, predecessorEnd + TURNAROUND_MS);
    s = startAfterBlocks(t[key], key, s, durationOf(t));
    return s;
  };

  // 目标单锚定在管理员指定时刻，但不得压上运输中/已完成的锁单（锁单绝不动）
  const targetLocks = work.filter((t) => t.id !== targetId && locked(t)).filter((t) =>
    t.vehicle_id === t0.vehicle_id
    || (t0.driver_id && t.driver_id === t0.driver_id)
    || (t0.escort_id && t.escort_id === t0.escort_id));
  for (const lk of targetLocks) {
    const [ls, le] = occupiedInterval(lk);
    if (overlap(depMs, t0.planned_arrival, ls, le)) {
      const share = lk.vehicle_id === t0.vehicle_id ? '同一车辆'
        : (lk.driver_id === t0.driver_id ? '同一驾驶员' : '同一押运员');
      return {
        ok: false,
        error: {
          code: 'TARGET_CONFLICTS_LOCKED',
          message: `目标落点（${fmtDT(depMs)}–${fmtDT(t0.planned_arrival)}）与${share}的运输中/已完成运单 ${lk.label}（${fmtDT(ls)}–${fmtDT(le)}）重叠。运输中与已完成的单不允许移动，请改选落点或资源。`,
          locked_waybill_id: lk.id,
        },
      };
    }
  }

  // 多轮直到稳定（跨车辆/人员的菱形依赖需要多轮传播）
  let changed = true;
  let passes = 0;
  while (changed && passes < work.length + 2) {
    changed = false;
    passes += 1;
    for (const key of resources3) {
      const line = timeline(key);
      let prevEnd = null;
      for (const t of line) {
        if (locked(t)) {
          prevEnd = occupiedInterval(t)[1];
          continue;
        }
        if (t.id === targetId) {
          // 目标单锚定在管理员指定时刻；其后的单必须给它让路
          prevEnd = t0.planned_arrival;
          continue;
        }
        const earliest = computeEarliest(t, key, prevEnd);
        if (earliest > toMs(t.planned_departure)) {
          const dur = durationOf(t);
          t.planned_departure = earliest;
          t.planned_arrival = earliest + dur;
          changed = true;
        }
        prevEnd = toMs(t.planned_arrival);
      }
    }
  }

  // 组装变更清单
  const orig = new Map(tasks.map((t) => [t.id, t]));
  const changes = [];
  const pushShift = (t, reasons) => {
    const o = orig.get(t.id);
    changes.push({
      waybill_id: t.id,
      waybill_label: t.label,
      kind: 'CHAIN_SHIFT',
      old_planned_departure: toMs(o.planned_departure),
      new_planned_departure: toMs(t.planned_departure),
      old_planned_arrival: toMs(o.planned_arrival),
      new_planned_arrival: toMs(t.planned_arrival),
      reasons,
    });
  };
  for (const t of work) {
    if (t.id === targetId) continue;
    const o = orig.get(t.id);
    if (toMs(t.planned_departure) !== toMs(o.planned_departure)) {
      pushShift(t, ['前序运单改派/顺延后为避免同车或同驾驶员/押运员同时段占用，按最小周转间隔链式后移']);
    }
  }
  changes.unshift({
    waybill_id: targetId,
    waybill_label: target.label,
    kind: oldVehicle !== newVehicleId || newDriverId || newEscortId ? 'REASSIGN' : 'RESCHEDULE',
    old_vehicle_id: oldVehicle,
    new_vehicle_id: newVehicleId,
    old_driver_id: oldDriver,
    new_driver_id: finalDriver,
    old_escort_id: oldEscort,
    new_escort_id: finalEscort,
    old_planned_departure: toMs(target.planned_departure),
    new_planned_departure: depMs,
    old_planned_arrival: toMs(target.planned_arrival),
    new_planned_arrival: t0.planned_arrival,
    reasons: [params.reason || ''].filter(Boolean),
  });

  // 落定后复检（新车/新人的证照、残余重叠等）
  const finalConflicts = detectConflicts(work, resources)
    .filter((c) => work.some((t) => t.id === c.waybill_id));

  return {
    ok: true,
    changes,
    finalTasks: work.map((t) => ({
      id: t.id,
      status: t.status,
      label: t.label,
      vehicle_id: t.vehicle_id,
      driver_id: t.driver_id,
      escort_id: t.escort_id,
      planned_departure: toMs(t.planned_departure),
      planned_arrival: toMs(t.planned_arrival),
    })),
    conflicts: finalConflicts,
    arrival_delayed: t0.planned_arrival > toMs(target.planned_arrival),
  };
}

/** 区间并集时长（与 [ws,we] 求交后合并）——双占用不重复计工时 */
export function unionDuration(intervals, ws, we) {
  const clipped = intervals
    .map(([s, e]) => [Math.max(toMs(s), ws), Math.min(toMs(e), we)])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let cur = null;
  for (const [s, e] of clipped) {
    if (!cur) { cur = [s, e]; continue; }
    if (s <= cur[1]) cur[1] = Math.max(cur[1], e);
    else { total += cur[1] - cur[0]; cur = [s, e]; }
  }
  if (cur) total += cur[1] - cur[0];
  return total;
}

/**
 * 车辆利用率（时间口径）：
 *   已排班时长 = 已派车/运输中/已完成运单占用区间并集（重叠不重复计）；
 *   可用时长   = 窗口自然时长 − 车辆登记不可用（维修/保养/抛锚）时长。
 * @returns { items:[{vehicle_id,plate,scheduled_ms,available_ms,ratio,overbooked}], fleet:{...} }
 */
export function computeUtilization(tasks, vehicles, vehicleBlocks, ws, we) {
  ws = toMs(ws);
  we = toMs(we);
  const win = Math.max(0, we - ws);
  const items = vehicles.map((v) => {
    const intervals = tasks
      .filter((t) => t.vehicle_id === v.id && isOccupying(t))
      .map((t) => occupiedInterval(t));
    const scheduled = unionDuration(intervals, ws, we);
    const unavailable = unionDuration(
      (vehicleBlocks || []).filter((b) => b.vehicle_id === v.id).map((b) => [toMs(b.start), toMs(b.end)]),
      ws, we,
    );
    // 维修/停运状态的车辆整窗不可用
    const hardDown = v.status && v.status !== 'AVAILABLE';
    const available = hardDown ? 0 : Math.max(0, win - unavailable);
    const rawSum = intervals.reduce((n, [s, e]) => n + Math.max(0, Math.min(e, we) - Math.max(s, ws)), 0);
    return {
      vehicle_id: v.id,
      plate: v.label,
      status: v.status || 'AVAILABLE',
      scheduled_ms: scheduled,
      unavailable_ms: hardDown ? win : unavailable,
      available_ms: available,
      ratio: available > 0 ? scheduled / available : (scheduled > 0 ? 1 : 0),
      overbooked: win > 0 && rawSum > win + TURNAROUND_MS, // 原始占用之和超出整窗 → 存在重复排班
    };
  });
  const schedAll = items.reduce((n, x) => n + x.scheduled_ms, 0);
  const availAll = items.reduce((n, x) => n + x.available_ms, 0);
  return {
    window_start: ws,
    window_end: we,
    items,
    fleet: {
      scheduled_ms: schedAll,
      available_ms: availAll,
      ratio: availAll > 0 ? schedAll / availAll : 0,
    },
  };
}

export const MS = { HOUR, DAY };

/** 把 ratio 格式化为统一展示文案（三处页面必须用同一函数口径） */
export function formatRatio(ratio) {
  if (!Number.isFinite(ratio)) return '—';
  const pct = Math.round(ratio * 100);
  return `${clamp(pct, 0, 100)}%`;
}

/**
 * 车辆利用率口径（全平台唯一口径，作战台/排班详情/导出必须共用此定义）：
 * 采用「时间口径」而非「单数口径」——临时改派多的月份，已执行单数/派单数会虚高
 * （改派不产生新单），无法反映车辆真实忙闲；时间口径直接度量产能占用。
 */
export const UTIL_METRIC = {
  key: 'TIME',
  name: '车辆利用率（时间口径）',
  formula: '已排班任务时长并集 ÷（统计窗口时长 − 车辆登记不可用时长）',
  detail: '已排班=已派车/运输中/已完成运单占用时段（同车重叠只计一次）；不可用=维修/保养/抛锚登记时段，维修中车辆整窗计为不可用。仅按当前周/日窗口统计。',
  compareNote: '不采用「已执行单数÷派单数」：临时改派多的月份该口径只降不升或失真，两口径会反向，全平台统一以本时间口径为准。',
};
