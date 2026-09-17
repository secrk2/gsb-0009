import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clipRange, mergeRanges, subtractRanges, sumMinutes, expandAvailability, computeUtilization,
} from '../src/utilization.js';

const H = 3600 * 1000;
// 用本地时间构造，避免测试机时区影响（生产容器统一 TZ=Asia/Shanghai）
const day0 = new Date(2026, 8, 17, 0, 0, 0).getTime(); // 周四 00:00
const WD_ALL = [0, 1, 2, 3, 4, 5, 6];
const ruleAllDay = WD_ALL.map((weekday) => ({ weekday, start_min: 0, end_min: 1440 }));
const ruleWork = WD_ALL.map((weekday) => ({ weekday, start_min: 8 * 60, end_min: 18 * 60 }));

test('clipRange：伸出窗口两端只计窗内；不相交为 null', () => {
  assert.deepEqual(clipRange(day0, day0 + 10 * H, day0 - 2 * H, day0 + 3 * H), [day0, day0 + 3 * H]);
  assert.deepEqual(clipRange(day0, day0 + 2 * H, day0 + 3 * H, day0 + 5 * H), null);
});

test('mergeRanges：重叠/相接合并，分钟不双算', () => {
  const m = mergeRanges([[day0 + 8 * H, day0 + 12 * H], [day0 + 10 * H, day0 + 14 * H], [day0 + 14 * H, day0 + 15 * H]]);
  assert.deepEqual(m, [[day0 + 8 * H, day0 + 15 * H]]);
  assert.equal(sumMinutes(m), 7 * 60);
});

test('subtractRanges：中间挖孔劈两段；整段覆盖为空；相切不切', () => {
  const base = [[day0 + 8 * H, day0 + 18 * H]];
  assert.deepEqual(subtractRanges(base, [[day0 + 10 * H, day0 + 12 * H]]),
    [[day0 + 8 * H, day0 + 10 * H], [day0 + 12 * H, day0 + 18 * H]]);
  assert.deepEqual(subtractRanges(base, [[day0 + 7 * H, day0 + 19 * H]]), []);
  assert.deepEqual(subtractRanges(base, [[day0 + 18 * H, day0 + 20 * H]]),
    [[day0 + 8 * H, day0 + 18 * H]]);
});

test('expandAvailability：全天规则窗口 2 天 => 2880 分钟；8-18 规则 => 1200 分钟/天', () => {
  const win = { from: day0, to: day0 + 2 * 24 * H };
  assert.equal(sumMinutes(expandAvailability(win.from, win.to, ruleAllDay)), 2 * 1440);
  assert.equal(Math.round(sumMinutes(expandAvailability(win.from, win.to, ruleWork))), 2 * 600);
});

test('expandAvailability：窗口半天裁剪', () => {
  const mins = sumMinutes(expandAvailability(day0 + 8 * H, day0 + 20 * H, ruleAllDay));
  assert.equal(mins, 12 * 60);
});

test('单车单单完全落窗：率 = 占用/可用', () => {
  const win = { from: day0, to: day0 + 24 * H };
  const items = computeUtilization({
    window: win,
    tasks: [{ resource_id: 1, status: 'DISPATCHED', start: day0 + 9 * H, end: day0 + 13 * H }],
    rulesByResource: { 1: ruleAllDay },
  });
  assert.equal(items[0].occupied_min, 240);
  assert.equal(items[0].available_min, 1440);
  assert.ok(Math.abs(items[0].rate - 240 / 1440) < 1e-9);
  assert.equal(items[0].waybill_count, 1);
});

test('同车两单重叠：分子为并集，不双算', () => {
  const win = { from: day0, to: day0 + 24 * H };
  const items = computeUtilization({
    window: win,
    tasks: [
      { resource_id: 1, status: 'DISPATCHED', start: day0 + 8 * H, end: day0 + 12 * H },
      { resource_id: 1, status: 'IN_TRANSIT', start: day0 + 10 * H, end: day0 + 14 * H },
    ],
    rulesByResource: { 1: ruleAllDay },
  });
  assert.equal(items[0].occupied_min, 6 * 60);
  assert.equal(items[0].waybill_count, 2);
});

test('不可用窗口扣减分母；ABORTED/待派不计分子', () => {
  const win = { from: day0, to: day0 + 24 * H };
  const items = computeUtilization({
    window: win,
    tasks: [
      { resource_id: 1, status: 'DISPATCHED', start: day0 + 9 * H, end: day0 + 10 * H },
      { resource_id: 1, status: 'ABORTED', start: day0 + 11 * H, end: day0 + 12 * H },
      { resource_id: 1, status: 'REGULATOR_VERIFY', start: day0 + 13 * H, end: day0 + 14 * H },
    ],
    rulesByResource: { 1: ruleWork },
    unavailByResource: { 1: [{ start: day0 + 12 * H, end: day0 + 16 * H }] },
  });
  assert.equal(items[0].occupied_min, 60);
  assert.equal(items[0].available_min, 600 - 240); // 8-18 共600，扣维保 4 小时
  assert.equal(items[0].waybill_count, 1);
});

test('分母为 0（无规则）=> rate=null 不抛错；超排 rate>1 不截断', () => {
  const win = { from: day0, to: day0 + 24 * H };
  const none = computeUtilization({
    window: win,
    tasks: [{ resource_id: 1, status: 'DISPATCHED', start: day0, end: day0 + H }],
    rulesByResource: {},
  });
  assert.equal(none[0].rate, null);

  const over = computeUtilization({
    window: win,
    tasks: [{ resource_id: 2, status: 'COMPLETED', start: day0 + 7 * H, end: day0 + 19 * H }],
    rulesByResource: { 2: ruleWork }, // 可用 600 分钟，占用 720
  });
  assert.equal(over[0].occupied_min, 720);
  assert.ok(over[0].rate > 1);
});
