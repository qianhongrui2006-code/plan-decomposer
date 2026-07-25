// drag-drop.js — Step 5 跨面板拖拽系统
// 链路：
//   1) 步骤卡（左侧）→ 日历：按落下位置生成时间块（起始=落点 5 分钟吸附，时长=AI 推荐）
//   2) 时间块（日历）→ 左侧面板：取消安排（左侧变回「待安排」）
//   3) 时间块（日历）→ 日历内另一位置：移动时间块（改起始时间）
// 说明：采用 HTML5 Drag and Drop（桌面稳定可靠）。完成后（completed）的步骤/块不可拖拽。
import { store } from './store.js';
import {
  snapMinutes,
  clamp,
  timeToMinutes,
  minutesToTime,
  durationMinutes,
} from './utils.js';

const SNAP = 5; // Step 5 确认：5 分钟网格吸附
const ADJACENT_SNAP = 6; // 落点距上一块结束 ≤6 分钟时，精确吸附到该结束时刻，便于「紧接着」排程

let timelineEl, blocksEl, dropZoneLeft, previewEl;
let currentDrag = null; // { type: 'step' | 'block', id }

/** 读取令牌中的每小时像素高度，JS 与 CSS 共用同一基准 */
function hourHeightPx() {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue('--timeline-hour-height')
    .trim();
  return parseFloat(v) || 52;
}

/** 游标 Y -> 时间线起始分钟（吸附） */
function startMinFromClientY(clientY) {
  const h = hourHeightPx();
  const rect = timelineEl.getBoundingClientRect();
  const y = clientY - rect.top; // 时间线内容内的纵向偏移
  let min = y / (h / 60);
  min = snapMinutes(min, SNAP);
  // 智能相邻吸附：贴近上一块结束时，精确对齐到其结束时刻（不改变任务时间，仅落点吸附）
  min = smartAdjacentSnap(min);
  return clamp(min, 0, 1440);
}

/**
 * 若落点（已 5 分钟网格吸附后）距某块的结束时刻 ≤ ADJACENT_SNAP，
 * 则吸附到该结束时刻，实现「上一项 10:00 结束 → 下一项 10:00 开始」的紧凑排程。
 */
function smartAdjacentSnap(min) {
  const date = store.getState().currentDate;
  let best = min;
  let bestDelta = ADJACENT_SNAP;
  for (const it of store.getScheduleByDate(date)) {
    const endMin = timeToMinutes(it.endTime);
    const d = Math.abs(min - endMin);
    if (d < bestDelta) {
      bestDelta = d;
      best = endMin;
    }
  }
  return best;
}

function showPreview(clientY) {
  const h = hourHeightPx();
  const min = startMinFromClientY(clientY);
  const dur = previewDuration();
  const topPx = min * (h / 60);
  // 预览框 = 真实时间块的倒影：顶部虚线即开始时刻，高度即任务时长，
  // 让落点位置与块长度一目了然（顶部线天然代表开始时间）
  const heightPx = Math.max(dur * (h / 60), 6);
  previewEl.style.top = `${topPx}px`;
  previewEl.style.height = `${heightPx}px`;
  previewEl.hidden = false;
}

/** 拖拽预览框的时长：与真实时间块一致（步骤=AI 推荐；块=既有时长） */
function previewDuration() {
  if (!currentDrag) return SNAP;
  if (currentDrag.type === 'step') {
    const step = store.getStep(currentDrag.id);
    return Math.max(step?.estimatedMinutes || SNAP, SNAP);
  }
  if (currentDrag.type === 'block') {
    const item = store.getSchedule(currentDrag.id);
    if (item) return Math.max(durationMinutes(item.startTime, item.endTime), SNAP);
  }
  return SNAP;
}
function clearPreview() {
  if (previewEl) previewEl.hidden = true;
}

export function initDragDrop() {
  timelineEl = document.getElementById('timeline');
  blocksEl = document.getElementById('timelineBlocks');
  dropZoneLeft = document.getElementById('taskPanelBody');
  if (!timelineEl || !blocksEl || !dropZoneLeft) return;

  // 拖拽预览线（落点提示）
  previewEl = document.createElement('div');
  previewEl.className = 'timeline__preview';
  previewEl.hidden = true;
  timelineEl.appendChild(previewEl);

  // —— 来源：步骤卡（左侧列表，事件委托）——
  const stepList = document.getElementById('stepList');
  stepList.addEventListener('dragstart', onStepDragStart);
  stepList.addEventListener('dragend', onDragEnd);

  // —— 来源：时间块（日历，事件委托）——
  blocksEl.addEventListener('dragstart', onBlockDragStart);
  blocksEl.addEventListener('dragend', onDragEnd);

  // —— 目标：时间线（生成 / 移动）——
  timelineEl.addEventListener('dragover', onTimelineDragOver);
  timelineEl.addEventListener('dragleave', onTimelineDragLeave);
  timelineEl.addEventListener('drop', onTimelineDrop);

  // —— 目标：左侧面板（取消安排）——
  dropZoneLeft.addEventListener('dragover', onLeftDragOver);
  dropZoneLeft.addEventListener('dragleave', onLeftDragLeave);
  dropZoneLeft.addEventListener('drop', onLeftDrop);
}

/* ---------------- 来源 ---------------- */
function onStepDragStart(e) {
  const card = e.target.closest('.step-card');
  if (!card) return;
  const stepId = card.dataset.stepId;
  const step = store.getStep(stepId);
  if (!step || step.completed) {
    e.preventDefault(); // 已完成不可拖拽
    return;
  }
  currentDrag = { type: 'step', id: stepId };
  e.dataTransfer.effectAllowed = 'copy';
  e.dataTransfer.setData('text/plain', stepId);
  card.classList.add('is-drag-source');
}

function onBlockDragStart(e) {
  const blk = e.target.closest('.time-block');
  if (!blk) return;
  const id = blk.dataset.id;
  const step = store.getStep(blk.dataset.step);
  if (!step || step.completed) {
    e.preventDefault(); // 已完成锁定
    return;
  }
  currentDrag = { type: 'block', id };
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', id);
  blk.classList.add('is-drag-source');
}

function onDragEnd() {
  currentDrag = null;
  document
    .querySelectorAll('.is-drag-source')
    .forEach((el) => el.classList.remove('is-drag-source'));
  clearPreview();
  timelineEl.classList.remove('is-drop-target');
  dropZoneLeft.classList.remove('is-drop-target');
}

/* ---------------- 目标：时间线 ---------------- */
function onTimelineDragOver(e) {
  if (!currentDrag || (currentDrag.type !== 'step' && currentDrag.type !== 'block')) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = currentDrag.type === 'step' ? 'copy' : 'move';
  timelineEl.classList.add('is-drop-target');
  showPreview(e.clientY);
}

function onTimelineDragLeave(e) {
  if (e.relatedTarget && timelineEl.contains(e.relatedTarget)) return;
  timelineEl.classList.remove('is-drop-target');
  clearPreview();
}

function onTimelineDrop(e) {
  if (!currentDrag) return;
  e.preventDefault();
  timelineEl.classList.remove('is-drop-target');
  clearPreview();

  const date = store.getState().currentDate;
  const startMin = startMinFromClientY(e.clientY);

  if (currentDrag.type === 'step') {
    scheduleStep(currentDrag.id, date, startMin);
  } else if (currentDrag.type === 'block') {
    const item = store.getSchedule(currentDrag.id);
    if (item) {
      const dur = Math.max(durationMinutes(item.startTime, item.endTime), SNAP);
      // 同步更新日期（跨日拖动时排程日期跟着走）；store 保证单任务单排程
      store.moveSchedule(currentDrag.id, clamp(startMin, 0, 1440 - dur), date);
    }
  }
}

/** 把步骤排进日历：addSchedule 已保证同一步骤只保留一条排程（任意日期），
 *  故拖到新日期即视为「移动到该日期」，不会在多处同时出现。 */
function scheduleStep(stepId, date, startMin) {
  const step = store.getStep(stepId);
  if (!step) return;
  const dur = Math.max(step.estimatedMinutes, SNAP);
  const startClamped = clamp(startMin, 0, 1440 - dur);
  store.addSchedule({
    stepId,
    date,
    startTime: minutesToTime(startClamped),
    endTime: minutesToTime(startClamped + dur),
  });
}

/* ---------------- 目标：左侧面板（取消安排）---------------- */
function onLeftDragOver(e) {
  if (!currentDrag || currentDrag.type !== 'block') return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  dropZoneLeft.classList.add('is-drop-target');
}

function onLeftDragLeave(e) {
  if (e.relatedTarget && dropZoneLeft.contains(e.relatedTarget)) return;
  dropZoneLeft.classList.remove('is-drop-target');
}

function onLeftDrop(e) {
  if (!currentDrag || currentDrag.type !== 'block') return;
  e.preventDefault();
  dropZoneLeft.classList.remove('is-drop-target');
  const item = store.getSchedule(currentDrag.id);
  if (item) {
    store.deleteSchedule(currentDrag.id); // 取消安排 -> 左侧变回「待安排」
  }
}
