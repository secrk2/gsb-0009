<template>
  <div class="gantt" ref="rootEl">
    <!-- 时间标尺 -->
    <div class="gantt-row gantt-head">
      <div class="lane-label">&nbsp;</div>
      <div class="lane-track axis" ref="axisEl">
        <template v-if="view === 'day'">
          <div
            v-for="h in 25"
            :key="h"
            class="tick"
            :style="{ left: `${(h / 24) * 100}%` }"
          >
            <span v-if="h < 24">{{ h }}时</span>
          </div>
        </template>
        <template v-else>
          <div
            v-for="(d, i) in days"
            :key="i"
            class="day-col"
            :class="{ weekend: d.weekend, today: d.isToday }"
            :style="{ left: `${(i / 7) * 100}%`, width: `${100 / 7}%` }"
          >
            <div class="day-head">{{ d.label }} {{ d.md }}<em v-if="d.isToday">今天</em></div>
          </div>
        </template>
        <div v-if="nowPct !== null" class="now-line" :style="{ left: `${nowPct}%` }"></div>
      </div>
    </div>

    <!-- 泳道 -->
    <div
      v-for="lane in lanes"
      :key="`${group}-${lane.id}`"
      class="gantt-row lane"
      :class="{ 'lane-hot': drag && drag.resourceType === group && drag.resourceId === lane.id }"
      :data-resource-type="group"
      :data-resource-id="lane.id"
    >
      <div class="lane-label">
        <div class="lane-name" :title="lane.name || lane.plate">
          <span v-if="lane.status === 'MAINTENANCE'" title="维修中">🔧</span>
          {{ lane.name || lane.plate }}
        </div>
        <div v-if="lane.expired" class="lane-warn" :title="lane.expiredText">证照过期</div>
      </div>
      <div class="lane-track">
        <!-- 网格列 -->
        <template v-if="view === 'day'">
          <div v-for="h in 24" :key="h" class="grid-col" :style="{ left: `${(h / 24) * 100}%`, width: `${100 / 24}%` }"></div>
        </template>
        <template v-else>
          <div
            v-for="(d, i) in days"
            :key="i"
            class="grid-col"
            :class="{ weekend: d.weekend, today: d.isToday }"
            :style="{ left: `${(i / 7) * 100}%`, width: `${100 / 7}%` }"
          ></div>
        </template>

        <!-- 车辆不可用 / 人员请假段 -->
        <div
          v-for="(b, bi) in lane.blocks || []"
          :key="`b${bi}`"
          class="block-seg"
          :style="segStyle(b.start, b.end)"
          :title="`${b.reason}：${fmtDT(b.start)} ~ ${fmtDT(b.end)}`"
        >
          <span class="block-reason">{{ b.reason }}</span>
        </div>

        <!-- 任务条 -->
        <div
          v-for="t in lane.tasks"
          :key="t.id"
          class="gbar"
          :class="barClass(t)"
          :style="segStyle(t.planned_departure, t.planned_arrival)"
          :title="barTitle(t)"
          @pointerdown="onDown($event, t)"
          @click="onClick($event, t)"
        >
          <span class="gbar-no">{{ t.locked ? '🔒 ' : '' }}{{ t.waybill_no }}</span>
          <span class="gbar-route">{{ t.origin }}→{{ t.destination }}</span>
          <span class="gbar-time">{{ fmtTime(t.planned_departure) }}–{{ fmtTime(t.planned_arrival) }}</span>
        </div>

        <div v-if="!lane.tasks.length && !(lane.blocks || []).length" class="lane-empty">
          {{ emptyText }}
        </div>

        <div v-if="nowPct !== null" class="now-line" :style="{ left: `${nowPct}%` }"></div>
      </div>
    </div>

    <!-- 拖拽浮动提示 -->
    <div v-if="drag" class="drag-ghost" :style="{ left: `${drag.x + 14}px`, top: `${drag.y + 12}px` }">
      <div class="drag-ghost-title">{{ drag.task.waybill_no }} → {{ drag.targetLabel }}</div>
      <div>{{ fmtDT(drag.newStart) }} 发车 · {{ drag.durationLabel }}</div>
      <div v-if="drag.snapHint" class="drag-ghost-hint">自动对齐 15 分钟</div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue';
import { fmtDT, fmtTime, WEEKDAYS } from '../../utils.js';

const props = defineProps({
  board: { type: Object, required: true },
  group: { type: String, required: true }, // vehicle | driver | escort
  conflictsByTask: { type: Map, required: true },
});
const emit = defineEmits(['drop', 'select', 'reassign']);

const rootEl = ref(null);
const drag = ref(null);
const suppressClick = ref(false);

const ws = computed(() => new Date(props.board.window_start).getTime());
const we = computed(() => new Date(props.board.window_end).getTime());
const winMs = computed(() => we.value - ws.value);

const pct = (iso) => {
  const t = new Date(iso).getTime();
  return Math.max(0, Math.min(100, ((t - ws.value) / winMs.value) * 100));
};
const segStyle = (s, e) => ({ left: `${pct(s)}%`, width: `${Math.max(0.6, pct(e) - pct(s))}%` });

const days = computed(() => {
  const out = [];
  const today = todayIso();
  for (let i = 0; i < 7; i += 1) {
    const d = new Date(ws.value + i * 86400000 + 8 * 3600000); // 窗口内该日 00:00（UTC 表示）
    const dow = (d.getUTCDay() + 6) % 7;
    out.push({
      label: WEEKDAYS[dow],
      md: `${d.getUTCMonth() + 1}/${d.getUTCDate()}`,
      weekend: dow >= 5,
      isToday: d.toISOString().slice(0, 10) === today,
    });
  }
  return out;
});
function todayIso() {
  const d = new Date(Date.now() + 8 * 3600000);
  return d.toISOString().slice(0, 10);
}

const nowPct = computed(() => {
  const n = Date.now();
  if (n < ws.value || n > we.value) return null;
  return ((n - ws.value) / winMs.value) * 100;
});

const conflictTaskIds = computed(() => new Set([...props.conflictsByTask.keys()]));

const RES_LABEL = { vehicle: '该车', driver: '该驾驶员', escort: '该押运员' };
const emptyText = computed(() => {
  const w = props.view === 'week' ? '本周' : '今日';
  return `${RES_LABEL[props.group] || '该资源'}${w}暂无排班`;
});

const lanes = computed(() => {
  if (props.group === 'vehicle') {
    return props.board.lanes.vehicles.map((v) => ({
      id: v.id,
      plate: v.plate,
      name: '',
      status: v.status,
      blocks: v.blocks,
      expired: !!v.license_until && new Date(v.license_until).getTime() < Date.now(),
      expiredText: `道路运输证有效期至 ${String(v.license_until).slice(0, 10)}`,
      tasks: props.board.tasks.filter((t) => t.vehicle_id === v.id),
    }));
  }
  const list = props.group === 'driver' ? props.board.lanes.drivers : props.board.lanes.escorts;
  return list.map((p) => ({
    id: p.id,
    name: p.name,
    blocks: (p.leaves || []).map((l) => l),
    expired: (p.certs || []).some((c) => c.expired),
    expiredText: '存在过期/缺失证照',
    tasks: props.board.tasks.filter((t) => (props.group === 'driver' ? t.driver_id : t.escort_id) === p.id),
  }));
});

function barClass(t) {
  return {
    'gbar-locked': t.locked,
    'gbar-conflict': conflictTaskIds.value.has(t.id),
    'gbar-transit': t.status === 'IN_TRANSIT',
    'gbar-done': t.status === 'COMPLETED',
  };
}
function barTitle(t) {
  const cs = props.conflictsByTask.get(t.id) || [];
  const base = `${t.waybill_no} ${t.origin}→${t.destination}\n${fmtDT(t.planned_departure)} ~ ${fmtDT(t.planned_arrival)}`;
  return cs.length ? `${base}\n⚠ ${cs.length} 条冲突：${cs.map((c) => c.title).join('、')}` : base;
}

// ---------- 拖拽（Pointer Events，鼠标/触摸统一） ----------
const SNAP_MS = 15 * 60 * 1000;

function onDown(ev, task) {
  if (task.locked) return;
  ev.preventDefault();
  const track = ev.currentTarget.parentElement;
  const rect = track.getBoundingClientRect();
  const dur = new Date(task.planned_arrival).getTime() - new Date(task.planned_departure).getTime();
  const start = {
    x: ev.clientX,
    y: ev.clientY,
    rect,
    task,
    origGroup: props.group,
    origResourceId: resourceIdOf(task),
    moved: false,
  };
  const state = {
    task,
    x: ev.clientX,
    y: ev.clientY,
    resourceType: props.group,
    resourceId: start.origResourceId,
    targetLabel: laneLabelOf(props.group, start.origResourceId),
    newStart: new Date(task.planned_departure).getTime(),
    durationLabel: `约 ${Math.max(1, Math.round(dur / 3600000 * 10) / 10)} 小时`,
    snapHint: false,
  };
  drag.value = state;

  const move = (e) => {
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (!start.moved && Math.hypot(dx, dy) < 6) return;
    start.moved = true;
    state.x = e.clientX;
    state.y = e.clientY;
    const raw = ws.value + ((e.clientX - start.rect.left) / start.rect.width) * winMs.value;
    const snapped = Math.round(raw / SNAP_MS) * SNAP_MS;
    state.newStart = Math.max(ws.value, Math.min(we.value - dur, snapped));
    state.snapHint = Math.abs(snapped - raw) > 60 * 1000;
    const laneEl = document.elementFromPoint(e.clientX, e.clientY)?.closest('.lane');
    if (laneEl) {
      state.resourceType = laneEl.dataset.resourceType;
      state.resourceId = Number(laneEl.dataset.resourceId);
      state.targetLabel = laneLabelOf(state.resourceType, state.resourceId);
    }
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    const wasMoved = start.moved;
    const payload = { ...state };
    drag.value = null;
    if (wasMoved) {
      suppressClick.value = true;
      setTimeout(() => { suppressClick.value = false; }, 50);
      emit('drop', {
        task: start.task,
        resourceType: payload.resourceType,
        resourceId: payload.resourceId,
        newStart: payload.newStart,
      });
    }
  };
  window.addEventListener('pointermove', move, { passive: false });
  window.addEventListener('pointerup', up);
}

function onClick(ev, task) {
  if (suppressClick.value) return;
  emit('select', task);
}

function resourceIdOf(t) {
  if (props.group === 'vehicle') return t.vehicle_id;
  if (props.group === 'driver') return t.driver_id;
  return t.escort_id;
}
function laneLabelOf(type, id) {
  if (type === 'vehicle') return props.board.lanes.vehicles.find((v) => v.id === id)?.plate || `车辆#${id}`;
  const list = type === 'driver' ? props.board.lanes.drivers : props.board.lanes.escorts;
  return `${type === 'driver' ? '驾驶员' : '押运员'} ${list.find((p) => p.id === id)?.name || '#' + id}`;
}
</script>
