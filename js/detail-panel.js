// detail-panel.js — 右侧任务详情面板（Step 6）
// 监听 step:select（左侧步骤卡）/ timeblock:select（日历时间块）渲染选中步骤的详情。
// 结构（按优化意见）：时间安排 + 📎学习资源 + 🪜执行步骤 + ✅验收清单 + 📤产出物；
// 标题与各字段行内即时自动保存；完成勾选与日历双向同步；删除步骤本身（二次确认）。
import { store } from './store.js';
import { timeToMinutes, minutesToTime, durationMinutes } from './utils.js';
import { enrichTaskStep } from './ai-service.js';

let bodyEl; // #detailPanelBody
let selectedStepId = null;
let isEditing = false; // 正在编辑文本字段，抑制自身重渲染以保护输入焦点
let enrichLoading = false; // 正在 AI 补充详情，显示 loading

/* ---------------- 初始化 ---------------- */
export function initDetailPanel() {
  bodyEl = document.getElementById('detailPanelBody');
  if (!bodyEl) return;
  bodyEl.setAttribute('aria-live', 'polite');

  document.addEventListener('step:select', onSelect);
  document.addEventListener('timeblock:select', onSelect);
  // 外部变化（日历勾选完成、左栏删除步骤、拖拽排期等）同步刷新面板
  store.subscribe(onStoreChange);
  // 计划切换时清空选中状态
  document.addEventListener('plan:switch', () => {
    selectedStepId = null;
    isEditing = false;
    enrichLoading = false;
    renderEmpty();
  });

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
  const plan = store.getPlan(step.taskId);
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

  // 📎 学习资源：类型 + 名称 + 链接/关键词（均可编辑；链接为 http 时给「打开」入口）
  const res = step.resource || {};
  const resType = res.type || 'article';
  const hasLink = res.url && /^https?:\/\//i.test(res.url);
  // 判断是否需要 AI 补充详情（所有富字段都为空时显示 enrichment 横幅）
  const needsEnrich =
    !step.resource &&
    (!Array.isArray(step.subtasks) || !step.subtasks.length) &&
    (!Array.isArray(step.checklist) || !step.checklist.length) &&
    !step.output &&
    !done;
  const enrichBanner = needsEnrich
    ? `<div class="detail__enrich">
         <span class="detail__enrich-text">✨ ${enrichLoading ? '<span class="spinner"></span> AI 正在补充详情…' : '正在准备详情…'}</span>
       </div>`
    : '';
  const resourceSection = `
    <section class="detail__section detail__resource">
      <h3 class="detail__label">📎 学习资源</h3>
      <div class="detail__res-row">
        <select class="detail__res-type" aria-label="资源类型" ${disabled}>
          <option value="article" ${resType === 'article' ? 'selected' : ''}>文章</option>
          <option value="video" ${resType === 'video' ? 'selected' : ''}>视频</option>
          <option value="practice" ${resType === 'practice' ? 'selected' : ''}>实践</option>
          <option value="other" ${resType === 'other' ? 'selected' : ''}>其他</option>
        </select>
        <input class="form-input detail__res-name" type="text"
          value="${escapeHtml(res.name || '')}" placeholder="资源名称（如 MDN Flexbox）"
          aria-label="资源名称" ${disabled} />
      </div>
      <input class="form-input detail__res-url" type="text"
        value="${escapeHtml(res.url || '')}" placeholder="链接或精确搜索关键词"
        aria-label="资源链接或关键词" ${disabled} />
      ${hasLink ? `<a class="detail__res-link" href="${escapeHtml(res.url)}" target="_blank" rel="noopener noreferrer">打开资源 ↗</a>` : ''}
    </section>`;

  // 🪜 执行步骤（AI 分解生成的具体动作，可勾选、增删）
  const subs = Array.isArray(step.subtasks) ? step.subtasks : [];
  const subsDone = subs.filter((s) => s.completed).length;
  const stepsSection = checklistSectionHTML({
    items: subs,
    doneCount: subsDone,
    label: '🪜 执行步骤',
    field: 'subtasks',
    toggleAct: 'toggle-sub',
    delAct: 'del-sub',
    emptyHint: '暂无执行步骤。可手动添加，或由 AI 分解生成。',
    addPlaceholder: '添加执行步骤…',
    disabled,
  });

  // ✅ 验收清单（做完后怎么自查）
  const cls = Array.isArray(step.checklist) ? step.checklist : [];
  const clsDone = cls.filter((s) => s.completed).length;
  const checkSection = checklistSectionHTML({
    items: cls,
    doneCount: clsDone,
    label: '✅ 验收清单',
    field: 'checklist',
    toggleAct: 'toggle-cl',
    delAct: 'del-cl',
    emptyHint: '暂无验收清单。做完后用什么标准自查？',
    addPlaceholder: '添加验收检查项…',
    disabled,
  });

  // 📤 产出物（这一步做完要留下什么；旧数据的 standard 作为初始值承接）
  const outputVal = step.output || step.standard || '';
  const outputSection = `
    <section class="detail__section">
      <h3 class="detail__label">📤 产出物</h3>
      <textarea class="form-textarea detail__output"
        placeholder="这一步做完要留下什么？（链接 / 文件 / 笔记 / 截图）"
        aria-label="产出物" ${disabled}>${escapeHtml(outputVal)}</textarea>
    </section>`;

  // 所属里程碑（有则显示在头部元信息里）
  const msChip = step.milestone
    ? `<span class="detail__milestone" title="所属阶段">🏁 ${escapeHtml(step.milestone)}</span>`
    : '';

  bodyEl.innerHTML = `
    <div class="detail">
      <div class="detail__head">
        <input class="form-input detail__title" type="text"
          value="${escapeHtml(step.title)}" placeholder="步骤标题"
          aria-label="步骤标题" ${disabled} />
        <div class="detail__meta">
          <span class="step-card__status status--${status}">${statusText}</span>
          ${msChip}
          <span class="detail__parent" title="所属计划">${escapeHtml(plan ? plan.title : '—')}</span>
        </div>
      </div>

      <section class="detail__section">
        <h3 class="detail__label">时间安排</h3>
        ${timeSection}
      </section>

      ${resourceSection}
      ${enrichBanner}
      ${stepsSection}
      ${checkSection}
      ${outputSection}

      <section class="detail__section detail__footer">
        <label class="detail__check">
          <input type="checkbox" data-act="toggle-done" ${done ? 'checked' : ''} />
          <span>标记为已完成</span>
        </label>
        <button class="btn btn--block detail__delete" type="button">删除步骤</button>
      </section>
    </div>`;

  bindEvents(step, sched);

  // 自动补充详情：检测到富字段全空时，异步调用 AI 补充
  if (needsEnrich && !enrichLoading) {
    enrichLoading = true;
    setTimeout(() => autoEnrich(step), 100);
  }
}

/** 执行步骤 / 验收清单共用的列表区块 HTML（结构同构，仅数据字段与文案不同） */
function checklistSectionHTML({ items, doneCount, label, field, toggleAct, delAct, emptyHint, addPlaceholder, disabled }) {
  return `
    <section class="detail__section detail__subtasks" data-field="${field}">
      <div class="detail__subtasks-head">
        <h3 class="detail__label">${label}</h3>
        ${items.length ? `<span class="detail__subtasks-progress">${doneCount}/${items.length}</span>` : ''}
      </div>
      ${
        items.length
          ? `<ul class="subtasks">
              ${items
                .map(
                  (s) =>
                    `<li class="subtask${s.completed ? ' is-done' : ''}">
                      <label class="subtask__row">
                        <input type="checkbox" data-act="${toggleAct}" data-sub="${s.id}" ${s.completed ? 'checked' : ''} ${disabled} />
                        <span class="subtask__title">${escapeHtml(s.title)}</span>
                      </label>
                      <button class="subtask__del" type="button" data-act="${delAct}" data-sub="${s.id}" aria-label="删除" ${disabled}>✕</button>
                    </li>`
                )
                .join('')}
            </ul>`
          : `<p class="detail__hint">${emptyHint}</p>`
      }
      <div class="detail__subtasks-add">
        <input class="form-input detail__list-input" type="text"
          placeholder="${addPlaceholder}" aria-label="${addPlaceholder}" ${disabled} />
        <button class="btn btn--ghost detail__list-add" type="button" ${disabled}>＋ 添加</button>
      </div>
    </section>`;
}

/* ---------------- 事件绑定 ---------------- */
function bindEvents(step, sched) {
  const titleInput = bodyEl.querySelector('.detail__title');
  const check = bodyEl.querySelector('[data-act="toggle-done"]');
  const arrangeBtn = bodyEl.querySelector('.detail__arrange');
  const delBtn = bodyEl.querySelector('.detail__delete');

  // 标题：聚焦期间抑制自身重渲染，输入即写回 store（即时自动保存）
  bindAutoSaveText(titleInput, () => {
    store.updateStep(step.id, { title: titleInput.value });
  });

  // 📎 学习资源：三个字段合并为一个 resource 对象写回
  const resTypeEl = bodyEl.querySelector('.detail__res-type');
  const resNameEl = bodyEl.querySelector('.detail__res-name');
  const resUrlEl = bodyEl.querySelector('.detail__res-url');
  const saveResource = () => {
    const name = resNameEl.value.trim();
    const url = resUrlEl.value.trim();
    const type = resTypeEl.value;
    store.updateStep(step.id, {
      resource: name || url ? { name, url, type } : null,
    });
  };
  [resTypeEl, resNameEl, resUrlEl].forEach((el) => {
    if (!el) return;
    el.addEventListener('focus', () => { isEditing = true; });
    el.addEventListener('blur', onEditBlur);
  });
  if (resNameEl) resNameEl.addEventListener('input', saveResource);
  if (resUrlEl) resUrlEl.addEventListener('input', saveResource);
  if (resTypeEl) resTypeEl.addEventListener('change', saveResource);

  // 🪜 执行步骤 / ✅ 验收清单：两个同构区块分别绑定（按 data-field 区分写入字段）
  bodyEl.querySelectorAll('.detail__subtasks[data-field]').forEach((section) => {
    const field = section.dataset.field; // 'subtasks' | 'checklist'
    section.querySelectorAll('[data-act^="toggle-"]').forEach((cb) => {
      cb.addEventListener('change', () => {
        store.toggleStepListItem(step.id, field, cb.dataset.sub);
      });
    });
    section.querySelectorAll('[data-act^="del-"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        store.deleteStepListItem(step.id, field, btn.dataset.sub);
      });
    });
    const input = section.querySelector('.detail__list-input');
    const addItem = () => {
      if (!input) return;
      const v = input.value.trim();
      if (!v) return;
      store.addStepListItem(step.id, field, v); // 写入后由 onStoreChange 重渲染，输入框自动清空
    };
    section.querySelector('.detail__list-add')?.addEventListener('click', addItem);
    if (input) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          addItem();
        }
      });
    }
  });

  // 📤 产出物：自动保存 + 随内容撑高
  const outputEl = bodyEl.querySelector('.detail__output');
  bindAutoSaveText(outputEl, () => {
    store.updateStep(step.id, { output: outputEl.value });
    autoResize(outputEl);
  });
  autoResize(outputEl);

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

/** 自动补充详情：检测到富字段全空时异步调用 AI，完成后自动刷新面板 */
async function autoEnrich(step) {
  const plan = store.getPlan(step.taskId);
  const ctx = [plan && plan.title, step.milestone].filter(Boolean).join(' / ');
  const data = await enrichTaskStep(step.title, ctx);
  if (data) {
    store.updateStepEnrichment(step.id, {
      resource: data.resource,
      steps: data.steps,
      checklist: data.checklist,
      output: data.output,
    });
  }
  enrichLoading = false;
  // 如果用户仍停留在此步骤上，刷新面板显示结果
  if (selectedStepId === step.id) render();
}

/** 文本类字段的自动保存绑定：聚焦抑制重渲染，输入即时写回，失焦恢复渲染 */
function bindAutoSaveText(el, onInput) {
  if (!el) return;
  el.addEventListener('focus', () => { isEditing = true; });
  el.addEventListener('blur', onEditBlur);
  el.addEventListener('input', onInput);
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
  const activePlan = store.getActivePlan();
  const planStepIds = activePlan ? new Set(activePlan.steps.map((s) => s.id)) : new Set();
  const items = store.getScheduleByDate(date).filter((s) => planStepIds.has(s.stepId));
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
