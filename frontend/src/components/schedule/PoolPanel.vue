<template>
  <div class="pool-panel">
    <div class="pool-head">
      <span>🗂️ 待派运单</span>
      <span class="badge-count">{{ items.length }}</span>
    </div>
    <p v-if="hint" class="pool-hint">{{ hint }}</p>
    <div
      v-for="t in items"
      :key="t.waybill_id"
      class="pool-item"
      :class="{ 'pool-dragging': dragId === t.waybill_id }"
      @pointerdown="canWrite ? $emit('start-drag', $event, t) : null"
      @click="$emit('pick', t)"
    >
      <div class="pool-no mono">{{ t.waybill_no }}</div>
      <div class="pool-cargo">{{ t.cargo_name }}</div>
      <div class="pool-route">{{ t.vehicle_name ? `拟派 ${t.vehicle_name}` : '未指定车辆' }}</div>
      <div class="pool-crew">{{ t.driver_name }} · {{ t.escort_name }}</div>
      <div class="pool-time">计划 {{ fmtDT(t.start) }} 出发</div>
      <div v-if="conflictMap[t.waybill_id]?.length" class="pool-clash">
        ⚠ {{ conflictMap[t.waybill_id][0].title }}
      </div>
    </div>
  </div>
</template>

<script setup>
import { fmtDT } from '../../utils.js';

defineProps({
  items: { type: Array, default: () => [] },
  canWrite: { type: Boolean, default: false },
  dragId: { type: Number, default: null },
  conflictMap: { type: Object, default: () => ({}) },
  hint: { type: String, default: '' },
});
defineEmits(['start-drag', 'pick']);
</script>
