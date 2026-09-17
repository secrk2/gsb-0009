<template>
  <div class="schedule-page">
    <!-- 工具栏 -->
    <div class="card sched-toolbar">
      <div class="chip-row">
        <button class="chip" :class="{ active: viewMode === 'week' }" @click="viewMode = 'week'">周视图</button>
        <button class="chip" :class="{ active: viewMode === 'day' }" @click="viewMode = 'day'">日视图</button>
      </div>
      <div class="sched-nav">
        <button class="btn btn-ghost btn-sm" @click="shift(-1)">‹ {{ viewMode === 'week' ? '上周' : '前一天' }}</button>
        <button class="btn btn-ghost btn-sm" @click="goToday">今天</button>
        <button class="btn btn-ghost btn-sm" @click="shift(1)">{{ viewMode === 'week' ? '下周' : '后一天' }} ›</button>
        <span class="sched-window">{{ winLabel }}</span>
      </div>
      <div class="filter-tools">
        <select v-if="isRegulator" v-model="enterpriseId" class="input sched-select">
          <option value="">全部企业</option>
          <option v-for="e in enterprises" :key="e.id" :value="e.id">{{ e.name }}</option>
        </select>
        <div class="chip-row">
          <button class="chip" :class="{ active: dimension === 'VEHICLE' }" @click="dimension = 'VEHICLE'">车辆</button>
          <button class="chip" :class="{ active: dimension === 'DRIVER' }" @click="dimension = 'DRIVER'">驾驶员</button>
          <button class="chip" :class="{ active: dimension === 'ESCORT' }" @click="dimension = 'ESCORT'">押运员</button>
        </div>
        <button v-if="canWrite" class="btn btn-ghost btn-sm" @click="onExport">导出利用率 CSV</button>
      </div>
    </div>

    <div v-if="stale" class="stale-banner">
      ⚠️ 当前展示离线缓存数据（更新于 {{ fmtClock(cachedAt) }}），排班写操作需要在线，恢复网络后自动刷新。
    </div>

    <ErrorState v-if="error" :type="errorType" :message="error.message">
      <button class="btn btn-primary" @click="load">重新加载</button>
    </ErrorState>

    <template v-else-if="gantt">
      <!-- 选中车辆该时段无排班 -->
      <div v-if="selectedEmpty" class="card empty-banner">
        <button class="eb-close" @click="selectedRow = null">×</button>
        <div class="eb-icon">🚚💤</div>
        <div class="eb-title">「{{ selectedEmpty.name }}」在当前时段还没有排班</div>
        <div class="eb-sub">从左侧待派池把「待核验」运单拖到这辆车的时间格，松手即完成派车；手机端点卡片上的「派车」。</div>
        <button class="btn btn-primary btn-sm" @click="focusPool">查看待派运单（{{ gantt.pool.length }}）</button>
      </div>

      <!-- 窗口内排班全部取消 -->
      <div v-else-if="allAborted" class="card empty-banner">
        <div class="eb-icon">🧾</div>
        <div class="eb-title">当前{{ viewMode === 'week' ? '一周' : '一天' }}的排班已全部取消</div>
        <div class="eb-sub">该时间窗内 {{ gantt.tasks.length }} 张运单均为「异常中止」，没有待执行或在途任务。可查看中止原因。</div>
        <button class="btn btn-ghost btn-sm" @click="goWaybill(firstAborted?.waybill_id)">查看中止运单</button>
      </div>

      <!-- 窗口完全空白 -->
      <div v-else-if="!gantt.tasks.length && !gantt.pool.length && !gantt.resources.length" class="card empty-banner">
        <div class="eb-icon">🗓️</div>
        <div class="eb-title">该时间窗内暂无任何运单计划</div>
        <div class="eb-sub">试试切换到周视图，或前后移动一天查看其他排班。</div>
        <div class="eb-actions">
          <button class="btn btn-ghost btn-sm" @click="viewMode = 'week'">切换到周视图</button>
          <button class="btn btn-ghost btn-sm" @click="shift(-1)">看前一{{ viewMode === 'week' ? '周' : '天' }}</button>
        </div>
      </div>

      <div class="schedule-layout" :class="{ 'layout-compact': !!selectedTask }">
        <!-- 桌面/平板甘特（手机隐藏） -->
        <div class="gantt-col">
          <ConflictPanel
            v-if="pendingConflicts.length"
            :conflicts="pendingConflicts"
            :as-error="conflictBlocked"
            @locate="locateConflict"
          />
          <div v-if="!canWrite" class="readonly-note">当前为只读视图（驾驶员/押运员），排班调整请联系企业管理员或监管员。</div>
          <GanttBoard
            ref="boardRef"
            :view-mode="viewMode"
            :win="win"
            :resources="gantt.resources"
            :tasks="gantt.tasks"
            :unavailability="gantt.unavailability"
            :utilization="gantt.utilization"
            :dimension="dimension"
            :conflict-map="mergedConflictMap"
            :flash-id="flashId"
            :drag="dragProxy"
            :can-write="canWrite"
            :now-tick="nowTick"
            @task-click="onTaskClick"
            @row-click="onRowClick"
            @start-drag="startDrag"
          />
          <div class="gantt-foot">
            <span><i class="legend-swatch ls-dispatched"></i>已派车</span>
            <span><i class="legend-swatch ls-transit"></i>运输中 🔒</span>
            <span><i class="legend-swatch ls-done"></i>已完成 🔒</span>
            <span><i class="legend-swatch ls-aborted"></i>已取消</span>
            <span><i class="legend-swatch ls-clash"></i>冲突</span>
            <span class="gantt-caliber">利用率口径：已排班占用时长 ÷ 可用时长（区间合并去重，扣除维保/请假）</span>
          </div>
        </div>

        <!-- 右栏：待派池 / 详情 -->
        <aside class="side-col">
          <ScheduleDetailPanel
            v-if="selectedTask"
            :task="selectedTask"
            :utilization="gantt.utilization"
            :conflicts="mergedConflictMap[selectedTask.waybill_id] || liveDetailConflicts"
            :can-write="canWrite"
            @close="selectedTask = null"
            @assign="openEditor('assign', $event)"
            @reschedule="openEditor('reschedule', $event)"
            @reassign="openEditor('reassign', $event)"
            @unbind="askUnbind"
          />
          <PoolPanel
            v-else
            ref="poolRef"
            :items="gantt.pool"
            :can-write="canWrite"
            :drag-id="dragProxy?.task?.waybill_id"
            :conflict-map="mergedConflictMap"
            :hint="dimension !== 'VEHICLE' ? '派车请先切到「车辆」维度，把运单拖到目标车辆行' : ''"
            @pick="onPoolPick"
            @start-drag="startDrag"
          />
        </aside>
      </div>

      <!-- 手机竖向卡片流（仅 ≤640 显示） -->
      <ScheduleCardList
        class="schedule-cards-wrap"
        :win="win"
        :view-mode="viewMode"
        :tasks="gantt.tasks"
        :pool="gantt.pool"
        :conflict-map="mergedConflictMap"
        :can-write="canWrite"
        @pick="openEditor('assign', $event)"
        @assign="openEditor('assign', $event)"
        @task-click="onTaskClick"
        @reschedule="openEditor('reschedule', $event)"
        @reassign="openEditor('reassign', $event)"
        @unbind="askUnbind"
      />
    </template>

    <div v-else class="loading">加载中…</div>

    <!-- 派车/改期/改派表单（手机端也用它） -->
    <EditAssignmentModal
      :open="editor.open"
      :mode="editor.mode"
      :task="editor.task"
      :vehicles="vehicleOptions"
      :drivers="gantt?.drivers || []"
      :escorts="gantt?.escorts || []"
      :prefill="editor.prefill"
      :submitting="submitting"
      @close="editor.open = false"
      @submit="submitFromEditor"
    />

    <!-- 晚点二次确认 -->
    <LateConfirmModal
      :open="late.open"
      :late-waybills="late.waybills"
      :cascade-count="Math.max(0, late.waybills.length - 1)"
      :submitting="submitting"
      @confirm="confirmLate"
      @cancel="cancelLate"
    />

    <!-- 解绑原因 -->
    <Modal :open="unbindOpen" title="解绑退回待派池" :dismissable="!submitting" @close="unbindOpen = false">
      <p class="unbind-tip">解绑后该运单回到「监管核验（待派车）」池，车辆与班组保留为默认值，需重新派车。</p>
      <label class="form-item">
        <span>解绑原因（必填，如：车辆抛锚 / 押运员请假）</span>
        <textarea v-model="unbindReason" rows="3" maxlength="500" class="input"></textarea>
      </label>
      <template #footer>
        <button class="btn btn-ghost" :disabled="submitting" @click="unbindOpen = false">取消</button>
        <button class="btn btn-danger" :disabled="!unbindReason.trim() || submitting" @click="doUnbind">
          {{ submitting ? '提交中…' : '确认解绑' }}
        </button>
      </template>
    </Modal>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { getCached, api, checkSchedule,
  assignSchedule, rescheduleSchedule, reassignSchedule, unbindSchedule, downloadScheduleCsv } from '../api.js';
import { store, toast } from '../store.js';
import { fmtClock } from '../utils.js';
import {
  windowOf, toLocalInput, addDays, labelDay, weekdayCn,
  ROW_H, LABEL_W, DAY_W, HOUR_W, DAY_MS, DRAG_THRESHOLD,
} from '../utils/gantt.js';
import ErrorState from '../components/ErrorState.vue';
import Modal from '../components/Modal.vue';
import GanttBoard from '../components/schedule/GanttBoard.vue';
import PoolPanel from '../components/schedule/PoolPanel.vue';
import ConflictPanel from '../components/schedule/ConflictPanel.vue';
import ScheduleDetailPanel from '../components/schedule/ScheduleDetailPanel.vue';
import ScheduleCardList from '../components/schedule/ScheduleCardList.vue';
import EditAssignmentModal from '../components/schedule/EditAssignmentModal.vue';
import LateConfirmModal from '../components/schedule/LateConfirmModal.vue';

const router = useRouter();

// ---------- 视图状态 ----------
const isRegulator = computed(() => store.user?.role === 'REGULATOR');
const canWrite = computed(() => ['REGULATOR', 'ENTERPRISE_ADMIN'].includes(store.user?.role));

const viewMode = ref('week');
const dimension = ref('VEHICLE');
const anchor = ref(new Date());
const enterpriseId = ref('');
const enterprises = ref([]);
const win = computed(() => windowOf(viewMode.value, anchor.value));
const winLabel = computed(() => {
  const s = win.value.start;
  if (viewMode.value === 'week') {
    const end = addDays(s, 6);
    return `${labelDay(s)} 周${weekdayCn(s)} – ${labelDay(end)} 周${weekdayCn(end)}`;
  }
  return `${labelDay(s)} 周${weekdayCn(s)}`;
});
function shift(n) { anchor.value = addDays(anchor.value, n * (viewMode.value === 'week' ? 7 : 1)); }
function goToday() { anchor.value = new Date(); }

// ---------- 数据 ----------
const gantt = ref(null);
const loading = ref(false);
const error = ref(null);
const errorType = ref('error');
const stale = ref(false);
const cachedAt = ref(null);
const nowTick = ref(Date.now());
let nowTimer = setInterval(() => { nowTick.value = Date.now(); }, 60000);
onUnmounted(() => clearInterval(nowTimer));

const params = computed(() => ({
  from: toLocalInput(win.value.start),
  to: toLocalInput(win.value.end),
  dimension: dimension.value,
  enterprise_id: enterpriseId.value || undefined,
}));

async function load() {
  loading.value = true;
  error.value = null;
  try {
    const qs = Object.entries(params.value)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    const r = await getCached(`/schedules/gantt?${qs}`);
    gantt.value = r.data;
    stale.value = r.stale;
    cachedAt.value = r.cachedAt;
    if (pendingLocate.value) {
      const pl = pendingLocate.value;
      pendingLocate.value = null;
      setTimeout(() => doLocate(pl.waybillId, pl.resource), 120);
    }
  } catch (e) {
    error.value = e;
    errorType.value = e.code === 'OFFLINE' ? 'offline' : (e.status === 403 ? 'forbidden' : 'error');
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  if (isRegulator.value) {
    try { enterprises.value = (await api.get('/meta/enterprises')).items; } catch { /* ignore */ }
  }
  load();
});
watch([viewMode, dimension, enterpriseId, anchor], () => { pendingConflicts.value = []; load(); });

const vehicleOptions = computed(() => (gantt.value?.vehicles || [])
  .map((v) => ({ id: v.id, name: v.plate, sub: `${v.vehicle_type || ''}${v.load_tons ? ` · ${v.load_tons}吨` : ''}` })));

// ---------- 空态判定 ----------
const selectedRow = ref(null);
const activeTasks = computed(() => (gantt.value?.tasks || []).filter((t) => !t.aborted));
const selectedEmpty = computed(() => {
  if (!gantt.value || !selectedRow.value) return null;
  const r = selectedRow.value;
  const has = (gantt.value.tasks || []).some((t) => (
    dimension.value === 'VEHICLE' ? t.vehicle_id === r.id
      : dimension.value === 'DRIVER' ? t.driver_id === r.id
        : t.escort_id === r.id));
  return has ? null : r;
});
const allAborted = computed(() => {
  if (!gantt.value) return false;
  const t = gantt.value.tasks;
  return t.length > 0 && t.every((x) => x.aborted)
    && activeTasks.value.length === 0 && gantt.value.pool.length === 0;
});
const firstAborted = computed(() => (gantt.value?.tasks || []).find((t) => t.aborted));
function onRowClick(r) {
  selectedTask.value = null;
  selectedRow.value = (selectedRow.value?.id === r.id && selectedRow.value?.type === r.type) ? null : r;
}
const poolRef = ref(null);
function focusPool() {
  document.querySelector('.pool-panel')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  selectedRow.value = null;
}
function goWaybill(id) { if (id) router.push(`/waybills/${id}`); }

// ---------- 选中任务/详情 ----------
const selectedTask = ref(null);
const suppressClickUntil = ref(0);
function onTaskClick(t) {
  if (Date.now() < suppressClickUntil.value) return;
  selectedRow.value = null;
  selectedTask.value = t;
}
function onPoolPick(t) {
  if (Date.now() < suppressClickUntil.value) return;
  if (!canWrite.value) { selectedTask.value = t; return; }
  openEditor('assign', t);
}

// ---------- 冲突 ----------
const pendingConflicts = ref([]);
const conflictBlocked = ref(false);
const flashId = ref(null);
let flashTimer = null;
const boardRef = ref(null);
const pendingLocate = ref(null);
const serverConflictMap = computed(() => gantt.value?.conflict_map || {});
const liveDetailConflicts = computed(() => pendingConflicts.value
  .filter((c) => c.waybill_id === selectedTask.value?.waybill_id));
// 以服务端开箱冲突为底；试算冲突补充（红条定位到对方单）
const mergedConflictMap = computed(() => {
  const m = { ...serverConflictMap.value };
  for (const c of pendingConflicts.value) {
    if (c.waybill_id) (m[c.waybill_id] ||= []).push(c);
  }
  return m;
});

const DIM_OF_CONFLICT = {
  VEHICLE_OVERLAP: 'VEHICLE', VEHICLE_UNAVAILABLE: 'VEHICLE', ANCHOR_COLLISION: 'VEHICLE',
  DRIVER_OVERLAP: 'DRIVER', DRIVER_UNAVAILABLE: 'DRIVER',
  ESCORT_OVERLAP: 'ESCORT', ESCORT_UNAVAILABLE: 'ESCORT', LICENSE_EXPIRED: 'ESCORT',
};
function locateConflict(c) {
  const wantDim = DIM_OF_CONFLICT[c.type] || 'VEHICLE';
  const id = c.waybill_id;
  if (dimension.value !== wantDim) {
    dimension.value = wantDim;
    pendingLocate.value = id ? { waybillId: id, resource: { type: wantDim, id: c.resource_id } } : { resource: { type: wantDim, id: c.resource_id } };
    return;
  }
  doLocate(id, { type: wantDim, id: c.resource_id });
}
function doLocate(id, resource) {
  let ok = id ? boardRef.value?.scrollToTask(id) : false;
  if (!ok && resource?.id) ok = boardRef.value?.scrollToResource(resource.type, resource.id);
  if (ok && id) {
    flashId.value = null;
    requestAnimationFrame(() => { flashId.value = id; });
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { flashId.value = null; }, 2600);
  } else if (!ok) {
    toast('该冲突涉及的资源/运单不在当前时间窗，请切换到对应周/日', 'error');
  }
}

// ---------- 拖拽（Pointer Events，桌面/平板统一；手机走卡片表单） ----------
const dragProxy = ref(null);
let dragState = null;

function startDrag(e, task) {
  if (!canWrite.value) return;
  if (e.button !== undefined && e.button !== 0) return;
  const el = e.currentTarget;
  try { el.setPointerCapture?.(e.pointerId); } catch { /* pool 元素可能已失焦 */ }
  dragState = {
    pointerId: e.pointerId,
    kind: task.status === 'REGULATOR_VERIFY' ? 'pool' : 'task',
    task,
    startX: e.clientX, startY: e.clientY,
    moved: false, ghost: null,
  };
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp, { once: true });
  window.addEventListener('pointercancel', cancelDrag, { once: true });
}

function makeGhost(label) {
  const g = document.createElement('div');
  g.className = 'drag-ghost';
  g.textContent = label;
  document.body.appendChild(g);
  return g;
}

function onPointerMove(e) {
  const ds = dragState;
  if (!ds) return;
  const dx = e.clientX - ds.startX;
  const dy = e.clientY - ds.startY;
  if (!ds.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
  if (!ds.moved) {
    ds.moved = true;
    ds.ghost = makeGhost(`${ds.task.waybill_no}`);
  }
  const hit = boardRef.value?.hitTest(e.clientX, e.clientY) || { inside: false };
  const duration = new Date(ds.task.end) - new Date(ds.task.start);
  const valid = hit.inside
    && !(ds.kind === 'pool' && dimension.value !== 'VEHICLE')
    && hit.row?.type === dimension.value;

  dragProxy.value = {
    task: ds.task,
    inside: hit.inside,
    valid,
    rowIdx: hit.rowIdx ?? 0,
    rowId: hit.rowId,
    x: hit.x ?? 0,
    w: duration / (viewMode.value === 'week' ? 7 * DAY_MS : DAY_MS)
      * (viewMode.value === 'week' ? 7 * DAY_W : 24 * HOUR_W),
  };
  if (ds.ghost) {
    ds.ghost.style.left = `${e.clientX + 12}px`;
    ds.ghost.style.top = `${e.clientY + 12}px`;
    ds.ghost.classList.toggle('bad', !valid);
    ds.ghost.textContent = valid
      ? `${ds.task.waybill_no} → ${hit.row.name} ${toLocalInput(hit.time).slice(5, 16).replace('T', ' ')}`
      : ds.task.waybill_no;
  }
}

function onPointerUp(e) {
  window.removeEventListener('pointermove', onPointerMove);
  const ds = dragState;
  dragState = null;
  // 松手瞬间再做一次命中，使用最终坐标
  let proxy = dragProxy.value;
  if (ds?.moved && e) {
    const hit = boardRef.value?.hitTest(e.clientX, e.clientY) || { inside: false };
    const duration = new Date(ds.task.end) - new Date(ds.task.start);
    if (hit.inside) {
      proxy = {
        task: ds.task, inside: true,
        valid: !(ds.kind === 'pool' && dimension.value !== 'VEHICLE') && hit.row?.type === dimension.value,
        rowIdx: hit.rowIdx, rowId: hit.rowId, x: hit.x,
        w: duration / (viewMode.value === 'week' ? 7 * DAY_MS : DAY_MS)
          * (viewMode.value === 'week' ? 7 * DAY_W : 24 * HOUR_W),
      };
    }
  }
  dragProxy.value = null;
  if (ds?.ghost) ds.ghost.remove();
  if (ds?.moved) suppressClickUntil.value = Date.now() + 300; // 抑制拖拽结束后的误 click
  if (!ds?.moved || !proxy?.valid) return;
  commitDrop(ds.task, proxy.rowId, proxy);
}

function cancelDrag() {
  window.removeEventListener('pointermove', onPointerMove);
  dragState?.ghost?.remove();
  dragState = null;
  dragProxy.value = null;
}

function findRow(rowId) {
  return (gantt.value?.resources || []).find((r) => `${r.type}:${r.id}` === rowId);
}

function commitDrop(task, rowId, proxy) {
  const row = findRow(rowId);
  if (!row) return;
  // proxy.x 是相对网格左缘像素，反推吸附时间
  const axisW = viewMode.value === 'week' ? 7 * DAY_W : 24 * HOUR_W;
  const winMs = viewMode.value === 'week' ? 7 * DAY_MS : DAY_MS;
  const start = new Date(+win.value.start + proxy.x / axisW * winMs);
  const end = new Date(start.getTime() + (new Date(task.end) - new Date(task.start)));

  const sameResource = (dimension.value === 'VEHICLE' && task.vehicle_id === row.id)
    || (dimension.value === 'DRIVER' && task.driver_id === row.id)
    || (dimension.value === 'ESCORT' && task.escort_id === row.id);

  const payload = {
    waybill_id: task.waybill_id,
    start: toLocalInput(start),
    end: toLocalInput(end),
    vehicle_id: dimension.value === 'VEHICLE' ? row.id : task.vehicle_id,
    driver_id: dimension.value === 'DRIVER' ? row.id : task.driver_id,
    escort_id: dimension.value === 'ESCORT' ? row.id : task.escort_id,
  };

  if (task.status === 'REGULATOR_VERIFY') {
    void runPayload('assign', payload);
  } else if (sameResource) {
    void runPayload('reschedule', { waybill_id: payload.waybill_id, start: payload.start, end: payload.end });
  } else {
    // 跨资源 = 改派，必须填原因 → 打开表单
    openEditor('reassign', task, {
      vehicle_id: payload.vehicle_id, driver_id: payload.driver_id, escort_id: payload.escort_id,
      start: payload.start, end: payload.end,
    });
  }
}

// ---------- 编辑弹窗 ----------
const editor = ref({ open: false, mode: 'assign', task: null, prefill: null });
const submitting = ref(false);

function openEditor(mode, task, prefill = null) {
  if (task.status === 'REGULATOR_VERIFY' && mode === 'reschedule') mode = 'assign';
  editor.value = { open: true, mode, task, prefill };
}

// ---------- 写提交（check → 晚点确认 → 写） ----------
let pendingPayload = null;
let pendingMode = null;

async function submitFromEditor(payload) {
  const { mode, ...body } = payload;
  return runPayload(mode, body);
}

async function runPayload(mode, body) {
  submitting.value = true;
  pendingConflicts.value = [];
  try {
    const check = await checkSchedule({ mode, ...body });
    if (!check.valid) {
      pendingConflicts.value = check.conflicts;
      conflictBlocked.value = false;
      editor.value.open = false;
      toast(`发现 ${check.conflicts.length} 项冲突，未保存`, 'error');
      return;
    }
    pendingMode = mode;
    pendingPayload = body;
    if (check.late) {
      openLate(check.late_waybills);
      return;
    }
    await doWrite(body, '');
  } catch (e) {
    if (e.status === 409 && e.details?.conflicts) {
      pendingConflicts.value = e.details.conflicts;
      conflictBlocked.value = true;
      toast('保存瞬间数据已变化，请按最新冲突调整', 'error');
    } else if (e.status === 400 && e.code === 'LATE_REASON_REQUIRED') {
      openLate(e.details.late_waybills);
    } else {
      toast(e.message || '排班提交失败', 'error');
    }
  } finally {
    submitting.value = false;
  }
}

// ---------- 晚点确认 ----------
const late = ref({ open: false, waybills: [] });
function openLate(waybills) {
  late.value = { open: true, waybills: waybills || [] };
}
function cancelLate() {
  late.value.open = false;
  pendingPayload = null;
  pendingMode = null;
}
async function confirmLate(reason) {
  if (!pendingPayload) return;
  submitting.value = true;
  try {
    await doWrite(pendingPayload, reason);
  } finally {
    submitting.value = false;
    late.value.open = false;
  }
}

async function doWrite(body, lateReason) {
  const writer = { assign: assignSchedule, reschedule: rescheduleSchedule, reassign: reassignSchedule }[pendingMode];
  const res = await writer({ ...body, late_reason: lateReason || undefined });
  editor.value.open = false;
  selectedTask.value = null;
  toast(res.cascaded_count
    ? `已保存，并连带调整 ${res.cascaded_count} 张同车后续运单`
    : '排班已保存', 'success');
  pendingPayload = null;
  pendingMode = null;
  await load();
}

// ---------- 解绑 ----------
const unbindOpen = ref(false);
const unbindReason = ref('');
let unbindTarget = null;
function askUnbind(task) {
  unbindTarget = task;
  unbindReason.value = '';
  unbindOpen.value = true;
}
async function doUnbind() {
  if (!unbindTarget || !unbindReason.value.trim()) return;
  submitting.value = true;
  try {
    await unbindSchedule({ waybill_id: unbindTarget.waybill_id, reason: unbindReason.value.trim() });
    unbindOpen.value = false;
    selectedTask.value = null;
    toast('已解绑，运单回到待派池', 'success');
    await load();
  } catch (e) {
    toast(e.message || '解绑失败', 'error');
  } finally {
    submitting.value = false;
  }
}

// ---------- 导出 ----------
async function onExport() {
  try {
    await downloadScheduleCsv({ from: params.value.from, to: params.value.to, enterprise_id: enterpriseId.value || undefined });
    toast('利用率 CSV 已导出', 'success');
  } catch (e) {
    toast(e.message || '导出失败', 'error');
  }
}
</script>
