import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { pool, withTransaction } from '../db.js';
import { authRequired, requireRole } from '../auth.js';
import {
  requireIdempotencyKey, replayIfExists, storeIdempotentResult, isDuplicateKeyError,
} from '../idempotency.js';
import { cacheDelPrefix } from '../redis.js';
import {
  buildBoard, previewReassign, getHorizonForSave, loadEngineData,
} from '../schedulingService.js';
import { planReassign } from '../scheduling.js';

const router = Router();
router.use(authRequired, requireRole('REGULATOR', 'ENTERPRISE_ADMIN'));

/** 解析当前请求的企业范围：企业管理员强制本企业；监管员必须带 enterprise_id */
function resolveEnterprise(req, res) {
  if (req.user.role === 'ENTERPRISE_ADMIN') return req.user.enterprise_id;
  const id = Number(req.query.enterprise_id || req.body?.enterprise_id);
  if (!id) {
    res.status(400).json({ error: { code: 'ENTERPRISE_REQUIRED', message: '监管员查询/操作排班需指定 enterprise_id' } });
    return null;
  }
  return id;
}

function validView(v) {
  return v === 'week' || v === 'day' ? v : 'week';
}

// GET /scheduling/board?view=week|day&date=YYYY-MM-DD&enterprise_id=（监管员）
router.get('/board', async (req, res, next) => {
  try {
    const enterpriseId = resolveEnterprise(req, res);
    if (!enterpriseId) return;
    const board = await buildBoard(pool, {
      enterpriseId, view: validView(req.query.view), date: String(req.query.date || ''),
    });
    res.json(board);
  } catch (err) {
    next(err);
  }
});

// POST /scheduling/check 改派预检（不落库）：返回链式顺延预览、残余冲突、是否超时到达
router.post('/check', async (req, res, next) => {
  try {
    const enterpriseId = resolveEnterprise(req, res);
    if (!enterpriseId) return;
    const body = req.body || {};
    const plan = await previewReassign(enterpriseId, {
      targetId: Number(body.waybill_id),
      newVehicleId: body.new_vehicle_id ? Number(body.new_vehicle_id) : null,
      newDriverId: body.new_driver_id ? Number(body.new_driver_id) : null,
      newEscortId: body.new_escort_id ? Number(body.new_escort_id) : null,
      newDeparture: body.new_departure,
    });
    if (!plan.ok) {
      return res.status(409).json({ error: { code: plan.error.code, message: plan.error.message, detail: plan.error } });
    }
    res.json(serializePlan(plan));
  } catch (err) {
    next(err);
  }
});

// POST /scheduling/waybills/:id/reassign 确认改派（幂等、留痕、事务内重算）
router.post('/waybills/:id/reassign', requireIdempotencyKey, async (req, res, next) => {
  try {
    if (await replayIfExists(req, res)) return;
    const targetId = Number(req.params.id);
    const body = req.body || {};
    const enterpriseId = resolveEnterprise(req, res);
    if (!enterpriseId) return;

    const reason = String(body.reason || '').trim();
    if (!reason) {
      return res.status(400).json({ error: { code: 'REASON_REQUIRED', message: '改派必须填写原因（车辆故障/人员请假等，将写入排班留痕）。' } });
    }
    if (reason.length > 500) {
      return res.status(400).json({ error: { code: 'REASON_TOO_LONG', message: '改派原因不能超过 500 字。' } });
    }
    const lateConfirmed = !!body.late_arrival_confirmed;
    const newVehicleId = body.new_vehicle_id ? Number(body.new_vehicle_id) : null;
    const newDriverId = body.new_driver_id ? Number(body.new_driver_id) : null;
    const newEscortId = body.new_escort_id ? Number(body.new_escort_id) : null;
    if (!newVehicleId) {
      return res.status(400).json({ error: { code: 'VEHICLE_REQUIRED', message: '改派必须指定新的车辆。' } });
    }
    const dep = body.new_departure ? new Date(body.new_departure) : null;
    if (!dep || Number.isNaN(dep.getTime())) {
      return res.status(400).json({ error: { code: 'BAD_DATETIME', message: '新的计划发车时间格式不正确。' } });
    }

    const outcome = await withTransaction(async (conn) => {
      // 锁定目标单，二次确认归属企业与状态
      const [trows] = await conn.query('SELECT * FROM waybills WHERE id = ? FOR UPDATE', [targetId]);
      const target = trows[0];
      if (!target) return { httpStatus: 404, body: { error: { code: 'NOT_FOUND', message: '运单不存在' } } };
      if (target.enterprise_id !== enterpriseId) {
        return { httpStatus: 403, body: { error: { code: 'FORBIDDEN_ENTERPRISE', message: '无权改派其他企业的运单。' } } };
      }

      // 事务内重算，避免预检后数据被他人改动
      const horizon = await getHorizonForSave(conn, enterpriseId);
      const plan = planReassign(horizon.engineTasks, {
        targetId,
        newVehicleId,
        newDriverId,
        newEscortId,
        newDeparture: dep,
        resources: horizon.resources,
        reason,
      });
      if (!plan.ok) {
        return { httpStatus: 409, body: { error: { code: plan.error.code, message: plan.error.message, detail: plan.error } } };
      }
      if (plan.arrival_delayed && !lateConfirmed) {
        return {
          httpStatus: 409,
          body: {
            error: {
              code: 'LATE_ARRIVAL_CONFIRM_REQUIRED',
              message: '该落点将导致计划到达时间晚于原计划，必须勾选确认并填写原因后才能提交。',
              plan: serializePlan(plan),
            },
          },
        };
      }
      // 残余硬冲突只看本次改派/顺延涉及的单；与本操作无关的历史冲突不应阻塞本次提交
      const changedIds = new Set(plan.changes.map((c) => c.waybill_id));
      const hard = plan.conflicts.filter((c) => changedIds.has(c.waybill_id)
        && ['VEHICLE_DOUBLE_BOOKED', 'DRIVER_DOUBLE_BOOKED', 'ESCORT_DOUBLE_BOOKED',
          'VEHICLE_MAINTENANCE', 'VEHICLE_LICENSE_EXPIRED', 'VEHICLE_UNAVAILABLE',
          'DRIVER_CERT_EXPIRED', 'ESCORT_CERT_EXPIRED', 'DRIVER_ON_LEAVE', 'ESCORT_ON_LEAVE'].includes(c.code));
      if (hard.length) {
        return {
          httpStatus: 409,
          body: {
            error: {
              code: 'CONFLICTS_REMAIN',
              message: '改派后仍存在排班冲突，请逐条处理后再提交：' + hard.slice(0, 3).map((c) => `「${c.title}」`).join('、'),
              conflicts: hard,
            },
          },
        };
      }

      const batchId = randomUUID();
      const finalById = new Map(plan.finalTasks.map((t) => [t.id, t]));

      // 逐单写库 + 留痕（plan.changes 恰好包含目标单与每一张被链式顺延的单，不含未变动单）
      for (const ch of plan.changes) {
        const wid = ch.waybill_id;
        const ft = finalById.get(wid) || {
          vehicle_id: ch.new_vehicle_id, driver_id: ch.new_driver_id, escort_id: ch.new_escort_id,
          planned_departure: new Date(ch.new_planned_departure).getTime(),
          planned_arrival: new Date(ch.new_planned_arrival).getTime(),
        };
        const [curRows] = await conn.query('SELECT * FROM waybills WHERE id = ? FOR UPDATE', [wid]);
        const cur = curRows[0];
        if (!cur || cur.status !== 'DISPATCHED') continue; // 双重保险：运输中/完成绝不动

        await conn.query(
          `UPDATE waybills
             SET vehicle_id = ?, vehicle_plate = COALESCE((SELECT plate FROM vehicles WHERE id = ?), vehicle_plate),
                 driver_id = ?, escort_id = ?,
                 planned_departure = ?, planned_arrival = ?
           WHERE id = ? AND status = 'DISPATCHED'`,
          [ft.vehicle_id, ft.vehicle_id, ft.driver_id, ft.escort_id,
            new Date(ft.planned_departure), new Date(ft.planned_arrival), wid],
        );

        let kind = 'CHAIN_SHIFT';
        if (wid === targetId) {
          if (cur.vehicle_id !== ft.vehicle_id) kind = 'REASSIGN_VEHICLE';
          else if (cur.driver_id !== ft.driver_id) kind = 'REASSIGN_DRIVER';
          else if (cur.escort_id !== ft.escort_id) kind = 'REASSIGN_ESCORT';
          else kind = 'RESCHEDULE';
        }
        const isTarget = wid === targetId;
        await conn.query(
          `INSERT INTO schedule_adjustments
            (waybill_id, batch_id, kind,
             old_vehicle_id, new_vehicle_id, old_driver_id, new_driver_id, old_escort_id, new_escort_id,
             old_planned_departure, new_planned_departure, old_planned_arrival, new_planned_arrival,
             late_arrival_confirmed, reason, actor_id, actor_name, idempotency_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            wid, batchId, kind,
            cur.vehicle_id, ft.vehicle_id,
            cur.driver_id, ft.driver_id,
            cur.escort_id, ft.escort_id,
            cur.planned_departure, new Date(ft.planned_departure),
            cur.planned_arrival, new Date(ft.planned_arrival),
            isTarget ? (lateConfirmed ? 1 : 0) : 0,
            isTarget
              ? reason
              : `链式顺延：前序运单 ${target.waybill_no} 改派（${reason}），本单按周转间隔自动后移`,
            req.user.id, req.user.name,
            isTarget ? req.idempotencyKey : null,
          ],
        );
      }

      const body = {
        ok: true,
        batch_id: batchId,
        changed_count: plan.changes.length,
        shifted_count: plan.changes.length - 1,
        plan: serializePlan(plan),
        message: `改派成功：目标运单已重派，${plan.changes.length - 1} 张后续运单已链式顺延，全程留痕。`,
      };
      await storeIdempotentResult(conn, req, { waybillId: targetId, status: 200, body });
      return { httpStatus: 200, body };
    });

    if (outcome.httpStatus < 300) await cacheDelPrefix('dash:');
    res.status(outcome.httpStatus).json(outcome.body);
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      if (await replayIfExists(req, res)) return;
    }
    next(err);
  }
});

// GET /scheduling/export.csv?view=&date=&enterprise_id= —— 与看板同一口径、同一数值
router.get('/export.csv', async (req, res, next) => {
  try {
    const enterpriseId = resolveEnterprise(req, res);
    if (!enterpriseId) return;
    const board = await buildBoard(pool, {
      enterpriseId, view: validView(req.query.view), date: String(req.query.date || ''),
    });
    const csv = buildCsv(board);
    const fname = `排班导出_${board.view}_${board.date}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`);
    // UTF-8 BOM，Excel 直接打开不乱码
    res.send(`﻿${csv}`);
  } catch (err) {
    next(err);
  }
});

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v).replace(/"/g, '""');
  return /[",\n]/.test(s) ? `"${s}"` : s;
}
function pad(n) { return String(n).padStart(2, '0'); }
function fmtLocal(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function buildCsv(board) {
  const lines = [];
  lines.push(['# 安运通 · 运输排班导出（口径与作战台/排班详情完全一致）']);
  lines.push(['# 口径', board.utilization.metric.name, board.utilization.metric.formula, board.utilization.metric.detail]);
  lines.push(['# 窗口', board.view === 'week' ? '周视图' : '日视图',
    `${fmtLocal(board.window_start)} ~ ${fmtLocal(board.window_end)}`]);
  lines.push(['# 车队利用率（时间口径）',
    `${board.utilization.fleet.scheduled_hours}h`, `${board.utilization.fleet.available_hours}h`,
    board.utilization.fleet.ratio_text]);
  lines.push([]);
  lines.push(['运单号', '状态', '车辆号牌', '驾驶员', '押运员', '装货地', '卸货地',
    '计划发车', '计划到达', '货物', '冲突条数']);
  const conflictCount = new Map();
  for (const c of board.conflicts) conflictCount.set(c.waybill_id, (conflictCount.get(c.waybill_id) || 0) + 1);
  for (const t of board.tasks) {
    lines.push([
      t.waybill_no, t.status, t.vehicle_plate, t.driver_name, t.escort_name,
      t.origin, t.destination, fmtLocal(t.planned_departure), fmtLocal(t.planned_arrival),
      `${t.cargo_name}/${t.cargo_class}`, conflictCount.get(t.id) || 0,
    ].map(csvCell).join(','));
  }
  lines.push([]);
  lines.push(['车辆利用率明细（时间口径）']);
  lines.push(['车辆号牌', '状态', '已排班时长(h)', '不可用时长(h)', '可用时长(h)', '利用率', '疑似超排']);
  for (const it of board.utilization.items) {
    lines.push([
      it.plate, it.status === 'AVAILABLE' ? '可用' : it.status === 'MAINTENANCE' ? '维修中' : '停运',
      it.scheduled_hours, it.unavailable_hours, it.available_hours, it.ratio_text,
      it.overbooked ? '是' : '否',
    ].map(csvCell).join(','));
  }
  if (board.conflicts.length) {
    lines.push([]);
    lines.push(['冲突明细（逐条）']);
    lines.push(['运单号', '冲突类型', '资源', '原因']);
    for (const c of board.conflicts) {
      lines.push([c.waybill_label, c.title, c.resource_label, c.message].map(csvCell).join(','));
    }
  }
  return lines.map((l) => (Array.isArray(l) ? l.join(',') : l)).join('\r\n');
}

function serializePlan(plan) {
  return {
    ok: true,
    arrival_delayed: plan.arrival_delayed,
    changes: plan.changes.map((c) => ({
      ...c,
      old_planned_departure: c.old_planned_departure ? new Date(c.old_planned_departure).toISOString() : null,
      new_planned_departure: c.new_planned_departure ? new Date(c.new_planned_departure).toISOString() : null,
      old_planned_arrival: c.old_planned_arrival ? new Date(c.old_planned_arrival).toISOString() : null,
      new_planned_arrival: c.new_planned_arrival ? new Date(c.new_planned_arrival).toISOString() : null,
    })),
    final_tasks: plan.finalTasks.map((t) => ({
      ...t,
      planned_departure: new Date(t.planned_departure).toISOString(),
      planned_arrival: new Date(t.planned_arrival).toISOString(),
    })),
    conflicts: plan.conflicts,
  };
}

export default router;
