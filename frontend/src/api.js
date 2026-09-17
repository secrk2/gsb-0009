import { store, logout } from './store.js';

export class ApiError extends Error {
  constructor(code, message, status, details = null) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

async function request(path, { method = 'GET', body, headers = {} } = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(store.token ? { Authorization: `Bearer ${store.token}` } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    store.online = false;
    throw new ApiError('OFFLINE', '网络连接失败，当前处于离线状态', 0);
  }
  if (!store.online) store.online = true;

  let data = null;
  try { data = await res.json(); } catch { /* 空响应 */ }

  if (res.status === 401 && path !== '/auth/login') {
    logout();
    if (!location.pathname.startsWith('/login')) location.assign('/login');
    throw new ApiError('UNAUTHORIZED', '登录已过期，请重新登录', 401);
  }
  if (!res.ok) {
    throw new ApiError(
      data?.error?.code || 'ERROR',
      data?.error?.message || `请求失败（${res.status}）`,
      res.status,
      data?.error?.details || null,
    );
  }
  return data;
}

const CACHE_PREFIX = 'ayt_cache:';

/**
 * GET + 本地缓存：在线时刷新缓存；离线时回退缓存并标记 stale，
 * 页面必须展示「缓存数据·可能已过期」，避免拿旧状态当真。
 */
export async function getCached(path) {
  try {
    const data = await request(path);
    try {
      localStorage.setItem(CACHE_PREFIX + path, JSON.stringify({ data, ts: Date.now() }));
    } catch { /* 存储满则忽略 */ }
    return { data, stale: false, cachedAt: null };
  } catch (e) {
    if (e.code === 'OFFLINE') {
      const raw = localStorage.getItem(CACHE_PREFIX + path);
      if (raw) {
        const c = JSON.parse(raw);
        return { data: c.data, stale: true, cachedAt: c.ts };
      }
    }
    throw e;
  }
}

export const api = {
  get: (path) => request(path),
  post: (path, body, headers = {}) => request(path, { method: 'POST', body, headers }),
};

export function newIdempotencyKey() {
  return crypto.randomUUID ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

/** 状态流转（幂等键可外部指定——离线队列重放时必须沿用首次生成的键） */
export function transitionWaybill(id, action, { reason, occurredAt, idempotencyKey } = {}) {
  return api.post(
    `/waybills/${id}/transition`,
    { action, reason, occurred_at: occurredAt },
    { 'Idempotency-Key': idempotencyKey || newIdempotencyKey() },
  );
}

// ---------- 运输排班 ----------

const qs = (params) => Object.entries(params)
  .filter(([, v]) => v !== undefined && v !== null && v !== '')
  .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
  .join('&');

export const getGantt = (params) => request(`/schedules/gantt?${qs(params)}`);
export const getUtilization = (params) => request(`/schedules/utilization?${qs(params)}`);
export const checkSchedule = (body) => api.post('/schedules/check', body);

function scheduleWrite(path, body) {
  return api.post(path, body, { 'Idempotency-Key': newIdempotencyKey() });
}
export const assignSchedule = (body) => scheduleWrite('/schedules/assign', body);
export const rescheduleSchedule = (body) => scheduleWrite('/schedules/reschedule', body);
export const reassignSchedule = (body) => scheduleWrite('/schedules/reassign', body);
export const unbindSchedule = (body) => scheduleWrite('/schedules/unbind', body);

/** 利用率 CSV 导出（需带 JWT，取 Blob 触发下载） */
export async function downloadScheduleCsv(params) {
  const res = await fetch(`/api/schedules/export.csv?${qs(params)}`, {
    headers: store.token ? { Authorization: `Bearer ${store.token}` } : {},
  });
  if (!res.ok) throw new ApiError('CSV_FAILED', '导出失败，请稍后重试', res.status);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `车辆利用率_${params.from?.slice(0, 10) || ''}_${params.to?.slice(0, 10) || ''}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
