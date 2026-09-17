import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectConflicts, planReassign, computeUtilization, formatRatio,
  occupiedInterval, CHAINABLE_STATUSES,
} from '../src/scheduling.js';

const H = 3600 * 1000;
const day = (n, h = 0) => new Date(2026, 8, 20 + n, h).getTime(); // 2026-09-20 本地墙钟
const mkTask = (o) => ({
  status: 'DISPATCHED',
  planned_departure: day(0, 8),
  planned_arrival: day(0, 12),
  driver_id: 10,
  escort_id: 20,
  vehicle_id: 1,
  label: `W${o.id}`,
  ...o,
});
const mkResources = (o = {}) => ({
  vehicles: o.vehicles || [
    { id: 1, label: '云A·1001', status: 'AVAILABLE' },
    { id: 2, label: '云A·1002', status: 'AVAILABLE' },
  ],
  people: o.people || [
    { id: 10, label: '张司机', role: 'DRIVER' },
    { id: 11, label: '李司机', role: 'DRIVER' },
    { id: 20, label: '周押运', role: 'ESCORT' },
    { id: 21, label: '吴押运', role: 'ESCORT' },
  ],
  quals: o.quals || [
    { user_id: 10, cert_type: 'DRIVING_LICENSE', valid_until: day(30) },
    { user_id: 10, cert_type: 'QUALIFICATION_CARD', valid_until: day(30) },
    { user_id: 11, cert_type: 'DRIVING_LICENSE', valid_until: day(30) },
    { user_id: 11, cert_type: 'QUALIFICATION_CARD', valid_until: day(30) },
    { user_id: 20, cert_type: 'QUALIFICATION_CARD', valid_until: day(30) },
    { user_id: 21, cert_type: 'QUALIFICATION_CARD', valid_until: day(30) },
  ],
  vehicleBlocks: o.vehicleBlocks || [],
  leaves: o.leaves || [],
});

test('无冲突：证照齐全、资源不重叠时检测为空', () => {
  const tasks = [
    mkTask({ id: 1, vehicle_id: 1, driver_id: 10, escort_id: 20, planned_departure: day(0, 8), planned_arrival: day(0, 12) }),
    mkTask({ id: 2, vehicle_id: 1, driver_id: 11, escort_id: 21, planned_departure: day(0, 13), planned_arrival: day(0, 17) }),
  ];
  assert.deepEqual(detectConflicts(tasks, mkResources()), []);
});

test('同一辆车同段被两单占 → VEHICLE_DOUBLE_BOOKED，两单各挂一条', () => {
  const tasks = [
    mkTask({ id: 1, vehicle_id: 1, driver_id: 10, escort_id: 20, planned_departure: day(0, 8), planned_arrival: day(0, 12) }),
    mkTask({ id: 2, vehicle_id: 1, driver_id: 11, escort_id: 21, planned_departure: day(0, 11), planned_arrival: day(0, 15) }),
  ];
  const cs = detectConflicts(tasks, mkResources());
  const v = cs.filter((c) => c.code === 'VEHICLE_DOUBLE_BOOKED');
  assert.equal(v.length, 2);
  assert.deepEqual(v.map((c) => c.waybill_id).sort(), [1, 2]);
  assert.equal(v[0].conflicting_waybill_id, 2);
  assert.match(v[0].message, /云A·1001/);
});

test('同一驾驶员同时落两单 → DRIVER_DOUBLE_BOOKED', () => {
  const tasks = [
    mkTask({ id: 1, vehicle_id: 1, driver_id: 10, escort_id: 20 }),
    mkTask({ id: 2, vehicle_id: 2, driver_id: 10, escort_id: 21, planned_departure: day(0, 10), planned_arrival: day(0, 14) }),
  ];
  const codes = detectConflicts(tasks, mkResources()).map((c) => c.code);
  assert.ok(codes.includes('DRIVER_DOUBLE_BOOKED'));
});

test('押运员证照过期 → ESCORT_CERT_EXPIRED，中文原因点名证照', () => {
  const res = mkResources({
    quals: [
      { user_id: 10, cert_type: 'DRIVING_LICENSE', valid_until: day(30) },
      { user_id: 10, cert_type: 'QUALIFICATION_CARD', valid_until: day(30) },
      { user_id: 20, cert_type: 'QUALIFICATION_CARD', valid_until: day(-1) }, // 昨日过期
    ],
  });
  const cs = detectConflicts([mkTask({ id: 1 })], res);
  const c = cs.find((x) => x.code === 'ESCORT_CERT_EXPIRED');
  assert.ok(c);
  assert.match(c.message, /押运从业资格证/);
  assert.equal(c.waybill_id, 1);
});

test('车辆维修登记时段 / 人员请假时段冲突', () => {
  const res = mkResources({
    vehicleBlocks: [{ vehicle_id: 1, start: day(0, 9), end: day(0, 11), reason: '抛锚抢修' }],
    leaves: [{ user_id: 20, start: day(0, 10), end: day(0, 12), reason: '家中急事' }],
  });
  const codes = detectConflicts([mkTask({ id: 1 })], res).map((c) => c.code);
  assert.ok(codes.includes('VEHICLE_UNAVAILABLE'));
  assert.ok(codes.includes('ESCORT_ON_LEAVE'));
});

test('车辆维修状态 + 道路运输证过期', () => {
  const res = mkResources({
    vehicles: [{ id: 1, label: '云A·1001', status: 'MAINTENANCE', license_until: day(0) - 1 }],
  });
  const codes = detectConflicts([mkTask({ id: 1 })], res).map((c) => c.code);
  assert.ok(codes.includes('VEHICLE_MAINTENANCE'));
  assert.ok(codes.includes('VEHICLE_LICENSE_EXPIRED'));
});

test('运输中/已完成的单锁定：改派直接拒绝', () => {
  const tasks = [mkTask({ id: 1, status: 'IN_TRANSIT' })];
  const r = planReassign(tasks, {
    targetId: 1, newVehicleId: 2, newDeparture: day(1, 8), resources: mkResources(),
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'ORDER_LOCKED');

  const r2 = planReassign([mkTask({ id: 1, status: 'COMPLETED' })], {
    targetId: 1, newVehicleId: 2, newDeparture: day(1, 8), resources: mkResources(),
  });
  assert.equal(r2.error.code, 'ORDER_LOCKED');
});

test('改派到空车成功，后续同车单按周转间隔链式顺延（只后移）', () => {
  const tasks = [
    mkTask({ id: 1, vehicle_id: 1, driver_id: 10, escort_id: 20, planned_departure: day(0, 8), planned_arrival: day(0, 12) }),
    mkTask({ id: 2, vehicle_id: 1, driver_id: 11, escort_id: 21, planned_departure: day(0, 12), planned_arrival: day(0, 16) }),
    mkTask({ id: 3, vehicle_id: 1, driver_id: 10, escort_id: 20, planned_departure: day(0, 18), planned_arrival: day(0, 22) }),
  ];
  // 车1抛锚 → W1 改派到车2（车2 8-12 空闲），车1 后续 W2/W3 不应被前移；目标单时刻不动
  const r = planReassign(tasks, {
    targetId: 1, newVehicleId: 2, newDeparture: day(0, 9), resources: mkResources(), reason: '云A·1001 抛锚',
  });
  assert.ok(r.ok, r.error?.message);
  const w1 = r.finalTasks.find((t) => t.id === 1);
  assert.equal(w1.vehicle_id, 2);
  assert.equal(w1.planned_departure, day(0, 9));
  assert.equal(w1.planned_arrival, day(0, 13));
  // W2/W3 留在原车且只顺延不前移
  const w2 = r.finalTasks.find((t) => t.id === 2);
  const w3 = r.finalTasks.find((t) => t.id === 3);
  assert.ok(w2.planned_departure >= day(0, 12));
  assert.ok(w3.planned_departure >= day(0, 18));
});

test('新车同段已有后单：目标单插入后，后单链式后移且消除双占', () => {
  const tasks = [
    mkTask({ id: 1, vehicle_id: 1, driver_id: 10, escort_id: 20, planned_departure: day(0, 8), planned_arrival: day(0, 12) }),
    mkTask({ id: 2, vehicle_id: 2, driver_id: 11, escort_id: 21, planned_departure: day(0, 10), planned_arrival: day(0, 14) }),
  ];
  const r = planReassign(tasks, {
    targetId: 1, newVehicleId: 2, newDeparture: day(0, 9), resources: mkResources(),
  });
  assert.ok(r.ok);
  const w1 = r.finalTasks.find((t) => t.id === 1);
  const w2 = r.finalTasks.find((t) => t.id === 2);
  assert.equal(w1.vehicle_id, 2);
  // W2 必须让到 W1 结束 + 30 分钟周转之后
  assert.ok(w2.planned_departure >= w1.planned_arrival + 30 * 60 * 1000,
    `${w2.planned_departure} >= ${w1.planned_arrival + 30 * 60 * 1000}`);
  // 复检无车辆双占
  assert.ok(!r.conflicts.some((c) => c.code === 'VEHICLE_DOUBLE_BOOKED'));
});

test('锁定单是不可移动锚点：目标落点压上运输中单时直接拒绝，绝不挪锁单', () => {
  const tasks = [
    mkTask({ id: 1, vehicle_id: 1, driver_id: 10, escort_id: 20, planned_departure: day(0, 8), planned_arrival: day(0, 12) }),
    mkTask({
      id: 2, vehicle_id: 1, driver_id: 11, escort_id: 21,
      status: 'IN_TRANSIT',
      planned_departure: day(0, 13), planned_arrival: day(0, 17),
      actual_departure: day(0, 13), actual_arrival: null,
    }),
  ];
  // 想把 W1 改到 10 点（10-14 与锁单 13-17 重叠）→ 拒绝
  const r = planReassign(tasks, {
    targetId: 1, newVehicleId: 1, newDeparture: day(0, 10), resources: mkResources(),
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'TARGET_CONFLICTS_LOCKED');

  // 改到锁单结束后的落点（17:30 发车）则允许
  const r2 = planReassign(tasks, {
    targetId: 1, newVehicleId: 1, newDeparture: day(0, 17) + 30 * 60 * 1000, resources: mkResources(),
  });
  assert.ok(r2.ok, r2.error?.message);
  const w1 = r2.finalTasks.find((t) => t.id === 1);
  assert.equal(w1.planned_departure, day(0, 17) + 30 * 60 * 1000);
});

test('驾驶员同人为跨车依赖时也能传播顺延且无环形依赖（终止性）', () => {
  const tasks = [
    mkTask({ id: 1, vehicle_id: 1, driver_id: 10, escort_id: 20, planned_departure: day(0, 6), planned_arrival: day(0, 10) }),
    mkTask({ id: 2, vehicle_id: 2, driver_id: 11, escort_id: 21, planned_departure: day(0, 8), planned_arrival: day(0, 12) }),
    mkTask({ id: 3, vehicle_id: 2, driver_id: 10, escort_id: 21, planned_departure: day(0, 12, ), planned_arrival: day(0, 16) }),
  ];
  // W1 换到车2 的 7 点（4h 到 11 点）；W2(车2,8-12) 顺延到 11:30；W3 用同驾驶员 10，也必须继续让
  const r = planReassign(tasks, {
    targetId: 1, newVehicleId: 2, newDriverId: 10, newDeparture: day(0, 7), resources: mkResources(),
  });
  assert.ok(r.ok, r.error?.message);
  const byId = Object.fromEntries(r.finalTasks.map((t) => [t.id, t]));
  assert.ok(byId[2].planned_departure >= byId[1].planned_arrival + 30 * 60 * 1000);
  assert.ok(byId[3].planned_departure >= byId[2].planned_arrival + 30 * 60 * 1000
    || byId[3].planned_departure >= byId[1].planned_arrival + 30 * 60 * 1000);
  assert.ok(!r.conflicts.some((c) => c.code.endsWith('_DOUBLE_BOOKED')));
});

test('驾驶员与押运员同一人 → 拒绝', () => {
  const r = planReassign([mkTask({ id: 1 })], {
    targetId: 1, newVehicleId: 2, newDriverId: 21, newEscortId: 21, newDeparture: day(1, 8), resources: mkResources(),
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'SAME_PERSON');
});

test('利用率（时间口径）：并集去重、不可用时段扣减分母', () => {
  const vehicles = [{ id: 1, label: '云A·1001', status: 'AVAILABLE' }];
  const tasks = [
    mkTask({ id: 1, vehicle_id: 1, planned_departure: day(0, 8), planned_arrival: day(0, 12) }), // 4h
    mkTask({ id: 2, vehicle_id: 1, planned_departure: day(0, 11), planned_arrival: day(0, 13) }), // 与上重叠1h
  ];
  const blocks = [{ vehicle_id: 1, start: day(0, 18), end: day(0, 22), reason: '保养' }]; // 4h
  const u = computeUtilization(tasks, vehicles, blocks, day(0, 0), day(1, 0));
  // 并集 8-13 = 5h；可用 24-4 = 20h → 25%
  assert.equal(u.items[0].scheduled_ms, 5 * H);
  assert.equal(u.items[0].available_ms, 20 * H);
  assert.equal(Math.round(u.items[0].ratio * 100), 25);
  assert.equal(u.fleet.ratio, u.items[0].ratio);
});

test('利用率：维修中车辆分母为 0 不产生 Infinity', () => {
  const vehicles = [{ id: 1, label: '云A·1001', status: 'MAINTENANCE' }];
  const u = computeUtilization([], vehicles, [], day(0, 0), day(1, 0));
  assert.equal(u.items[0].available_ms, 0);
  assert.ok(Number.isFinite(u.items[0].ratio));
  assert.equal(formatRatio(NaN), '—');
  assert.equal(formatRatio(0.254), '25%');
});

test('运输中按实际发车起算占用区间', () => {
  const t = mkTask({
    id: 1, status: 'IN_TRANSIT',
    planned_departure: day(0, 8), planned_arrival: day(0, 18),
    actual_departure: day(0, 9),
  });
  const [s] = occupiedInterval(t);
  assert.equal(s, day(0, 9));
});

test('CHAINABLE_STATUSES 只含已派车：异常中止/填报等单不可改派', () => {
  for (const st of ['DRAFT', 'ENTERPRISE_REVIEW', 'REGULATOR_VERIFY', 'ABORTED']) {
    const r = planReassign([mkTask({ id: 1, status: st })], {
      targetId: 1, newVehicleId: 2, newDeparture: day(1, 8), resources: mkResources(),
    });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'ORDER_LOCKED');
  }
  assert.ok(CHAINABLE_STATUSES.includes('DISPATCHED'));
});
