// store.js — 集中式状态管理 + 存储抽象层（多计划模型）
// schema v3：plans[] + activePlanId，支持多计划切换
// 每个 plan 独立保存任务/步骤/里程碑，日程全局但按 plan 筛选。

import {
  uid,
  todayStr,
  timeToMinutes,
  minutesToTime,
  durationMinutes,
  clamp,
} from './utils.js';

/* ============================================================
   存储抽象层（StorageAdapter）
   ============================================================ */
class StorageAdapter {
  load(/* key */) { throw new Error('StorageAdapter.load() 未实现'); }
  save(/* key, value */) { throw new Error('StorageAdapter.save() 未实现'); }
}

class LocalStorageAdapter extends StorageAdapter {
  constructor(namespace = 'plandecomposer') {
    super();
    this.ns = namespace;
  }
  load(key) {
    try {
      const raw = localStorage.getItem(`${this.ns}:${key}`);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }
  save(key, value) {
    try { localStorage.setItem(`${this.ns}:${key}`, JSON.stringify(value)); }
    catch (e) { console.warn('[store] 保存失败', e); }
  }
}

/* ============================================================
   常量与默认值
   ============================================================ */
const STORAGE_KEY = 'state';
const SCHEMA_VERSION = 3;

export const PANEL_IDS = ['task', 'calendar', 'detail'];
export const CENTER_PANEL = 'calendar';
export const MIN_PANEL_WIDTH = 240;

const DEFAULT_LAYOUT = {
  order: ['task', 'calendar', 'detail'],
  widths: { task: 340, detail: 340 },
};

function defaultState() {
  return {
    version: SCHEMA_VERSION,
    plans: [],            // Plan[]
    activePlanId: null,   // 当前激活的计划 id
    schedule: [],         // ScheduleItem[]（全局）
    currentDate: todayStr(),
    layout: { ...DEFAULT_LAYOUT, order: [...DEFAULT_LAYOUT.order] },
  };
}

/* ============================================================
   数据结构（schema v3）
   Plan         { id, title, description, createdAt, milestones: Milestone[],
                  dailyCapacity, steps: Step[] }
   Milestone    { title, dayRange, deliverable }
   Step         { id, taskId(→planId), title, standard, estimatedMinutes, order,
                  milestone, day, resource: Resource|null, output,
                  subtasks: Subtask[], checklist: CheckItem[], completed }
   Resource     { name, url, type }  // article|video|practice|other
   Subtask/CheckItem { id, title, completed }
   ScheduleItem { id, stepId, date, startTime, endTime, completed, note }
   ============================================================ */

/** 修补单个 plan 的字段到 v3（幂等） */
function ensurePlanV3(plan) {
  if (!Array.isArray(plan.steps)) plan.steps = [];
  if (!Array.isArray(plan.milestones)) plan.milestones = [];
  if (typeof plan.dailyCapacity !== 'string') plan.dailyCapacity = '';
  (plan.steps || []).forEach((s) => {
    if (!Array.isArray(s.subtasks)) s.subtasks = [];
    if (!Array.isArray(s.checklist)) s.checklist = [];
    if (s.resource === undefined) s.resource = null;
    if (typeof s.output !== 'string') s.output = '';
    if (s.milestone === undefined) s.milestone = null;
    if (s.day === undefined) s.day = null;
    if (typeof s.completed !== 'boolean') s.completed = false;
    // 修正 taskId → 指向 plan.id
    if (s.taskId !== plan.id) s.taskId = plan.id;
  });
  return plan;
}

/** v2（单计划 tasks[]） → v3（多计划 plans[]）迁移 */
function migrateV2toV3(saved) {
  saved.version = 3;
  const plans = [];
  // 旧的 tasks[] 每条转为一个 plan
  if (Array.isArray(saved.tasks)) {
    saved.tasks.forEach((t) => {
      plans.push(ensurePlanV3({
        id: t.id || uid('plan'),
        title: t.title || '未命名计划',
        description: t.description || '',
        createdAt: t.createdAt || Date.now(),
        milestones: Array.isArray(t.milestones) ? t.milestones : [],
        dailyCapacity: typeof t.dailyCapacity === 'string' ? t.dailyCapacity : '',
        steps: Array.isArray(t.steps) ? t.steps : [],
      }));
    });
    delete saved.tasks;
  }
  // 旧版没有 plans 字段
  if (!Array.isArray(saved.plans)) saved.plans = [];
  saved.plans = [...plans, ...saved.plans]; // 旧任务排前面
  saved.activePlanId = saved.plans.length > 0 ? saved.plans[0].id : null;
  return saved;
}

/* ============================================================
   Store
   ============================================================ */
class Store {
  constructor(adapter) {
    this.adapter = adapter;
    this.listeners = new Set();
    this.state = this._load();
  }

  _load() {
    let saved = this.adapter.load(STORAGE_KEY);
    if (!saved) {
      const fresh = defaultState();
      this.adapter.save(STORAGE_KEY, fresh);
      return fresh;
    }
    // v1/v2 → v3 迁移
    if (saved.version < 3) {
      if (saved.version === 1 && !saved.plans) {
        // 中间过 v2 补字段（幂等）
        (saved.tasks || []).forEach((t) => {
          if (!Array.isArray(t.milestones)) t.milestones = [];
          if (typeof t.dailyCapacity !== 'string') t.dailyCapacity = '';
        });
      }
      saved = migrateV2toV3(saved);
      this.adapter.save(STORAGE_KEY, saved);
    }
    if (saved.version !== SCHEMA_VERSION) {
      const fresh = defaultState();
      this.adapter.save(STORAGE_KEY, fresh);
      return fresh;
    }
    // 兜底
    if (!Array.isArray(saved.plans)) saved.plans = [];
    if (!saved.activePlanId && saved.plans.length > 0) saved.activePlanId = saved.plans[0].id;
    if (!saved.layout) saved.layout = defaultState().layout;
    if (!saved.layout.order) saved.layout.order = [...DEFAULT_LAYOUT.order];
    if (!saved.layout.widths) saved.layout.widths = { ...DEFAULT_LAYOUT.widths };
    return saved;
  }

  _persist() { this.adapter.save(STORAGE_KEY, this.state); }
  _emit() { this._persist(); this.listeners.forEach((fn) => fn(this.state)); }

  getState() { return this.state; }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  /* ---------------- 当前日期 ---------------- */
  setCurrentDate(dStr) { this.state.currentDate = dStr; this._emit(); }

  /* ---------------- 计划 Plan（核心新增） ---------------- */

  /** 获取当前激活的计划（可能为 null，表示尚无计划） */
  getActivePlan() {
    return this.state.plans.find((p) => p.id === this.state.activePlanId) || null;
  }

  /** 获取当前激活计划的步骤列表（排序后） */
  getActiveSteps() {
    const plan = this.getActivePlan();
    if (!plan || !Array.isArray(plan.steps)) return [];
    return [...plan.steps].sort((a, b) => a.order - b.order);
  }

  /** 按 id 获取计划 */
  getPlan(id) { return this.state.plans.find((p) => p.id === id) || null; }

  /** 创建新计划（激活并切过去） */
  createPlan({ title, description = '' }) {
    const plan = {
      id: uid('plan'),
      title: String(title).trim() || '未命名计划',
      description: String(description),
      createdAt: Date.now(),
      milestones: [],
      dailyCapacity: '',
      steps: [],
    };
    this.state.plans.push(plan);
    this.state.activePlanId = plan.id;
    this._emit();
    return plan;
  }

  /** 切换到指定计划 */
  switchPlan(planId) {
    if (!this.state.plans.some((p) => p.id === planId)) return null;
    if (this.state.activePlanId === planId) return this.getPlan(planId);
    this.state.activePlanId = planId;
    this._emit();
    return this.getPlan(planId);
  }

  /** 删除计划（同时清除关联日程）；返回被删计划的 id，或 null */
  deletePlan(planId) {
    const idx = this.state.plans.findIndex((p) => p.id === planId);
    if (idx < 0) return null;
    const removed = this.state.plans.splice(idx, 1)[0];
    const stepIds = new Set((removed.steps || []).map((s) => s.id));
    this.state.schedule = this.state.schedule.filter((s) => !stepIds.has(s.stepId));
    // 如果删的是当前激活的，选第一个或置 null
    if (this.state.activePlanId === planId) {
      this.state.activePlanId = this.state.plans.length > 0 ? this.state.plans[0].id : null;
    }
    this._emit();
    return planId;
  }

  /**
   * 将 AI 分解结果写入当前激活的计划。
   * 如果当前无计划，自动创建一个。
   */
  replaceCurrentTask({ title, description = '', steps = [], plan = null }) {
    let active = this.getActivePlan();
    if (!active) {
      active = this.createPlan({ title: '新计划' });
    }
    // 【数据安全】替换前捕获当前计划的旧步骤 id，只清除本计划日程
    const oldStepIds = new Set((active.steps || []).map((s) => s.id));

    active.title = title || active.title;
    active.description = description || active.description;
    active.milestones = Array.isArray(plan && plan.milestones)
      ? plan.milestones.map((m) => ({
          title: String(m.title || ''),
          dayRange: String(m.dayRange || m.day_range || ''),
          deliverable: String(m.deliverable || ''),
        }))
      : [];
    active.dailyCapacity = String((plan && (plan.dailyCapacity || plan.daily_capacity)) || '');
    active.steps = steps.map((s, i) => ({
      id: uid('step'),
      taskId: active.id,
      title: s.title,
      standard: s.standard || '',
      estimatedMinutes: s.estimatedMinutes || 30,
      completed: false,
      order: i,
      milestone: s.milestone || null,
      day: Number.isFinite(s.day) ? s.day : null,
      resource: s.resource
        ? { name: String(s.resource.name || ''), url: String(s.resource.url || ''), type: String(s.resource.type || 'article') }
        : null,
      output: s.output || '',
      subtasks: (s.subtasks || []).map((x) => ({ id: uid('sub'), title: x.title, completed: !!x.completed })),
      checklist: (s.checklist || []).map((x) => ({ id: uid('chk'), title: x.title, completed: !!x.completed })),
    }));
    // 【数据安全】只清除当前计划的旧日程，保留其他计划的日程
    this.state.schedule = this.state.schedule.filter((s) => !oldStepIds.has(s.stepId));
    this._emit();
    return active;
  }

  /* ---------------- 步骤 Step ---------------- */
  addStep({ taskId, title, standard = '', estimatedMinutes = 30, order, subtasks = [] }) {
    const plan = this.getPlan(taskId); if (!plan) return null;
    const step = {
      id: uid('step'), taskId, title, standard, estimatedMinutes, completed: false,
      order: order ?? plan.steps.length, milestone: null, day: null, resource: null, output: '',
      subtasks: (subtasks || []).map((x) => ({ id: uid('sub'), title: x.title, completed: !!x.completed })),
      checklist: [],
    };
    plan.steps.push(step); this._emit(); return step;
  }

  /* ---------------- 步骤列表项（subtasks / checklist 同构） ---------------- */
  addStepListItem(stepId, field, title) {
    const step = this.getStep(stepId);
    if (!step || (field !== 'subtasks' && field !== 'checklist')) return null;
    if (!Array.isArray(step[field])) step[field] = [];
    const item = { id: uid(field === 'subtasks' ? 'sub' : 'chk'), title: String(title).trim(), completed: false };
    if (!item.title) return null;
    step[field].push(item); this._emit(); return item;
  }
  toggleStepListItem(stepId, field, itemId) {
    const step = this.getStep(stepId); if (!step || !Array.isArray(step[field])) return;
    const item = step[field].find((s) => s.id === itemId); if (!item) return;
    item.completed = !item.completed; this._emit();
  }
  deleteStepListItem(stepId, field, itemId) {
    const step = this.getStep(stepId); if (!step || !Array.isArray(step[field])) return;
    step[field] = step[field].filter((s) => s.id !== itemId); this._emit();
  }

  addSubtask(stepId, title) { return this.addStepListItem(stepId, 'subtasks', title); }
  toggleSubtask(stepId, subtaskId) { return this.toggleStepListItem(stepId, 'subtasks', subtaskId); }
  deleteSubtask(stepId, subtaskId) { return this.deleteStepListItem(stepId, 'subtasks', subtaskId); }

  toggleStepComplete(stepId) {
    const step = this.getStep(stepId); if (!step) return;
    step.completed = !step.completed;
    this.state.schedule.forEach((s) => { if (s.stepId === stepId) s.completed = step.completed; });
    this._emit();
  }

  getStep(id) {
    for (const p of this.state.plans) {
      const s = p.steps.find((x) => x.id === id);
      if (s) return s;
    }
    return null;
  }

  updateStep(id, patch) { const s = this.getStep(id); if (!s) return null; Object.assign(s, patch); this._emit(); return s; }

  updateStepEnrichment(stepId, { resource, steps, checklist, output }) {
    const step = this.getStep(stepId); if (!step) return null;
    if (resource && !step.resource) step.resource = resource;
    if (output && !step.output) step.output = output;
    if (Array.isArray(steps) && steps.length && (!step.subtasks || !step.subtasks.length))
      step.subtasks = steps.map((x) => ({ id: uid('sub'), title: String(x || ''), completed: false }));
    if (Array.isArray(checklist) && checklist.length && (!step.checklist || !step.checklist.length))
      step.checklist = checklist.map((x) => ({ id: uid('chk'), title: String(x || ''), completed: false }));
    this._emit(); return step;
  }

  deleteStep(id) {
    for (const p of this.state.plans) {
      const idx = p.steps.findIndex((s) => s.id === id);
      if (idx >= 0) { p.steps.splice(idx, 1); break; }
    }
    this.state.schedule = this.state.schedule.filter((s) => s.stepId !== id);
    this._emit();
  }

  moveStep(stepId, dir) {
    for (const p of this.state.plans) {
      const idx = p.steps.findIndex((s) => s.id === stepId);
      if (idx < 0) continue;
      const target = idx + (dir === 'up' ? -1 : 1);
      if (target < 0 || target >= p.steps.length) return;
      [p.steps[idx], p.steps[target]] = [p.steps[target], p.steps[idx]];
      p.steps.forEach((s, i) => { s.order = i; });
      this._emit(); return;
    }
  }

  /* ---------------- 日程 ScheduleItem（全局；按 plan 筛选） ---------------- */
  addSchedule({ stepId, date, startTime, endTime, completed = false, note = '' }) {
    this.state.schedule = this.state.schedule.filter((s) => s.stepId !== stepId);
    const item = { id: uid('sch'), stepId, date, startTime, endTime, completed, note };
    this.state.schedule.push(item); this._emit(); return item;
  }

  getSchedule(id) { return this.state.schedule.find((s) => s.id === id) || null; }

  updateSchedule(id, patch) { const s = this.getSchedule(id); if (!s) return null; Object.assign(s, patch); this._emit(); return s; }
  deleteSchedule(id) { this.state.schedule = this.state.schedule.filter((s) => s.id !== id); this._emit(); }

  getScheduleByDate(date) {
    return this.state.schedule
      .filter((s) => s.date === date)
      .sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));
  }

  /** 获取当前计划在某天的日程（按步骤归属筛选） */
  getScheduleByDateForPlan(date, planId) {
    const plan = this.getPlan(planId);
    if (!plan) return [];
    const stepIds = new Set(plan.steps.map((s) => s.id));
    return this.getScheduleByDate(date).filter((s) => stepIds.has(s.stepId));
  }

  scheduledMinutesForStepOnDate(stepId, date) {
    return this.getScheduleByDate(date)
      .filter((s) => s.stepId === stepId)
      .reduce((sum, s) => sum + durationMinutes(s.startTime, s.endTime), 0);
  }

  isStepScheduled(stepId, date) {
    return this.state.schedule.some((s) => s.stepId === stepId && s.date === date);
  }

  getScheduleForStepOnDate(stepId, date) {
    return this.state.schedule.find((s) => s.stepId === stepId && s.date === date) || null;
  }

  moveSchedule(id, newStartMinutes, newDate) {
    const item = this.getSchedule(id); if (!item) return null;
    const dur = Math.max(durationMinutes(item.startTime, item.endTime), 5);
    const startMin = clamp(newStartMinutes, 0, 1440 - dur);
    item.startTime = minutesToTime(startMin);
    item.endTime = minutesToTime(startMin + dur);
    if (newDate) item.date = newDate;
    this._emit(); return item;
  }

  /* ---------------- 面板布局配置 ---------------- */
  getLayout() { return this.state.layout; }
  setLayoutOrder(order) {
    const valid = PANEL_IDS.every((id) => order.includes(id)) && order.length === PANEL_IDS.length;
    if (!valid) { console.warn('[store] setLayoutOrder 参数非法', order); return; }
    this.state.layout.order = [...order]; this._emit();
  }
  setLayoutWidths(widths) {
    this.state.layout.widths = { ...this.state.layout.widths, ...widths }; this._emit();
  }
}

export const store = new Store(new LocalStorageAdapter());
export { LocalStorageAdapter, StorageAdapter };
