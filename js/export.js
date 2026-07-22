// export.js — 导出当前计划为 JSON（Step 7）
// 导出范围：当前正在编辑的那一份计划（单计划模型下即 tasks[0]），
// 含步骤、手动编辑后的标题/描述/子任务、完成态与排期。不包含面板布局配置。
import { timeToMinutes, minutesToTime } from './utils.js';

/** 取当前计划（单计划模型：tasks[0]），无计划返回 null */
function getCurrentPlan(store) {
  const task = store.getState().tasks[0];
  if (!task || task.steps.length === 0) return null;
  return task;
}

/** 构建导出数据对象（结构化、可读、含元信息） */
function buildPayload(store) {
  const task = getCurrentPlan(store);
  const stepIds = new Set(task.steps.map((s) => s.id));
  const schedule = store
    .getState()
    .schedule.filter((s) => stepIds.has(s.stepId))
    .sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));

  return {
    app: '计划分解器',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    plan: {
      title: task.title,
      description: task.description || '',
      createdAt: task.createdAt,
      steps: task.steps
        .slice()
        .sort((a, b) => a.order - b.order)
        .map((s) => ({
          title: s.title,
          standard: s.standard || '',
          estimatedMinutes: s.estimatedMinutes,
          completed: !!s.completed,
          order: s.order,
          subtasks: (s.subtasks || []).map((st) => ({
            title: st.title,
            completed: !!st.completed,
          })),
        })),
      schedule: schedule.map((s) => ({
        date: s.date,
        startTime: s.startTime,
        endTime: s.endTime,
        completed: !!s.completed,
      })),
    },
  };
}

/** 触发浏览器下载一个 JSON 文件 */
function downloadJSON(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** 把计划标题转为安全的文件名片段 */
function safeName(title) {
  return (
    String(title || 'plan')
      .trim()
      .replace(/[\\/:*?"<>|]+/g, '_')
      .slice(0, 40) || 'plan'
  );
}

/**
 * 导出当前计划。
 * @returns {boolean} 是否成功触发下载（无计划时返回 false）
 */
export function exportCurrentPlan(store) {
  const task = getCurrentPlan(store);
  if (!task) return false;
  const date = store.getState().currentDate;
  const payload = buildPayload(store);
  const filename = `计划分解器-${safeName(task.title)}-${date}.json`;
  downloadJSON(filename, payload);
  return true;
}
