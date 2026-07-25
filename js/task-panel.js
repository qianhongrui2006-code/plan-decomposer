// task-panel.js — 左侧 AI 任务分解面板
// 输入区、AI 分解（真实 AI + 追问澄清流程）、里程碑分组步骤卡（进度条 + 阶段筛选）、
// 行内编辑标题、上移/下移、删除、底部重新生成全部
import { store } from './store.js';
import { decomposeTask, mockDecompose } from './ai-service.js';
import { formatDateShort } from './utils.js';

let currentTaskId = null; // 当前正在编辑的计划（单计划模型）
let currentVariant = 0; // 当前方案变体，供「重新生成全部」循环切换
let editingStepId = null; // 正在行内编辑的步骤，避免订阅重渲染打断输入
let cancelEdit = false; // Escape 取消编辑标记
let lastUsedMock = null; // 最近一次分解是否走本地示例模板（true=示例，false=真实 AI，null=尚未生成）
let decomposeError = null; // 分解失败的临时提示文本
let pendingClarify = null; // AI 追问待答：{ description, questions[] }（非 null 时优先渲染追问卡片）
let clarifyLoading = false; // 追问提交中（防重复点击）
let milestoneFilter = null; // 当前筛选的里程碑名（点击阶段头切换，null=全部）

const els = {};

export function initTaskPanel() {
  els.textarea = document.getElementById('taskDescription');
  els.generateBtn = document.getElementById('generateBtn');
  els.stepList = document.getElementById('stepList');

  els.generateBtn.addEventListener('click', onGenerate);
  els.stepList.addEventListener('click', onListClick);

  // 状态变化时重渲染（编辑中 / 追问提交中不重渲染，保护输入焦点与待答状态）
  store.subscribe(() => {
    if (editingStepId || clarifyLoading) return;
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

  els.generateBtn.disabled = true;
  const label = els.generateBtn.textContent;
  els.generateBtn.textContent = 'AI 分解中…';
  // 在列表区显示明显的加载提示，避免用户以为卡死了
  els.stepList.innerHTML =
    '<div class="loading-state"><span class="spinner"></span><p>AI 正在拆解计划，约需 30-60 秒…</p><p class="loading-state__sub">请耐心等待，完成后会自动刷新</p></div>';

  try {
    currentVariant = 0;
    pendingClarify = null;
    let res;
    try {
      res = await decomposeTask(desc, currentVariant);
    } catch (e) {
      if (e && e.isUpstream) {
        // AI 服务商侧错误（Key/模型/余额/超时）：如实显示真实原因，不伪装成示例
        lastUsedMock = null;
        showDecomposeError(e.reason || 'AI 调用失败，请检查配置。');
        return;
      }
      throw e;
    }

    // AI 认为信息不足：先渲染追问卡片，收集回答后再生成
    if (Array.isArray(res.questions) && res.questions.length) {
      pendingClarify = { description: desc, questions: res.questions };
      lastUsedMock = false;
      render();
      return;
    }

    applyDecomposeResult(desc, res);
  } finally {
    els.generateBtn.disabled = false;
    els.generateBtn.textContent = label;
  }
}

/** 把一次成功的分解结果写入 store（含空结果兜底） */
function applyDecomposeResult(desc, res) {
  let steps = res.steps;
  let plan = res.plan || null;
  lastUsedMock = res.usedMock;

  // 极端兜底：真实 AI 返回空/异常时，强制用本地模板保证界面不空白
  if (!Array.isArray(steps) || steps.length === 0) {
    console.warn('[计划分解器] AI 返回空步骤，强制 fallback 到本地模板');
    const mock = mockDecompose(desc, currentVariant);
    steps = mock.steps;
    plan = null;
    lastUsedMock = true;
  }

  const task = store.replaceCurrentTask({
    title: (plan && plan.title) || desc,
    description: desc,
    steps,
    plan,
  });
  currentTaskId = task.id;
  pendingClarify = null;
  setMilestoneFilter(null);
  els.textarea.value = ''; // 清空输入，方便下次规划
}

/* ---------------- AI 追问澄清 ---------------- */
async function onClarifySubmit(skip) {
  if (!pendingClarify || clarifyLoading) return;
  const answers = skip
    ? []
    : [...els.stepList.querySelectorAll('.clarify-card__input')]
        .map((inp) => ({ q: inp.dataset.q, a: inp.value.trim() }))
        .filter((x) => x.q && x.a);
  const desc = pendingClarify.description;

  clarifyLoading = true;
  render(); // 按钮置灰 + 文案变「生成中…」
  try {
    let res;
    try {
      res = await decomposeTask(
        desc,
        0,
        skip ? { skipClarify: true } : { answers }
      );
    } catch (e) {
      if (e && e.isUpstream) {
        showDecomposeError(e.reason || 'AI 调用失败，请检查配置。');
        return; // pendingClarify 保留，用户可重试
      }
      throw e;
    }

    // 极少数情况下模型继续追问：更新问题再渲染一次
    if (Array.isArray(res.questions) && res.questions.length && !skip) {
      pendingClarify.questions = res.questions;
      render();
      return;
    }

    applyDecomposeResult(desc, res);
  } finally {
    clarifyLoading = false;
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
  let res;
  try {
    // 重新生成固定跳过追问，直接要新方案
    res = await decomposeTask(task.description || task.title, currentVariant, {
      skipClarify: true,
    });
  } catch (e) {
    if (e && e.isUpstream) {
      lastUsedMock = null;
      showDecomposeError(e.reason || 'AI 调用失败，请检查配置。');
      return;
    }
    throw e;
  }

  let steps = res.steps;
  let plan = res.plan || null;
  lastUsedMock = res.usedMock;

  if (!Array.isArray(steps) || steps.length === 0) {
    console.warn('[计划分解器] 重新生成时 AI 返回空步骤，fallback 到本地模板');
    const mock = mockDecompose(task.description || task.title, currentVariant);
    steps = mock.steps;
    plan = null;
    lastUsedMock = true;
  }

  const t = store.replaceCurrentTask({
    title: (plan && plan.title) || task.title,
    description: task.description,
    steps,
    plan,
  });
  currentTaskId = t.id;
  pendingClarify = null;
  setMilestoneFilter(null);
}

/* ---------------- 里程碑筛选（通知日历暗淡其它阶段） ---------------- */
function setMilestoneFilter(ms) {
  milestoneFilter = ms;
  document.dispatchEvent(
    new CustomEvent('milestone:filter', { detail: { milestone: ms } })
  );
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
    // AI 追问卡片：提交 / 跳过 / 点击候选答案 chip 填入输入框
    if (act === 'clarify-submit') {
      onClarifySubmit(false);
      return;
    }
    if (act === 'clarify-skip') {
      onClarifySubmit(true);
      return;
    }
    if (act === 'clarify-opt') {
      if (clarifyLoading) return;
      const wrap = trigger.closest('.clarify-card__q');
      const input = wrap && wrap.querySelector('.clarify-card__input');
      if (input) {
        input.value = trigger.dataset.opt || '';
        input.focus();
      }
      return;
    }
    // 阶段头：点击筛选该阶段的日程（再点取消）
    if (act === 'ms-filter') {
      const ms = trigger.dataset.ms || '';
      setMilestoneFilter(milestoneFilter === ms ? null : ms);
      render();
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
  // AI 追问待答：优先渲染追问卡片（此时通常还没有步骤）
  if (pendingClarify) {
    els.stepList.innerHTML = errorBannerHTML() + clarifyCardHTML();
    return;
  }

  const task = currentTaskId
    ? store.getTask(currentTaskId)
    : store.getState().tasks[0];

  if (!task || task.steps.length === 0) {
    els.stepList.innerHTML =
      errorBannerHTML() +
      '<div class="empty-state"><p>输入计划并点击「AI 分解」生成细化步骤</p></div>';
    return;
  }

  currentTaskId = task.id;
  const sorted = [...task.steps].sort((a, b) => a.order - b.order);
  const date = store.getState().currentDate;
  const groups = buildGroups(task, sorted);

  // 无里程碑信息（本地示例模板 / 旧数据）：保持平铺渲染
  const flat = groups.length === 1 && groups[0].key === '';

  const body = flat
    ? sorted.map((s, i) => stepCardHTML(s, i, sorted.length, date)).join('')
    : groups
        .map((g, gi) => milestoneGroupHTML(g, gi, date))
        .join('');

  const capacity =
    !flat && task.dailyCapacity
      ? `<div class="plan-capacity">⏱ 建议每天投入 <strong>${escapeHtml(task.dailyCapacity)}</strong></div>`
      : '';

  const regen = `
    <button class="btn btn--ghost btn--block step-regen" type="button" data-act="regen">
      ↻ 重新生成全部
    </button>`;

  els.stepList.innerHTML = modeBannerHTML() + capacity + body + regen;
}

/** 按里程碑分组（组内保持 order 顺序；组顺序按首次出现） */
function buildGroups(task, sorted) {
  const meta = new Map((task.milestones || []).map((m) => [m.title, m]));
  const groups = [];
  const byKey = new Map();
  for (const s of sorted) {
    const key = s.milestone || '';
    let g = byKey.get(key);
    if (!g) {
      g = { key, steps: [], meta: meta.get(key) || null };
      byKey.set(key, g);
      groups.push(g);
    }
    g.steps.push(s);
  }
  return groups;
}

/** 一个里程碑分组：阶段头（可点击筛选）+ 交付物 + 进度条 + 步骤卡 */
function milestoneGroupHTML(g, gi, date) {
  const total = g.steps.length;
  const done = g.steps.filter((s) => s.completed).length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const active = milestoneFilter === g.key ? ' is-active' : '';
  const days = g.meta && g.meta.dayRange
    ? `<span class="milestone__days">${escapeHtml(g.meta.dayRange)}</span>`
    : '';
  const deliverable = g.meta && g.meta.deliverable
    ? `<div class="milestone__deliverable">🎯 ${escapeHtml(g.meta.deliverable)}</div>`
    : '';

  const cards = g.steps
    .map((s, i) => stepCardHTML(s, i, total, date))
    .join('');

  return `
  <section class="milestone">
    <div class="milestone__head${active}" data-act="ms-filter" data-ms="${escapeHtml(g.key)}"
      title="点击在日历中只高亮该阶段的任务（再点取消）">
      <span class="milestone__badge">阶段 ${gi + 1}</span>
      <span class="milestone__title">${escapeHtml(g.key)}</span>
      ${days}
      <span class="milestone__count">${done}/${total}</span>
    </div>
    ${deliverable}
    <div class="milestone__bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100">
      <i style="width:${pct}%"></i>
    </div>
    ${cards}
  </section>`;
}

/** 解析追问文本：尾部括号内的候选答案拆成可点击 chips（「问题（A / B / C）」） */
function parseQuestion(q) {
  const m = String(q).match(/^(.*?)[（(]([^（）()]+)[）)]\s*$/);
  if (!m) return { text: String(q), options: [] };
  const options = m[2]
    .split(/[\/、，,]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 4);
  return { text: m[1].trim() || String(q), options };
}

/** AI 追问卡片 */
function clarifyCardHTML() {
  const qs = pendingClarify.questions
    .map((q, i) => {
      const { text, options } = parseQuestion(q);
      const chips = options.length
        ? `<span class="clarify-card__options">${options
            .map(
              (o) =>
                `<button type="button" class="clarify-card__chip" data-act="clarify-opt" data-opt="${escapeHtml(o)}" ${clarifyLoading ? 'disabled' : ''}>${escapeHtml(o)}</button>`
            )
            .join('')}</span>`
        : '';
      return `
      <label class="clarify-card__q">
        <span class="clarify-card__q-text">${i + 1}. ${escapeHtml(text)}</span>
        ${chips}
        <input class="form-input clarify-card__input" type="text"
          data-q="${escapeHtml(text)}" placeholder="点击上方选项快速回答，或手动输入"
          ${clarifyLoading ? 'disabled' : ''} />
      </label>`;
    })
    .join('');
  return `
  <div class="clarify-card">
    <div class="clarify-card__head">💬 为了拆得更准，AI 想先了解几个问题：</div>
    ${qs}
    <div class="clarify-card__actions">
      <button class="btn btn--primary btn--sm" type="button" data-act="clarify-submit" ${clarifyLoading ? 'disabled' : ''}>
        ${clarifyLoading ? '生成中…' : '回答并生成计划'}
      </button>
      <button class="btn btn--ghost btn--sm" type="button" data-act="clarify-skip" ${clarifyLoading ? 'disabled' : ''}>
        跳过，直接生成
      </button>
    </div>
  </div>`;
}

/** 分解错误提示条（有错误时才输出） */
function errorBannerHTML() {
  if (!decomposeError) return '';
  return `<div class="ai-mode-banner ai-mode-banner--mock" role="alert"><span class="ai-mode-banner__dot" aria-hidden="true">●</span><span class="ai-mode-banner__text">${escapeHtml(decomposeError)}</span></div>`;
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

  // 计划第几天（AI 按天排布时给出）
  const dayChip = s.day
    ? `<span class="step-card__day">第 ${s.day} 天</span>`
    : '';

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
          ${dayChip}
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
