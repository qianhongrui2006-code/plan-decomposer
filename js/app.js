// app.js — 应用入口（多计划模型）
// Step 2：store + utils
// Step 2.5：面板布局可调节（宽度/顺序拖拽）
// Step 3：左侧 AI 任务分解面板
// Step 4：中间时间日历面板（刻度 + 当前时间线 + 日期导航）

import { store } from './store.js';
import { formatDateCN } from './utils.js';
import { initPanelResize } from './panel-resize.js';
import { initTaskPanel } from './task-panel.js';
import { initCalendar } from './calendar.js';
import { initDragDrop } from './drag-drop.js';
import { initDetailPanel } from './detail-panel.js';
import { initPlanSwitcher } from './plan-switcher.js';
import { exportCurrentPlan } from './export.js';

function renderDate() {
  const el = document.getElementById('calendarDate');
  if (el) el.textContent = formatDateCN(store.getState().currentDate);
}

/** 更新导出按钮可用性（有任务时可用） */
function updateExportBtn() {
  const btn = document.getElementById('exportBtn');
  if (!btn) return;
  const plan = store.getActivePlan();
  btn.disabled = !(plan && plan.steps.length > 0);
}

document.addEventListener('DOMContentLoaded', () => {
  renderDate();
  updateExportBtn();
  initPlanSwitcher();   // 顶部栏计划标签页切换器
  initPanelResize();    // Step 2.5：面板宽度/顺序可拖拽调节
  initTaskPanel();      // Step 3：左侧 AI 任务分解面板
  initCalendar();       // Step 4：日历刻度 + 当前时间线 + 日期导航
  initDragDrop();       // Step 5：步骤 ↔ 日历 跨面板拖拽
  initDetailPanel();    // Step 6：右侧任务详情面板

  store.subscribe(() => {
    renderDate();
    updateExportBtn();
  });

  // 导出按钮
  document.getElementById('exportBtn')?.addEventListener('click', () => {
    const btn = document.getElementById('exportBtn');
    const ok = exportCurrentPlan(store);
    if (ok && btn) {
      const original = btn.textContent;
      btn.textContent = '已导出 ✓';
      setTimeout(() => { btn.textContent = original; }, 1500);
    }
  });
});
