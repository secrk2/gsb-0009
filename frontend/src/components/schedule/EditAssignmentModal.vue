<template>
  <Modal :open="open" :title="title" width="600px" :dismissable="!submitting" @close="$emit('close')">
    <div v-if="task" class="edit-form">
      <div class="edit-task-line">
        <span class="mono">{{ task.waybill_no }}</span>
        <StateBadge :status="task.status" />
        <span class="card-note">{{ task.cargo_name }} · {{ task.start?.slice(5, 16).replace('T', ' ') }}</span>
      </div>

      <div class="form-grid">
        <label class="form-item">
          <span>车辆（号牌）</span>
          <select v-model.number="form.vehicle_id" class="input">
            <option v-for="v in vehicles" :key="v.id" :value="v.id">{{ v.name }}（{{ v.sub }}）</option>
          </select>
        </label>
        <label class="form-item">
          <span>押运员</span>
          <select v-model.number="form.escort_id" class="input" :disabled="mode === 'reschedule'">
            <option v-for="p in escorts" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
        </label>
        <label class="form-item">
          <span>驾驶员</span>
          <select v-model.number="form.driver_id" class="input" :disabled="mode === 'reschedule'">
            <option v-for="p in drivers" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
        </label>
        <label class="form-item">
          <span>计划出发</span>
          <input v-model="form.start" type="datetime-local" class="input">
        </label>
        <label class="form-item">
          <span>计划到达</span>
          <input v-model="form.end" type="datetime-local" class="input">
        </label>
        <label v-if="mode === 'reassign'" class="form-item form-item-wide">
          <span>改派原因（必填）<em class="field-error">*</em></span>
          <textarea v-model="form.reason" rows="2" maxlength="500" class="input"
            placeholder="如：车辆抛锚 / 驾驶员请假，改由备用车组执行"></textarea>
        </label>
      </div>
      <p class="edit-hint">提交时自动检查同车/同人时段与押运员证照；若到达晚于原计划，还需填写晚点原因。</p>
    </div>
    <template #footer>
      <button class="btn btn-ghost" :disabled="submitting" @click="$emit('close')">取消</button>
      <button class="btn btn-primary" :disabled="!canSubmit || submitting" @click="submit">
        {{ submitting ? '检查并提交…' : '提交排班' }}
      </button>
    </template>
  </Modal>
</template>

<script setup>
import { reactive, ref, computed, watch } from 'vue';
import Modal from '../Modal.vue';
import StateBadge from '../StateBadge.vue';
import { toLocalInput } from '../../utils/gantt.js';

// 已经是 datetime-local 形态（拖拽预填）则原样使用，否则按东八区格式化
const asInput = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) ? v : toLocalInput(v));

const props = defineProps({
  open: Boolean,
  mode: { type: String, default: 'assign' }, // assign | reschedule | reassign
  task: { type: Object, default: null },
  vehicles: { type: Array, default: () => [] },
  drivers: { type: Array, default: () => [] },
  escorts: { type: Array, default: () => [] },
  prefill: { type: Object, default: null },
  submitting: Boolean,
});
const emit = defineEmits(['submit', 'close']);

const title = computed(() => ({
  assign: '派车：绑定车辆与班组',
  reschedule: '调整计划时间',
  reassign: '改派：更换车辆 / 驾驶员 / 押运员',
}[props.mode]));

const form = reactive({ vehicle_id: null, driver_id: null, escort_id: null, start: '', end: '', reason: '' });

watch(() => props.open, (v) => {
  if (!v || !props.task) return;
  const p = props.prefill || {};
  form.vehicle_id = p.vehicle_id ?? props.task.vehicle_id ?? props.vehicles[0]?.id ?? null;
  form.driver_id = p.driver_id ?? props.task.driver_id ?? props.drivers[0]?.id ?? null;
  form.escort_id = p.escort_id ?? props.task.escort_id ?? props.escorts[0]?.id ?? null;
  form.start = asInput(p.start ?? props.task.start);
  form.end = asInput(p.end ?? props.task.end);
  form.reason = '';
});

const canSubmit = computed(() => form.vehicle_id && form.driver_id && form.escort_id
  && form.start && form.end && new Date(form.end) > new Date(form.start)
  && (props.mode !== 'reassign' || form.reason.trim()));

function submit() {
  if (!canSubmit.value) return;
  emit('submit', {
    mode: props.mode,
    waybill_id: props.task.waybill_id,
    vehicle_id: form.vehicle_id,
    driver_id: form.driver_id,
    escort_id: form.escort_id,
    start: form.start,
    end: form.end,
    reason: form.reason.trim(),
  });
}
</script>
