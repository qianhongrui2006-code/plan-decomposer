// detail-panel.js — 右侧任务详情面板（Step 6）
// 监听 step:select（左侧步骤卡）/ timeblock:select（日历时间块）渲染选中步骤的详情；
// 标题与描述行内即时自动保存；完成勾选与日历双向同步；删除步骤本身（二次确认）。
import { store } from './store.js';
import { timeToMinutes, minutesToTime, durationMinutes } from './utils.js';

let bodyEl; // #detailPanelBody
let selectedStepId = null;
let isEditing = false; // 正在编辑文本字段，抑制自身重渲染以保护输入焦点

/* ---------------- 初始化 ---------------- */
export function initDetailPanel() {
  bodyEl = document.getElementById('detailPanelBody');
  if (!bodyEl) return;
  bodyEl.setAttribute('aria-live', 'polite');

  document.addEventListener('step:select', onSelect);
  document.addEventListener('timeblock:select', onSelect);
  // 外部变化（日历勾选完成、左栏删除步骤、拖拽排期等）同步刷新面板
  store.subscribe(onStoreChange);

  renderEmpty();
}

function onSelect(e) {
  const stepId = e.detail && e.detail.stepId;
  if (!stepId) return;
  selectedStepId = stepId;
  isEditing = false;
  render();
}

/** store 变化回调：自身编辑触发的变化(isEditing)不重渲染，避免打断输入 */
function onStoreChange() {
  if (!selectedStepId || isEditing) return;
  render(); // 外部变化（完成态、删除、排期）同步
}

/* ---------------- 渲染 ---------------- */
function renderEmpty() {
  selectedStepId = null;
  bodyEl.innerHTML =
    '<div class="empty-state"><p>选择一个步骤或时间块查看详情</p></div>';
}

function render() {
  const step = selectedStepId ? store.getStep(selectedStepId) : null;
  if (!step) {
    renderEmpty();
    return;
  }
  const task = store.getTask(step.taskId);
  const date = store.getState().currentDate;
  const sched = store.getScheduleForStepOnDate(step.id, date);
  const done = !!step.completed;
  const scheduled = !done && !!sched;
  const status = done ? 'done' : scheduled ? 'scheduled' : 'pending';
  const statusText = done ? '已完成' : scheduled ? '已安排' : '待规划';
  const disabled = done ? 'disabled' : '';
  const durMin = sched ? durationMinutes(sched.startTime, sched.endTime) : step.estimatedMinutes;

  const timeSection = sched
    ? `<div class="detail__time">
         <div class="detail__time-row"><span>开始</span><strong>${sched.startTime}</strong></div>
         <div class="detail__time-row"><span>结束</span><strong>${sched.endTime}</strong></div>
         <div class="detail__time-row"><span>时长</span><strong>${formatDuration(durMin)}</strong></div>
       </div>`
    : `<p class="detail__hint">尚未安排到日历</p>` +
      (done
        ? ''
        : '<button class="btn btn--ghost btn--block detail__arrange" type="button">＋ 安排到今天</button>');

  // 子任务（AI 分解生成，或用户手动添加）；含完成态与进度统计
  const subs = Array.isArray(step.subtasks) ? step.subtasks : [];
  const doneCount = subs.filter((s) => s.completed).length;
  const subtaskSection = `
    <section class="detail__section detail__subtasks">
      <div class="detail__subtasks-head">
        <h3 class="detail__label">子任务</h3>
        ${subs.length ? `<span class="detail__subtasks-progress">${doneCount}/${subs.length}</span>` : ''}
      </div>
      ${
        subs.length
          ? `<ul class="subtasks">
              ${subs
                .map(
                  (s) =>
                    `<li class="subtask${s.completed ? ' is-done' : ''}">
                      <label class="subtask__row">
                        <input type="checkbox" data-act="toggle-sub" data-sub="${s.id}" ${s.completed ? 'checked' : ''} ${disabled} />
                        <span class="subtask__title">${escapeHtml(s.title)}</span>
                      </label>
                      <button class="subtask__del" type="button" data-act="del-sub" data-sub="${s.id}" aria-label="删除子任务" ${disabled}>✕</button>
                    </li>`
                )
                .join('')}
            </ul>`
          : `<p class="detail__hint">暂无子任务。可手动添加，或重新 AI 分解以生成子任务提示。</p>`
      }
      <div class="detail__subtasks-add">
        <input class="form-input detail__subtask-input" type="text"
          placeholder="添加子任务…" aria-label="添加子任务" ${disabled} />
        <button class="btn btn--ghost detail__subtask-add" type="button" ${disabled}>＋ 添加</button>
      </div>
    </section>`;

  bodyEl.innerHTML = `
    <div class="detail">
      <div class="detail__head">
        <input class="form-input detail__title" type="text"
          value="${escapeHtml(step.title)}" placeholder="步骤标题"
          aria-label="步骤标题" ${disabled} />
        <div class="detail__meta">
          <span class="step-card__status status--${status}">${statusText}</span>
          <span class="detail__parent" title="所属计划">${escapeHtml(task ? task.title : '—')}</span>
        </div>
      </div>

      <section class="detail__section">
        <h3 class="detail__label">时间安排</h3>
        ${timeSection}
      </section>

      <section class="detail__section">
        <h3 class="detail__label">执行标准 / 描述</h3>
        <textarea class="form-textarea detail__desc"
          placeholder="填写这一步的执行标准或备注…" aria-label="执行标准或描述" ${disabled}>${escapeHtml(step.standard || '')}</textarea>
      </section>

      ${subtaskSection}

      <section class="detail__section detail__footer">
        <label class="detail__check">
          <input type="checkbox" data-act="toggle-done" ${done ? 'checked' : ''} />
          <span>标记为已完成</span>
        </label>
        <button class="btn btn--block detail__delete" type="button">删除步骤</button>
      </section>
    </div>`;

  bindEvents(step, sched);
}

/* ---------------- 事件绑定 ---------------- */
function bindEvents(step, sched) {
  const titleInput = bodyEl.querySelector('.detail__title');
  const descInput = bodyEl.querySelector('.detail__desc');
  const check = bodyEl.querySelector('[data-act="toggle-done"]');
  const arrangeBtn = bodyEl.querySelector('.detail__arrange');
  const delBtn = bodyEl.querySelector('.detail__delete');

  // 标题：聚焦期间抑制自身重渲染，输入即写回 store（即时自动保存）
  if (titleInput) {
    titleInput.addEventListener('focus', () => { isEditing = true; });
    titleInput.addEventListener('blur', onEditBlur);
    titleInput.addEventListener('input', () => {
      store.updateStep(step.id, { title: titleInput.value });
    });
  }
  // 描述：同上；并随内容自动撑高（生成多少文字就有多大）
  if (descInput) {
    descInput.addEventListener('focus', () => { isEditing = true; });
    descInput.addEventListener('blur', onEditBlur);
    descInput.addEventListener('input', () => {
      store.updateStep(step.id, { standard: descInput.value });
      autoResize(descInput); // 边输入边撑高
    });
    autoResize(descInput);
  }
  // 子任务：勾选切换完成态（打勾效果）、删除、手动添加
  bodyEl.querySelectorAll('[data-act="toggle-sub"]').forEach((cb) => {
    cb.addEventListener('change', () => {
      store.toggleSubtask(step.id, cb.dataset.sub);
    });
  });
  bodyEl.querySelectorAll('[data-act="del-sub"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      store.deleteSubtask(step.id, btn.dataset.sub);
    });
  });
  const subtaskInput = bodyEl.querySelector('.detail__subtask-input');
  const addSub = () => {
    if (!subtaskInput) return;
    const v = subtaskInput.value.trim();
    if (!v) return;
    store.addSubtask(step.id, v); // 写入后由 onStoreChange 重渲染，输入框自动清空
  };
  if (subtaskInput) {
    bodyEl.querySelector('.detail__subtask-add')?.addEventListener('click', addSub);
    subtaskInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addSub();
      }
    });
  }
  // 完成勾选：与日历双向同步
  if (check) {
    check.addEventListener('change', () => {
      store.toggleStepComplete(step.id);
    });
  }
  // 安排到今天：在未排期时给出默认空闲时段
  if (arrangeBtn) {
    arrangeBtn.addEventListener('click', () => {
      const date = store.getState().currentDate;
      const dur = Math.max(step.estimatedMinutes || 30, 15);
      const startMin = findFreeSlot(date, dur);
      store.addSchedule({
        stepId: step.id,
        date,
        startTime: minutesToTime(startMin),
        endTime: minutesToTime(startMin + dur),
      });
    });
  }
  // 删除步骤本身（排期 + 左侧步骤一并删，二次确认防误删）
  if (delBtn) {
    delBtn.addEventListener('click', () => {
      const ok = window.confirm('确定删除该步骤吗？其在日历中的排期也会一并移除，且不可恢复。');
      if (!ok) return;
      store.deleteStep(step.id);
    });
  }
}

/** 编辑失焦：解除抑制并重渲染，使只读区（状态/时间）同步最新值 */
function onEditBlur() {
  isEditing = false;
  render();
}

/* ---------------- 工具 ---------------- */
/** 为未排期步骤寻找当天首个 5 分钟网格空闲时段（默认从 08:00 起，允许重叠则退回 08:00） */
function findFreeSlot(date, dur) {
  const start = 8 * 60;
  const items = store.getScheduleByDate(date);
  const busy = items
    .map((i) => ({ s: timeToMinutes(i.startTime), e: timeToMinutes(i.endTime) }))
    .sort((a, b) => a.s - b.s);
  let cand = start;
  while (cand + dur <= 1440) {
    const overlaps = busy.some((b) => cand < b.e && cand + dur > b.s);
    if (!overlaps) return cand;
    cand += 5;
  }
  return start;
}

/** 让 textarea 随内容自动撑高（不出现固定高度与内部滚动条） */
function autoResize(el) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

function formatDuration(min) {
  if (min >= 60) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
  }
  return `${min} 分钟`;
}

function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}
