import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePlan } from '../src/routes/schedule.routes.js';

// 不依赖真实 MySQL：用内存 fake conn 验证 computePlan 编排（链式/锚点/证照/晚点）
const H = 3600 * 1000;
const D0 = Date.UTC(2026, 8, 17, 0, 0); // 北京 08:00
const bj = (day, hh, mm = 0) => D0 + day * 24 * H + (hh - 8) * H + mm * 60000;
const input = (day, hh, mm = 0) => {
  // 输出东八区墙钟字符串（后端 parseLocalDateTime 按 +08:00 解释）
  const d = new Date(bj(day, hh, mm) + 8 * H);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
};

const admin = { id: 1, role: 'ENTERPRISE_ADMIN', enterprise_id: 1 };

function makeConn({ waybill, tasks, licenseExpiry }) {
  return {
    async query(sql) {
      if (sql.includes('FROM waybills WHERE id')) return [waybill ? [waybill] : []];
      if (sql.includes('FROM vehicles WHERE id')) {
        return [[{ id: waybill.vehicle_id, plate: '云A·D3106', enterprise_id: 1 }]];
      }
      if (sql.includes('FROM users WHERE id IN')) {
        return [[
          { id: 10, name: '张司机', role: 'DRIVER', enterprise_id: 1, active: 1 },
          { id: 11, name: '李司机', role: 'DRIVER', enterprise_id: 1, active: 1 },
          { id: 12, name: '王司机', role: 'DRIVER', enterprise_id: 1, active: 1 },
          { id: 20, name: '周押运', role: 'ESCORT', enterprise_id: 1, active: 1 },
          { id: 21, name: '吴押运', role: 'ESCORT', enterprise_id: 1, active: 1 },
          { id: 22, name: '何押运', role: 'ESCORT', enterprise_id: 1, active: 1 },
        ]];
      }
      if (sql.includes("w.status IN ('DISPATCHED'")) return [tasks];
      if (sql.includes('FROM crew_licenses')) {
        return [[{ user_id: 20, role: 'ESCORT', license_type: 'ESCORT', expires_at: new Date(licenseExpiry) }]];
      }
      if (sql.includes('FROM resource_unavailability')) return [[]];
      throw new Error(`未预期的查询: ${sql.slice(0, 80)}`);
    },
  };
}

const wb = (id, extra = {}) => ({
  id, waybill_no: `AL${id}`, enterprise_id: 1, status: 'DISPATCHED',
  vehicle_id: 1, vehicle_plate: '云A·D3106', driver_id: 10, escort_id: 20,
  planned_departure: new Date(bj(0, 8)), planned_arrival: new Date(bj(0, 11)),
  ...extra,
});

test('改期：主单延后 2 小时，后两单各 30 分钟周转链式顺延，且三张单全部晚点', async () => {
  const tasks = [
    wb(1, { driver_id: 10, escort_id: 20, planned_departure: new Date(bj(0, 8)), planned_arrival: new Date(bj(0, 11)) }),
    wb(2, { driver_id: 11, escort_id: 21, planned_departure: new Date(bj(0, 11, 30)), planned_arrival: new Date(bj(0, 14, 30)) }),
    wb(3, { driver_id: 12, escort_id: 22, planned_departure: new Date(bj(0, 15)), planned_arrival: new Date(bj(0, 18)) }),
  ];
  const conn = makeConn({ waybill: tasks[0], tasks, licenseExpiry: bj(300, 12) });
  const r = await computePlan(conn, {
    user: admin,
    body: { waybill_id: 1, start: input(0, 10) }, // 只改时间，时长沿用 3h
    mode: 'reschedule',
  });
  assert.equal(r.httpStatus, 200, JSON.stringify(r.body));
  const p = r.plan;
  assert.equal(p.start.getTime(), bj(0, 10));
  assert.equal(p.end.getTime(), bj(0, 13));
  assert.equal(p.cascade.length, 2);
  const c2 = p.cascade.find((c) => c.waybill_id === 2);
  const c3 = p.cascade.find((c) => c.waybill_id === 3);
  assert.equal(new Date(c2.start).getTime(), bj(0, 13, 30));
  assert.equal(new Date(c2.end).getTime(), bj(0, 16, 30));
  assert.equal(new Date(c3.start).getTime(), bj(0, 17));
  assert.equal(new Date(c3.end).getTime(), bj(0, 20));
  assert.deepEqual(p.lateWaybills.map((w) => w.waybill_id).sort(), [1, 2, 3]);
  assert.equal(p.conflicts.length, 0);
});

test('改期撞上运输中锚点 => 409 ANCHOR_COLLISION，锚点不动', async () => {
  const tasks = [
    wb(1, { driver_id: 10, escort_id: 20, planned_departure: new Date(bj(0, 8)), planned_arrival: new Date(bj(0, 11)) }),
    wb(2, { status: 'IN_TRANSIT', driver_id: 11, escort_id: 21,
      planned_departure: new Date(bj(0, 11, 30)), planned_arrival: new Date(bj(0, 14, 30)) }),
  ];
  const conn = makeConn({ waybill: tasks[0], tasks, licenseExpiry: bj(300, 12) });
  const r = await computePlan(conn, {
    user: admin, body: { waybill_id: 1, start: input(0, 10) }, mode: 'reschedule',
  });
  assert.equal(r.httpStatus, 409);
  assert.equal(r.body.error.code, 'ANCHOR_COLLISION');
});

test('押运证过期 => 冲突含 LICENSE_EXPIRED（阻断保存）', async () => {
  const tasks = [wb(1)];
  const conn = makeConn({ waybill: tasks[0], tasks, licenseExpiry: bj(-1, 23, 59) });
  const r = await computePlan(conn, {
    user: admin, body: { waybill_id: 1, start: input(0, 10) }, mode: 'reschedule',
  });
  assert.equal(r.httpStatus, 200);
  assert.ok(r.plan.conflicts.some((c) => c.type === 'LICENSE_EXPIRED'));
});

test('运输中单不能改期/改派（锚点保护）', async () => {
  const transit = wb(1, { status: 'IN_TRANSIT' });
  const conn = makeConn({ waybill: transit, tasks: [transit], licenseExpiry: bj(300, 12) });
  const r = await computePlan(conn, {
    user: admin, body: { waybill_id: 1, start: input(0, 10) }, mode: 'reschedule',
  });
  assert.equal(r.httpStatus, 409);
  assert.equal(r.body.error.code, 'ILLEGAL_TRANSITION');
});

test('改期请求夹带车辆变更被拒绝（必须走改派并填原因）', async () => {
  const tasks = [wb(1)];
  const conn = makeConn({ waybill: tasks[0], tasks, licenseExpiry: bj(300, 12) });
  const r = await computePlan(conn, {
    user: admin, body: { waybill_id: 1, start: input(0, 10), vehicle_id: 2 }, mode: 'reschedule',
  });
  assert.equal(r.httpStatus, 400);
  assert.equal(r.body.error.code, 'RESOURCE_CHANGE_NOT_ALLOWED');
});

test('改派缺少原因 => 400 REASON_REQUIRED', async () => {
  const tasks = [wb(1)];
  const conn = makeConn({ waybill: tasks[0], tasks, licenseExpiry: bj(300, 12) });
  const r = await computePlan(conn, {
    user: admin, body: { waybill_id: 1, start: input(1, 8), vehicle_id: 1, driver_id: 10, escort_id: 20 },
    mode: 'reassign',
  });
  assert.equal(r.httpStatus, 400);
  assert.equal(r.body.error.code, 'REASON_REQUIRED');
});
