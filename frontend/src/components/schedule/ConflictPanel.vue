<template>
  <div class="conflict-panel" :class="{ 'as-error': asError }">
    <div class="conflict-head">
      <span class="conflict-title">
        <span v-if="asError">⛔ 保存被阻止</span>
        <span v-else>⚠️ 发现 {{ conflicts.length }} 项排班冲突</span>
      </span>
      <span class="conflict-sub">点击每条查看具体原因，红条任务可在甘特上定位</span>
    </div>
    <div
      v-for="(c, i) in conflicts"
      :key="c.type + (c.waybill_id || '') + i"
      class="conflict-item"
    >
      <button class="conflict-summary" @click="open = open === i ? -1 : i">
        <span class="conflict-badge">{{ icon(c.type) }}</span>
        <span class="conflict-name">{{ c.title }}</span>
        <span v-if="c.waybill_no" class="conflict-no">{{ c.waybill_no }}</span>
        <span class="conflict-caret">{{ open === i ? '▾' : '▸' }}</span>
      </button>
      <div v-if="open === i" class="conflict-detail">
        <p>{{ c.detail }}</p>
        <div v-if="c.ranges?.length" class="conflict-ranges">
          <div v-for="(r, ri) in c.ranges" :key="ri" class="conflict-range">
            <span class="cr-label">{{ r.label }}</span>
            <span>{{ fmtRangeCN(r.start, r.end) }}</span>
          </div>
        </div>
        <div class="conflict-actions">
          <button class="btn btn-danger btn-sm" @click="$emit('locate', c)">
            在甘特上定位{{ c.waybill_no ? `（${c.waybill_no}）` : '' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { fmtRangeCN } from '../../utils/gantt.js';

defineProps({
  conflicts: { type: Array, required: true },
  asError: { type: Boolean, default: false },
});
defineEmits(['locate']);
const open = ref(0);

function icon(type) {
  return {
    VEHICLE_OVERLAP: '🚚',
    DRIVER_OVERLAP: '👨‍✈️',
    ESCORT_OVERLAP: '🛡️',
    LICENSE_EXPIRED: '📄',
    VEHICLE_UNAVAILABLE: '🔧',
    DRIVER_UNAVAILABLE: '🚫',
    ESCORT_UNAVAILABLE: '🚫',
    ANCHOR_COLLISION: '🔒',
  }[type] || '⚠️';
}
</script>
