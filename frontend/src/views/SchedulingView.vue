<template>
  <div class="scheduling">
    <!-- 工具栏 -->
    <div class="card sch-toolbar">
      <div class="tb-left">
        <div class="seg">
          <button :class="{ active: view === 'week' }" @click="setView('week')">周甘特</button>
          <button :class="{ active: view === 'day' }" @click="setView('day')">日甘特</button>
        </div>
        <div class="date-nav">
          <button class="btn btn-ghost btn-sm" @click="shift(-1)">‹</button>
          <button class="btn btn-ghost btn-sm" @click="goToday">今天</button>
          <button class="btn btn-ghost btn-sm" @click="shift(1)">›</button>
          <span class="date-label">{{ rangeLabel }}</span>
        </div>
      </div>
      <div class="tb-right">
        <select v-if="store.user?.role === 'REGULATOR'" v-model.number="enterpriseId" class="input ent-select" @change="load">
          <option :value="null" disabled>选择企业</option>
          <option v-for="e in enterprises" :key="e.id" :value="e.id">{{ e.name }}</option>
        </select>
        <div class="lane-tabs">
          <button v-for="g in GROUPS" :key="g.key"
                  class="chip" :class="{ active: group === g.key }"
                  @click="group = g.key">{{ g.label }}</button>
        </div>
        <button class="btn btn-ghost btn-sm" :disabled="!board" @click="onExport">导出 CSV</button>
        <button class="btn btn-ghost btn-sm" @click="load">刷新</button>
      </div>
    </div>

    <ErrorState v-if="error" :type="errorType" :message="error.message">
      <button class="btn btn-primary" @click="load">重新加载</button>
    </ErrorState>

    <div v-else-if="needEnterprise" class="card board-empty">
      <div class="be-icon">🏢</div>
      <div class="be-title">请先选择要查看排班的企业</div>
      <div class="be-msg">监管员可查看全省企业排班，数据按企业隔离展示。</div>
      <select v-model.number="enterpriseId" class="input ent-select-inline" @change="load">
        <option :value="null" disabled>选择企业</option>
        <option v-for="e in enterprises" :key="e.id" :value="e.id">{{ e.name }}</option>
      </select>
    </div>

    <template v-else-if="board">
      <!-- 利用率（时间口径，全平台统一文案） -->
      <div class="card util-card">
        <div class="util-main">
          <div class="util-num" :class="{ warn: board.utilization.fleet.ratio > 1 }">
            {{ board.utilization.fleet.ratio_text }}
          </div>
          <div>
            <div class="util-name">{{ board.metric.name }} · {{ board.utilization.view_label }}</div>
            <div class="util-formula">口径：{{ board.metric.formula }}</div>
          </div>
        </div>
        <div class="util-hours">
          已排班 <b>{{ board.utilization.fleet.scheduled_hours }}h</b>
          / 可用 <b>{{ board.utilization.fleet.available_hours }}h</b>
          <span v-if="board.utilization.overbooked_vehicles" class="util-warn">
            · {{ board.utilization.overbooked_vehicles }} 辆车疑似超排
          </span>
        </div>
        <button class="btn btn-ghost btn-sm util-detail-btn" @click="showUtilDetail = !showUtilDetail">
          {{ showUtilDetail ? '收起车辆明细' : '车辆明细' }}
        </button>
      </div>
      <div v-if="showUtilDetail" class="card util-detail">
        <div class="cell-sub">{{ board.metric.detail }}</div>
        <table class="data-table util-table">
          <thead>
            <tr><th>车辆</th><th>状态</th><th>已排班(h)</th><th>不可用(h)</th><th>可用(h)</th><th>利用率</th></tr>
          </thead>
          <tbody>
            <tr v-for="it in board.utilization.items" :key="it.vehicle_id"
                :class="{ 'row-conflict': it.overbooked }">
              <td class="mono">{{ it.plate }}</td>
              <td>{{ it.status === 'AVAILABLE' ? '可用' : it.status === 'MAINTENANCE' ? '维修中' : '停运' }}</td>
              <td>{{ it.scheduled_hours }}</td>
              <td>{{ it.unavailable_hours }}</td>
              <td>{{ it.available_hours }}</td>
              <td :class="{ 'util-red': it.overbooked }"><b>{{ it.ratio_text }}</b></td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 全窗口空态：区分"无排班/全取消/有待核验单" -->
      <div v-if="!board.tasks.length" class="card board-empty">
        <template v-if="board.counts.aborted > 0">
          <div class="be-icon">🧯</div>
          <div class="be-title">本{{ view === 'week' ? '周' : '日' }}排班已全部取消</div>
          <div class="be-msg">
            窗口内 {{ board.counts.aborted }} 张运单异常中止、没有任何在排车辆任务。
            异常中止不可恢复，如需运输请重新填报运单。
          </div>
        </template>
        <template v-else-if="board.counts.pending > 0">
          <div class="be-icon">⏳</div>
          <div class="be-title">暂无已排班任务：有 {{ board.counts.pending }} 单还在填报/审核/核验中</div>
          <div class="be-msg">运单经监管核验通过·派车后才会进入排班甘特，请在电子运单中推进流程。</div>
          <RouterLink class="btn btn-primary" to="/waybills">去处理待派车运单</RouterLink>
        </template>
        <template v-else>
          <div class="be-icon">🗓️</div>
          <div class="be-title">{{ rangeLabel }} 暂无排班</div>
          <div class="be-msg">该企业在本{{ view === 'week' ? '周' : '日' }}窗口内还没有已派车/运输中的运单，可切换日期或先去派车。</div>
        </template>
      </div>

      <div v-else class="sch-body" :class="{ 'is-tablet': isTablet }">
        <div class="gantt-wrap card" ref="ganttWrap">
          <GanttBoard
            :board="board"
            :group="group"
            :conflicts-by-task="conflictsByTask"
            @drop="onDrop"
            @select="onSelectTask"
            @reassign="onReassignConflict"
          />
        </div>

        <!-- 右侧栏：冲突逐条 -->
        <aside class="sch-rail">
          <div class="card rail-conflicts">
            <ConflictPanel
              :conflicts="board.conflicts"
              :filter-waybill-id="selectedTaskId"
              @clear-filter="selectedTaskId = null"
              @locate="locateConflict"
              @open-waybill="goWaybill"
              @reassign="onReassignConflict"
            />
          </div>
        </aside>
      </div>

      <!-- 手机竖向卡（≤640 自动显示） -->
      <div class="mobile-cards">
        <div class="mc-hint">
          点卡片查看冲突原因与改派；运输中/已完成单 🔒 锁定不可改派。
        </div>
        <div v-for="day in mobileDays" :key="day.key" class="mc-day">
          <div class="mc-day-head">{{ day.label }}</div>
          <div v-if="!day.tasks.length" class="mc-day-empty">当日暂无排班</div>
          <div
            v-for="t in day.tasks"
            :key="t.id"
            class="mc-card"
            :class="{ conflict: conflictsByTask.has(t.id), locked: t.locked }"
            @click="selectedTaskId = t.id"
          >
            <div class="mc-card-head">
              <b>{{ t.waybill_no }}</b>
              <StateBadge :status="t.status" />
            </div>
            <div class="mc-route">{{ t.origin }} → {{ t.destination }}</div>
            <div class="mc-meta">
              {{ t.vehicle_plate }} · {{ t.driver_name }} / {{ t.escort_name }}
            </div>
            <div class="mc-meta">{{ fmtDT(t.planned_departure) }} ~ {{ fmtDT(t.planned_arrival) }}</div>
            <ul v-if="conflictsByTask.has(t.id)" class="mc-conflicts">
              <li v-for="(c, i) in conflictsByTask.get(t.id)" :key="i">
                {{ c.title }}：{{ c.message }}
              </li>
            </ul>
            <div v-if="selectedTaskId === t.id" class="mc-actions">
              <button class="btn btn-primary btn-sm" :disabled="t.locked" @click.stop="openReassign(t)">
                {{ t.locked ? '运输中/已完成，不可改派' : '改派' }}
              </button>
              <button class="btn btn-ghost btn-sm" @click.stop="goWaybill(t.id)">运单详情</button>
            </div>
          </div>
        </div>
        <div class="card rail-conflicts mc-conflict-panel">
          <ConflictPanel
            :conflicts="board.conflicts"
            :filter-waybill-id="selectedTaskId"
            @clear-filter="selectedTaskId = null"
            @open-waybill="goWaybill"
            @reassign="onReassignConflict"
          />
        </div>
      </div>
    </template>

    <div v-else class="loading">排班加载中…</div>

    <!-- 改派弹窗 -->
    <ReassignDialog
      v-if="reassignTask"
      :board="board"
      :task="reassignTask"
      :drop="dropPayload"
      @close="closeReassign"
      @done="onReassignDone"
    />
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, download } from '../api.js';
import { store, toast } from '../store.js';
import { fmtDT } from '../utils.js';
import ErrorState from '../components/ErrorState.vue';
import StateBadge from '../components/StateBadge.vue';
import GanttBoard from '../components/scheduling/GanttBoard.vue';
import ConflictPanel from '../components/scheduling/ConflictPanel.vue';
import ReassignDialog from '../components/scheduling/ReassignDialog.vue';

const router = useRouter();
const route = useRoute();
const GROUPS = [
  { key: 'vehicle', label: '车辆' },
  { key: 'driver', label: '驾驶员' },
  { key: 'escort', label: '押运员' },
];

const view = ref('week');
const date = ref('');
const group = ref('vehicle');
const enterpriseId = ref(
  store.user?.role === 'REGULATOR'
    ? (Number(route.query.enterprise_id) || null)
    : store.user?.enterprise_id,
);
const enterprises = ref([]);
const board = ref(null);
const error = ref(null);
const errorType = ref('error');
const selectedTaskId = ref(null);
const reassignTask = ref(null);
const dropPayload = ref(null);
const showUtilDetail = ref(false);
const isTablet = ref(false);
const ganttWrap = ref(null);

const needEnterprise = computed(() => store.user?.role === 'REGULATOR' && !enterpriseId.value);

const rangeLabel = computed(() => {  if (!board.value) return '';
  const s = new Date(board.value.window_start);
  const e = new Date(board.value.window_end - 60000);
  const p = (d) => `${d.getMonth() + 1}月${d.getDate()}日`;
  return view.value === 'week'
    ? `${p(s)} – ${p(e)}`
    : `${s.getFullYear()}年${p(s)}`;
});

const conflictsByTask = computed(() => {
  const m = new Map();
  for (const c of board.value?.conflicts || []) {
    if (!m.has(c.waybill_id)) m.set(c.waybill_id, []);
    m.get(c.waybill_id).push(c);
  }
  return m;
});

const mobileDays = computed(() => {
  if (!board.value) return [];
  const ws = new Date(board.value.window_start).getTime();
  const days = view.value === 'week' ? 7 : 1;
  const labels = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  return Array.from({ length: days }, (_, i) => {
    const ds = ws + i * 86400000;
    const de = ds + 86400000;
    const d = new Date(ds + 8 * 3600000);
    const dow = (d.getUTCDay() + 6) % 7;
    return {
      key: ds,
      label: days === 7 ? `${labels[dow]} ${d.getUTCMonth() + 1}/${d.getUTCDate()}` : `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`,
      tasks: board.value.tasks
        .filter((t) => new Date(t.planned_departure).getTime() >= ds && new Date(t.planned_departure).getTime() < de)
        .sort((a, b) => new Date(a.planned_departure) - new Date(b.planned_departure)),
    };
  });
});

function shiftDate(d, days) {
  const dt = new Date(`${d}T12:00:00+08:00`);
  dt.setUTCDate(dt.getUTCDate() + days);
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

async function load() {
  if (store.user?.role === 'REGULATOR' && !enterpriseId.value) {
    board.value = null;
    return;
  }
  error.value = null;
  try {
    const q = new URLSearchParams({ view: view.value, date: date.value });
    if (enterpriseId.value) q.set('enterprise_id', enterpriseId.value);
    const b = await api.get(`/scheduling/board?${q}`);
    board.value = b;
    if (!date.value) date.value = b.date;
    // 从运单详情「运输排班·改派」直达
    const rid = Number(route.query.reassign);
    if (rid && reassignTask.value === null) {
      const t = b.tasks.find((x) => x.id === rid);
      if (t) {
        selectedTaskId.value = t.id;
        if (!t.locked) openReassign(t);
      } else {
        toast('该运单不在当前周窗口内，可切换日期查找', 'info', 5000);
      }
    }
  } catch (e) {
    error.value = e;
    errorType.value = e.code === 'OFFLINE' ? 'offline' : (e.status === 403 ? 'forbidden' : 'error');
    board.value = null;
  }
}

function setView(v) {
  view.value = v;
  load();
}
function shift(delta) {
  date.value = shiftDate(date.value || board.value.date, view.value === 'week' ? 7 * delta : delta);
  load();
}
function goToday() {
  date.value = '';
  load();
}

async function onExport() {
  try {
    const q = new URLSearchParams({ view: view.value, date: date.value || board.value.date });
    if (enterpriseId.value) q.set('enterprise_id', enterpriseId.value);
    await download(`/scheduling/export.csv?${q}`);
    toast('已导出排班 CSV（含冲突明细与同口径利用率）', 'success');
  } catch (e) {
    toast(e.message, 'error', 6000);
  }
}

function onSelectTask(t) {
  selectedTaskId.value = t.id;
}

function onDrop(payload) {
  const t = board.value.tasks.find((x) => x.id === payload.task.id);
  dropPayload.value = {
    resourceType: payload.resourceType,
    resourceId: payload.resourceId,
    newStart: payload.newStart,
  };
  reassignTask.value = t;
  selectedTaskId.value = t.id;
}

function openReassign(t) {
  dropPayload.value = null;
  reassignTask.value = t;
}

function onReassignConflict(c) {
  const t = board.value.tasks.find((x) => x.id === c.waybill_id);
  if (!t) {
    toast('该冲突关联的运单不在当前窗口内，请到运单详情处理', 'info');
    return;
  }
  if (t.locked) {
    toast('运输中/已完成的运单已锁定，不能改派；请改派与之冲突的待发车单', 'info', 6000);
    return;
  }
  openReassign(t);
}

function closeReassign() {
  reassignTask.value = null;
  dropPayload.value = null;
}

async function onReassignDone(res) {
  toast(res.message || '改派成功，已链式重排', 'success', 6000);
  closeReassign();
  await load();
}

function locateConflict(c) {
  const map = { VEHICLE: 'vehicle', DRIVER: 'driver', ESCORT: 'escort' };
  group.value = map[c.resource_type] || 'vehicle';
  selectedTaskId.value = c.waybill_id;
}

function goWaybill(id) {
  router.push(`/waybills/${id}`);
}

function detectTablet() {
  isTablet.value = window.innerWidth <= 1023 && window.innerWidth > 640;
}

onMounted(async () => {
  detectTablet();
  window.addEventListener('resize', detectTablet);
  if (store.user?.role === 'REGULATOR') {
    try {
      const r = await api.get('/meta/enterprises');
      enterprises.value = r.items;
    } catch { /* 错误态由看板加载呈现 */ }
  }
  load();
});
onUnmounted(() => window.removeEventListener('resize', detectTablet));
</script>
