// calendar.js — Step 4 中间时间日历面板
// 功能：
//   1) 渲染 00:00–24:00 时间刻度（每小时实线 + 半小时虚线）
//   2) 渲染当前时间红线，每分钟自动移动
//   3) 渲染当日已排时间块（高度按 AI 推荐时长换算）
//   4) 日期前后切换 / 回到今天
// 说明：时间块的"默认时长 = 步骤 AI 推荐时长"由 Step 5 拖拽生成时确定，
//       此处仅负责按 schedule 数据渲染（startTime/endTime 已含时长），
//       因此现在即使还没有拖拽，空白日历也能看到完整刻度与当前时间线。
import { store } from './store.js';
import {
  addDays,
  todayStr,
  timeToMinutes,
  nowTimeStr,
  durationMinutes,
} from './utils.js';

const DAY_START = 0;
const DAY_END = 24;

let bodyEl, timelineEl, gridEl, blocksEl, nowLineEl, checkpointEl;
let nowTimer = null;
let lastSig = '';
let lastDate = '';
let selectedStepId = null; // 当前选中的步骤（来自左栏卡片或时间块点击），用于高亮对应时间块
let filterMilestone = null; // 左栏阶段头点击筛选：非该里程碑的时间块暗淡显示

/** 资源类型 → 中文标签 */
function resTypeLabel(type) {
  return { article: '文章', video: '视频', practice: '实践' }[type] || '资源';
}

/** 读取令牌中的每小时像素高度，JS 与 CSS 共用同一基准 */
function hourHeightPx() {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue('--timeline-hour-height')
    .trim();
  return parseFloat(v) || 64;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function stepTitle(stepId) {
  const s = store.getStep(stepId);
  return s ? s.title : '（已删除步骤）';
}

function renderGrid() {
  const h = hourHeightPx();
  const rows = [];
  for (let hr = DAY_START; hr < DAY_END; hr++) {
    rows.push(
      `<div class="timeline__hour">` +
        `<span class="timeline__hour-label">${String(hr).padStart(2, '0')}:00</span>` +
        `<span class="timeline__half"></span>` +
      `</div>`
    );
  }
  rows.push(`<div class="timeline__end"><span class="timeline__hour-label">24:00</span></div>`);
  gridEl.innerHTML = rows.join('');
  timelineEl.style.height = `${DAY_END * h}px`;
}

function renderBlocks() {
  const h = hourHeightPx();
  const pxPerMin = h / 60;
  const gap = parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--block-gap')
  ) || 8;
  // 极短任务的微小兜底高度，避免高度为 0/负值（不改变时间对应）
  const MIN_SLOT = 4;
  // 布局按「内层卡片高度 = 外层时间槽高度 − 间隔」判定：
  // - cardH < 18px：极短块，只显示时间（标题进 aria-label）
  // - ≥ 18px：统一单行显示「标题 + 时间」，标题省略、时间固定右侧，避免标题/时间黏连或换行
  // - ≥ 44px 且有资源：追加第二行「资源胶囊」（类型 + 资源名）
  const MICRO_PX = 18;
  const RICH_PX = 44;
  const date = store.getState().currentDate;
  const items = store.getScheduleByDate(date);
  // 时间精确渲染：外层 .time-block 占满真实时间槽（top/height 与时刻一一对应）；
  // 内层 .time-block__card 使用 margin:gap/2 0 形成与相邻块的物理间隔。
  // 任务时间数据完全不变，间隔纯展示层留白。
  blocksEl.innerHTML = items.map((it) => {
    const startMin = timeToMinutes(it.startTime);
    const dur = Math.max(durationMinutes(it.startTime, it.endTime), 15);
    const top = startMin * pxPerMin;
    const height = Math.max(dur * pxPerMin, MIN_SLOT);
    const cardH = Math.max(height - gap, 2);
    const isMicro = cardH < MICRO_PX;
    const step = store.getStep(it.stepId);
    const done = !!step?.completed;
    const res = step && step.resource && step.resource.name ? step.resource : null;
    const showRes = !isMicro && cardH >= RICH_PX && !!res;
    // 阶段筛选：非该里程碑的块暗淡（不清除，保留位置感）
    const dimmed =
      !!filterMilestone && (step ? step.milestone || '' : '') !== filterMilestone;
    const cls = 'time-block' +
      (done ? ' is-done' : '') +
      (isMicro ? ' is-micro' : '') +
      (it.stepId === selectedStepId ? ' is-selected' : '') +
      (dimmed ? ' is-dimmed' : '');
    const draggable = done ? 'false' : 'true';
    const check = done
      ? '<label class="time-block__check" title="标记完成">' +
        '<input type="checkbox" data-act="toggle-done" checked /></label>'
      : '<label class="time-block__check" title="标记完成">' +
        '<input type="checkbox" data-act="toggle-done" /></label>';
    const title = escapeHtml(stepTitle(it.stepId));
    const time = `${it.startTime}–${it.endTime}`;
    let body;
    if (isMicro) {
      body = `<div class="time-block__time">${time}</div>`;
    } else if (showRes) {
      body =
        `<div class="time-block__row">` +
          `<div class="time-block__title">${title}</div>` +
          `<div class="time-block__time">${time}</div>` +
        `</div>` +
        `<div class="time-block__res"><i>${resTypeLabel(res.type)}</i><span>${escapeHtml(res.name)}</span></div>`;
    } else {
      body =
        `<div class="time-block__title">${title}</div>` +
        `<div class="time-block__time">${time}</div>`;
    }
    return (
      `<div class="${cls}" data-id="${it.id}" data-step="${it.stepId}" ` +
      `draggable="${draggable}" ` +
      `style="top:${top}px;height:${height}px" tabindex="0" role="button" ` +
      `aria-label="${title} ${time}">` +
        `<div class="time-block__card${showRes ? ' is-rich' : ''}">` +
          check +
          body +
        `</div>` +
      `</div>`
    );
  }).join('');
}

/** 底部「本日检查点」条：今日任务进度 + 当前里程碑交付物（sticky 吸附日历底部） */
function renderCheckpoint() {
  if (!checkpointEl) return;
  const date = store.getState().currentDate;
  const items = store.getScheduleByDate(date);
  const hasAnyPlan = store.getState().plans.some((p) => p.steps && p.steps.length > 0);

  // 无排程：仅「今天 + 已有计划」时给引导，其余情况隐藏
  if (!items.length) {
    if (isTodayView() && hasAnyPlan) {
      checkpointEl.hidden = false;
      checkpointEl.innerHTML =
        `<span class="today-checkpoint__icon" aria-hidden="true">🎯</span>` +
        `<span>今天还没有安排任务，把左侧任务拖进来开始执行吧</span>`;
    } else {
      checkpointEl.hidden = true;
    }
    return;
  }

  const done = items.filter((it) => {
    const s = store.getStep(it.stepId);
    return !!s?.completed;
  }).length;

  // 检查点锚点：第一个未完成任务的里程碑交付物；全部完成则用最后一块的里程碑
  const steps = items.map((it) => store.getStep(it.stepId)).filter(Boolean);
  const anchor = steps.find((s) => !s.completed) || steps[steps.length - 1];
  let checkpoint = '';
  if (anchor && anchor.milestone) {
    const anchorPlan = store.getState().plans.find((p) => p.id === anchor.taskId);
    if (anchorPlan && Array.isArray(anchorPlan.milestones)) {
      const meta = anchorPlan.milestones.find((m) => m.title === anchor.milestone);
      if (meta && meta.deliverable) checkpoint = meta.deliverable;
    }
  }

  const allDone = done === items.length;
  checkpointEl.hidden = false;
  checkpointEl.innerHTML = allDone
    ? `<span class="today-checkpoint__icon" aria-hidden="true">🎉</span>` +
      `<span><strong>本日任务全部完成！</strong><em class="today-checkpoint__progress">${done}/${items.length}</em></span>`
    : `<span class="today-checkpoint__icon" aria-hidden="true">🎯</span>` +
      `<span>本日检查点：<strong>${escapeHtml(checkpoint || '完成今天安排的任务')}</strong><em class="today-checkpoint__progress">${done}/${items.length}</em></span>`;
}

function isTodayView() {
  return store.getState().currentDate === todayStr();
}

function updateNowLine() {
  if (!nowLineEl) return;
  // 仅当查看「今天」时才显示当前时间线（其它日期无「现在」可言）
  if (!isTodayView()) {
    nowLineEl.style.display = 'none';
    return;
  }
  nowLineEl.style.display = '';
  const h = hourHeightPx();
  const curMin = timeToMinutes(nowTimeStr());
  nowLineEl.style.top = `${curMin * (h / 60)}px`;
}

function scrollToNow() {
  const h = hourHeightPx();
  const curMin = timeToMinutes(nowTimeStr());
  const target = curMin * (h / 60) - bodyEl.clientHeight / 3;
  bodyEl.scrollTop = Math.max(0, target);
}

function scheduleSig() {
  const date = store.getState().currentDate;
  const items = store.getScheduleByDate(date);
  const activePlanId = store.getState().activePlanId || '';
  // 纳入 completed / 步骤标题 / 里程碑 / 资源 / activePlanId，切换计划时触发重渲染
  return date + '|' + activePlanId + '|' + (filterMilestone || '') + '|' + items
    .map((i) => {
      const s = store.getStep(i.stepId);
      const res = s && s.resource && s.resource.name ? `${s.resource.type}:${s.resource.name}` : '';
      return `${i.id}:${i.startTime}:${i.endTime}:${i.completed ? 1 : 0}:${s?.completed ? 1 : 0}:${s?.title || ''}:${s?.milestone || ''}:${res}`;
    })
    .join(',');
}

function onStoreChange() {
  const date = store.getState().currentDate;
  if (date !== lastDate) {
    lastDate = date;
    scrollToNow();
    updateNowLine(); // 日期切换后立即刷新红线显隐（仅今天显示）
  }
  renderCheckpoint(); // 检查点条轻量，每次状态变化都刷新
  const sig = scheduleSig();
  if (sig === lastSig) return;
  lastSig = sig;
  renderBlocks();
}

/** 选中时间块 -> 高亮并通知详情面板（Step 6 接入） */
function selectBlock(blk) {
  if (!blk) return;
  selectedStepId = blk.dataset.step;
  blocksEl.querySelectorAll('.time-block.is-selected')
    .forEach((b) => b.classList.remove('is-selected'));
  blk.classList.add('is-selected');
  document.dispatchEvent(
    new CustomEvent('timeblock:select', { detail: { id: blk.dataset.id, stepId: blk.dataset.step } })
  );
}

/** 左栏步骤卡选中 -> 高亮日历中对应时间块（若当天已排） */
function onStepSelect(e) {
  selectedStepId = e.detail && e.detail.stepId;
  renderBlocks();
}

export function initCalendar() {
  bodyEl = document.getElementById('calendarBody');
  if (!bodyEl) return;

  bodyEl.innerHTML =
    `<div class="timeline" id="timeline">` +
      `<div class="timeline__grid" id="timelineGrid"></div>` +
      `<div class="timeline__blocks" id="timelineBlocks"></div>` +
      `<div class="now-line" id="nowLine"></div>` +
    `</div>` +
    `<div class="today-checkpoint" id="todayCheckpoint" hidden></div>`;

  timelineEl = document.getElementById('timeline');
  gridEl = document.getElementById('timelineGrid');
  blocksEl = document.getElementById('timelineBlocks');
  nowLineEl = document.getElementById('nowLine');
  checkpointEl = document.getElementById('todayCheckpoint');

  renderGrid();
  renderBlocks();
  renderCheckpoint();
  updateNowLine();
  scrollToNow();
  lastSig = scheduleSig();
  lastDate = store.getState().currentDate;

  // 日期导航
  document.getElementById('prevDay')?.addEventListener('click', () => {
    store.setCurrentDate(addDays(store.getState().currentDate, -1));
  });
  document.getElementById('nextDay')?.addEventListener('click', () => {
    store.setCurrentDate(addDays(store.getState().currentDate, 1));
  });
  document.getElementById('todayBtn')?.addEventListener('click', () => {
    store.setCurrentDate(todayStr());
  });

  // 时间块选择 / 完成勾选（点击 / 键盘）
  blocksEl.addEventListener('click', (e) => {
    const check = e.target.closest('[data-act="toggle-done"]');
    if (check) {
      e.preventDefault();
      const blk = e.target.closest('.time-block');
      if (blk && blk.dataset.step) store.toggleStepComplete(blk.dataset.step);
      return;
    }
    selectBlock(e.target.closest('.time-block'));
  });
  blocksEl.addEventListener('keydown', (e) => {
    const blk = e.target.closest('.time-block');
    if (blk && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      selectBlock(blk);
    }
  });

  // 每分钟移动红线
  if (nowTimer) clearInterval(nowTimer);
  nowTimer = setInterval(updateNowLine, 60 * 1000);

  store.subscribe(onStoreChange);

  // 左栏步骤卡选中 -> 高亮日历对应块（Step 6）
  document.addEventListener('step:select', onStepSelect);

  // 左栏阶段头筛选 -> 非该里程碑的时间块暗淡显示
  document.addEventListener('milestone:filter', (e) => {
    filterMilestone = (e.detail && e.detail.milestone) || null;
    lastSig = ''; // 强制重渲染（sig 含筛选条件，此处兜底）
    renderBlocks();
  });

  // 计划切换时刷新日历
  document.addEventListener('plan:switch', () => {
    filterMilestone = null;
    lastSig = '';
    lastDate = '';
    renderBlocks();
  });
}
