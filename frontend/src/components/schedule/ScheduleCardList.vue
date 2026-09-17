<template>
  <div class="schedule-cards">
    <section v-if="pool.length && canWrite" class="sc-group">
      <h3 class="sc-group-title">🗂️ 待派运单（{{ pool.length }}）</h3>
      <div
        v-for="t in pool"
        :key="'p' + t.waybill_id"
        class="sc-card sc-pool"
        :class="{ clash: conflictMap[t.waybill_id]?.length }"
        @click="$emit('pick', t)"
      >
        <div class="sc-head">
          <span class="mono">{{ t.waybill_no }}</span>
          <StateBadge :status="t.status" />
        </div>
        <div class="sc-cargo">{{ t.cargo_name }}</div>
        <div class="sc-meta">{{ t.driver_name }} · {{ t.escort_name }} · {{ fmtDT(t.start) }} 出发</div>
        <div v-if="conflictMap[t.waybill_id]?.length" class="sc-clash-text">
          ⚠ {{ conflictMap[t.waybill_id][0].title }}
        </div>
        <div class="sc-actions">
          <button class="btn btn-primary btn-sm btn-block" @click.stop="$emit('assign', t)">派车</button>
        </div>
      </div>
    </section>

    <section v-for="g in groups" :key="g.key" class="sc-group">
      <h3 class="sc-group-title">{{ g.label }}（{{ g.tasks.length }}）</h3>
      <div
        v-for="t in g.tasks"
        :key="t.waybill_id"
        class="sc-card"
        :class="{ clash: conflictMap[t.waybill_id]?.length, aborted: t.aborted }"
        @click="$emit('task-click', t)"
      >
        <div class="sc-head">
          <span class="mono">{{ t.waybill_no }}</span>
          <StateBadge :status="t.status" />
        </div>
        <div class="sc-cargo">{{ t.cargo_name }}</div>
        <div class="sc-meta">🚚 {{ t.vehicle_name }} · {{ t.driver_name }} / {{ t.escort_name }}</div>
        <div class="sc-meta">⏰ {{ fmtDT(t.start) }} → {{ fmtDT(t.end) }}</div>
        <div v-if="t.locked" class="sc-lock">🔒 运输中/已完成，时间锁定</div>
        <div v-if="conflictMap[t.waybill_id]?.length" class="sc-clash-text">
          <div v-for="(c, i) in conflictMap[t.waybill_id]" :key="i">⚠ {{ c.title }}：{{ c.resource_name }}</div>
        </div>
        <div v-if="canWrite && !t.locked && !t.aborted" class="sc-actions sc-actions-row">
          <button class="btn btn-ghost btn-sm" @click.stop="$emit('reschedule', t)">改时间</button>
          <button class="btn btn-primary btn-sm" @click.stop="$emit('reassign', t)">改派</button>
          <button class="btn btn-danger btn-sm" @click.stop="$emit('unbind', t)">解绑</button>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import StateBadge from '../StateBadge.vue';
import { fmtDT } from '../../utils.js';
import { startOfDayBeijing, addDays, weekdayCn, labelDay } from '../../utils/gantt.js';

const props = defineProps({
  win: { type: Object, required: true },
  viewMode: String,
  tasks: { type: Array, default: () => [] },
  pool: { type: Array, default: () => [] },
  conflictMap: { type: Object, default: () => ({}) },
  canWrite: Boolean,
});
defineEmits(['pick', 'assign', 'task-click', 'reschedule', 'reassign', 'unbind']);

const groups = computed(() => {
  const days = props.viewMode === 'week' ? 7 : 1;
  const gs = [];
  for (let i = 0; i < days; i += 1) {
    const dayStart = addDays(props.win.start, i).getTime();
    const dayEnd = addDays(props.win.start, i + 1).getTime();
    const list = props.tasks.filter((t) =>
      new Date(t.start).getTime() < dayEnd && new Date(t.end).getTime() > dayStart);
    if (!list.length) continue;
    gs.push({
      key: dayStart,
      label: `${labelDay(dayStart)} 周${weekdayCn(dayStart)}`,
      tasks: list.sort((a, b) => new Date(a.start) - new Date(b.start)),
    });
  }
  return gs;
});
</script>
