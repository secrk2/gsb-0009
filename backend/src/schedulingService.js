// 运输排班数据服务：窗口（周/日，东八区）计算、资源/任务装载、引擎入参转换。
import { pool } from './db.js';
import {
  detectConflicts, planReassign, computeUtilization, UTIL_METRIC,
} from './scheduling.js';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

/** 取东八区墙钟的当前 Date（容器 TZ=Asia/Shanghai，本地开发时显式偏移兜底） */
export function nowCST() {
  const now = new Date();
  // 转为 +08:00 的墙钟分量再包回 Date，保证周/日窗口不依赖运行机时区
  const cst = new Date(now.getTime() + 8 * HOUR + now.getTimezoneOffset() * 60 * 1000);
  return cst;
}

/** 'YYYY-MM-DD'（东八区）；不传则取今天 */
export function cstDateStr(d = nowCST()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 计算周/日窗口（绝对时刻）。
 * 周：周一 00:00 ~ 下周一 00:00（东八区墙钟）；日：当日 00:00 ~ 次日 00:00。
 */
export function windowRange(view, dateStr) {
  const s = /^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || '')) ? String(dateStr) : cstDateStr();
  const [y, m, d] = s.split('-').map(Number);
  const noon = new Date(`${s}T12:00:00+08:00`); // 正午实例化，规避任何时区漂移
  const dow = (noon.getUTCDay() + 6) % 7; // 周一=0
  let start;
  let end;
  if (view === 'week') {
    start = new Date(Date.UTC(y, m - 1, d - dow, -8, 0, 0)); // 东八区周一 00:00 = UTC 周一-8h(即周日16:00)
    end = new Date(start.getTime() + 7 * DAY);
  } else {
    start = new Date(Date.UTC(y, m - 1, d, -8, 0, 0));
    end = new Date(start.getTime() + DAY);
  }
  return { start, end, date: s };
}

/** 相邻窗口（周/日前移/后移） */
export function shiftDateStr(dateStr, view, delta) {
  const s = /^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || '')) ? String(dateStr) : cstDateStr();
  const d = new Date(`${s}T12:00:00+08:00`);
  d.setUTCDate(d.getUTCDate() + (view === 'week' ? 7 * delta : delta));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

const TASK_STATUSES = ['DISPATCHED', 'IN_TRANSIT', 'COMPLETED'];

/** DATE 列（mysql2 返回 'YYYY-MM-DD'）→ 当日 23:59:59.999（含当日有效） */
function dateUntilEnd(v) {
  if (v == null) return null;
  if (v instanceof Date) return new Date(v.getFullYear(), v.getMonth(), v.getDate(), 23, 59, 59, 999);
  return new Date(`${String(v).slice(0, 10)}T23:59:59.999+08:00`);
}

/**
 * 装载某企业在 [from,to) 内的引擎数据（任务+资源）。
 * 任务取与窗口相交的已派车/运输中/已完成运单。
 * @param executor pool 或事务连接
 */
export async function loadEngineData(executor, enterpriseId, from, to) {
  const [vehRows] = await executor.query(
    `SELECT id, plate, status, transport_license_until
     FROM vehicles WHERE enterprise_id = ? AND active = 1 ORDER BY id`,
    [enterpriseId],
  );
  const vehicles = vehRows.map((v) => ({
    id: v.id,
    label: v.plate,
    plate: v.plate,
    status: v.status,
    license_until: dateUntilEnd(v.transport_license_until)?.getTime() ?? null,
  }));

  const [blockRows] = await executor.query(
    `SELECT vu.vehicle_id, vu.start_at, vu.end_at, vu.reason
     FROM vehicle_unavailability vu
     JOIN vehicles v ON v.id = vu.vehicle_id
     WHERE v.enterprise_id = ? AND vu.start_at < ? AND vu.end_at > ?`,
    [enterpriseId, to, from],
  );
  const vehicleBlocks = blockRows.map((b) => ({
    vehicle_id: b.vehicle_id, start: b.start_at.getTime(), end: b.end_at.getTime(), reason: b.reason,
  }));

  const [peopleRows] = await executor.query(
    `SELECT id, name, role, phone FROM users
     WHERE enterprise_id = ? AND role IN ('DRIVER','ESCORT') AND active = 1 ORDER BY role, id`,
    [enterpriseId],
  );
  const people = peopleRows.map((u) => ({ id: u.id, label: u.name, name: u.name, role: u.role, phone: u.phone }));

  const [qualRows] = await executor.query(
    `SELECT q.user_id, q.cert_type, q.valid_until
     FROM crew_qualifications q
     JOIN users u ON u.id = q.user_id
     WHERE u.enterprise_id = ?`,
    [enterpriseId],
  );
  const quals = qualRows.map((q) => ({
    user_id: q.user_id, cert_type: q.cert_type, valid_until: dateUntilEnd(q.valid_until).getTime(),
  }));

  const [leaveRows] = await executor.query(
    `SELECT cl.user_id, cl.start_at, cl.end_at, cl.reason
     FROM crew_leave cl JOIN users u ON u.id = cl.user_id
     WHERE u.enterprise_id = ? AND cl.start_at < ? AND cl.end_at > ?`,
    [enterpriseId, to, from],
  );
  const leaves = leaveRows.map((l) => ({
    user_id: l.user_id, start: l.start_at.getTime(), end: l.end_at.getTime(), reason: l.reason,
  }));

  const [taskRows] = await executor.query(
    `SELECT w.id, w.waybill_no, w.status, w.cargo_name, w.cargo_class,
            w.origin, w.destination, w.vehicle_id, w.vehicle_plate,
            w.driver_id, w.escort_id, d.name AS driver_name, s.name AS escort_name,
            w.planned_departure, w.planned_arrival, w.actual_departure, w.actual_arrival
     FROM waybills w
     JOIN users d ON d.id = w.driver_id
     JOIN users s ON s.id = w.escort_id
     WHERE w.enterprise_id = ? AND w.status IN ('DISPATCHED','IN_TRANSIT','COMPLETED')
       AND w.planned_departure < ? AND w.planned_arrival > ?
     ORDER BY w.planned_departure`,
    [enterpriseId, to, from],
  );
  const tasks = taskRows.map((t) => ({ ...t, label: t.waybill_no }));

  return {
    tasks,
    engineTasks: tasks,
    resources: { vehicles, vehicleBlocks, people, quals, leaves },
    raw: { vehicles, vehicleBlocks, people, quals, leaves },
  };
}

/** 窗口内异常中止/其他未排单数量（区分"全取消"与"从未排班"空态） */
export async function loadWindowCounts(executor, enterpriseId, from, to) {
  const [[row]] = await executor.query(
    `SELECT
       COALESCE(SUM(w.status = 'ABORTED'), 0) AS aborted,
       COALESCE(SUM(w.status IN ('DRAFT','ENTERPRISE_REVIEW','REGULATOR_VERIFY')), 0) AS pending,
       COUNT(*) AS total
     FROM waybills w
     WHERE w.enterprise_id = ? AND w.planned_departure >= ? AND w.planned_departure < ?`,
    [enterpriseId, from, to],
  );
  return {
    aborted: Number(row.aborted), pending: Number(row.pending), total: Number(row.total),
  };
}

/** 组装看板响应 */
export async function buildBoard(poolInstance, { enterpriseId, view, date }) {
  const { start, end, date: d } = windowRange(view, date);
  const data = await loadEngineData(poolInstance, enterpriseId, start, end);
  const conflicts = detectConflicts(data.engineTasks, data.resources);
  const utilization = computeUtilization(data.engineTasks, data.resources.vehicles, data.resources.vehicleBlocks, start, end);
  const counts = await loadWindowCounts(poolInstance, enterpriseId, start, end);

  // 证照/不可用区间挂到泳道
  const qualOf = (uid) => data.raw.quals.filter((q) => q.user_id === uid);
  const personView = (role) => data.raw.people
    .filter((p) => p.role === role)
    .map((p) => ({
      id: p.id, name: p.name, phone: p.phone,
      certs: qualOf(p.id).map((q) => ({
        cert_type: q.cert_type,
        valid_until: new Date(q.valid_until).toISOString(),
        expired: q.valid_until < start.getTime(),
      })),
      leaves: data.raw.leaves.filter((l) => l.user_id === p.id)
        .map((l) => ({ start: new Date(l.start).toISOString(), end: new Date(l.end).toISOString(), reason: l.reason })),
      task_ids: data.tasks.filter((t) => (role === 'DRIVER' ? t.driver_id : t.escort_id) === p.id).map((t) => t.id),
    }));

  const board = {
    view, date: d,
    window_start: start.toISOString(),
    window_end: end.toISOString(),
    enterprise_id: enterpriseId,
    tasks: data.tasks.map(serializeTask),
    lanes: {
      vehicles: data.raw.vehicles.map((v) => ({
        id: v.id, plate: v.plate, status: v.status,
        license_until: v.license_until ? new Date(v.license_until).toISOString() : null,
        blocks: data.raw.vehicleBlocks.filter((b) => b.vehicle_id === v.id)
          .map((b) => ({ start: new Date(b.start).toISOString(), end: new Date(b.end).toISOString(), reason: b.reason })),
        task_ids: data.tasks.filter((t) => t.vehicle_id === v.id).map((t) => t.id),
      })),
      drivers: personView('DRIVER'),
      escorts: personView('ESCORT'),
    },
    conflicts: conflicts.map((c) => ({ ...c })),
    utilization: {
      metric: UTIL_METRIC,
      window_start: new Date(utilization.window_start).toISOString(),
      window_end: new Date(utilization.window_end).toISOString(),
      view_label: view === 'week' ? '本周' : '今日',
      fleet: {
        ...utilization.fleet,
        scheduled_hours: round1(utilization.fleet.scheduled_ms / HOUR),
        available_hours: round1(utilization.fleet.available_ms / HOUR),
        ratio_text: formatPct(utilization.fleet.ratio),
      },
      items: utilization.items.map((it) => ({
        vehicle_id: it.vehicle_id,
        plate: it.plate,
        status: it.status,
        scheduled_hours: round1(it.scheduled_ms / HOUR),
        unavailable_hours: round1(it.unavailable_ms / HOUR),
        available_hours: round1(it.available_ms / HOUR),
        ratio: it.ratio,
        ratio_text: formatPct(it.ratio),
        overbooked: it.overbooked,
      })),
    },
    counts,
    metric: UTIL_METRIC,
  };
  return board;
}

function serializeTask(t) {
  return {
    id: t.id,
    waybill_no: t.waybill_no,
    status: t.status,
    locked: t.status === 'IN_TRANSIT' || t.status === 'COMPLETED',
    cargo_name: t.cargo_name,
    cargo_class: t.cargo_class,
    origin: t.origin,
    destination: t.destination,
    vehicle_id: t.vehicle_id,
    vehicle_plate: t.vehicle_plate,
    driver_id: t.driver_id,
    driver_name: t.driver_name,
    escort_id: t.escort_id,
    escort_name: t.escort_name,
    planned_departure: t.planned_departure.toISOString(),
    planned_arrival: t.planned_arrival.toISOString(),
    actual_departure: t.actual_departure ? t.actual_departure.toISOString() : null,
    actual_arrival: t.actual_arrival ? t.actual_arrival.toISOString() : null,
  };
}

const round1 = (n) => Math.round(n * 10) / 10;
function formatPct(r) {
  if (!Number.isFinite(r)) return '—';
  // 不做上限截断：>100% 本身就是超排信号（配合 overbooked 标记与红色展示）
  return `${Math.max(0, Math.round(r * 100))}%`;
}

/**
 * 改派预检（不落库）：返回链式顺延预览、残余冲突、是否晚于原计划到达。
 */
export async function previewReassign(enterpriseId, { targetId, newVehicleId, newDriverId, newEscortId, newDeparture }) {
  const horizon = await loadHorizon(pool, enterpriseId);
  return planReassign(horizon.tasks, {
    targetId, newVehicleId, newDriverId, newEscortId,
    newDeparture: new Date(newDeparture),
    resources: horizon.resources,
  });
}

/** 改派用全量视野：窗口前后留足余量，保证链式顺延看到完整队列 */
async function loadHorizon(executor, enterpriseId) {
  const from = new Date(Date.now() - 2 * DAY);
  const to = new Date(Date.now() + 60 * DAY);
  return loadEngineData(executor, enterpriseId, from, to);
}

export async function getHorizonForSave(conn, enterpriseId) {
  return loadHorizon(conn, enterpriseId);
}

/**
 * 作战台用的利用率汇总（当前周窗口）。enterpriseId 为 null 时全省聚合（监管员）。
 * 与看板/导出走同一个 computeUtilization，数值口径完全一致。
 */
export async function loadUtilization(executor, enterpriseIdOrNull) {
  const { start, end } = windowRange('week', cstDateStr());
  const entWhere = enterpriseIdOrNull ? 'WHERE enterprise_id = ?' : '';
  const entParams = enterpriseIdOrNull ? [enterpriseIdOrNull] : [];

  const [vehRows] = await executor.query(
    `SELECT id, enterprise_id, plate, status, transport_license_until
     FROM vehicles WHERE active = 1 ${enterpriseIdOrNull ? 'AND enterprise_id = ?' : ''} ORDER BY enterprise_id, id`,
    entParams,
  );
  const vehicles = vehRows.map((v) => ({
    id: v.id, label: v.plate, plate: v.plate, status: v.status,
    license_until: dateUntilEnd(v.transport_license_until)?.getTime() ?? null,
  }));

  const [blockRows] = await executor.query(
    `SELECT vu.vehicle_id, vu.start_at, vu.end_at
     FROM vehicle_unavailability vu
     WHERE vu.start_at < ? AND vu.end_at > ?`,
    [end, start],
  );
  const blocks = blockRows
    .filter((b) => !enterpriseIdOrNull || vehicles.some((v) => v.id === b.vehicle_id))
    .map((b) => ({ vehicle_id: b.vehicle_id, start: b.start_at.getTime(), end: b.end_at.getTime() }));

  const [taskRows] = await executor.query(
    `SELECT id, vehicle_id, status, planned_departure, planned_arrival, actual_departure, actual_arrival
     FROM waybills
     WHERE status IN ('DISPATCHED','IN_TRANSIT','COMPLETED')
       AND planned_departure < ? AND planned_arrival > ?
       ${enterpriseIdOrNull ? 'AND enterprise_id = ?' : ''}`,
    [end, start, ...entParams],
  );
  const tasks = taskRows
    .filter((t) => !enterpriseIdOrNull || vehicles.some((v) => v.id === t.vehicle_id))
    .map((t) => ({ ...t, label: t.waybill_no }));

  const u = computeUtilization(tasks, vehicles, blocks, start, end);
  return {
    metric: UTIL_METRIC,
    window_start: start.toISOString(),
    window_end: end.toISOString(),
    view_label: '本周',
    fleet: {
      scheduled_hours: round1(u.fleet.scheduled_ms / HOUR),
      available_hours: round1(u.fleet.available_ms / HOUR),
      ratio: u.fleet.ratio,
      ratio_text: formatPct(u.fleet.ratio),
    },
    overbooked_vehicles: u.items.filter((x) => x.overbooked).length,
    total_vehicles: u.items.length,
  };
}

export { TASK_STATUSES };
