<template>
  <div v-if="task" class="detail-panel">
    <div class="detail-panel-head">
      <div>
        <span class="mono detail-no">{{ task.waybill_no }}</span>
        <StateBadge :status="task.status" />
      </div>
      <button class="modal-x" @click="$emit('close')">×</button>
    </div>

    <div class="detail-rows">
      <div><dt>货物</dt><dd>{{ task.cargo_name }}</dd></div>
      <div><dt>车辆</dt><dd>{{ task.vehicle_name }}</dd></div>
      <div><dt>驾驶员</dt><dd>{{ task.driver_name }}</dd></div>
      <div><dt>押运员</dt><dd>{{ task.escort_name }}</dd></div>
      <div><dt>计划出发</dt><dd>{{ fmtDT(task.start) }}</dd></div>
      <div><dt>计划到达</dt><dd>{{ fmtDT(task.end) }}</dd></div>
      <div v-if="task.locked"><dt>状态</dt><dd class="lock-note">🔒 运输中/已完成，为时间锚点，不可改派或移动</dd></div>
    </div>

    <div v-if="task.vehicle_id && util" class="detail-util">
      <div class="du-head">
        <span>{{ task.vehicle_name }} · 本窗口利用率</span>
        <span class="du-rate" :class="{ over: util.rate > 1 }">{{ fmtRate(util.rate) }}</span>
      </div>
      <div class="du-bar"><div class="du-bar-in" :style="{ width: barW }"></div></div>
      <div class="du-nums">
        已排班 {{ fmtMinutes(util.occupied_min) }} / 可用 {{ fmtMinutes(util.available_min) }} · {{ util.waybill_count }} 单
      </div>
      <div class="du-caliber">时间口径：已排班占用时长 ÷ 可用时长（与作战台、导出一致）</div>
    </div>

    <div v-if="conflicts.length" class="detail-conflicts">
      <div v-for="(c, i) in conflicts" :key="i" class="dc-item">
        <strong>{{ icon(c.type) }} {{ c.title }}</strong>
        <p>{{ c.detail }}</p>
      </div>
    </div>

    <div v-if="canWrite && !task.locked && !task.aborted" class="detail-actions">
      <template v-if="task.status === 'REGULATOR_VERIFY'">
        <button class="btn btn-primary btn-sm" @click="$emit('assign', task)">派车</button>
      </template>
      <template v-else>
        <button class="btn btn-ghost btn-sm" @click="$emit('reschedule', task)">改时间</button>
        <button class="btn btn-primary btn-sm" @click="$emit('reassign', task)">改派</button>
        <button class="btn btn-danger btn-sm" @click="$emit('unbind', task)">解绑退回</button>
      </template>
      <RouterLink class="btn btn-ghost btn-sm" :to="`/waybills/${task.waybill_id}`">运单详情</RouterLink>
    </div>
    <div v-else class="detail-actions">
      <RouterLink class="btn btn-ghost btn-sm" :to="`/waybills/${task.waybill_id}`">运单详情</RouterLink>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import StateBadge from '../StateBadge.vue';
import { fmtDT } from '../../utils.js';
import { fmtRate, fmtMinutes } from '../../utils/gantt.js';

const props = defineProps({
  task: { type: Object, default: null },
  utilization: { type: Array, default: () => [] },
  conflicts: { type: Array, default: () => [] },
  canWrite: Boolean,
});
defineEmits(['close', 'assign', 'reschedule', 'reassign', 'unbind']);

const util = computed(() => props.utilization.find((u) => u.resource_id === props.task?.vehicle_id) || null);
const barW = computed(() => `${Math.min(100, (util.value?.rate || 0) * 100).toFixed(1)}%`);
function icon(type) {
  return { VEHICLE_OVERLAP: '🚚', DRIVER_OVERLAP: '👨‍✈️', ESCORT_OVERLAP: '🛡️',
    LICENSE_EXPIRED: '📄', VEHICLE_UNAVAILABLE: '🔧', DRIVER_UNAVAILABLE: '🚫',
    ESCORT_UNAVAILABLE: '🚫', ANCHOR_COLLISION: '🔒' }[type] || '⚠️';
}
</script>
