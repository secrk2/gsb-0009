import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  intervalsOverlap, intersectRange, licenseCoversTask, detectConflicts,
} from '../src/conflicts.js';

const H = 3600 * 1000;
const t0 = Date.UTC(2026, 8, 17, 0, 0, 0); // 固定基准，避免依赖当前时间

const draft = (over = {}) => ({
  id: 100, waybill_no: 'AL100', vehicle_id: 1, driver_id: 10, escort_id: 20,
  vehicle_name: '云A·D1', driver_name: '张司机', escort_name: '周押运',
  start: t0 + 8 * H, end: t0 + 12 * H, ...over,
});

test('区间重叠：部分交/内含/分离/相切（含30分钟周转buffer）', () => {
  assert.equal(intervalsOverlap(t0 + 8 * H, t0 + 12 * H, t0 + 11 * H, t0 + 14 * H), true);
  assert.equal(intervalsOverlap(t0 + 8 * H, t0 + 12 * H, t0 + 9 * H, t0 + 11 * H), true);
  assert.equal(intervalsOverlap(t0 + 8 * H, t0 + 12 * H, t0 + 13 * H, t0 + 15 * H), false); // 隔60分钟
  // 相切但周转不足30分钟 => 仍判冲突
  assert.equal(intervalsOverlap(t0 + 8 * H, t0 + 12 * H, t0 + 12 * H + 10 * 60000, t0 + 14 * H), true);
  // gap=0 时相切不冲突
  assert.equal(intervalsOverlap(t0 + 8 * H, t0 + 12 * H, t0 + 12 * H, t0 + 14 * H, 0), false);
});

test('求交区间', () => {
  assert.deepEqual(intersectRange(t0, t0 + 10 * H, t0 + 2 * H, t0 + 4 * H), [t0 + 2 * H, t0 + 4 * H]);
  assert.equal(intersectRange(t0, t0 + 2 * H, t0 + 3 * H, t0 + 5 * H), null);
});

test('同车重叠 => VEHICLE_OVERLAP，含两单号与资源名', () => {
  const cs = detectConflicts(draft(), {
    existing: [{ id: 5, waybill_no: 'AL005', vehicle_id: 1, driver_id: 99, escort_id: 98,
      start: t0 + 11 * H, end: t0 + 15 * H }],
  });
  const c = cs.find((x) => x.type === 'VEHICLE_OVERLAP');
  assert.ok(c);
  assert.equal(c.waybill_no, 'AL005');
  assert.match(c.detail, /云A·D1/);
  assert.equal(c.ranges.length, 2);
});

test('同驾驶员/同押运员重叠分别报 DRIVER_OVERLAP / ESCORT_OVERLAP', () => {
  const cs = detectConflicts(draft(), {
    existing: [
      { id: 6, waybill_no: 'AL006', vehicle_id: 2, driver_id: 10, escort_id: 77,
        start: t0 + 10 * H, end: t0 + 13 * H },
      { id: 7, waybill_no: 'AL007', vehicle_id: 3, driver_id: 88, escort_id: 20,
        start: t0 + 9 * H, end: t0 + 10 * H - 60000 }, // buffer 不足 => 押运员冲突
    ],
  });
  assert.ok(cs.some((c) => c.type === 'DRIVER_OVERLAP' && c.waybill_no === 'AL006'));
  assert.ok(cs.some((c) => c.type === 'ESCORT_OVERLAP' && c.waybill_no === 'AL007'));
});

test('自身原记录不误报（excludeSelf）', () => {
  const cs = detectConflicts(draft(), {
    existing: [{ id: 100, waybill_no: 'AL100', vehicle_id: 1, driver_id: 10, escort_id: 20,
      start: t0 + 8 * H, end: t0 + 12 * H }],
  });
  assert.equal(cs.length, 0);
});

test('押运证边界：到期时刻等于/晚于/早于任务结束', () => {
  const end = t0 + 12 * H;
  assert.equal(licenseCoversTask(end, 0, end), true);          // 恰好到达到期仍有效
  assert.equal(licenseCoversTask(end + 1000, 0, end), true);  // 晚于
  assert.equal(licenseCoversTask(end - 1, 0, end), false);    // 早 1ms 即过期
});

test('押运证过期 => LICENSE_EXPIRED 且 block 级，含到期时间', () => {
  const cs = detectConflicts(draft(), {
    licenses: { 20: { expires_at: t0 + 11 * H } },
  });
  const c = cs.find((x) => x.type === 'LICENSE_EXPIRED');
  assert.ok(c);
  assert.equal(c.severity, 'block');
  assert.match(c.detail, /周押运/);
  assert.match(c.detail, /过期/);
});

test('证照未过期不报错；无证照记录不臆断', () => {
  assert.equal(detectConflicts(draft(), { licenses: { 20: { expires_at: t0 + 20 * H } } }).length, 0);
  assert.equal(detectConflicts(draft(), { licenses: {} }).length, 0);
});

test('不可用窗口：重叠报 UNAVAILABLE 且带原因；相切不报', () => {
  const csHit = detectConflicts(draft(), {
    unavailability: [{ resource_type: 'VEHICLE', resource_id: 1,
      start: t0 + 10 * H, end: t0 + 11 * H, reason: '二级维护' }],
  });
  const c = csHit.find((x) => x.type === 'VEHICLE_UNAVAILABLE');
  assert.ok(c);
  assert.match(c.detail, /二级维护/);

  const csMiss = detectConflicts(draft(), {
    unavailability: [{ resource_type: 'VEHICLE', resource_id: 1,
      start: t0 + 12 * H, end: t0 + 13 * H, reason: '二级维护' }],
  });
  assert.equal(csMiss.length, 0);
});

test('ABORTED 单（不在 existing 占用集）不产生冲突', () => {
  // existing 只放活跃单；调用方负责过滤，这里模拟已过滤 => 无冲突
  const cs = detectConflicts(draft(), { existing: [] });
  assert.equal(cs.length, 0);
});

test('非法任务区间不产生误报', () => {
  assert.equal(detectConflicts(draft({ start: t0 + 12 * H, end: t0 + 8 * H }), {}).length, 0);
});
