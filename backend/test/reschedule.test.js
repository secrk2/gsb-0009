import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulateChain, hasCycle, buildChainDeps, lateArrival, isLocked } from '../src/reschedule.js';

const H = 3600 * 1000;
const t0 = Date.UTC(2026, 8, 17, 0, 0, 0);
const BUFFER = H; // 测试用 60 分钟周转

const task = (id, status, sh, eh, vehicleId = 1, no) => ({
  id, waybill_no: no || `AL${id}`, vehicle_id: vehicleId, status,
  start: t0 + sh * H, end: t0 + eh * H,
});

test('链式三级后推：A 延后 2 小时，B/C 依次顺延且时长不变、间隔恒为 60 分钟', () => {
  const tasks = [
    task(1, 'DISPATCHED', 8, 12),
    task(2, 'DISPATCHED', 13, 17),
    task(3, 'DISPATCHED', 18, 22),
  ];
  const r = simulateChain({ movedId: 1, newStart: t0 + 10 * H, vehicleId: 1, tasks, buffer: BUFFER });
  assert.equal(r.ok, true, r.conflict?.detail);
  const byId = Object.fromEntries([...r.schedule.values()].map((t) => [t.id, t]));
  assert.equal(byId[1].start, t0 + 10 * H);
  assert.equal(byId[1].end, t0 + 14 * H);
  assert.equal(byId[2].start, t0 + 15 * H);
  assert.equal(byId[2].end, t0 + 19 * H);
  assert.equal(byId[3].start, t0 + 20 * H);
  assert.equal(byId[3].end, t0 + 24 * H);
  assert.deepEqual(r.moves.map((m) => m.id).sort(), [1, 2, 3]);
  assert.equal(r.moves.filter((m) => m.shifted).length, 2);
});

test('只后推：把链头拖早，后续单不动', () => {
  const tasks = [task(1, 'DISPATCHED', 8, 12), task(2, 'DISPATCHED', 13, 17)];
  const r = simulateChain({ movedId: 1, newStart: t0 + 7 * H, vehicleId: 1, tasks, buffer: BUFFER });
  assert.equal(r.ok, true);
  const byId = Object.fromEntries([...r.schedule.values()].map((t) => [t.id, t]));
  assert.equal(byId[1].start, t0 + 7 * H);
  assert.equal(byId[1].end, t0 + 11 * H);
  assert.equal(byId[2].start, t0 + 13 * H); // 纹丝不动
});

test('左夹取：落点与前车周转不足时被吸附到前车 end+buffer', () => {
  const tasks = [task(1, 'DISPATCHED', 8, 12), task(2, 'DISPATCHED', 14, 18)];
  const r = simulateChain({ movedId: 2, newStart: t0 + 12.5 * H, vehicleId: 1, tasks, buffer: BUFFER });
  assert.equal(r.ok, true);
  const byId = Object.fromEntries([...r.schedule.values()].map((t) => [t.id, t]));
  assert.equal(byId[2].start, t0 + 13 * H);
  assert.equal(byId[2].end, t0 + 17 * H);
});

test('撞上锚点：顺延侵占运输中单 => ANCHOR_COLLISION，锚点不在 moves 中', () => {
  const tasks = [
    task(1, 'DISPATCHED', 8, 12),
    task(2, 'IN_TRANSIT', 13, 17),
    task(3, 'DISPATCHED', 18, 22),
  ];
  const r = simulateChain({ movedId: 1, newStart: t0 + 12 * H, vehicleId: 1, tasks, buffer: BUFFER });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ANCHOR_COLLISION');
  assert.equal(r.conflict.waybill_id, 2);
  assert.equal(isLocked(tasks[1]), true);
});

test('锚点未被撞：传播在锚点处停止，不穿透改锚点之后的单', () => {
  const tasks = [
    task(1, 'DISPATCHED', 8, 12),
    task(2, 'IN_TRANSIT', 13, 17),
    task(3, 'DISPATCHED', 18, 22),
  ];
  const r = simulateChain({ movedId: 1, newStart: t0 + 7.5 * H, vehicleId: 1, tasks, buffer: BUFFER });
  assert.equal(r.ok, true);
  const byId = Object.fromEntries([...r.schedule.values()].map((t) => [t.id, t]));
  assert.equal(byId[2].start, t0 + 13 * H);
  assert.equal(byId[3].start, t0 + 18 * H);
});

test('晚点判定：严格大于原到达才算晚点；级联单也会被带晚', () => {
  assert.equal(lateArrival(t0 + 12 * H, t0 + 12 * H), false);
  const tasks = [task(1, 'DISPATCHED', 8, 12), task(2, 'DISPATCHED', 13, 17)];
  const r = simulateChain({ movedId: 1, newStart: t0 + 10 * H, vehicleId: 1, tasks, buffer: BUFFER });
  const m1 = r.moves.find((m) => m.id === 1);
  const m2 = r.moves.find((m) => m.id === 2);
  assert.equal(lateArrival(t0 + 12 * H, m1.end), true);
  assert.equal(lateArrival(t0 + 17 * H, m2.end), true); // B 本不晚，被连带拖晚
});

test('跨车改派：从源车移除（源车留空不重排），插入目标车链', () => {
  const tasks = [
    task(1, 'DISPATCHED', 8, 12, 1, '源车单'),
    task(2, 'DISPATCHED', 8, 12, 2, '目标车A'),
  ];
  const r = simulateChain({ movedId: 1, newStart: t0 + 13 * H, vehicleId: 2, tasks, buffer: BUFFER });
  assert.equal(r.ok, true);
  const byId = Object.fromEntries([...r.schedule.values()].map((t) => [t.id, t]));
  assert.equal(byId[1].vehicle_id, 2);
  assert.equal(byId[1].start, t0 + 13 * H);
  assert.equal(byId[2].start, t0 + 8 * H);
});

test('hasCycle：纯链无环；自环/三角环/双向边被识别', () => {
  const chain = [
    { id: 1, vehicle_id: 1, start: 0, end: 1 },
    { id: 2, vehicle_id: 1, start: 2, end: 3 },
    { id: 3, vehicle_id: 1, start: 4, end: 5 },
  ];
  assert.equal(hasCycle(buildChainDeps(chain)), false);
  assert.equal(hasCycle(new Map([[1, [1]]])), true);
  assert.equal(hasCycle(new Map([[1, [2]], [2, [3]], [3, [1]]])), true);
  assert.equal(hasCycle(new Map([[1, [2]], [2, [1]]])), true);
});

test('非法输入：找不到任务/时间非法返回错误码', () => {
  const r1 = simulateChain({ movedId: 99, newStart: t0, vehicleId: 1, tasks: [], buffer: BUFFER });
  assert.equal(r1.ok, false);
  assert.equal(r1.code, 'TASK_NOT_FOUND');
  const r2 = simulateChain({ movedId: 1, newStart: 'bad', vehicleId: 1, tasks: [task(1, 'DISPATCHED', 8, 12)], buffer: BUFFER });
  assert.equal(r2.code, 'BAD_TIME');
});
