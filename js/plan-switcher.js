// plan-switcher.js — 顶部栏计划标签页切换器
// 渲染 plan tabs、处理切换/新建/删除；超过 3 个时折叠到「⋯更多」下拉菜单
// 删除按钮：鼠标悬停标签显示 ×，二次确认后删除（保留至少 1 个计划）。

import { store } from './store.js';

let tabsEl, newPlanBtn;
const PLAN_TITLE_MAX = 12;        // 标签显示最大字数
const MAX_VISIBLE_TABS = 3;       // 最多显示几个标签，超出折叠

function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

/** 渲染单个标签按钮 */
function tabHTML(p, activeId, showDelete) {
  const title = p.title || '未命名计划';
  const short = title.length > PLAN_TITLE_MAX ? title.slice(0, PLAN_TITLE_MAX) + '…' : title;
  const cls = 'plan-tab' + (p.id === activeId ? ' plan-tab--active' : '');
  const done = p.steps.filter((s) => s.completed).length;
  const total = p.steps.length;
  const badge = total > 0 ? ` <span class="plan-tab__badge">${done}/${total}</span>` : '';
  const delBtn = showDelete
    ? `<span class="plan-tab__del" data-act="delete" data-plan="${p.id}" title="删除计划" tabindex="0" role="button" aria-label="删除计划">×</span>`
    : '';
  return `<button class="${cls}" data-act="switch" data-plan="${p.id}" title="${escapeHtml(title)}" tabindex="0">
    <span class="plan-tab__title">${escapeHtml(short)}</span>${badge}
  </button>${delBtn}`;
}

/** 渲染下拉菜单项 */
function dropdownItemHTML(p, activeId) {
  const title = p.title || '未命名计划';
  const check = p.id === activeId ? ' ✓' : '';
  const done = p.steps.filter((s) => s.completed).length;
  const total = p.steps.length;
  return `<li class="plan-dropdown__item${p.id === activeId ? ' plan-dropdown__item--active' : ''}" data-act="switch" data-plan="${p.id}" tabindex="0" role="option">
    <span>${escapeHtml(title)}${check}</span>
    ${total > 0 ? `<span class="plan-dropdown__badge">${done}/${total}</span>` : ''}
    <span class="plan-dropdown__del" data-act="delete" data-plan="${p.id}" title="删除计划" tabindex="0" role="button" aria-label="删除计划">×</span>
  </li>`;
}

/** 渲染所有计划标签页 + 空状态 */
function render() {
  if (!tabsEl) return;
  const plans = store.getState().plans;
  const activeId = store.getState().activePlanId;

  if (plans.length === 0) {
    tabsEl.innerHTML = '<span class="plan-tabs__empty">暂无计划，输入目标开始吧</span>';
    return;
  }

  const visible = plans.slice(0, MAX_VISIBLE_TABS);
  const overflow = plans.length > MAX_VISIBLE_TABS ? plans.slice(MAX_VISIBLE_TABS) : [];

  // 可见标签
  const tabs = visible.map((p) => tabHTML(p, activeId, true)).join('');

  // 折叠下拉（如果有）
  const more = overflow.length > 0
    ? `<div class="plan-tabs__more">
         <button class="plan-tab plan-tab--more" type="button" data-act="toggle-more"
           aria-haspopup="listbox" aria-expanded="false" title="更多计划（${overflow.length} 个）">
           ⋯ <span class="plan-tab__badge">${overflow.length}</span>
         </button>
         <ul class="plan-dropdown" hidden>
           ${overflow.map((p) => dropdownItemHTML(p, activeId)).join('')}
         </ul>
       </div>`
    : '';

  tabsEl.innerHTML = tabs + more;
}

/** 关闭所有下拉菜单 */
function closeAllDropdowns() {
  document.querySelectorAll('.plan-dropdown').forEach((d) => { d.hidden = true; });
  document.querySelectorAll('.plan-tab--more').forEach((b) => { b.setAttribute('aria-expanded', 'false'); });
}

/** 事件代理 */
function onClick(e) {
  const actEl = e.target.closest('[data-act]');
  if (!actEl) { closeAllDropdowns(); return; }
  const act = actEl.dataset.act;

  if (act === 'switch') {
    store.switchPlan(actEl.dataset.plan);
    closeAllDropdowns();
    return;
  }

  if (act === 'toggle-more') {
    const dropdown = tabsEl.querySelector('.plan-dropdown');
    if (!dropdown) return;
    const isOpen = !dropdown.hidden;
    closeAllDropdowns(); // 先关所有
    if (!isOpen) {
      dropdown.hidden = false;
      actEl.closest('.plan-tab--more')?.setAttribute('aria-expanded', 'true');
    }
    return;
  }

  if (act === 'delete') {
    e.stopPropagation();
    const planId = actEl.dataset.plan;
    const plan = store.getPlan(planId);
    if (!plan) return;
    const planName = plan.title || '未命名计划';
    // 不允许删除最后一个计划
    if (store.getState().plans.length <= 1) {
      window.alert('至少需要保留一个计划');
      return;
    }
    const ok = window.confirm(`确定删除计划「${planName}」吗？该计划的日程也将一并移除，且不可恢复。`);
    if (!ok) return;
    store.deletePlan(planId);
    closeAllDropdowns();
    return;
  }

  closeAllDropdowns();
}

/** 点击页面空白处关闭下拉 */
function onDocumentClick(e) {
  if (!tabsEl || tabsEl.contains(e.target)) return;
  closeAllDropdowns();
}

/** 自定义弹窗：新建计划（替代浏览器原生 prompt） */
function showCreateModal() {
  const old = document.querySelector('.plan-modal-overlay');
  if (old) old.remove();

  const overlay = document.createElement('div');
  overlay.className = 'plan-modal-overlay';
  overlay.innerHTML = `<div class="plan-modal" role="dialog" aria-modal="true" aria-label="新建计划">
    <h2 class="plan-modal__title">新建计划</h2>
    <input class="plan-modal__input" type="text" placeholder="输入计划名称，如「两周学前端设计」" autofocus maxlength="40">
    <div class="plan-modal__actions">
      <button class="btn btn--ghost btn--sm" type="button" data-act="modal-cancel">取消</button>
      <button class="btn btn--primary btn--sm" type="button" data-act="modal-create" disabled>创建计划</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);

  const input = overlay.querySelector('.plan-modal__input');
  const createBtn = overlay.querySelector('[data-act="modal-create"]');

  const doCreate = () => {
    const v = input.value.trim();
    if (!v) return;
    overlay.remove();
    const plan = store.createPlan({ title: v });
    document.dispatchEvent(new CustomEvent('plan:switch', { detail: { planId: plan.id } }));
  };

  input.addEventListener('input', () => { createBtn.disabled = !input.value.trim(); });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { overlay.remove(); return; }
    if (ev.key === 'Enter') doCreate();
  });
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) overlay.remove(); });
  overlay.querySelector('[data-act="modal-cancel"]').addEventListener('click', () => overlay.remove());
  createBtn.addEventListener('click', doCreate);

  setTimeout(() => input.focus(), 100);
}

/** 初始化 */
export function initPlanSwitcher() {
  tabsEl = document.getElementById('planTabs');
  newPlanBtn = document.getElementById('newPlanBtn');

  if (!tabsEl) return;

  tabsEl.addEventListener('click', onClick);
  document.addEventListener('click', onDocumentClick);

  // 新建计划 → 自定义弹窗
  if (newPlanBtn) {
    newPlanBtn.addEventListener('click', showCreateModal);
  }

  // 订阅 store 变化自动重渲染标签页
  store.subscribe(() => render());

  render();
}
