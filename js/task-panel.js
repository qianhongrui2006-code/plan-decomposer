// task-panel.js — 左侧 AI 任务分解面板
// Step 3：输入区、AI 分解（mock）、步骤卡渲染、行内编辑标题、上移/下移、删除、底部重新生成全部
import { store } from './store.js';
import { decomposeTask, mockDecompose } from './ai-service.js';
import { formatDateShort } from './utils.js';

let currentTaskId = null; // 当前正在编辑的计划（单计划模型）
let currentVariant = 0; // 当前方案变体，供「重新生成全部」循环切换
let editingStepId = null; // 正在行内编辑的步骤，避免订阅重渲染打断输入
let cancelEdit = false; // Escape 取消编辑标记
let lastUsedMock = null; // 最近一次分解是否走本地示例模板（true=示例，false=真实 AI，null=尚未生成）
let decomposeError = null; // 分解失败的临时提示文本

const els = {};

export function initTaskPanel() {
  els.textarea = document.getElementById('taskDescription');
  els.generateBtn = document.getElementById('generateBtn');
  els.stepList = document.getElementById('stepList');

  els.generateBtn.addEventListener('click', onGenerate);
  els.stepList.addEventListener('click', onListClick);

  // 状态变化时重渲染（编辑中不重渲染，保护输入焦点）
  store.subscribe(() => {
    if (editingStepId) return;
    render();
  });

  render();
}

/* ---------------- 生成 ---------------- */
async function onGenerate() {
  const desc = els.textarea.value.trim();
  if (!desc) {
    els.textarea.classList.add('is-invalid');
    els.textarea.focus();
    setTimeout(() => els.textarea.classList.remove('is-invalid'), 1200);
    return;
  }

  // 真实异步：调用 /api/decompose（未配置 AI 时回退本地 Mock）
  els.generateBtn.disabled = true;
  const label = els.generateBtn.textContent;
  els.generateBtn.textContent = 'AI 分解中…';

  try {
    currentVariant = 0;
    let { steps, usedMock } = await decomposeTask(desc, currentVariant);
    lastUsedMock = usedMock;

    // 极端兜底：真实 AI 返回空/异常时，强制用本地模板保证界面不空白
    if (!Array.isArray(steps) || steps.length === 0) {
      console.warn('[计划分解器] AI 返回空步骤，强制 fallback 到本地模板');
      const mock = mockDecompose(desc, currentVariant);
      steps = mock.steps;
      lastUsedMock = true;
    }

    const task = store.replaceCurrentTask({
      title: desc,
      description: desc,
      steps,
    });
    currentTaskId = task.id;
    els.textarea.value = ''; // 清空输入，方便下次规划
  } catch (e) {
    console.warn('[计划分解器] 分解失败：', e);
    // 即便 decomposeTask 抛异常，也强制本地模板，确保永远有输出
    const mock = mockDecompose(desc, currentVariant);
    const task = store.replaceCurrentTask({
      title: desc,
      description: desc,
      steps: mock.steps,
    });
    currentTaskId = task.id;
    lastUsedMock = true;
    showDecomposeError('AI 服务异常，已自动切换为示例分解。');
  } finally {
    els.generateBtn.disabled = false;
    els.generateBtn.textContent = label;
  }
}

/* ---------------- 重新生成全部 ---------------- */
async function onRegenerate() {
  const task = currentTaskId
    ? store.getTask(currentTaskId)
    : store.getState().tasks[0];
  if (!task) return;

  const ok = window.confirm('重新生成将用一套新的 AI 建议替换当前所有步骤，确定吗？');
  if (!ok) return;

  currentVariant += 1;
  let { steps, usedMock } = await decomposeTask(task.title || task.description, currentVariant);
  lastUsedMock = usedMock;

  if (!Array.isArray(steps) || steps.length === 0) {
    console.warn('[计划分解器] 重新生成时 AI 返回空步骤，fallback 到本地模板');
    const mock = mockDecompose(task.title || task.description, currentVariant);
    steps = mock.steps;
    lastUsedMock = true;
  }

  const t = store.replaceCurrentTask({
    title: task.title,
    description: task.description,
    steps,
  });
  currentTaskId = t.id;
}

/* ---------------- 列表点击分发 ---------------- */
function onListClick(e) {
  const trigger = e.target.closest('[data-act]');
  if (trigger) {
    const act = trigger.dataset.act;

    if (act === 'regen') {
      onRegenerate();
      return;
    }

    const card = e.target.closest('.step-card');
    if (!card) return;
    const stepId = card.dataset.stepId;

    switch (act) {
      case 'toggle-done':
        e.preventDefault(); // 阻止原生勾选，统一由 store 控制
        store.toggleStepComplete(stepId);
        break;
      case 'up':
        store.moveStep(stepId, 'up');
        break;
      case 'down':
        store.moveStep(stepId, 'down');
        break;
      case 'del':
        store.deleteStep(stepId);
        break;
      case 'edit':
        startEditTitle(card, stepId);
        break;
      default:
        break;
    }
    return; // data-act 已处理，不再打开详情
  }

  // 点击卡片其它区域（标题除外，标题点击=编辑）→ 打开右侧详情面板
  const card = e.target.closest('.step-card');
  if (!card) return;
  selectStep(card.dataset.stepId);
}

/** 通知详情面板选中某步骤（Step 6） */
function selectStep(stepId) {
  document.dispatchEvent(new CustomEvent('step:select', { detail: { stepId } }));
}

/* ---------------- 行内编辑标题 ---------------- */
function startEditTitle(card, stepId) {
  if (editingStepId) return;
  const step = store.getStep(stepId);
  if (!step || step.completed) return; // 已完成不可编辑
  const titleEl = card.querySelector('.step-card__title');
  if (!titleEl) return;

  editingStepId = stepId;
  cancelEdit = false;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'step-card__title-input';
  input.value = step.title;

  titleEl.replaceWith(input);
  input.focus();
  input.select();

  const commit = () => {
    if (editingStepId !== stepId) return; // 已被 Escape 处理
    const val = input.value.trim();
    if (!cancelEdit && val) {
      store.updateStep(stepId, { title: val });
    }
    editingStepId = null;
    render();
  };

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      input.blur();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      cancelEdit = true;
      input.blur();
    }
  });
}

/* ---------------- 渲染 ---------------- */
function render() {
  const task = currentTaskId
    ? store.getTask(currentTaskId)
    : store.getState().tasks[0];

  if (!task || task.steps.length === 0) {
    const errorBanner = decomposeError
      ? `<div class="ai-mode-banner ai-mode-banner--mock" role="alert"><span class="ai-mode-banner__dot" aria-hidden="true">●</span><span class="ai-mode-banner__text">${escapeHtml(decomposeError)}</span></div>`
      : '';
    els.stepList.innerHTML =
      errorBanner +
      '<div class="empty-state"><p>输入计划并点击「AI 分解」生成细化步骤</p></div>';
    return;
  }

  currentTaskId = task.id;
  const sorted = [...task.steps].sort((a, b) => a.order - b.order);
  const total = sorted.length;
  const date = store.getState().currentDate;

  const cards = sorted
    .map((s, i) => stepCardHTML(s, i, total, date))
    .join('');

  const regen = `
    <button class="btn btn--ghost btn--block step-regen" type="button" data-act="regen">
      ↻ 重新生成全部
    </button>`;

  els.stepList.innerHTML = modeBannerHTML() + cards + regen;
}

/** 显示分解错误提示，4 秒后自动清除 */
function showDecomposeError(message) {
  decomposeError = message;
  render();
  setTimeout(() => {
    decomposeError = null;
    render();
  }, 4000);
}

/** 顶部模式提示：区分「真实 AI 生成」与「本地示例模板」，避免把模板误当成 AI 输出 */
function modeBannerHTML() {
  if (lastUsedMock === null) return '';
  if (lastUsedMock) {
    return `<div class="ai-mode-banner ai-mode-banner--mock" role="status">
      <span class="ai-mode-banner__dot" aria-hidden="true">●</span>
      <span class="ai-mode-banner__text">当前为<strong>示例分解</strong>（未接入 AI 或调用失败）。在 Vercel 配置 <code>AI_API_KEY</code> 后将切换为真实 AI 生成。</span>
    </div>`;
  }
  return `<div class="ai-mode-banner ai-mode-banner--live" role="status">
    <span class="ai-mode-banner__dot" aria-hidden="true">●</span>
    <span class="ai-mode-banner__text">由 <strong>DeepSeek 实时生成</strong></span>
  </div>`;
}

function stepCardHTML(s, i, total, date) {
  const dur = formatDuration(s.estimatedMinutes);
  const isFirst = i === 0;
  const isLast = i === total - 1;
  const title = escapeHtml(s.title);

  const done = !!s.completed;
  // 状态「已安排」基于步骤是否在任意日期排过程程（切日期不翻回待规划）；
  // 时间行优先显示当前查看日期的排程，否则显示其真实排程日期。
  const schedOnView = store.getScheduleForStepOnDate(s.id, date);
  const schedAny = store.getState().schedule.find((x) => x.stepId === s.id) || null;
  const scheduled = !!schedAny;
  const sched = schedOnView || schedAny;
  const status = done ? 'done' : scheduled ? 'scheduled' : 'pending';
  const statusText = done ? '已完成' : scheduled ? '已安排' : '待规划';
  const stateClass = done ? 'is-done' : scheduled ? 'is-scheduled' : '';
  const draggable = done ? 'false' : 'true';
  // 已完成：禁用编辑/上下移；未完成：标题可点编辑
  const titleAttr = done ? '' : ' data-act="edit" title="点击编辑标题"';

  const check = `<label class="step-card__check" title="标记完成">
      <input type="checkbox" data-act="toggle-done" ${done ? 'checked' : ''} />
    </label>`;

  // 排程信息：日期 + 起止时间（拖动到日历后即时显示）
  const schedLine = sched
    ? `<div class="step-card__time" title="安排在 ${escapeHtml(formatDateShort(sched.date))} ${sched.startTime}–${sched.endTime}">
         <span class="step-card__time-icon" aria-hidden="true">📅</span>
         <span class="step-card__time-date">${formatDateShort(sched.date)}</span>
         <span class="step-card__time-range">${sched.startTime}–${sched.endTime}</span>
       </div>`
    : '';

  const actions = `
    <div class="step-card__actions">
      <button class="step-card__btn" type="button" data-act="up"
        ${isFirst || done ? 'disabled' : ''} aria-label="上移" title="上移">↑</button>
      <button class="step-card__btn" type="button" data-act="down"
        ${isLast || done ? 'disabled' : ''} aria-label="下移" title="下移">↓</button>
      <button class="step-card__btn step-card__btn--danger" type="button" data-act="del"
        aria-label="删除" title="删除">✕</button>
    </div>`;

  return `
    <div class="step-card ${stateClass}" data-step-id="${s.id}" draggable="${draggable}">
      ${check}
      <span class="step-card__index">${i + 1}</span>
      <div class="step-card__main">
        <div class="step-card__title"${titleAttr}>${title}</div>
        <div class="step-card__sub">
          <span class="step-card__status status--${status}">${statusText}</span>
          <span class="step-card__duration">约 ${dur}</span>
        </div>
        ${schedLine}
      </div>
      ${actions}
    </div>`;
}

/* ---------------- 工具 ---------------- */
function formatDuration(min) {
  if (min >= 60) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
  }
  return `${min} 分钟`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}
