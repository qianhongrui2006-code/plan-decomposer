// store.js — 集中式状态管理 + 存储抽象层
// Step 2：状态管理、localStorage 持久化、CRUD、数据版本控制、面板布局配置

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
   业务代码只依赖此接口，底层可替换为后端 API。
   ============================================================ */
class StorageAdapter {
  load(/* key */) {
    throw new Error('StorageAdapter.load() 未实现');
  }
  save(/* key, value */) {
    throw new Error('StorageAdapter.save() 未实现');
  }
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
    } catch {
      return null;
    }
  }
  save(key, value) {
    try {
      localStorage.setItem(`${this.ns}:${key}`, JSON.stringify(value));
    } catch (e) {
      console.warn('[store] 保存失败（可能超出配额或隐私模式）', e);
    }
  }
}

/* ============================================================
   常量与默认值
   ============================================================ */
const STORAGE_KEY = 'state';
const SCHEMA_VERSION = 2;

export const PANEL_IDS = ['task', 'calendar', 'detail'];
export const CENTER_PANEL = 'calendar'; // 中间面板始终弹性填充，不存固定宽度
export const MIN_PANEL_WIDTH = 240; // 用户确认需要最小宽度，默认 240px（可调）

const DEFAULT_LAYOUT = {
  order: ['task', 'calendar', 'detail'],
  widths: { task: 340, detail: 340 }, // calendar 为 1fr，不存固定值
};

function defaultState() {
  return {
    version: SCHEMA_VERSION,
    tasks: [], // Task[]
    schedule: [], // ScheduleItem[]
    currentDate: todayStr(),
    layout: {
      order: [...DEFAULT_LAYOUT.order],
      widths: { ...DEFAULT_LAYOUT.widths },
    },
  };
}

/* ============================================================
   数据结构（schema v2）
   Task      { id, title, description, createdAt, steps: Step[],
               milestones: Milestone[], dailyCapacity }
   Milestone { title, dayRange, deliverable }   // 计划级阶段元信息（AI 生成）
   Step      { id, taskId, title, standard, estimatedMinutes, order,
               milestone, day, resource, output,
               subtasks: Subtask[], checklist: CheckItem[] }
   Resource  { name, url, type }                // type: article|video|practice|other
   Subtask / CheckItem { id, title, completed } // 执行步骤 / 验收清单（同构）
   ScheduleItem { id, stepId, date, startTime, endTime, completed, note }
   ============================================================ */

/** v1 → v2 迁移：为旧数据补齐新字段（保留全部用户内容，不清空） */
function migrateV1toV2(saved) {
  saved.version = 2;
  (saved.tasks || []).forEach((t) => {
    if (!Array.isArray(t.milestones)) t.milestones = [];
    if (typeof t.dailyCapacity !== 'string') t.dailyCapacity = '';
    (t.steps || []).forEach((s) => {
      if (!Array.isArray(s.checklist)) s.checklist = [];
      if (s.resource === undefined) s.resource = null;
      if (typeof s.output !== 'string') s.output = '';
      if (s.milestone === undefined) s.milestone = null;
      if (s.day === undefined) s.day = null;
    });
  });
  return saved;
}

class Store {
  constructor(adapter) {
    this.adapter = adapter;
    this.listeners = new Set();
    this.state = this._load();
  }

  /** 加载并做版本校验 / 迁移 */
  _load() {
    let saved = this.adapter.load(STORAGE_KEY);
    if (!saved) {
      const fresh = defaultState();
      this.adapter.save(STORAGE_KEY, fresh);
      return fresh;
    }
    // v1 → v2：补字段迁移（保留用户数据）
    if (saved.version === 1) {
      saved = migrateV1toV2(saved);
      this.adapter.save(STORAGE_KEY, saved);
    }
    if (saved.version !== SCHEMA_VERSION) {
      // 未知版本：无法安全迁移，重置为默认
      const fresh = defaultState();
      this.adapter.save(STORAGE_KEY, fresh);
      return fresh;
    }
    // 兜底补齐 layout（兼容旧数据）
    if (!saved.layout) saved.layout = defaultState().layout;
    if (!saved.layout.order) saved.layout.order = [...DEFAULT_LAYOUT.order];
    if (!saved.layout.widths) saved.layout.widths = { ...DEFAULT_LAYOUT.widths };
    return saved;
  }

  _persist() {
    this.adapter.save(STORAGE_KEY, this.state);
  }

  /** 通知订阅者（在 _persist 之后调用） */
  _emit() {
    this._persist();
    this.listeners.forEach((fn) => fn(this.state));
  }

  getState() {
    return this.state;
  }

  /** 订阅状态变化，返回取消订阅函数 */
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /* ---------------- 当前日期 ---------------- */
  setCurrentDate(dStr) {
    this.state.currentDate = dStr;
    this._emit();
  }

  /* ---------------- 任务 Task ---------------- */
  addTask({ title, description = '' }) {
    const task = {
      id: uid('task'),
      title,
      description,
      createdAt: Date.now(),
      steps: [],
    };
    this.state.tasks.push(task);
    this._emit();
    return task;
  }

  getTask(id) {
    return this.state.tasks.find((t) => t.id === id) || null;
  }

  updateTask(id, patch) {
    const task = this.getTask(id);
    if (!task) return null;
    Object.assign(task, patch);
    this._emit();
    return task;
  }

  deleteTask(id) {
    const task = this.getTask(id);
    const removedStepIds = new Set(task ? task.steps.map((s) => s.id) : []);
    this.state.tasks = this.state.tasks.filter((t) => t.id !== id);
    this.state.schedule = this.state.schedule.filter(
      (s) => !removedStepIds.has(s.stepId)
    );
    this._emit();
  }

  /**
   * 用一份全新的分解结果替换「当前计划」。
   * 设计为单计划模型：左侧始终只维护一份当前任务。
   * 替换会清空旧的日程（旧步骤已失效），并在一次 emit 内完成。
   * plan：AI 返回的计划级元信息 { title, dailyCapacity, milestones }（可为 null）。
   */
  replaceCurrentTask({ title, description = '', steps = [], plan = null }) {
    const task = {
      id: uid('task'),
      title,
      description,
      createdAt: Date.now(),
      milestones: Array.isArray(plan && plan.milestones)
        ? plan.milestones.map((m) => ({
            title: String(m.title || ''),
            dayRange: String(m.dayRange || m.day_range || ''),
            deliverable: String(m.deliverable || ''),
          }))
        : [],
      dailyCapacity: String((plan && (plan.dailyCapacity || plan.daily_capacity)) || ''),
      steps: steps.map((s, i) => ({
        id: uid('step'),
        taskId: '', // 下方补填
        title: s.title,
        standard: s.standard || '',
        estimatedMinutes: s.estimatedMinutes || 30,
        completed: false,
        order: i,
        milestone: s.milestone || null,
        day: Number.isFinite(s.day) ? s.day : null,
        resource: s.resource
          ? {
              name: String(s.resource.name || ''),
              url: String(s.resource.url || ''),
              type: String(s.resource.type || 'article'),
            }
          : null,
        output: s.output || '',
        subtasks: (s.subtasks || []).map((x) => ({
          id: uid('sub'),
          title: x.title,
          completed: !!x.completed,
        })),
        checklist: (s.checklist || []).map((x) => ({
          id: uid('chk'),
          title: x.title,
          completed: !!x.completed,
        })),
      })),
    };
    task.steps.forEach((s) => {
      s.taskId = task.id;
    });
    this.state.tasks = [task];
    this.state.schedule = []; // 旧步骤失效，清空关联日程
    this._emit();
    return task;
  }

  /* ---------------- 步骤 Step ---------------- */
  addStep({ taskId, title, standard = '', estimatedMinutes = 30, order, subtasks = [] }) {
    const task = this.getTask(taskId);
    if (!task) return null;
    const step = {
      id: uid('step'),
      taskId,
      title,
      standard,
      estimatedMinutes,
      completed: false,
      order: order ?? task.steps.length,
      milestone: null,
      day: null,
      resource: null,
      output: '',
      subtasks: (subtasks || []).map((x) => ({
        id: uid('sub'),
        title: x.title,
        completed: !!x.completed,
      })),
      checklist: [],
    };
    task.steps.push(step);
    this._emit();
    return step;
  }

  /* ---------------- 步骤列表项（subtasks 执行步骤 / checklist 验收清单，同构） ---------------- */

  /** 通用：向步骤的列表字段添加条目（field: 'subtasks' | 'checklist'） */
  addStepListItem(stepId, field, title) {
    const step = this.getStep(stepId);
    if (!step || (field !== 'subtasks' && field !== 'checklist')) return null;
    if (!Array.isArray(step[field])) step[field] = [];
    const item = {
      id: uid(field === 'subtasks' ? 'sub' : 'chk'),
      title: String(title).trim(),
      completed: false,
    };
    if (!item.title) return null;
    step[field].push(item);
    this._emit();
    return item;
  }

  /** 通用：切换列表项完成态（「打勾」效果的数据来源） */
  toggleStepListItem(stepId, field, itemId) {
    const step = this.getStep(stepId);
    if (!step || !Array.isArray(step[field])) return;
    const item = step[field].find((s) => s.id === itemId);
    if (!item) return;
    item.completed = !item.completed;
    this._emit();
  }

  /** 通用：删除列表项 */
  deleteStepListItem(stepId, field, itemId) {
    const step = this.getStep(stepId);
    if (!step || !Array.isArray(step[field])) return;
    step[field] = step[field].filter((s) => s.id !== itemId);
    this._emit();
  }

  /** 新增子任务（AI 分解或用户手动补充） */
  addSubtask(stepId, title) {
    return this.addStepListItem(stepId, 'subtasks', title);
  }

  /** 切换子任务完成态 */
  toggleSubtask(stepId, subtaskId) {
    return this.toggleStepListItem(stepId, 'subtasks', subtaskId);
  }

  /** 删除子任务 */
  deleteSubtask(stepId, subtaskId) {
    return this.deleteStepListItem(stepId, 'subtasks', subtaskId);
  }

  /** 切换步骤完成态（同步其所有日程的完成态） */
  toggleStepComplete(stepId) {
    const step = this.getStep(stepId);
    if (!step) return;
    step.completed = !step.completed;
    this.state.schedule.forEach((s) => {
      if (s.stepId === stepId) s.completed = step.completed;
    });
    this._emit();
  }

  getStep(id) {
    for (const t of this.state.tasks) {
      const s = t.steps.find((x) => x.id === id);
      if (s) return s;
    }
    return null;
  }

  updateStep(id, patch) {
    const step = this.getStep(id);
    if (!step) return null;
    Object.assign(step, patch);
    this._emit();
    return step;
  }

  deleteStep(id) {
    for (const t of this.state.tasks) {
      const idx = t.steps.findIndex((s) => s.id === id);
      if (idx >= 0) {
        t.steps.splice(idx, 1);
        break;
      }
    }
    this.state.schedule = this.state.schedule.filter((s) => s.stepId !== id);
    this._emit();
  }

  /** 在步骤列表内上下移动（dir: 'up' | 'down'），自动重排 order */
  moveStep(stepId, dir) {
    for (const t of this.state.tasks) {
      const idx = t.steps.findIndex((s) => s.id === stepId);
      if (idx < 0) continue;
      const target = idx + (dir === 'up' ? -1 : 1);
      if (target < 0 || target >= t.steps.length) return;
      const arr = t.steps;
      [arr[idx], arr[target]] = [arr[target], arr[idx]];
      arr.forEach((s, i) => {
        s.order = i;
      });
      this._emit();
      return;
    }
  }

  /* ---------------- 日程 ScheduleItem ---------------- */
  addSchedule({ stepId, date, startTime, endTime, completed = false, note = '' }) {
    // 单任务单排程：同一 step 全局只允许一条排程，先清掉旧的（任意日期），
    // 保证「一个任务只能安排一次」，不会同时出现在多个时间点。
    this.state.schedule = this.state.schedule.filter((s) => s.stepId !== stepId);
    const item = {
      id: uid('sch'),
      stepId,
      date,
      startTime,
      endTime,
      completed,
      note,
    };
    this.state.schedule.push(item);
    this._emit();
    return item;
  }

  getSchedule(id) {
    return this.state.schedule.find((s) => s.id === id) || null;
  }

  updateSchedule(id, patch) {
    const item = this.getSchedule(id);
    if (!item) return null;
    Object.assign(item, patch);
    this._emit();
    return item;
  }

  deleteSchedule(id) {
    this.state.schedule = this.state.schedule.filter((s) => s.id !== id);
    this._emit();
  }

  /** 取某天所有日程（按开始时间升序） */
  getScheduleByDate(date) {
    return this.state.schedule
      .filter((s) => s.date === date)
      .sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));
  }

  /** 计算某 step 在某天的已排时长（分钟） */
  scheduledMinutesForStepOnDate(stepId, date) {
    return this.getScheduleByDate(date)
      .filter((s) => s.stepId === stepId)
      .reduce((sum, s) => sum + durationMinutes(s.startTime, s.endTime), 0);
  }

  /** 某 step 在某天是否已排程（用于左侧卡片「已安排」状态） */
  isStepScheduled(stepId, date) {
    return this.state.schedule.some(
      (s) => s.stepId === stepId && s.date === date
    );
  }

  /** 取某 step 在某天的日程（单日单条模型） */
  getScheduleForStepOnDate(stepId, date) {
    return (
      this.state.schedule.find(
        (s) => s.stepId === stepId && s.date === date
      ) || null
    );
  }

  /** 移动日程到新的起始分钟（保持时长，限制在 00:00–24:00 内）；可选 newDate 同步改日期 */
  moveSchedule(id, newStartMinutes, newDate) {
    const item = this.getSchedule(id);
    if (!item) return null;
    const dur = Math.max(durationMinutes(item.startTime, item.endTime), 5);
    const startMin = clamp(newStartMinutes, 0, 1440 - dur);
    item.startTime = minutesToTime(startMin);
    item.endTime = minutesToTime(startMin + dur);
    if (newDate) item.date = newDate; // 跨日期拖动时同步更新排程日期
    this._emit();
    return item;
  }

  /* ---------------- 面板布局配置 ---------------- */
  getLayout() {
    return this.state.layout;
  }

  setLayoutOrder(order) {
    // 仅接受合法的 panel id 排列
    const valid = PANEL_IDS.every((id) => order.includes(id)) &&
      order.length === PANEL_IDS.length;
    if (!valid) {
      console.warn('[store] setLayoutOrder 参数非法', order);
      return;
    }
    this.state.layout.order = [...order];
    this._emit();
  }

  setLayoutWidths(widths) {
    this.state.layout.widths = { ...this.state.layout.widths, ...widths };
    this._emit();
  }
}

/* 导出单例与底层类型（便于未来替换适配器） */
export const store = new Store(new LocalStorageAdapter());
export { LocalStorageAdapter, StorageAdapter };
