<template>
  <Modal :open="open" title="预计到达将晚点，请二次确认" width="560px" :dismissable="!submitting" @close="$emit('cancel')">
    <div class="reason-panel">
      <div class="reason-title">🕒 以下运单的预计到达时间将晚于原计划：</div>
      <div v-for="w in lateWaybills" :key="w.waybill_id" class="late-row">
        <span class="late-no">{{ w.waybill_no }}</span>
        <span class="late-time">原计划 {{ fmtDT(w.planned_arrival) }} → 新预计 {{ fmtDT(w.new_arrival) }}</span>
      </div>
      <div v-if="cascadeCount" class="late-cascade">其中含 {{ cascadeCount }} 张同车后续运单被连带顺延。</div>
    </div>
    <label class="late-reason-label">
      晚点原因（必填，将写入排班留痕）
      <textarea
        v-model="reason"
        class="input late-textarea"
        rows="3"
        maxlength="500"
        placeholder="如：目标车辆抛锚改派、装卸延误、道路管制…"
      ></textarea>
      <span class="late-count">{{ reason.length }}/500</span>
    </label>
    <template #footer>
      <button class="btn btn-ghost" :disabled="submitting" @click="$emit('cancel')">取消，回退拖拽</button>
      <button class="btn btn-primary" :disabled="!reason.trim() || submitting" @click="confirm">
        {{ submitting ? '提交中…' : '确认晚点并提交' }}
      </button>
    </template>
  </Modal>
</template>

<script setup>
import { ref, watch } from 'vue';
import Modal from '../Modal.vue';
import { fmtDT } from '../../utils.js';

const props = defineProps({
  open: Boolean,
  lateWaybills: { type: Array, default: () => [] },
  cascadeCount: { type: Number, default: 0 },
  submitting: Boolean,
});
const emit = defineEmits(['confirm', 'cancel']);
const reason = ref('');
watch(() => props.open, (v) => { if (v) reason.value = ''; });
function confirm() {
  if (!reason.value.trim()) return;
  emit('confirm', reason.value.trim());
}
</script>
