<template>
  <div class="conflict-panel">
    <div class="cp-head">
      <h2>
        <span v-if="conflicts.length" class="dot"></span>
        排班冲突
        <span class="cp-count" :class="{ armed: conflicts.length }">{{ conflicts.length }}</span>
      </h2>
      <button v-if="filterWaybillId" class="btn btn-ghost btn-sm" @click="$emit('clear-filter')">
        只看本单 ✕
      </button>
    </div>

    <div v-if="!conflicts.length" class="cp-ok">
      ✅ 当前窗口未发现排班冲突：车辆/人员无重叠，证照均在有效期内。
    </div>

    <ul v-else class="cp-list">
      <li
        v-for="(c, i) in shown"
        :key="`${c.waybill_id}-${c.code}-${c.resource_id}-${c.conflicting_waybill_id || i}`"
        class="cp-item"
        :class="{ open: openKey === key(c, i) }"
      >
        <button class="cp-item-head" @click="toggle(key(c, i))">
          <span class="cp-icon">{{ iconOf(c.code) }}</span>
          <span class="cp-item-main">
            <span class="cp-item-title">{{ c.title }}</span>
            <span class="cp-item-sub">
              {{ c.waybill_label }} · {{ c.resource_label }}
            </span>
          </span>
          <span class="cp-caret">{{ openKey === key(c, i) ? '收起 ▲' : '原因 ▼' }}</span>
        </button>
        <div v-if="openKey === key(c, i)" class="cp-detail">
          <p>{{ c.message }}</p>
          <div class="cp-detail-actions">
            <button class="btn btn-ghost btn-sm" @click="$emit('locate', c)">定位甘特</button>
            <button class="btn btn-ghost btn-sm" @click="$emit('open-waybill', c.waybill_id)">运单详情</button>
            <button
              v-if="canReassign(c)"
              class="btn btn-primary btn-sm"
              @click="$emit('reassign', c)"
            >去改派</button>
          </div>
        </div>
      </li>
    </ul>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue';

const props = defineProps({
  conflicts: { type: Array, required: true },
  filterWaybillId: { type: Number, default: null },
});
defineEmits(['locate', 'open-waybill', 'reassign', 'clear-filter']);

const openKey = ref(null);
const key = (c, i) => `${c.waybill_id}-${c.code}-${c.resource_id}-${c.conflicting_waybill_id || ''}-${i}`;
function toggle(k) {
  openKey.value = openKey.value === k ? null : k;
}

const shown = computed(() => (props.filterWaybillId
  ? props.conflicts.filter((c) => c.waybill_id === props.filterWaybillId)
  : props.conflicts));

const ICONS = {
  VEHICLE_DOUBLE_BOOKED: '🚚',
  DRIVER_DOUBLE_BOOKED: '🧑‍✈️',
  ESCORT_DOUBLE_BOOKED: '🛡️',
  VEHICLE_MAINTENANCE: '🔧',
  VEHICLE_UNAVAILABLE: '🚧',
  VEHICLE_LICENSE_EXPIRED: '📄',
  DRIVER_CERT_EXPIRED: '🪪',
  ESCORT_CERT_EXPIRED: '🪪',
  DRIVER_ON_LEAVE: '🏖️',
  ESCORT_ON_LEAVE: '🏖️',
};
const iconOf = (code) => ICONS[code] || '⚠️';

// 锁单上的冲突只能"看"，改派入口在另一张可动单上
function canReassign(c) {
  return c.code !== 'VEHICLE_LICENSE_EXPIRED';
}
</script>
