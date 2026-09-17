import { Router } from 'express';
import { pool, withTransaction } from '../db.js';
import { authRequired, requireRole } from '../auth.js';
import { checkTransition } from '../stateMachine.js';
import { parseLocalDateTime } from '../validators.js';
import {
  requireIdempotencyKey, replayIfExists, storeIdempotentResult, isDuplicateKeyError,
} from '../idempotency.js';
import { cacheDelPrefix } from '../redis.js';
import { detectConflicts } from '../conflicts.js';
import { simulateChain } from '../reschedule.js';
import {
  computeUtilization, OCCUPIED_STATUSES,
} from '../utilization.js';

const router = Router();
router.use(authRequired);

const DAY_MS = 24 * 3600 * 1000;
const PLAN_PAST_MS = 7 * DAY_MS;
const PLAN_FUTURE_MS = 14 * DAY_MS;
const ACTIVE_STATUSES = ['DISPATCHED', 'IN_TRANSIT', 'COMPLETED'];

// ---------- 通用辅助 ----------

function scopeEnterpriseId(user) {
  return user.role === 'REGULATOR' ? null : user.enterprise_id;
}

function badRequest(message, extra = {}) {
  return { httpStatus: 400, body: { error: { code: 'BAD_REQUEST', message, ...extra } } };
}

function parseWindow(query) {
  const from = parseLocalDateTime(query.from);
  const to = parseLocalDateTime(query.to);
  if (!from || !to) return { error: badRequest('必须提供起止时间 from / to（如 2026-09-14T00:00）') };
  if (to <= from) return { error: badRequest('结束时间必须晚于开始时间') };
  if (to.getTime() - from.getTime() > 31 * DAY_MS) {
    return { error: badRequest('排班窗口最长 31 天，请缩小查询范围') };
  }
  return { from, to };
}

function toIso(d) { return d ? new Date(d).toISOString() : null; }

async function loadGanttData(q, { user, from, to, dimension, enterpriseId }) {
  const params = [];
  const where = ['(w.planned_departure < ? AND w.planned_arrival > ?)'];
  params.push(to, from);
  if (user.role === 'ENTERPRISE_ADMIN') {
    where.push('w.enterprise_id = ?');
    params.push(user.enterprise_id);
  } else if (user.role === 'DRIVER') {
    where.push('(w.driver_id = ? OR w.escort_id = ?)');
    params.push(user.id, user.id);
  } else if (user.role === 'ESCORT') {
    where.push('w.escort_id = ?');
    params.push(user.id);
  } else if (enterpriseId) {
    where.push('w.enterprise_id = ?');
    params.push(enterpriseId);
  }

  const [waybillRows] = await q.query(
    `SELECT w.*, e.name AS enterprise_name,
            d.name AS driver_name, s.name AS escort_name,
            v.plate AS vehicle_plate_resolved
     FROM waybills w
     JOIN enterprises e ON e.id = w.enterprise_id
     JOIN users d ON d.id = w.driver_id
     JOIN users s ON s.id = w.escort_id
     LEFT JOIN vehicles v ON v.id = w.vehicle_id
     WHERE ${where.join(' AND ')}
     ORDER BY w.planned_departure`,
    params,
  );

  // 资源范围（车辆/人员）
  const entIds = [...new Set(waybillRows.map((w) => w.enterprise_id))];
  let resParams = [];
  let vehicleWhere = '1=1';
  if (user.role === 'ENTERPRISE_ADMIN') {
    vehicleWhere = 'enterprise_id = ?';
    resParams = [user.enterprise_id];
  } else if (enterpriseId) {
    vehicleWhere = 'enterprise_id = ?';
    resParams = [enterpriseId];
  } else if (user.role === 'DRIVER' || user.role === 'ESCORT') {
    // 司乘只见自己运单涉及的车辆
    const visibleVids = [...new Set(waybillRows.map((w) => w.vehicle_id).filter(Boolean))];
    vehicleWhere = 'id IN (?)';
    resParams = [visibleVids.length ? visibleVids : [0]];
  } else if (entIds.length) {
    vehicleWhere = 'enterprise_id IN (?)';
    resParams = [entIds];
  } else {
    vehicleWhere = '1=0';
  }
  const [vehicles] = await q.query(
    `SELECT v.*, e.name AS enterprise_name FROM vehicles v
     JOIN enterprises e ON e.id = v.enterprise_id
     WHERE v.active = 1 AND ${vehicleWhere} ORDER BY v.enterprise_id, v.id`,
    resParams,
  );

  // 人员资源（驾驶员/押运员）：监管按企业、企业用户本企业、司乘仅本人（最小可见）
  let crewWhere = "u.role IN ('DRIVER','ESCORT') AND u.active = 1";
  const crewParams = [];
  if (user.role === 'ENTERPRISE_ADMIN') {
    crewWhere += ' AND u.enterprise_id = ?';
    crewParams.push(user.enterprise_id);
  } else if (enterpriseId) {
    crewWhere += ' AND u.enterprise_id = ?';
    crewParams.push(enterpriseId);
  } else if (user.role === 'DRIVER' || user.role === 'ESCORT') {
    crewWhere += ' AND u.id = ?';
    crewParams.push(user.id);
  } else if (entIds.length) {
    crewWhere += ' AND u.enterprise_id IN (?)';
    crewParams.push(entIds);
  }
  const [crew] = await q.query(
    `SELECT u.id, u.name, u.role, u.phone, u.enterprise_id, e.name AS enterprise_name
     FROM users u JOIN enterprises e ON e.id = u.enterprise_id
     WHERE ${crewWhere} ORDER BY u.role, u.id`,
    crewParams,
  );

  const vehicleIds = vehicles.map((v) => v.id);
  const crewIds = crew.map((c) => c.id);
  const vIn = vehicleIds.length ? vehicleIds : [0];
  const cIn = crewIds.length ? crewIds : [0];

  // 可用时段规则
  const [availRows] = await q.query(
    `SELECT resource_type, resource_id, weekday,
            HOUR(start_time)*60+MINUTE(start_time) AS start_min,
            HOUR(end_time)*60+MINUTE(end_time) AS end_min
     FROM resource_availability
     WHERE (resource_type='VEHICLE' AND resource_id IN (?))
        OR (resource_type IN ('DRIVER','ESCORT') AND resource_id IN (?))`,
    [vIn, cIn],
  );
  const rulesByResource = indexRules(availRows);

  // 不可用窗口
  const [unavailRows] = await q.query(
    `SELECT resource_type, resource_id, start_at, end_at, reason
     FROM resource_unavailability
     WHERE start_at < ? AND end_at > ?
       AND ((resource_type='VEHICLE' AND resource_id IN (?))
         OR (resource_type IN ('DRIVER','ESCORT') AND resource_id IN (?)))`,
    [to, from, vIn, cIn],
  );

  // 证照（同企业全部司乘）
  const [licenseRows] = await q.query(
    `SELECT cl.user_id, cl.license_type, cl.license_no, cl.expires_at, u.name AS user_name, u.role
     FROM crew_licenses cl JOIN users u ON u.id = cl.user_id
     WHERE cl.user_id IN (?)`,
    [cIn],
  );

  return {
    waybillRows, vehicles, crew, availRows, rulesByResource, unavailRows, licenseRows,
  };
}

function indexRules(rows) {
  const map = {};
  for (const r of rows) {
    const key = `${r.resource_type}:${r.resource_id}`;
    if (!map[key]) map[key] = [];
    map[key].push({ weekday: r.weekday, start_min: Number(r.start_min), end_min: Number(r.end_min) });
  }
  return map;
}

/** 构造纯函数需要的任务/证照上下文 */
function buildConflictCtx(activeTasks, licenseRows, unavailRows, enterpriseCrew) {
  const licenses = {};
  for (const l of licenseRows) {
    // 驾驶员取从业资格证、押运员取押运证（同 user 只有一类生效）
    if (l.role === 'DRIVER' && l.license_type !== 'QUALIFICATION') continue;
    if (l.role === 'ESCORT' && l.license_type !== 'ESCORT') continue;
    licenses[l.user_id] = { expires_at: l.expires_at, license_no: l.license_no };
  }
  return {
    existing: activeTasks.map((t) => ({
      id: t.id, waybill_no: t.waybill_no, status: t.status,
      locked: ['IN_TRANSIT', 'COMPLETED'].includes(t.status),
      vehicle_id: t.vehicle_id, driver_id: t.driver_id, escort_id: t.escort_id,
      vehicle_name: t.vehicle_plate, driver_name: t.driver_name, escort_name: t.escort_name,
      start: t.planned_departure, end: t.planned_arrival,
    })),
    licenses,
    unavailability: unavailRows.map((u) => ({
      resource_type: u.resource_type, resource_id: u.resource_id,
      start: u.start_at, end: u.end_at, reason: u.reason,
    })),
  };
}

/** 计算窗口内每辆车的利用率（作战台/甘特/CSV 三处同一函数同一数据） */
function buildVehicleUtilization(from, to, waybillRows, rulesIndex, unavailRows, vehicles) {
  const tasks = waybillRows
    .filter((w) => w.vehicle_id && OCCUPIED_STATUSES.includes(w.status))
    .map((w) => ({
      resource_id: w.vehicle_id, status: w.status,
      start: w.planned_departure, end: w.planned_arrival,
    }));
  const rulesByResource = {};
  const unavailByResource = {};
  for (const v of vehicles) {
    rulesByResource[v.id] = rulesIndex[`VEHICLE:${v.id}`] || [];
    unavailByResource[v.id] = (unavailRows
      .filter((u) => u.resource_type === 'VEHICLE' && u.resource_id === v.id)
      .map((u) => ({ start: u.start_at, end: u.end_at })));
  }
  const items = computeUtilization({
    window: { from, to }, tasks, rulesByResource, unavailByResource,
  });
  const vmap = new Map(vehicles.map((v) => [v.id, v]));
  return items.map((it) => {
    const v = vmap.get(it.resource_id);
    return { ...it, resource_type: 'VEHICLE', plate: v?.plate, vehicle_type: v?.vehicle_type,
      enterprise_id: v?.enterprise_id, enterprise_name: v?.enterprise_name };
  });
}

// ---------- GET /gantt 甘特数据 ----------

router.get('/gantt', async (req, res, next) => {
  try {
    const win = parseWindow(req.query);
    if (win.error) return res.status(win.error.httpStatus).json(win.error.body);
    const dimension = ['VEHICLE', 'DRIVER', 'ESCORT'].includes(req.query.dimension)
      ? req.query.dimension : 'VEHICLE';
    const enterpriseId = req.user.role === 'REGULATOR' && req.query.enterprise_id
      ? Number(req.query.enterprise_id) : scopeEnterpriseId(req.user);

    const data = await loadGanttData(pool, {
      user: req.user, from: win.from, to: win.to, dimension, enterpriseId,
    });

    const active = data.waybillRows.filter((w) => ACTIVE_STATUSES.includes(w.status));
    const conflictCtx = buildConflictCtx(active, data.licenseRows, data.unavailRows, data.crew);
    // 读时即算的冲突地图：过期证照/维保窗口/已存在重叠开箱即红
    const conflictMap = {};
    for (const t of conflictCtx.existing) {
      const list = detectConflicts(t, conflictCtx);
      if (list.length) conflictMap[t.id] = list;
    }

    const mapTask = (w) => ({
      waybill_id: w.id, waybill_no: w.waybill_no, status: w.status, cargo_name: w.cargo_name,
      enterprise_id: w.enterprise_id, enterprise_name: w.enterprise_name,
      vehicle_id: w.vehicle_id, vehicle_name: w.vehicle_plate_resolved || w.vehicle_plate,
      driver_id: w.driver_id, driver_name: w.driver_name,
      escort_id: w.escort_id, escort_name: w.escort_name,
      start: toIso(w.planned_departure), end: toIso(w.planned_arrival),
      locked: ['IN_TRANSIT', 'COMPLETED'].includes(w.status),
      aborted: w.status === 'ABORTED',
    });

    const utilization = buildVehicleUtilization(
      win.from, win.to, data.waybillRows, data.rulesByResource, data.unavailRows, data.vehicles,
    );

    res.json({
      window: { from: toIso(win.from), to: toIso(win.to) },
      dimension,
      can_write: ['REGULATOR', 'ENTERPRISE_ADMIN'].includes(req.user.role),
      // 全量车辆（与当前维度无关）：派车/改派弹窗的车辆下拉在任一维度都要有数据
      vehicles: data.vehicles.map((v) => ({
        id: v.id, plate: v.plate, vehicle_type: v.vehicle_type, load_tons: v.load_tons,
        enterprise_id: v.enterprise_id, enterprise_name: v.enterprise_name,
      })),
      resources: buildResources(dimension, data, win, data.rulesByResource),
      tasks: data.waybillRows
        .filter((w) => ACTIVE_STATUSES.includes(w.status) || w.status === 'ABORTED')
        .map(mapTask),
      pool: data.waybillRows.filter((w) => w.status === 'REGULATOR_VERIFY').map(mapTask),
      drivers: data.crew.filter((c) => c.role === 'DRIVER').map((c) => ({
        id: c.id, name: c.name, phone: c.phone, enterprise_id: c.enterprise_id, enterprise_name: c.enterprise_name,
      })),
      escorts: data.crew.filter((c) => c.role === 'ESCORT').map((c) => ({
        id: c.id, name: c.name, phone: c.phone, enterprise_id: c.enterprise_id, enterprise_name: c.enterprise_name,
      })),
      unavailability: data.unavailRows.map((u) => ({
        resource_type: u.resource_type, resource_id: u.resource_id,
        start: toIso(u.start_at), end: toIso(u.end_at), reason: u.reason,
      })),
      licenses: data.licenseRows.map((l) => ({
        user_id: l.user_id, user_name: l.user_name, license_type: l.license_type,
        license_no: l.license_no, expires_at: toIso(l.expires_at),
        expired: new Date(l.expires_at).getTime() < Date.now(),
      })),
      conflict_map: conflictMap,
      utilization,
    });
  } catch (err) {
    next(err);
  }
});

function buildResources(dimension, data, win, rulesByResource) {
  if (dimension === 'VEHICLE') {
    return data.vehicles.map((v) => ({
      type: 'VEHICLE', id: v.id, name: v.plate,
      sub: `${v.vehicle_type}${v.load_tons ? ` · ${v.load_tons}吨` : ''}`,
      enterprise_id: v.enterprise_id, enterprise_name: v.enterprise_name,
    }));
  }
  const want = dimension === 'DRIVER' ? 'DRIVER' : 'ESCORT';
  return data.crew.filter((c) => c.role === want).map((c) => ({
    type: dimension, id: c.id, name: c.name, sub: c.phone || c.enterprise_name,
    enterprise_id: c.enterprise_id, enterprise_name: c.enterprise_name,
  }));
}

// ---------- GET /utilization ----------

router.get('/utilization', requireRole('REGULATOR', 'ENTERPRISE_ADMIN'), async (req, res, next) => {
  try {
    const win = parseWindow(req.query);
    if (win.error) return res.status(win.error.httpStatus).json(win.error.body);
    const enterpriseId = req.user.role === 'REGULATOR' && req.query.enterprise_id
      ? Number(req.query.enterprise_id) : scopeEnterpriseId(req.user);
    const data = await loadGanttData(pool, {
      user: req.user, from: win.from, to: win.to, enterpriseId,
    });
    const items = buildVehicleUtilization(
      win.from, win.to, data.waybillRows, data.rulesByResource, data.unavailRows, data.vehicles,
    );
    res.json({
      window: { from: toIso(win.from), to: toIso(win.to) },
      items,
      caliber: 'time',
      caliber_text: '利用率 = 已排班占用时长 ÷ 可用时长（区间合并去重，扣除维保/请假）',
    });
  } catch (err) {
    next(err);
  }
});

// ---------- 排班试算 / 写入的核心规划（纯读，可在锁外 dry-run） ----------

async function computePlan(q, { user, body, mode }, current = false) {
  // current=true（写事务锁内复验）时全部走当前读 FOR UPDATE：
  // MySQL 可重复读下普通 SELECT 是事务快照读，看不到并发事务刚提交的派车，
  // 必须用当前读，车辆/人员行锁的串行化结果才能反映到冲突检测里。
  const lock = current ? ' FOR UPDATE' : '';
  const waybillId = Number(body.waybill_id);
  if (!Number.isInteger(waybillId) || waybillId <= 0) return badRequest('缺少 waybill_id');

  const [wbRows] = await q.query(`SELECT * FROM waybills WHERE id = ? LIMIT 1${lock}`, [waybillId]);
  const waybill = wbRows[0];
  if (!waybill) return { httpStatus: 404, body: { error: { code: 'NOT_FOUND', message: '运单不存在' } } };

  if (user.role !== 'REGULATOR' && waybill.enterprise_id !== user.enterprise_id) {
    return { httpStatus: 403, body: { error: { code: 'FORBIDDEN_ENTERPRISE', message: '无权操作其他企业的运单（企业数据已隔离）。' } } };
  }

  // 模式 × 状态门槛
  if (mode === 'assign') {
    const chk = checkTransition(waybill, 'schedule_assign', user);
    if (!chk.ok) return { httpStatus: chk.status, body: { error: chk.error } };
  } else if (mode === 'reschedule') {
    if (waybill.status !== 'DISPATCHED') {
      return {
        httpStatus: 409,
        body: { error: { code: 'ILLEGAL_TRANSITION',
          message: '仅「已派车」且未启运的运单可以改期/改派；运输中与已完成的单为时间锚点，不可移动。' } },
      };
    }
    // 改期只允许动时间，不允许借道换车/换人（换资源必须走改派并填原因）
    const changedResource = ['vehicle_id', 'driver_id', 'escort_id']
      .some((k) => body[k] !== undefined && Number(body[k]) !== waybill[k]);
    if (changedResource) {
      return { httpStatus: 400, body: { error: {
        code: 'RESOURCE_CHANGE_NOT_ALLOWED',
        message: '改期操作不能更换车辆/驾驶员/押运员；如需更换请使用「改派」并填写改派原因。' } } };
    }
  } else if (mode === 'reassign') {
    if (waybill.status !== 'DISPATCHED') {
      return {
        httpStatus: 409,
        body: { error: { code: 'ILLEGAL_TRANSITION',
          message: '仅「已派车」且未启运的运单可以改派；运输中与已完成的单为时间锚点，不可移动。' } },
      };
    }
  }

  const start = parseLocalDateTime(body.start);
  if (!start) return badRequest('开始时间 start 缺失或格式不正确');
  let end = parseLocalDateTime(body.end);
  const origDur = new Date(waybill.planned_arrival).getTime() - new Date(waybill.planned_departure).getTime();
  if (!end) end = new Date(start.getTime() + origDur);
  if (end <= start) return badRequest('结束时间必须晚于开始时间');

  // 目标资源（缺省沿用原绑定）
  const vehicleId = Number(body.vehicle_id ?? waybill.vehicle_id);
  const driverId = Number(body.driver_id ?? waybill.driver_id);
  const escortId = Number(body.escort_id ?? waybill.escort_id);
  if (![vehicleId, driverId, escortId].every((n) => Number.isInteger(n) && n > 0)) {
    return badRequest('必须指定车辆、驾驶员、押运员');
  }
  if (driverId === escortId) return badRequest('驾驶员与押运员不得为同一人');

  const reason = body.reason ? String(body.reason).trim() : '';
  if (mode === 'reassign' && !reason) {
    return { httpStatus: 400, body: { error: { code: 'REASON_REQUIRED', message: '改派必须填写原因（车抛锚/人请假等，将写入留痕）。' } } };
  }
  if (reason.length > 500) return badRequest('原因不能超过 500 字');

  // 资源校验：同企业、启用
  const entId = waybill.enterprise_id;
  const [vehRows] = await q.query(`SELECT * FROM vehicles WHERE id = ? AND active = 1 LIMIT 1${lock}`, [vehicleId]);
  const vehicle = vehRows[0];
  if (!vehicle || vehicle.enterprise_id !== entId) {
    return { httpStatus: 422, body: { error: { code: 'BAD_RESOURCE', message: '目标车辆不存在、已停用或不属于本企业' } } };
  }
  const [crewRows] = await q.query(
    `SELECT id, name, role, enterprise_id, active FROM users WHERE id IN (?, ?)${current ? ' FOR UPDATE' : ''}`,
    [driverId, escortId],
  );
  const driver = crewRows.find((u) => u.id === driverId);
  const escort = crewRows.find((u) => u.id === escortId);
  const crewErr = (m) => ({ httpStatus: 422, body: { error: { code: 'BAD_RESOURCE', message: m } } });
  if (!driver || driver.role !== 'DRIVER' || !driver.active || driver.enterprise_id !== entId) {
    return crewErr('目标驾驶员不存在、已停用或不属于本企业');
  }
  if (!escort || escort.role !== 'ESCORT' || !escort.active || escort.enterprise_id !== entId) {
    return crewErr('目标押运员不存在、已停用或不属于本企业');
  }

  // 规划范围：本企业任务，落点前 7 天 ~ 后 14 天（覆盖链式外推）
  const rangeFrom = new Date(start.getTime() - PLAN_PAST_MS);
  const rangeTo = new Date(start.getTime() + PLAN_FUTURE_MS);
  const [tasksRows] = await q.query(
    `SELECT w.*, d.name AS driver_name, s.name AS escort_name
     FROM waybills w
     JOIN users d ON d.id = w.driver_id
     JOIN users s ON s.id = w.escort_id
     WHERE w.enterprise_id = ?
       AND w.status IN ('DISPATCHED','IN_TRANSIT','COMPLETED')
       AND w.planned_departure >= ? AND w.planned_departure <= ?${current ? ' FOR UPDATE' : ''}`,
    [entId, rangeFrom, rangeTo],
  );
  const chainTasks = tasksRows.map((t) => ({
    id: t.id, waybill_no: t.waybill_no, vehicle_id: t.vehicle_id,
    driver_id: t.driver_id, escort_id: t.escort_id, status: t.status,
    start: t.planned_departure, end: t.planned_arrival,
    driver_name: t.driver_name, escort_name: t.escort_name, vehicle_name: t.vehicle_plate,
  }));
  // assign 时目标单尚不在链里，补进去（simulateChain 会把它放到目标车）
  if (mode === 'assign' && !chainTasks.some((t) => t.id === waybillId)) {
    chainTasks.push({
      id: waybill.id, waybill_no: waybill.waybill_no, vehicle_id: vehicleId,
      driver_id: waybill.driver_id, escort_id: waybill.escort_id, status: 'DISPATCHED',
      start: waybill.planned_departure, end: waybill.planned_arrival,
      driver_name: driver.name, escort_name: escort.name, vehicle_name: vehicle.plate,
    });
  }

  // 链式重排
  const sim = simulateChain({
    movedId: waybillId, newStart: start.getTime(), vehicleId, tasks: chainTasks,
  });
  if (!sim.ok) {
    return { httpStatus: 409, body: { error: { code: sim.code, message: sim.conflict?.detail || '链式重排失败',
      details: { conflicts: [sim.conflict] } } } };
  }

  const finalTimes = new Map();
  for (const m of sim.moves) finalTimes.set(m.id, { start: new Date(m.start), end: new Date(m.end) });
  // 主单起讫以链式排布结果为准（落点离前车太近时会被吸附到前车 end+buffer）
  const mainNode = sim.schedule.get(waybillId);
  const mainStart = new Date(mainNode.start);
  const mainEnd = new Date(mainNode.end);
  finalTimes.set(waybillId, { start: mainStart, end: mainEnd });

  // 原始终态表（晚点判定基线 = 库里当前 planned_arrival）
  const origEnd = new Map(tasksRows.map((t) => [t.id, new Date(t.planned_arrival).getTime()]));
  origEnd.set(waybillId, new Date(waybill.planned_arrival).getTime());

  // 冲突：每个被移动的单按最终时间/资源检测
  const [licenseRows] = await q.query(
    `SELECT cl.*, u.role FROM crew_licenses cl JOIN users u ON u.id = cl.user_id
     WHERE u.enterprise_id = ?`,
    [entId],
  );
  const [unavailRows] = await q.query(
    `SELECT resource_type, resource_id, start_at, end_at, reason
     FROM resource_unavailability
     WHERE start_at < ? AND end_at > ?`,
    [rangeTo, rangeFrom],
  );

  // 最终态任务视图（移动过的单覆盖时间；主单覆盖资源，统一先排除再压入避免重复）
  const finalView = chainTasks
    .filter((t) => t.id !== waybillId)
    .map((t) => {
      const ft = finalTimes.get(t.id);
      return {
        ...t,
        start: ft ? ft.start : t.start,
        end: ft ? ft.end : t.end,
        vehicle_id: t.id === waybillId ? vehicleId : t.vehicle_id,
        driver_id: t.id === waybillId ? driverId : t.driver_id,
        escort_id: t.id === waybillId ? escortId : t.escort_id,
        vehicle_name: t.id === waybillId ? vehicle.plate : t.vehicle_name,
        driver_name: t.id === waybillId ? driver.name : t.driver_name,
        escort_name: t.id === waybillId ? escort.name : t.escort_name,
      };
    });
  finalView.push({
    id: waybillId, waybill_no: waybill.waybill_no, vehicle_id: vehicleId,
    driver_id: driverId, escort_id: escortId, status: 'DISPATCHED',
    start: mainStart, end: mainEnd, vehicle_name: vehicle.plate,
    driver_name: driver.name, escort_name: escort.name,
  });

  const ctx = buildConflictCtx(finalView, licenseRows, unavailRows);
  const movedIds = new Set([waybillId, ...sim.moves.filter((m) => m.shifted).map((m) => m.id)]);
  const conflicts = [];
  for (const t of finalView) {
    if (!movedIds.has(t.id)) continue;
    conflicts.push(...detectConflicts(t, ctx));
  }
  dedupeConflicts(conflicts);

  // 晚点：任一被移动单的新到达晚于库里原计划到达
  const noById = new Map(finalView.map((t) => [t.id, t]));
  const lateWaybills = [];
  for (const [id, ft] of finalTimes) {
    const orig = origEnd.get(id);
    if (Number.isFinite(orig) && ft.end.getTime() > orig) {
      lateWaybills.push({
        waybill_id: id, waybill_no: noById.get(id)?.waybill_no,
        planned_arrival: toIso(new Date(orig)), new_arrival: toIso(ft.end),
      });
    }
  }

  const cascade = sim.moves
    .filter((m) => m.shifted)
    .map((m) => ({
      waybill_id: m.id, waybill_no: m.waybill_no,
      start: toIso(new Date(m.start)), end: toIso(new Date(m.end)),
      planned_arrival: toIso(new Date(origEnd.get(m.id))),
      new_arrival: toIso(new Date(m.end)),
    }));

  return {
    httpStatus: 200,
    plan: {
      mode, waybill, vehicle, driver, escort,
      start: mainStart, end: mainEnd, reason,
      finalTimes, cascade, lateWaybills, conflicts,
      rangeFrom, rangeTo, chainTasks,
    },
  };
}

function dedupeConflicts(list) {
  const seen = new Set();
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const c = list[i];
    const key = `${c.type}|${c.waybill_id || ''}|${c.resource_name || ''}|${c.ranges?.map((r) => r.start).join(',')}`;
    if (seen.has(key)) list.splice(i, 1);
    else seen.add(key);
  }
}

function conflictError(conflicts) {
  return {
    error: {
      code: 'SCHEDULE_CONFLICT',
      message: `排班存在 ${conflicts.length} 项冲突，已阻止保存（未写入任何数据），请逐条处理后重试。`,
      details: { conflicts },
    },
  };
}

// ---------- POST /check 试算（不落库） ----------

router.post('/check', requireRole('REGULATOR', 'ENTERPRISE_ADMIN'), async (req, res, next) => {
  try {
    const mode = String(req.body?.mode || 'assign');
    if (!['assign', 'reschedule', 'reassign'].includes(mode)) return res.status(400).json(badRequest('未知 mode').body);
    const result = await computePlan(pool, { user: req.user, body: req.body || {}, mode });
    if (result.httpStatus !== 200) return res.status(result.httpStatus).json(result.body);
    const { conflicts, lateWaybills, cascade } = result.plan;
    res.json({
      advisory: true,
      valid: conflicts.length === 0,
      conflicts,
      late: lateWaybills.length > 0,
      late_waybills: lateWaybills,
      cascade,
    });
  } catch (err) {
    next(err);
  }
});

// ---------- 写操作：assign / reschedule / reassign ----------

for (const [path, mode] of [['/assign', 'assign'], ['/reschedule', 'reschedule'], ['/reassign', 'reassign']]) {
  router.post(path, requireRole('REGULATOR', 'ENTERPRISE_ADMIN'), requireIdempotencyKey,
    (req, res, next) => writeSchedule(req, res, next, mode));
}

async function writeSchedule(req, res, next, mode) {
  try {
    if (await replayIfExists(req, res)) return;

    const outcome = await withTransaction(async (conn) => {
      // 先快照试算（拿涉及资源/单据集合）
      const snapshot = await computePlan(conn, { user: req.user, body: req.body || {}, mode });
      if (snapshot.httpStatus !== 200) return { httpStatus: snapshot.httpStatus, body: snapshot.body };
      const { plan } = snapshot;

      // 统一按 id 排序加锁，防并发同车/同人双派与死锁
      const vehicleIds = [...new Set([plan.vehicle.id, plan.waybill.vehicle_id].filter(Boolean))].sort((a, b) => a - b);
      const userIds = [...new Set([
        plan.driver.id, plan.escort.id, plan.waybill.driver_id, plan.waybill.escort_id,
      ])].sort((a, b) => a - b);
      const [affectedBefore] = await conn.query(
        `SELECT id FROM waybills
         WHERE enterprise_id = ? AND status IN ('DISPATCHED','IN_TRANSIT','COMPLETED')
           AND planned_departure >= ? AND planned_departure <= ?`,
        [plan.waybill.enterprise_id, plan.rangeFrom, plan.rangeTo],
      );
      const waybillIds = [...new Set([
        plan.waybill.id, ...affectedBefore.map((r) => r.id),
        ...plan.cascade.map((c) => c.waybill_id),
      ])].sort((a, b) => a - b);

      await conn.query('SELECT id FROM vehicles WHERE id IN (?) ORDER BY id FOR UPDATE', [vehicleIds]);
      await conn.query('SELECT id FROM users WHERE id IN (?) ORDER BY id FOR UPDATE', [userIds]);
      await conn.query('SELECT id FROM waybills WHERE id IN (?) ORDER BY id FOR UPDATE', [waybillIds]);

      // 锁内用最新数据（当前读）复验
      const locked = await computePlan(conn, { user: req.user, body: req.body || {}, mode }, true);
      if (locked.httpStatus !== 200) return { httpStatus: locked.httpStatus, body: locked.body };
      const p = locked.plan;

      if (p.conflicts.length) return { httpStatus: 409, body: conflictError(p.conflicts) };

      // 晚点必须填原因
      const lateReason = req.body.late_reason ? String(req.body.late_reason).trim() : '';
      if (lateReason.length > 500) {
        return { httpStatus: 400, body: { error: { code: 'BAD_REQUEST', message: '晚点原因不能超过 500 字' } } };
      }
      if (p.lateWaybills.length && !lateReason) {
        return {
          httpStatus: 400,
          body: { error: {
            code: 'LATE_REASON_REQUIRED',
            message: '本次落点（含连带调整）会使预计到达晚于原计划到达，必须填写晚点原因后才能提交。',
            details: { late_waybills: p.lateWaybills },
          } },
        };
      }

      const fromStatus = plan.waybill.status;
      const action = mode === 'assign' ? 'schedule_assign' : mode;

      // 主单更新（双写 vehicle_id + vehicle_plate，车牌以库中车辆为准，不信前端传牌）
      await conn.query(
        `UPDATE waybills
         SET vehicle_id = ?, vehicle_plate = ?, driver_id = ?, escort_id = ?,
             planned_departure = ?, planned_arrival = ?, status = 'DISPATCHED'
         WHERE id = ?`,
        [p.vehicle.id, p.vehicle.plate, p.driver.id, p.escort.id,
          p.start, p.end, p.waybill.id],
      );

      // 级联单逐单后推
      for (const c of p.cascade) {
        await conn.query(
          'UPDATE waybills SET planned_departure = ?, planned_arrival = ? WHERE id = ? AND status = ?',
          [c.start, c.end, c.waybill_id, 'DISPATCHED'],
        );
      }

      // 留痕：主单
      const changes = {
        mode,
        resource: {
          vehicle_id: p.vehicle.id, vehicle_plate: p.vehicle.plate,
          driver_id: p.driver.id, driver_name: p.driver.name,
          escort_id: p.escort.id, escort_name: p.escort.name,
          previous: {
            vehicle_id: plan.waybill.vehicle_id, vehicle_plate: plan.waybill.vehicle_plate,
            driver_id: plan.waybill.driver_id, escort_id: plan.waybill.escort_id,
          },
        },
        late_waybills: p.lateWaybills,
        cascade: p.cascade,
      };
      await appendEvent(conn, {
        waybillId: p.waybill.id, action, fromStatus, toStatus: 'DISPATCHED',
        reason: p.reason || lateReason || null, changes,
        actor: req.user, idemKey: req.idempotencyKey,
      });
      // 级联单各一条改期留痕（不占幂等键）
      for (const c of p.cascade) {
        await appendEvent(conn, {
          waybillId: c.waybill_id, action: 'reschedule', fromStatus: 'DISPATCHED', toStatus: 'DISPATCHED',
          reason: `因运单 ${p.waybill.waybill_no} ${mode === 'assign' ? '派车' : '改派/改期'}连带调整`,
          changes: { cascade_of: p.waybill.id, start: c.start, end: c.end },
          actor: req.user, idemKey: null,
        });
      }

      const [detailRows] = await conn.query(
        `SELECT w.*, e.name AS enterprise_name, d.name AS driver_name, s.name AS escort_name
         FROM waybills w
         JOIN enterprises e ON e.id = w.enterprise_id
         JOIN users d ON d.id = w.driver_id
         JOIN users s ON s.id = w.escort_id
         WHERE w.id = ?`,
        [p.waybill.id],
      );
      const body = {
        waybill: detailRows[0],
        cascaded: p.cascade,
        cascaded_count: p.cascade.length,
        late: p.lateWaybills,
        deduplicated: false,
      };
      await storeIdempotentResult(conn, req, { waybillId: p.waybill.id, status: 200, body });
      return { httpStatus: 200, body };
    });

    if (outcome.httpStatus < 300) await cacheDelPrefix('dash:');
    res.status(outcome.httpStatus).json(outcome.body);
  } catch (err) {
    if (isDuplicateKeyError(err) && await replayIfExists(req, res)) return;
    next(err);
  }
}

async function appendEvent(conn, { waybillId, action, fromStatus, toStatus, reason, changes, actor, idemKey }) {
  const [[{ nextSeq }]] = await conn.query(
    'SELECT COALESCE(MAX(seq), 0) + 1 AS nextSeq FROM waybill_events WHERE waybill_id = ?',
    [waybillId],
  );
  await conn.query(
    `INSERT INTO waybill_events
       (waybill_id, seq, action, from_status, to_status, actor_id, actor_name, reason, changes, idempotency_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?)`,
    [waybillId, nextSeq, action, fromStatus, toStatus, actor.id, actor.name,
      reason || null, JSON.stringify(changes), idemKey],
  );
}

// ---------- POST /unbind 解绑退回待派池 ----------

router.post('/unbind', requireRole('REGULATOR', 'ENTERPRISE_ADMIN'), requireIdempotencyKey, async (req, res, next) => {
  try {
    if (await replayIfExists(req, res)) return;
    const id = Number(req.body?.waybill_id);
    const reason = String(req.body?.reason || '').trim();

    const outcome = await withTransaction(async (conn) => {
      const [rows] = await conn.query('SELECT * FROM waybills WHERE id = ? FOR UPDATE', [id]);
      const waybill = rows[0];
      if (!waybill) return { httpStatus: 404, body: { error: { code: 'NOT_FOUND', message: '运单不存在' } } };

      const chk = checkTransition(waybill, 'unassign', req.user, reason);
      if (!chk.ok) return { httpStatus: chk.status, body: { error: chk.error } };
      if (req.user.role !== 'REGULATOR' && waybill.enterprise_id !== req.user.enterprise_id) {
        return { httpStatus: 403, body: { error: { code: 'FORBIDDEN_ENTERPRISE', message: '无权操作其他企业的运单。' } } };
      }

      await conn.query('UPDATE waybills SET status = ? WHERE id = ?', ['REGULATOR_VERIFY', id]);
      await appendEvent(conn, {
        waybillId: id, action: 'unassign', fromStatus: 'DISPATCHED', toStatus: 'REGULATOR_VERIFY',
        reason, changes: { vehicle_plate: waybill.vehicle_plate, driver_id: waybill.driver_id, escort_id: waybill.escort_id },
        actor: req.user, idemKey: req.idempotencyKey,
      });
      const [detailRows] = await conn.query('SELECT * FROM waybills WHERE id = ?', [id]);
      const body = { waybill: detailRows[0], deduplicated: false };
      await storeIdempotentResult(conn, req, { waybillId: id, status: 200, body });
      return { httpStatus: 200, body };
    });

    if (outcome.httpStatus < 300) await cacheDelPrefix('dash:');
    res.status(outcome.httpStatus).json(outcome.body);
  } catch (err) {
    if (isDuplicateKeyError(err) && await replayIfExists(req, res)) return;
    next(err);
  }
});

// ---------- GET /export.csv 利用率导出（与作战台/甘特同一算法） ----------

router.get('/export.csv', requireRole('REGULATOR', 'ENTERPRISE_ADMIN'), async (req, res, next) => {
  try {
    const win = parseWindow(req.query);
    if (win.error) return res.status(win.error.httpStatus).json(win.error.body);
    const enterpriseId = req.user.role === 'REGULATOR' && req.query.enterprise_id
      ? Number(req.query.enterprise_id) : scopeEnterpriseId(req.user);
    const data = await loadGanttData(pool, {
      user: req.user, from: win.from, to: win.to, enterpriseId,
    });
    const items = buildVehicleUtilization(
      win.from, win.to, data.waybillRows, data.rulesByResource, data.unavailRows, data.vehicles,
    );

    const head = ['企业', '车牌', '车型', '可用时长(小时)', '排班时长(小时)', '利用率', '窗口内单数'];
    const lines = [head];
    for (const it of items) {
      lines.push([
        it.enterprise_name || '',
        it.plate || '',
        it.vehicle_type || '',
        (it.available_min / 60).toFixed(2),
        (it.occupied_min / 60).toFixed(2),
        it.rate === null ? '—' : `${(it.rate * 100).toFixed(1)}%`,
        String(it.waybill_count),
      ]);
    }
    // 口径行：与作战台、排班详情完全一致的文字
    lines.push([]);
    lines.push(['口径说明', '时间口径：利用率 = 已排班占用时长 ÷ 可用时长（区间合并去重，扣除维保/请假）；临时改派频繁月份可能与单数口径方向相反，本系统统一采用时间口径。']);
    const csv = `﻿${lines.map((row) => row.map(csvCell).join(',')).join('\r\n')}`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="schedule_utilization.csv"');
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

/** CSV 单元格：防公式注入（= + - @ 开头加单引号）+ 逗号/引号/换行转义 */
function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export default router;
export { computePlan };
