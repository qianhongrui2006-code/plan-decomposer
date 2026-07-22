// panel-resize.js — 面板布局可调节（稳定版 v2）
// 功能：
//   1) 宽度拖拽调节（面板间分隔区 resizer，带 <||> 抓取提示）
//   2) 顺序拖拽换位（每个面板顶部的三灰点手柄）
//      - 拖到目标模块上方：高亮落点 + 显示交换预览
//      - 松开鼠标：真正交换位置（带 FLIP 滑动动画）
//   3) 键盘可达（焦点在手柄上时方向键调整顺序）
//   4) 配置持久化（顺序/宽度写入 store -> localStorage）
//   5) 窄屏自动堆叠（<768px 时禁用宽度调节，顺序仍可调）
//
// 设计要点：落点判定改用「几何法」（游标 X 与各面板矩形比对），
// 不再依赖 elementFromPoint + 源面板 pointer-events:none 的命中穿透，
// 在各类浏览器下都稳定可靠。
import { store, CENTER_PANEL, MIN_PANEL_WIDTH } from './store.js';

const RESIZER_GAP = 20; // 与 CSS .resizer 宽度对应（px）
const MAX_PANEL_WIDTH = 720;

let layoutEl = null;
let panels = {};            // data-panel -> element
let resizers = [];          // 两个分隔区元素
let lastLayoutSig = '';
let draggingPanel = null;
let animateLayout = false;  // 仅顺序交换时触发 FLIP 动画

function isStacked() {
  return window.matchMedia('(max-width: 768px)').matches;
}

function buildResizers() {
  resizers = [0, 1].map(() => {
    const r = document.createElement('div');
    r.className = 'resizer';
    r.setAttribute('role', 'separator');
    r.setAttribute('aria-orientation', 'vertical');
    r.setAttribute('aria-label', '拖动调整面板宽度');
    r.setAttribute('tabindex', '-1');
    r.innerHTML =
      '<span class="resizer__grip" aria-hidden="true"><i></i><i></i></span>';
    return r;
  });
}

/* 找游标 X 落在哪个面板的矩形内（几何判定，稳定） */
function panelAtX(x) {
  let best = null;
  let bestDist = Infinity;
  for (const p of Object.values(panels)) {
    const rect = p.getBoundingClientRect();
    if (x >= rect.left && x <= rect.right) return p;
    const dist = x < rect.left ? rect.left - x : x - rect.right;
    if (dist < bestDist) {
      bestDist = dist;
      best = p;
    }
  }
  return best;
}

/* 按 store 中的 order 重排 DOM，并应用宽度（可选 FLIP 动画） */
function applyLayout(animate) {
  const firstRects = animate ? captureRects() : null;

  const { order, widths } = store.getLayout();
  const stacked = isStacked();

  // 1) 重排 DOM：面板与分隔区交错（分隔区 i 位于 order[i] 与 order[i+1] 之间）
  const seq = [];
  order.forEach((pid, i) => {
    const p = panels[pid];
    if (!p) return;
    seq.push(p);
    if (i < order.length - 1) seq.push(resizers[i]);
  });
  seq.forEach((el) => layoutEl.appendChild(el)); // 按 order 重新排列（appendChild 会移动节点）

  // 2) 应用宽度
  order.forEach((pid) => {
    const p = panels[pid];
    if (!p) return;
    if (stacked) {
      p.style.flex = '';
      p.style.width = '';
      p.style.minWidth = '';
      return;
    }
    if (pid === CENTER_PANEL) {
      p.style.flex = '1 1 0';
      p.style.width = '';
      p.style.minWidth = '0';
    } else {
      const w = Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, widths[pid] ?? 340));
      p.style.flex = `0 0 ${w}px`;
      p.style.width = `${w}px`;
      p.style.minWidth = '0';
    }
  });

  lastLayoutSig = JSON.stringify(store.getLayout());
  if (animate && firstRects) playFlip(firstRects);
}

function captureRects() {
  const m = {};
  Object.values(panels).forEach((p) => {
    m[p.dataset.panel] = p.getBoundingClientRect();
  });
  return m;
}

/* FLIP：先记录旧位置，DOM 重排后把面板「瞬移」回去，再过渡回原位 = 滑动动画 */
function playFlip(firstRects) {
  Object.values(panels).forEach((p) => {
    const first = firstRects[p.dataset.panel];
    if (!first) return;
    const last = p.getBoundingClientRect();
    const dx = first.left - last.left;
    const dy = first.top - last.top;
    if (dx === 0 && dy === 0) return;
    p.style.transition = 'none';
    p.style.transform = `translate(${dx}px, ${dy}px)`;
    void p.getBoundingClientRect(); // 强制回流
    requestAnimationFrame(() => {
      p.style.transition = 'transform 280ms ease';
      p.style.transform = '';
      const onEnd = () => {
        p.style.transition = '';
        p.removeEventListener('transitionend', onEnd);
      };
      p.addEventListener('transitionend', onEnd);
    });
  });
}

/* ---------------- 宽度拖拽 ---------------- */
function onResizerPointerDown(e, resizer) {
  if (e.button !== undefined && e.button !== 0) return; // 仅左键
  if (isStacked()) return; // 窄屏不调节宽度
  e.preventDefault();

  const prev = resizer.previousElementSibling;
  const next = resizer.nextElementSibling;

  // 目标 = 相邻两面板中「非中间面板」的那个侧栏
  let target = null;
  let dir = 1; // dir=1：向右拖=变宽；dir=-1：向右拖=变窄
  if (prev?.dataset?.panel && prev.dataset.panel !== CENTER_PANEL) {
    target = prev; dir = 1;
  } else if (next?.dataset?.panel && next.dataset.panel !== CENTER_PANEL) {
    target = next; dir = -1;
  } else if (prev?.dataset?.panel) {
    target = prev; dir = 1;
  }
  if (!target) return;

  resizer.classList.add('is-active');
  target.classList.add('is-resizing-panel');
  document.body.classList.add('is-resizing');
  try { resizer.setPointerCapture(e.pointerId); } catch {}

  const startX = e.clientX;
  const startW = target.getBoundingClientRect().width;
  const maxW = Math.min(
    MAX_PANEL_WIDTH,
    Math.max(
      MIN_PANEL_WIDTH + 40,
      layoutEl.getBoundingClientRect().width - MIN_PANEL_WIDTH * 2 - RESIZER_GAP * 2 - 32
    )
  );

  function move(ev) {
    const dx = (ev.clientX - startX) * dir;
    const w = Math.min(maxW, Math.max(MIN_PANEL_WIDTH, startW + dx));
    target.style.flex = `0 0 ${w}px`;
    target.style.width = `${w}px`;
  }
  function up() {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    document.removeEventListener('pointercancel', up);
    try { resizer.releasePointerCapture(e.pointerId); } catch {}
    resizer.classList.remove('is-active');
    document.body.classList.remove('is-resizing');
    target.classList.remove('is-resizing-panel');
    const w = Math.round(target.getBoundingClientRect().width);
    store.setLayoutWidths({ [target.dataset.panel]: w }); // 触发重排（无动画）
  }
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
  document.addEventListener('pointercancel', up);
}

/* ---------------- 顺序拖拽（几何判定落点 + 松手交换）---------------- */
function clearDropTargets() {
  Object.values(panels).forEach((p) => p.classList.remove('is-drop-target'));
}

function onHandlePointerDown(e, handle) {
  if (e.button !== undefined && e.button !== 0) return; // 仅左键
  e.preventDefault();
  const panel = handle.closest('.panel[data-panel]');
  if (!panel) return;
  draggingPanel = panel;
  panel.classList.add('is-dragging'); // 视觉浮起（不再设 pointer-events:none）
  document.body.classList.add('is-reordering');
  try { handle.setPointerCapture(e.pointerId); } catch {}

  let overPanel = null;
  function move(ev) {
    ev.preventDefault();
    const p = isStacked() ? panelAtY(ev.clientY) : panelAtX(ev.clientX);
    if (p && p !== draggingPanel) {
      if (p !== overPanel) {
        clearDropTargets();
        overPanel = p;
        overPanel.classList.add('is-drop-target'); // 高亮落点：显示交换预览
      }
    } else if (overPanel) {
      clearDropTargets();
      overPanel = null;
    }
  }
  function up() {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    document.removeEventListener('pointercancel', up);
    try { handle.releasePointerCapture(e.pointerId); } catch {}
    document.body.classList.remove('is-reordering');
    draggingPanel.classList.remove('is-dragging');
    clearDropTargets();
    // 松手才真正交换
    if (overPanel && overPanel !== draggingPanel) {
      const order = [...store.getLayout().order];
      const from = order.indexOf(draggingPanel.dataset.panel);
      const to = order.indexOf(overPanel.dataset.panel);
      if (from >= 0 && to >= 0) {
        order.splice(from, 1);
        order.splice(to, 0, draggingPanel.dataset.panel);
        animateLayout = true; // 触发 FLIP 滑动动画
        store.setLayoutOrder(order);
      }
    }
    draggingPanel = null;
    overPanel = null;
  }
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
  document.addEventListener('pointercancel', up);
}

/* 窄屏：找游标 Y 落在哪个面板 */
function panelAtY(y) {
  let best = null;
  let bestDist = Infinity;
  for (const p of Object.values(panels)) {
    const rect = p.getBoundingClientRect();
    if (y >= rect.top && y <= rect.bottom) return p;
    const dist = y < rect.top ? rect.top - y : y - rect.bottom;
    if (dist < bestDist) {
      bestDist = dist;
      best = p;
    }
  }
  return best;
}

/* 键盘可达：方向键调整顺序（带动画） */
function onHandleKeyDown(e, handle) {
  const panel = handle.closest('.panel[data-panel]');
  if (!panel) return;
  const key = panel.dataset.panel;
  const order = [...store.getLayout().order];
  const i = order.indexOf(key);
  let to = -1;
  if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') to = i - 1;
  else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') to = i + 1;
  else return;
  if (to < 0 || to >= order.length) return;
  e.preventDefault();
  order.splice(i, 1);
  order.splice(to, 0, key);
  animateLayout = true;
  store.setLayoutOrder(order);
}

/* ---------------- 初始化 ---------------- */
export function initPanelResize() {
  layoutEl = document.querySelector('.layout');
  if (!layoutEl) return;

  panels = {};
  layoutEl.querySelectorAll('.panel[data-panel]').forEach((p) => {
    panels[p.dataset.panel] = p;
  });
  buildResizers();

  // 绑定拖拽手柄（指针拖拽 + 键盘）
  layoutEl.querySelectorAll('[data-drag-handle]').forEach((h) => {
    h.addEventListener('pointerdown', (e) => onHandlePointerDown(e, h));
    h.addEventListener('keydown', (e) => onHandleKeyDown(e, h));
  });

  bindResizers();
  applyLayout(false);

  // 订阅布局变化：持久化后刷新 DOM（仅当布局确实变化才重排）
  store.subscribe(() => {
    const sig = JSON.stringify(store.getLayout());
    if (sig === lastLayoutSig) return;
    bindResizers();
    applyLayout(animateLayout);
    animateLayout = false;
  });

  // 窗口尺寸变化：切换堆叠/非堆叠
  let rt = null;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => applyLayout(false), 120);
  });
}

/* 分隔区已绑定一次，重复调用安全 */
function bindResizers() {
  resizers.forEach((r) => {
    if (r._bound) return;
    r.addEventListener('pointerdown', (e) => onResizerPointerDown(e, r));
    r._bound = true;
  });
}
