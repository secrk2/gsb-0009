// 排班冲突检测 —— 纯函数模块，不依赖数据库，便于单测。
//
// 全部时间参数均为 epoch 毫秒（或可被 Date 解析的值），区间统一为左闭右开 [start, end)。
// 端点相接（前一单 end === 后一单 start）视为不冲突，正好衔接到 BUFFER 之前的周转余量为止。

export const TURNAROUND_BUFFER_MS = 30 * 60 * 1000; // 同车相邻两单最小周转间隔 30 分钟

export const RESOURCE_TYPES = {
  VEHICLE: 'VEHICLE',
  DRIVER: 'DRIVER',
  ESCORT: 'ESCORT',
};

export const CONFLICT_LABELS = {
  VEHICLE_OVERLAP: '车辆时段冲突',
  DRIVER_OVERLAP: '驾驶员时段冲突',
  ESCORT_OVERLAP: '押运员时段冲突',
  LICENSE_EXPIRED: '押运员证照过期',
  VEHICLE_UNAVAILABLE: '车辆处于不可用窗口',
  DRIVER_UNAVAILABLE: '驾驶员处于不可用窗口',
  ESCORT_UNAVAILABLE: '押运员处于不可用窗口',
  ANCHOR_COLLISION: '撞上锁定单（运输中/已完成）',
};

/** 两单之间是否不满足最小周转间隔（相接且间隔 >= gap 才不冲突） */
export function intervalsOverlap(aStart, aEnd, bStart, bEnd, gap = TURNAROUND_BUFFER_MS) {
  const aS = +aStart; const aE = +aEnd; const bS = +bStart; const bE = +bEnd;
  return aE + gap > bS && bE + gap > aS;
}

/** 区间求交（左闭右开），无交集返回 null */
export function intersectRange(wStart, wEnd, s, e) {
  const lo = Math.max(+wStart, +s);
  const hi = Math.min(+wEnd, +e);
  return lo < hi ? [lo, hi] : null;
}

/**
 * 证照在任务区间内是否有效：expires_at 必须不早于任务结束时刻。
 * 边界：证照在到达当天到期即视为覆盖（expires_at === end 仍有效，因为区间右开）。
 */
export function licenseCoversTask(expiresAt, taskStart, taskEnd) {
  const exp = new Date(expiresAt).getTime();
  return Number.isFinite(exp) && exp >= +taskEnd;
}

/**
 * 检测一个候选排班与现有排班/资源约束之间的全部冲突。
 *
 * @param draft  候选排班 { id, waybill_no, vehicle_id, driver_id, escort_id,
 *                          start, end, vehicle_name, driver_name, escort_name }
 *               id 为自身已存在运单时，existing 中同 id 的记录自动跳过（自身不与自己冲突）。
 * @param ctx
 *   existing: 同窗口内其它运单排班数组，元素同 draft 形状并多一个 status / locked。
 *   licenses: { [userId]: { expires_at } }（只需放驾驶员/押运员；缺失证照按无照处理？否——仅在提供且过期时报）
 *   unavailability: [{ resource_type, resource_id, start, end, reason }]
 * @returns 冲突数组，逐条可渲染、可点开看原因
 */
export function detectConflicts(draft, ctx = {}) {
  const conflicts = [];
  const start = new Date(draft.start).getTime();
  const end = new Date(draft.end).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return conflicts;

  const pushOverlap = (type, other, resName) => {
    conflicts.push({
      type,
      severity: other.locked ? 'block' : 'warn',
      title: CONFLICT_LABELS[type],
      waybill_id: other.id,
      waybill_no: other.waybill_no,
      resource_name: resName,
      detail: overlapMessage(type, draft, other, resName),
      ranges: [
        { label: '本单', start, end },
        { label: other.waybill_no || `运单#${other.id}`, start: +other.start, end: +other.end },
      ],
    });
  };

  for (const o of ctx.existing || []) {
    if (o.id && draft.id && o.id === draft.id) continue;
    const oStart = +o.start; const oEnd = +o.end;
    if (!Number.isFinite(oStart) || !Number.isFinite(oEnd)) continue;

    if (draft.vehicle_id && o.vehicle_id && draft.vehicle_id === o.vehicle_id
        && intervalsOverlap(start, end, oStart, oEnd)) {
      pushOverlap('VEHICLE_OVERLAP', o, draft.vehicle_name || o.vehicle_name);
    }
    if (draft.driver_id && o.driver_id && draft.driver_id === o.driver_id
        && intervalsOverlap(start, end, oStart, oEnd)) {
      pushOverlap('DRIVER_OVERLAP', o, draft.driver_name);
    }
    if (draft.escort_id && o.escort_id && draft.escort_id === o.escort_id
        && intervalsOverlap(start, end, oStart, oEnd)) {
      pushOverlap('ESCORT_OVERLAP', o, draft.escort_name);
    }
  }

  // 证照：押运员（硬性要求），顺带校验驾驶员从业资格证
  checkLicense(conflicts, 'LICENSE_EXPIRED', 'ESCORT', draft.escort_id, draft.escort_name,
    ctx.licenses, start, end);
  checkDriverLicense(conflicts, draft, ctx.licenses, end);

  // 不可用窗口
  for (const u of ctx.unavailability || []) {
    const hitType = unavailableType(u.resource_type);
    if (!hitType) continue;
    const isTarget = u.resource_type === RESOURCE_TYPES.VEHICLE
      ? draft.vehicle_id === u.resource_id
      : (u.resource_type === RESOURCE_TYPES.DRIVER
        ? draft.driver_id === u.resource_id
        : draft.escort_id === u.resource_id);
    if (!isTarget) continue;
    if (intervalsOverlap(start, end, +u.start, +u.end, 0)) {
      conflicts.push({
        type: hitType,
        severity: 'block',
        title: CONFLICT_LABELS[hitType],
        resource_type: u.resource_type,
        resource_id: u.resource_id,
        resource_name: resourceNameOf(draft, u.resource_type),
        detail: `${CONFLICT_LABELS[hitType]}：${fmtRange(u.start, u.end)} 已登记「${u.reason || '不可用'}」，与本单运输时段重叠。`,
        ranges: [{ label: '不可用', start: +u.start, end: +u.end }, { label: '本单', start, end }],
      });
    }
  }

  return conflicts;
}

function checkLicense(conflicts, type, role, userId, userName, licenses, start, end) {
  const lic = licenses?.[userId];
  if (!lic) return; // 无证照记录不在此模型下硬判（数据由 seed/管理端保证）
  if (!licenseCoversTask(lic.expires_at, start, end)) {
    conflicts.push({
      type,
      severity: 'block',
      title: CONFLICT_LABELS[type],
      resource_type: 'ESCORT',
      resource_id: userId,
      resource_name: userName,
      detail: `押运员「${userName || userId}」的押运证有效期至 ${fmtDT(lic.expires_at)}，`
        + `本单计划到达 ${fmtDT(end)}，证照在运输结束前已过期，不能排班。`,
      license_expires_at: new Date(lic.expires_at).getTime(),
      ranges: [{ label: '本单', start, end }],
    });
  }
}

function checkDriverLicense(conflicts, draft, licenses, end) {
  const lic = licenses?.[draft.driver_id];
  if (!lic || licenseCoversTask(lic.expires_at, end, end)) return;
  conflicts.push({
    type: 'LICENSE_EXPIRED',
    severity: 'block',
    title: '驾驶员证照过期',
    resource_type: 'DRIVER',
    resource_id: draft.driver_id,
    resource_name: draft.driver_name,
    detail: `驾驶员「${draft.driver_name || draft.driver_id}」的从业资格证有效期至 ${fmtDT(lic.expires_at)}，`
      + `本单计划到达 ${fmtDT(end)}，证照在运输结束前已过期。`,
    license_expires_at: new Date(lic.expires_at).getTime(),
    ranges: [{ label: '本单', start: +draft.start, end }],
  });
}

function unavailableType(rt) {
  if (rt === RESOURCE_TYPES.VEHICLE) return 'VEHICLE_UNAVAILABLE';
  if (rt === RESOURCE_TYPES.DRIVER) return 'DRIVER_UNAVAILABLE';
  if (rt === RESOURCE_TYPES.ESCORT) return 'ESCORT_UNAVAILABLE';
  return null;
}

function resourceNameOf(draft, rt) {
  if (rt === RESOURCE_TYPES.VEHICLE) return draft.vehicle_name;
  if (rt === RESOURCE_TYPES.DRIVER) return draft.driver_name;
  return draft.escort_name;
}

function overlapMessage(type, draft, other, resName) {
  const label = CONFLICT_LABELS[type];
  const who = resName ? `「${resName}」` : '';
  const lock = other.locked ? '（运输中/已完成，时间锁定）' : '';
  return `${label}：${who}在 ${fmtRange(draft.start, draft.end)} 已被 `
    + `${other.waybill_no || `运单#${other.id}`} 占用（${fmtRange(other.start, other.end)}，`
    + `含 ${TURNAROUND_BUFFER_MS / 60000} 分钟周转间隔），两单时段无法兼得${lock}。`;
}

/** 多候选批量检测（便于 /check 接口一次校验整张甘特） */
export function detectAll(drafts, ctx = {}) {
  const result = {};
  for (const d of drafts) {
    const list = detectConflicts(d, ctx);
    if (list.length) result[d.id || d.client_key] = list;
  }
  return result;
}

function pad(n) { return String(n).padStart(2, '0'); }
function fmtDT(v) {
  const d = new Date(v);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fmtRange(s, e) { return `${fmtDT(s)}–${fmtDT(e)}`; }
