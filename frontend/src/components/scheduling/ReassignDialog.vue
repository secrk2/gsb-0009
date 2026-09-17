<template>
  <div class="modal-mask" @click.self="$emit('close')">
    <div class="modal reassign-modal">
      <div class="modal-head">
        <h2>改派运单 {{ task.waybill_no }}</h2>
        <button class="btn btn-ghost btn-sm" @click="$emit('close')">✕</button>
      </div>

      <div class="rs-target">
        <div><b>{{ task.origin }}</b> → <b>{{ task.destination }}</b></div>
        <div class="cell-sub">
          原车 {{ task.vehicle_plate }} · 驾驶员 {{ task.driver_name }} · 押运员 {{ task.escort_name }}
        </div>
        <div class="cell-sub">
          原计划 {{ fmtDT(task.planned_departure) }} 发车，{{ fmtDT(task.planned_arrival) }} 到达
        </div>
      </div>

      <div class="rs-form">
        <label class="form-item">
          <span>改派车辆 *（车辆抛锚时另选；不换车保持原车）</span>
          <select v-model.number="form.new_vehicle_id" class="input">
            <option v-for="v in board.lanes.vehicles" :key="v.id" :value="v.id" :disabled="v.status !== 'AVAILABLE'">
              {{ v.plate }}{{ v.status === 'MAINTENANCE' ? '（维修中）' : v.status === 'RETIRED' ? '（停运）' : '' }}
            </option>
          </select>
        </label>
        <label class="form-item">
          <span>新计划发车时间 *</span>
          <input v-model="form.new_departure" type="datetime-local" class="input" />
        </label>
        <label class="form-item">
          <span>更换驾驶员（人员请假时另选，不换保持原人）</span>
          <select v-model.number="form.new_driver_id" class="input">
            <option :value="null">保持 {{ task.driver_name }}</option>
            <option v-for="d in board.lanes.drivers" :key="d.id" :value="d.id">
              {{ d.name }}{{ dExpired(d) ? '（证照过期）' : '' }}
            </option>
          </select>
        </label>
        <label class="form-item">
          <span>更换押运员</span>
          <select v-model.number="form.new_escort_id" class="input">
            <option :value="null">保持 {{ task.escort_name }}</option>
            <option v-for="s in board.lanes.escorts" :key="s.id" :value="s.id">
              {{ s.name }}{{ sExpired(s) ? '（证照过期）' : '' }}
            </option>
          </select>
        </label>
      </div>

      <!-- 预检状态 -->
      <div v-if="checking" class="rs-checking">正在校验证照/重叠并计算链式顺延…</div>

      <template v-if="preview">
        <!-- 超时到达二次确认 -->
        <div v-if="preview.arrival_delayed" class="rs-late">
          <div class="rs-late-title">⚠️ 该落点将导致超时到达</div>
          <div class="cell-sub">
            新计划到达 {{ fmtDT(targetChange?.new_planned_arrival) }}，晚于原计划 {{ fmtDT(task.planned_arrival) }}。
            运输安全要求：必须勾选已知晓并填写原因后才能提交。
          </div>
          <label class="rs-confirm">
            <input type="checkbox" v-model="form.late_arrival_confirmed" />
            我已知晓该落点会超时到达，确认按此排班
          </label>
        </div>

        <!-- 链式顺延预览 -->
        <div v-if="chainChanges.length" class="rs-chain">
          <div class="rs-chain-title">🔗 后续 {{ chainChanges.length }} 单将链式顺延（运输中/已完成单不动，只后移不提前）</div>
          <div v-for="c in chainChanges" :key="c.waybill_id" class="rs-chain-item">
            <b>{{ c.waybill_label }}</b>
            <span>{{ fmtDT(c.old_planned_departure) }} → {{ fmtDT(c.new_planned_departure) }}</span>
          </div>
        </div>

        <!-- 残余冲突：只拦截本次改派/顺延涉及的单 -->
        <div v-if="blockingConflicts.length" class="rs-conflicts">
          <div class="rs-chain-title">❗ 该方案涉及的运单仍有 {{ blockingConflicts.length }} 条冲突，提交将被拒绝：</div>
          <div v-for="(c, i) in blockingConflicts" :key="i" class="rs-conflict-item">· {{ c.title }}：{{ c.message }}</div>
        </div>
        <div v-if="otherConflicts.length" class="rs-chain">
          <div class="rs-chain-title">ℹ️ 窗口内另有 {{ otherConflicts.length }} 条既有冲突与本次改派无关，不阻塞本次提交：</div>
          <div v-for="(c, i) in otherConflicts" :key="i" class="rs-conflict-item">· [{{ c.waybill_label }}] {{ c.title }}</div>
        </div>
      </template>

      <label class="form-item rs-reason">
        <span>改派/超时原因 *（强制留痕，写入排班记录，最多 500 字）</span>
        <textarea v-model.trim="form.reason" class="input" rows="2" maxlength="500"
          placeholder="如：云A·D3107 发动机故障抛锚拖修 / 驾驶员张远航家中急事请假，改由备用车与备班人员承运"></textarea>
      </label>

      <div v-if="submitError" class="form-error-banner">{{ submitError }}</div>

      <div class="rs-actions">
        <button class="btn btn-primary" :disabled="!canSubmit" @click="onSubmit">
          {{ submitting ? '提交中…' : '确认改派并链式重排' }}
        </button>
        <button class="btn btn-ghost" @click="$emit('close')">取消</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, reactive, ref, watch, onMounted, onUnmounted } from 'vue';
import { api, newIdempotencyKey } from '../../api.js';
import { toLocalInput, localInputToIso, fmtDT } from '../../utils.js';

const props = defineProps({
  board: { type: Object, required: true },
  task: { type: Object, required: true },
  drop: { type: Object, default: null }, // {resourceType, resourceId, newStart}
});
const emit = defineEmits(['close', 'done']);

const form = reactive({
  new_vehicle_id: props.task.vehicle_id,
  new_driver_id: null,
  new_escort_id: null,
  new_departure: toLocalInput(new Date(props.drop?.newStart || props.task.planned_departure)),
  late_arrival_confirmed: false,
  reason: '',
});
if (props.drop?.resourceType === 'vehicle') form.new_vehicle_id = props.drop.resourceId;
if (props.drop?.resourceType === 'driver') form.new_driver_id = props.drop.resourceId;
if (props.drop?.resourceType === 'escort') form.new_escort_id = props.drop.resourceId;

const checking = ref(false);
const preview = ref(null);
const submitError = ref('');
const submitting = ref(false);
let timer = null;

const dExpired = (d) => (d.certs || []).some((c) => c.expired);
const sExpired = dExpired;

const targetChange = computed(() => preview.value?.changes?.[0] || null);
const chainChanges = computed(() => (preview.value?.changes || []).filter((c) => c.waybill_id !== props.task.id));
const involvedIds = computed(() => new Set((preview.value?.changes || []).map((t) => t.waybill_id)));
const blockingConflicts = computed(() => (preview.value?.conflicts || [])
  .filter((c) => involvedIds.value.has(c.waybill_id)));
const otherConflicts = computed(() => (preview.value?.conflicts || [])
  .filter((c) => !involvedIds.value.has(c.waybill_id)));

const canSubmit = computed(() => !!form.reason.trim()
  && !!form.new_vehicle_id
  && !!form.new_departure
  && (!preview.value?.arrival_delayed || form.late_arrival_confirmed)
  && !blockingConflicts.value.length
  && !checking.value
  && !submitting.value);

async function runCheck() {
  if (!form.new_vehicle_id || !form.new_departure) return;
  const iso = localInputToIso(form.new_departure);
  if (!iso) return;
  checking.value = true;
  submitError.value = '';
  try {
    const res = await api.post('/scheduling/check', {
      enterprise_id: props.board.enterprise_id,
      waybill_id: props.task.id,
      new_vehicle_id: form.new_vehicle_id,
      new_driver_id: form.new_driver_id || undefined,
      new_escort_id: form.new_escort_id || undefined,
      new_departure: iso,
    });
    preview.value = res;
    if (!res.arrival_delayed) form.late_arrival_confirmed = false;
  } catch (e) {
    preview.value = null;
    submitError.value = e.message;
  } finally {
    checking.value = false;
  }
}

watch(() => [form.new_vehicle_id, form.new_driver_id, form.new_escort_id, form.new_departure],
  () => {
    clearTimeout(timer);
    timer = setTimeout(runCheck, 350);
  });

onMounted(runCheck);
onUnmounted(() => clearTimeout(timer));

async function onSubmit() {
  submitting.value = true;
  submitError.value = '';
  try {
    const res = await api.post(`/scheduling/waybills/${props.task.id}/reassign`, {
      enterprise_id: props.board.enterprise_id,
      new_vehicle_id: form.new_vehicle_id,
      new_driver_id: form.new_driver_id || undefined,
      new_escort_id: form.new_escort_id || undefined,
      new_departure: localInputToIso(form.new_departure),
      late_arrival_confirmed: form.late_arrival_confirmed,
      reason: form.reason.trim(),
    }, { 'Idempotency-Key': newIdempotencyKey() });
    emit('done', res);
  } catch (e) {
    submitError.value = e.message;
    if (e.code === 'LATE_ARRIVAL_CONFIRM_REQUIRED') form.late_arrival_confirmed = false;
    runCheck();
  } finally {
    submitting.value = false;
  }
}
</script>
