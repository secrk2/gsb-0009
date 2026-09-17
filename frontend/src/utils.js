// 展示辅助
export function fmtDT(v) {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtTime(v) {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtClock(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const pad = (n) => String(n).padStart(2, '0');

/** Date → datetime-local 输入框值（本地墙钟） */
export function toLocalInput(v) {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** datetime-local 值 → 带东八区偏移的 ISO 串（服务端按 +08:00 解释） */
export function localInputToIso(s) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(String(s || ''));
  if (!m) return null;
  return `${m[1]}T${m[2]}:00+08:00`;
}

export const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

export const ACTION_LABELS = {
  create: '创建运单',
  submit: '提交自审',
  return_to_draft: '退回修改',
  enterprise_approve: '自审通过',
  regulator_return: '监管退回',
  regulator_approve: '核验通过·派车',
  depart: '启运',
  arrive: '到达签收',
  abort: '异常中止',
};
