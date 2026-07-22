// utils.js — 通用工具函数
// Step 2：时间解析/格式化、ID 生成、日期计算、数值约束

/** 生成带前缀的唯一 ID */
export function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** "HH:mm" -> 当日分钟数（如 "09:30" -> 570） */
export function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

/** 分钟数 -> "HH:mm"（自动对 1440 取模，支持跨日回绕） */
export function minutesToTime(min) {
  min = ((Math.round(min) % 1440) + 1440) % 1440;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** 将分钟数按 snap 步长吸附（Step 5 确认：默认 5 分钟） */
export function snapMinutes(min, snap = 5) {
  return Math.round(min / snap) * snap;
}

/** 限制数值范围 */
export function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

/** 当前本地时间 "HH:mm" */
export function nowTimeStr() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Date -> "YYYY-MM-DD" */
export function toDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 今天 "YYYY-MM-DD" */
export function todayStr() {
  return toDateStr(new Date());
}

/** "YYYY-MM-DD" -> "YYYY年M月D日" */
export function formatDateCN(dStr) {
  const [y, m, d] = dStr.split('-').map(Number);
  return `${y}年${m}月${d}日`;
}

/** "YYYY-MM-DD" -> 精简日期标签：今天 / 明天 / 昨天 / "M月D日"（跨年带年份） */
export function formatDateShort(dStr) {
  const today = todayStr();
  if (dStr === today) return '今天';
  const t = new Date(`${today}T00:00:00`);
  const d = new Date(`${dStr}T00:00:00`);
  const diff = Math.round((d - t) / 86400000);
  if (diff === 1) return '明天';
  if (diff === -1) return '昨天';
  const [y, m, day] = dStr.split('-').map(Number);
  if (y !== t.getFullYear()) return `${y}年${m}月${day}日`;
  return `${m}月${day}日`;
}

/** "YYYY-MM-DD" 加减 n 天，返回新 "YYYY-MM-DD" */
export function addDays(dStr, n) {
  const d = new Date(`${dStr}T00:00:00`);
  d.setDate(d.getDate() + n);
  return toDateStr(d);
}

/** 计算两个 "HH:mm" 的分钟差（结束 - 开始） */
export function durationMinutes(start, end) {
  return timeToMinutes(end) - timeToMinutes(start);
}

/** 安全深拷贝（结构化数据） */
export function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}
