// 改派后的链式重排 —— 纯函数模块，不依赖数据库，便于单测。
//
// 模型：同一车辆上的运单按计划出发时间排成一条链；相邻两单之间必须留有周转 buffer。
// 改派（车抛锚换车 / 人请假换人）或拖动后，从落点开始向后逐单顺延，每单保持原时长。
// 运输中 / 已完成的单是「锚点」，时间锁定不可移动；顺延一旦撞上锚点即判 ANCHOR_COLLISION。
// 已异常中止（ABORTED）的单不占链，直接排除。

import { TURNAROUND_BUFFER_MS } from './conflicts.js';

const LOCKED_STATUS = ['IN_TRANSIT', 'COMPLETED'];
const ACTIVE_STATUS = ['DISPATCHED', 'IN_TRANSIT', 'COMPLETED'];

export const isLocked = (task) => LOCKED_STATUS.includes(task.status);
export const isChainTask = (task) => ACTIVE_STATUS.includes(task.status);

/**
 * 以某辆车为目标车辆，模拟把 movedId 放到 newStart 后的全链排布。
 *
 * @param tasks  该车相关运单（改派场景：应包含源车与目标车两车任务，并用 vehicle_id 标明新车）
 *               每条 { id, waybill_no, vehicle_id, status, start, end }
 * @returns 成功 { ok:true, moves:[{id, start, end, shifted}], schedule:Map }
 *          撞锚点 { ok:false, code:'ANCHOR_COLLISION', conflict:{...} }
 *
 * 只后推不前拉：除被拖动单外，任何单的新开始时间都不会早于原开始时间。
 */
export function simulateChain({ movedId, newStart, vehicleId, tasks, buffer = TURNAROUND_BUFFER_MS }) {
  const t0 = +newStart;
  const duration = new Map(tasks.map((t) => [t.id, +t.end - +t.start]));
  const moved = tasks.find((t) => t.id === movedId);
  if (!moved) return { ok: false, code: 'TASK_NOT_FOUND', conflict: null };
  if (!Number.isFinite(t0)) return { ok: false, code: 'BAD_TIME', conflict: null };

  let chain = tasks
    .filter((t) => t.vehicle_id === vehicleId && isChainTask(t))
    .map((t) => ({
      id: t.id, waybill_no: t.waybill_no, vehicle_id: vehicleId,
      status: t.status, start: +t.start, end: +t.end,
    }));

  // 被拖动单先落到新时间（保留原时长）
  const movedDur = duration.get(movedId);
  const placed = new Map(chain.map((t) => [t.id, { ...t }]));
  placed.set(movedId, {
    id: movedId, waybill_no: moved.waybill_no, vehicle_id: vehicleId,
    status: 'DISPATCHED', start: t0, end: t0 + movedDur, moved: true,
  });
  chain = [...placed.values()];

  // 松弛迭代：按当前开始时间排序，逐对保证 start_i >= end_{i-1} + buffer，直到稳定
  const originalStart = new Map(tasks.map((t) => [t.id, +t.start]));
  for (let pass = 0; pass < chain.length + 2; pass += 1) {
    const ordered = [...placed.values()].sort((a, b) => a.start - b.start || a.id - b.id);
    let changed = false;
    for (let i = 1; i < ordered.length; i += 1) {
      const prev = ordered[i - 1];
      const cur = ordered[i];
      const minStart = prev.end + buffer;
      if (cur.start < minStart) {
        if (isLocked(cur)) {
          return {
            ok: false,
            code: 'ANCHOR_COLLISION',
            conflict: {
              type: 'ANCHOR_COLLISION',
              severity: 'block',
              title: '撞上锁定单（运输中/已完成）',
              waybill_id: cur.id,
              waybill_no: cur.waybill_no,
              detail: `链式顺延到 ${fmtDT(minStart)} 时撞上锁定单 ${cur.waybill_no}（${cur.status === 'COMPLETED' ? '已完成' : '运输中'}，`
                + `计划 ${fmtDT(cur.start)} 发车，不可移动）。请改派到其它车辆或选择更早的落点。`,
              ranges: [
                { label: prev.waybill_no || `运单#${prev.id}`, start: prev.start, end: prev.end },
                { label: cur.waybill_no || `运单#${cur.id}`, start: cur.start, end: cur.end },
              ],
            },
          };
        }
        // 只后推：不允许把别人往更早挪
        const nextStart = Math.max(minStart, cur.start);
        if (nextStart !== cur.start) {
          placed.set(cur.id, { ...cur, start: nextStart, end: nextStart + duration.get(cur.id) });
          changed = true;
        }
      }
    }
    if (!changed) break;
  }

  const schedule = placed;
  const moves = [...placed.values()]
    .filter((t) => t.start !== originalStart.get(t.id))
    .map((t) => ({
      id: t.id,
      waybill_no: t.waybill_no,
      start: t.start,
      end: t.end,
      shifted: t.id !== movedId,
    }));

  // 安全闸：由最终排布反推依赖图做环检测（车辆链为森林天然无环，资源交换场景下兜底）
  const deps = buildChainDeps([...placed.values()]);
  if (hasCycle(deps)) {
    return { ok: false, code: 'CYCLE_DETECTED', conflict: { type: 'CYCLE_DETECTED', severity: 'block', title: '环形依赖' } };
  }

  return { ok: true, moves, schedule, movedId };
}

/** 由同车时间先后构造「后单依赖前单」的邻接表 */
export function buildChainDeps(orderedTasks) {
  const byVehicle = new Map();
  for (const t of orderedTasks) {
    const key = t.vehicle_id;
    if (!byVehicle.has(key)) byVehicle.set(key, []);
    byVehicle.get(key).push(t);
  }
  const deps = new Map();
  for (const list of byVehicle.values()) {
    list.sort((a, b) => a.start - b.start || a.id - b.id);
    for (let i = 1; i < list.length; i += 1) {
      const from = list[i - 1].id;
      const to = list[i].id;
      if (!deps.has(from)) deps.set(from, []);
      deps.get(from).push(to);
    }
  }
  return deps;
}

/**
 * 通用有向图环检测（三色 DFS）。
 * @param deps Map<node, node[]>，边 node -> 依赖于 node 的后继
 * @returns true 表示存在环
 */
export function hasCycle(deps) {
  const WHITE = 0; const GRAY = 1; const BLACK = 2;
  const color = new Map();
  const nodes = new Set([...deps.keys()]);
  for (const next of deps.values()) next.forEach((n) => nodes.add(n));
  nodes.forEach((n) => color.set(n, WHITE));

  const stack = [];
  for (const start of nodes) {
    if (color.get(start) !== WHITE) continue;
    stack.push(start);
    while (stack.length) {
      const u = stack[stack.length - 1];
      if (color.get(u) === WHITE) {
        color.set(u, GRAY);
        for (const v of deps.get(u) || []) {
          if (color.get(v) === GRAY) return true;
          if (color.get(v) === WHITE) stack.push(v);
        }
      } else {
        color.set(u, BLACK);
        stack.pop();
      }
    }
  }
  return false;
}

/** 落点是否导致晚点（新计划到达晚于原计划到达） */
export function lateArrival(originalEnd, newEnd) {
  return +newEnd > +originalEnd;
}

function pad(n) { return String(n).padStart(2, '0'); }
function fmtDT(v) {
  const d = new Date(v);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
