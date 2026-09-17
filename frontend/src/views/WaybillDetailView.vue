<template>
  <div>
    <ErrorState v-if="error" :type="errorType" :message="error.message">
      <RouterLink to="/waybills" class="btn btn-ghost">返回运单列表</RouterLink>
    </ErrorState>

    <template v-else-if="detail">
      <div v-if="stale" class="stale-banner">
        ⚠️ 离线缓存数据（更新于 {{ fmtClock(cachedAt) }}），运单状态可能已被他人变更，请勿仅凭此页面判断。
      </div>

      <div class="card">
        <div class="detail-head">
          <div>
            <div class="detail-no">{{ w.waybill_no }} <StateBadge :status="w.status" /></div>
            <div class="cell-sub">{{ w.enterprise_name }} · 创建于 {{ fmtDT(w.created_at) }}</div>
          </div>
          <div class="action-bar">
            <RouterLink
              v-if="canSchedule"
              class="btn"
              :class="w.status === 'DISPATCHED' ? 'btn-primary' : 'btn-ghost'"
              :to="schedulingLink"
            >{{ w.status === 'DISPATCHED' ? '运输排班·改派' : '查看运输排班' }}</RouterLink>
            <button
              v-for="a in detail.allowed_actions"
              :key="a.action"
              class="btn"
              :class="a.action === 'abort' ? 'btn-danger' : 'btn-primary'"
              :disabled="isQueued(a.action) || (!store.online && !isQueueable(a.action))"
              :title="isQueued(a.action) ? '已离线暂存，恢复网络后自动同步' : (!store.online && !isQueueable(a.action) ? '当前离线，该操作需要网络' : '')"
              @click="onAction(a)"
            >{{ isQueued(a.action) ? `${a.label}（已暂存待同步）` : a.label }}</button>
            <span v-if="!detail.allowed_actions.length && !canSchedule" class="cell-sub">当前状态无可执行操作</span>
          </div>
        </div>

        <!-- 需填原因的操作确认区 -->
        <div v-if="acting" class="reason-panel">
          <div class="reason-title">执行「{{ actingLabel }}」请填写原因（必填，将写入流转留痕）：</div>
          <textarea v-model.trim="reason" class="input" rows="2" maxlength="500" placeholder="请输入原因"></textarea>
          <div class="reason-actions">
            <button class="btn btn-danger" :disabled="!reason" @click="confirmReasoned">确认{{ actingLabel }}</button>
            <button class="btn btn-ghost" @click="acting = ''">取消</button>
          </div>
        </div>

        <div class="info-grid">
          <div class="info-block">
            <h3>货物信息</h3>
            <dl>
              <div><dt>货物名称</dt><dd>{{ w.cargo_name }}</dd></div>
              <div><dt>危险类别</dt><dd>{{ w.cargo_class }}</dd></div>
              <div><dt>数量</dt><dd>{{ w.quantity }} {{ w.unit }}</dd></div>
            </dl>
          </div>
          <div class="info-block">
            <h3>运输路线</h3>
            <dl>
              <div><dt>装货地</dt><dd>{{ w.origin }}</dd></div>
              <div><dt>卸货地</dt><dd>{{ w.destination }}</dd></div>
              <div><dt>承运车辆</dt><dd class="mono">{{ w.vehicle_plate }}</dd></div>
            </dl>
          </div>
          <div class="info-block">
            <h3>人员绑定</h3>
            <dl>
              <div><dt>驾驶员</dt><dd>{{ w.driver_name }}（{{ w.driver_phone || '—' }}）</dd></div>
              <div><dt>押运员</dt><dd>{{ w.escort_name }}（{{ w.escort_phone || '—' }}）</dd></div>
            </dl>
          </div>
          <div class="info-block">
            <h3>时间</h3>
            <dl>
              <div><dt>计划发车</dt><dd>{{ fmtDT(w.planned_departure) }}</dd></div>
              <div><dt>计划到达</dt><dd>{{ fmtDT(w.planned_arrival) }}</dd></div>
              <div><dt>实际发车</dt><dd>{{ fmtDT(w.actual_departure) }}</dd></div>
              <div><dt>实际到达</dt><dd>{{ fmtDT(w.actual_arrival) }}</dd></div>
            </dl>
          </div>
        </div>

        <div v-if="w.abort_reason" class="abort-reason">异常中止原因：{{ w.abort_reason }}</div>
        <div v-if="w.remark" class="cell-sub">备注：{{ w.remark }}</div>
      </div>

      <div class="card">
        <div class="card-head"><h2>流转留痕</h2><span class="card-note">含离线补录记录，全程可追溯</span></div>
        <WaybillTimeline :events="detail.events" />
      </div>

      <div v-if="detail.schedule_adjustments && detail.schedule_adjustments.length" class="card">
        <div class="card-head">
          <h2>排班改派留痕</h2>
          <span class="card-note">含链式顺延逐单记录与超时到达确认</span>
        </div>
        <ul class="timeline">
          <li v-for="a in detail.schedule_adjustments" :key="a.id" class="timeline-item">
            <span class="timeline-dot" :class="a.kind === 'CHAIN_SHIFT' ? 'dot-chain' : 'dot-reassign'"></span>
            <div class="timeline-body">
              <div class="timeline-head">
                <span class="timeline-action">{{ adjustmentKind(a.kind) }}</span>
                <span v-if="a.late_arrival_confirmed" class="tag tag-late">已确认超时到达</span>
              </div>
              <div class="timeline-meta">
                {{ a.actor_name }} · {{ fmtDT(a.created_at) }}
                · 计划发车 {{ fmtDT(a.old_planned_departure) }} → {{ fmtDT(a.new_planned_departure) }}
              </div>
              <div class="timeline-reason">{{ a.reason }}</div>
            </div>
          </li>
        </ul>
      </div>
    </template>

    <div v-else class="loading">加载中…</div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { getCached, transitionWaybill } from '../api.js';
import { store, toast } from '../store.js';
import { enqueueTransition } from '../offline.js';
import { fmtDT, fmtClock } from '../utils.js';
import StateBadge from '../components/StateBadge.vue';
import ErrorState from '../components/ErrorState.vue';
import WaybillTimeline from '../components/WaybillTimeline.vue';

const route = useRoute();
const id = route.params.id;

const detail = ref(null);
const stale = ref(false);
const cachedAt = ref(null);
const error = ref(null);
const errorType = ref('error');
const acting = ref('');
const reason = ref('');

const w = computed(() => detail.value?.waybill || {});
const actingLabel = computed(() => detail.value?.allowed_actions.find((a) => a.action === acting.value)?.label || '');

// 企业管理员/监管员可进入排班；仅已派车单支持直接改派
const canSchedule = computed(() =>
  ['REGULATOR', 'ENTERPRISE_ADMIN'].includes(store.user?.role)
  && ['DISPATCHED', 'IN_TRANSIT', 'COMPLETED'].includes(w.value.status));

// 监管员需带企业上下文才能打开排班；已派车单直达改派弹窗
const schedulingLink = computed(() => {
  const q = new URLSearchParams();
  if (store.user?.role === 'REGULATOR' && w.value.enterprise_id) q.set('enterprise_id', w.value.enterprise_id);
  if (w.value.status === 'DISPATCHED') q.set('reassign', w.value.id);
  const qs = q.toString();
  return `/scheduling${qs ? `?${qs}` : ''}`;
});

const ADJUSTMENT_KIND = {
  RESCHEDULE: '调整计划时间',
  REASSIGN_VEHICLE: '改派车辆',
  REASSIGN_DRIVER: '改派驾驶员',
  REASSIGN_ESCORT: '改派押运员',
  CHAIN_SHIFT: '链式顺延',
};
const adjustmentKind = (k) => ADJUSTMENT_KIND[k] || k;

// 离线时仅启运/到达可暂存本地
const isQueueable = (action) => action === 'depart' || action === 'arrive';
// 本单已暂存待同步的动作（防止离线重复点击）
const isQueued = (action) => store.queue.some((q) => q.waybillId === Number(id) && q.action === action);

async function load() {
  try {
    const r = await getCached(`/waybills/${id}`);
    detail.value = r.data;
    stale.value = r.stale;
    cachedAt.value = r.cachedAt;
    error.value = null;
  } catch (e) {
    error.value = e;
    errorType.value = e.status === 403 ? 'forbidden' : (e.status === 404 ? 'notfound' : (e.code === 'OFFLINE' ? 'offline' : 'error'));
  }
}

function onAction(a) {
  if (!store.online) {
    if (isQueueable(a.action)) {
      enqueueTransition(w.value, a.action, a.label);
      toast(`已离线暂存「${a.label}」，恢复网络后自动同步（发生时间取当前时间）`, 'info', 6000);
    }
    return;
  }
  if (a.needReason) {
    acting.value = a.action;
    reason.value = '';
    return;
  }
  if (window.confirm(`确认执行「${a.label}」？`)) doTransition(a.action);
}

async function confirmReasoned() {
  const action = acting.value;
  await doTransition(action, reason.value);
}

async function doTransition(action, reasonText) {
  try {
    const res = await transitionWaybill(id, action, { reason: reasonText });
    toast(res.deduplicated ? '该操作此前已生效，服务端已幂等去重' : '操作成功', 'success');
    acting.value = '';
    reason.value = '';
    await load();
  } catch (e) {
    toast(e.message, 'error', 6000);
  }
}

onMounted(load);
</script>
