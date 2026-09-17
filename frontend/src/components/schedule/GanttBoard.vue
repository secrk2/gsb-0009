<template>
  <div ref="scrollEl" class="gantt-scroll" :class="{ 'is-readonly': !canWrite }">
    <div class="gantt-inner" :style="innerStyle">
      <!-- 左上角 -->
      <div class="gantt-corner">
        <span>{{ dimension === 'VEHICLE' ? '车辆 \\ 时间' : dimension === 'DRIVER' ? '驾驶员 \\ 时间' : '押运员 \\ 时间' }}</span>
      </div>

      <!-- 时间表头 -->
      <div class="gantt-timehead">
        <template v-if="viewMode === 'week'">
          <div v-for="(d, i) in 7" :key="i" class="th-day" :style="{ width: DAY_W + 'px' }">
            <span class="th-date">{{ labelDay(+win.start + i * DAY_MS) }} 周{{ weekdayCn(+win.start + i * DAY_MS) }}</span>
          </div>
        </template>
        <template v-else>
          <div v-for="h in 24" :key="h - 1" class="th-hour" :style="{ width: HOUR_W + 'px' }">
            {{ pad(h - 1) }}
          </div>
        </template>
      </div>

      <!-- 资源名列 -->
      <div class="gantt-labelcol">
        <div
          v-for="(r, i) in resources"
          :key="r.type + r.id"
          class="gantt-rowlabel"
          :class="{ 'row-hot': drag && drag.rowId === rowKey(r) && drag.inside }"
          :style="{ height: ROW_H + 'px' }"
          @click="$emit('row-click', r)"
        >
          <div class="rl-name">{{ r.name }}</div>
          <div class="rl-sub">{{ r.sub }}</div>
          <div v-if="r.type === 'VEHICLE'" class="rl-rate">{{ rateOf(r.id) }}</div>
        </div>
      </div>

      <!-- 时间网格 -->
      <div ref="gridEl" class="gantt-grid" :style="{ height: resources.length * ROW_H + 'px' }">
        <!-- 竖向刻度 -->
        <template v-if="viewMode === 'week'">
          <div v-for="i in 7" :key="'d' + i" class="grid-col-line"
            :style="{ left: (i - 1) * DAY_W + 'px' }"></div>
          <div v-for="(d, di) in 7" :key="'ds' + di" class="grid-col-shade"
            :class="{ weekend: isWeekend(+win.start + di * DAY_MS) }"
            :style="{ left: di * DAY_W + 'px', width: DAY_W + 'px' }"></div>
        </template>
        <template v-else>
          <div v-for="h in 25" :key="'h' + h" class="grid-col-line hour-line"
            :style="{ left: (h - 1) * HOUR_W + 'px' }"></div>
        </template>

        <!-- 行分隔 -->
        <div v-for="i in resources.length" :key="'r' + i" class="grid-row-line"
          :style="{ top: (i - 1) * ROW_H + 'px' }"></div>

        <!-- 不可用窗口底色 -->
        <div
          v-for="(u, i) in unavailBlocks"
          :key="'u' + i"
          class="grid-unavail"
          :style="{ left: u.x + 'px', width: u.w + 'px', top: u.row * ROW_H + 'px', height: ROW_H + 'px' }"
          :title="`${u.reason} ${fmtRangeCN(u.s, u.e)}`"
        >
          <span class="gu-reason">⛔ {{ u.reason }}</span>
        </div>

        <!-- 当前时间线 -->
        <div v-if="nowX !== null" class="grid-nowline" :style="{ left: nowX + 'px' }"></div>

        <!-- 落点高亮 -->
        <div v-if="drag && drag.inside && drag.valid" class="grid-drop-hint"
          :style="{ left: drag.x + 'px', width: drag.w + 'px', top: drag.rowIdx * ROW_H + 6 + 'px', height: ROW_H - 12 + 'px' }">
        </div>

        <!-- 任务条 -->
        <div
          v-for="t in tasks"
          :key="t.waybill_id"
          ref="taskEls"
          :data-id="t.waybill_id"
          class="gantt-task"
          :class="taskClass(t)"
          :style="taskStyle(t)"
          @pointerdown="onTaskDown($event, t)"
          @click="$emit('task-click', t)"
        >
          <span class="gt-lock" v-if="t.locked">🔒</span>
          <span class="gt-text">{{ t.waybill_no }} · {{ t.vehicle_name }}</span>
          <span v-if="conflictMap[t.waybill_id]?.length" class="gt-clash-dot"></span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue';
import {
  DAY_W, HOUR_W, ROW_H, LABEL_W, HEAD_H, DAY_MS, HOUR_MS,
  timeToX, xToTime, snapTime, labelDay, weekdayCn, fmtRangeCN, fmtRate,
} from '../../utils/gantt.js';

const props = defineProps({
  viewMode: { type: String, default: 'week' },
  win: { type: Object, required: true },
  resources: { type: Array, default: () => [] },
  tasks: { type: Array, default: () => [] },
  unavailability: { type: Array, default: () => [] },
  utilization: { type: Array, default: () => [] },
  dimension: { type: String, default: 'VEHICLE' },
  conflictMap: { type: Object, default: () => ({}) },
  flashId: { type: Number, default: null },
  drag: { type: Object, default: null },
  canWrite: { type: Boolean, default: false },
  nowTick: { type: Number, default: Date.now() },
});
const emit = defineEmits(['task-click', 'row-click', 'start-drag']);

const scrollEl = ref(null);
const pad = (n) => String(n).padStart(2, '0');

const axisW = computed(() => (props.viewMode === 'week' ? 7 * DAY_W : 24 * HOUR_W));
const innerStyle = computed(() => ({
  width: LABEL_W + axisW.value + 'px',
  height: HEAD_H + props.resources.length * ROW_H + 'px',
}));

const rowKey = (r) => `${r.type}:${r.id}`;
const rateOf = (vid) => {
  const it = props.utilization.find((u) => u.resource_id === vid);
  if (!it) return '';
  return `利用率 ${fmtRate(it.rate)}`;
};

function taskStyle(t) {
  const x = timeToX(t.start, props.win.start, props.viewMode);
  const w = Math.max((new Date(t.end) - new Date(t.start)) / (props.viewMode === 'week' ? 7 * DAY_MS : DAY_MS) * axisW.value, 5);
  const rowIdx = props.resources.findIndex((r) => r.type === props.dimension && r.id === t[resourceIdKey()]);
  return {
    left: x + 'px',
    width: w + 'px',
    top: rowIdx * ROW_H + 6 + 'px',
    height: ROW_H - 12 + 'px',
  };
}
const resourceIdKey = () => ({ VEHICLE: 'vehicle_id', DRIVER: 'driver_id', ESCORT: 'escort_id' }[props.dimension]);

function taskClass(t) {
  return {
    [`gt-st-${t.status}`]: true,
    'gt-locked': t.locked,
    'gt-aborted': t.aborted,
    'gt-clash': !!props.conflictMap[t.waybill_id]?.length,
    'gt-flash': props.flashId === t.waybill_id,
    'gt-dragging': props.drag?.task?.waybill_id === t.waybill_id,
  };
}

const unavailBlocks = computed(() => {
  const out = [];
  for (const u of props.unavailability) {
    if (u.resource_type !== props.dimension) continue;
    const rowIdx = props.resources.findIndex((r) => r.type === u.resource_type && r.id === u.resource_id);
    if (rowIdx < 0) continue;
    const s = new Date(u.start).getTime(); const e = new Date(u.end).getTime();
    const x = timeToX(Math.max(s, +props.win.start), props.win.start, props.viewMode);
    const right = timeToX(Math.min(e, +props.win.end), props.win.start, props.viewMode);
    if (right <= x) continue;
    out.push({ x, w: right - x, row: rowIdx, reason: u.reason, s, e });
  }
  return out;
});

const nowX = computed(() => {
  const n = props.nowTick;
  if (n < +props.win.start || n > +props.win.end) return null;
  return timeToX(n, props.win.start, props.viewMode);
});

function isWeekend(t) {
  return [0, 6].includes(new Date(+t + 8 * HOUR_MS).getUTCDay());
}

// ---------- 拖拽 ----------
function onTaskDown(e, t) {
  if (!props.canWrite || t.locked || t.aborted) return;
  emit('start-drag', e, t);
}

/** 指针坐标 → 目标行/时间（供父组件拖拽时调用） */
function hitTest(clientX, clientY) {
  const el = scrollEl.value;
  if (!el) return { inside: false };
  const rect = el.getBoundingClientRect();
  // 网格区起点 = 滚动内容左边界 LABEL_W，滚动后视口左缘 = rect.left
  const xInGrid = clientX - rect.left + el.scrollLeft - LABEL_W;
  const yInGrid = clientY - el.getBoundingClientRect().top + el.scrollTop - HEAD_H;
  if (xInGrid < 0 || yInGrid < 0) return { inside: false };
  if (xInGrid > axisW.value || yInGrid > props.resources.length * ROW_H) return { inside: false };

  const rowIdx = Math.min(Math.floor(yInGrid / ROW_H), props.resources.length - 1);
  const row = props.resources[rowIdx];
  const rawTime = xToTime(xInGrid, props.win.start, props.viewMode);
  const snapped = snapTime(rawTime, props.viewMode);
  return {
    inside: true,
    rowIdx,
    row,
    rowId: rowKey(row),
    time: snapped,
    x: Math.max(0, timeToX(snapped, props.win.start, props.viewMode)),
  };
}

function scrollToTask(waybillId) {
  const t = props.tasks.find((x) => x.waybill_id === waybillId);
  if (!t) return false;
  const rid = props.dimension === 'VEHICLE' ? t.vehicle_id
    : props.dimension === 'DRIVER' ? t.driver_id : t.escort_id;
  const rowIdx = props.resources.findIndex((r) => r.type === props.dimension && r.id === rid);
  if (rowIdx < 0) return false;
  const el = scrollEl.value;
  el.scrollTo({
    left: Math.max(0, timeToX(t.start, props.win.start, props.viewMode) - 80),
    top: Math.max(0, rowIdx * ROW_H - 60),
    behavior: 'smooth',
  });
  return true;
}

function scrollToResource(type, id) {
  const rowIdx = props.resources.findIndex((r) => r.type === type && r.id === id);
  if (rowIdx < 0) return false;
  scrollEl.value.scrollTo({ left: 0, top: Math.max(0, rowIdx * ROW_H - 60), behavior: 'smooth' });
  return true;
}

defineExpose({ hitTest, scrollToTask, scrollToResource });
</script>
