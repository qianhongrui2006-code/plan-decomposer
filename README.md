# 计划分解器（Plan Decomposer）

一个本地优先的**单计划时间规划工具**：把一段目标描述交给 AI 分解成可执行步骤，拖入日历排期，逐步打勾推进。纯前端、零构建、数据存本地，刷新不丢。

---

## ✨ 功能特性

- **AI 步骤分解**：输入目标 → 自动拆成有序步骤，并给出每步 AI 建议时长
- **拖拽排期**：左侧步骤卡拖入中间日历即生成时间块（5 分钟吸附、允许重叠）
- **单任务单排程**：一个任务只安排一次，拖到别的日期即「移动」而非复制
- **跨日期状态保持**：已安排的任务切换日期仍为「已安排」，左卡显示其排期时间
- **任务详情面板**：标题 / 描述（自适应高度）/ 子任务（AI 生成 + 手动增删 + 打勾）/ 完成勾选，即时自动保存
- **当前时间线**：仅「今天」显示半透明红色虚线，每分钟自动下移
- **面板可调**：三栏宽度可拖拽调节、顺序可拖拽重排（含键盘支持），配置持久化
- **导出 JSON**：一键导出当前计划（含步骤 / 子任务 / 排期 / 手动编辑）用于备份
- **响应式**：窄屏自动堆叠，仍可正常使用
- **可访问性**：语义化结构、ARIA 标签、键盘可达、`prefers-reduced-motion` 支持、WCAG AA 对比度

---

## 🚀 快速开始

### 方式一：直接打开（最简单）

用浏览器打开 `index.html` 即可（ES Modules 在现代浏览器中可直接以 `file://` 运行）。

### 方式二：起一个本地静态服务器（推荐，避免个别浏览器对 `file://` 模块的限制）

```bash
# 任选其一，在项目根目录执行
python3 -m http.server 8080
# 或
npx serve .
```

然后访问 `http://localhost:8080`。

> 部署：可整体上传到任意静态托管（如 CloudStudio / GitHub Pages / Vercel），无需后端。

---

## 📖 使用流程

1. **写计划**：在左侧文本框描述你的目标，点「AI 分解」。
2. **理步骤**：在左侧编辑步骤标题、调整顺序、删除冗余；底部「重新生成全部」可重跑。
3. **排时间**：把步骤卡拖到中间日历的对应时刻（落下位置 = 开始时间，时长 = AI 建议时长）。
4. **看详情**：点击左侧卡片或日历时间块，右侧打开详情；编辑描述、勾选子任务、标记完成。
5. **切日期**：用日历顶部的 ‹ › 或「今天」切换；已安排的任务状态跨日期保留。
6. **导出**：顶栏「导出日程」下载当前计划的 JSON 备份。

### 常用交互

| 操作 | 方式 |
|------|------|
| 打开详情 | 点击左侧步骤卡 / 点击日历时间块 |
| 标记完成 | 左卡 / 时间块上的勾选框（两侧同步灰化锁定） |
| 取消安排 | 把日历块拖回左侧面板 |
| 调时间 | 在日历内上下拖动时间块 |
| 调面板 | 面板间灰色分隔条拖拽改宽；面板顶部三灰点拖拽换位（或聚焦后用方向键） |
| 删除步骤 | 卡片上的 ✕（含二次确认） |

---

## 🗂️ 项目结构

```
计划分解器A/
├── index.html              # 三栏布局骨架 + 顶栏
├── css/
│   ├── tokens.css          # 设计令牌（颜色/字体/间距/圆角/阴影…，单一浅色主题）
│   ├── base.css            # reset、:focus-visible、reduced-motion、滚动条
│   ├── layout.css          # 三栏布局、面板尺寸、响应式、顶栏
│   └── components.css      # 按钮/卡片/时间块/详情面板/子任务 等组件样式
├── js/
│   ├── utils.js            # 时间解析/格式化、ID、日期、吸附、clamp
│   ├── store.js            # 集中式状态 + 存储抽象层（localStorage 持久化 + 版本控制）
│   ├── ai-service.js       # AI 分解（当前为 Mock，Step 8 替换为真实 API）
│   ├── task-panel.js       # 左侧：输入/分解/步骤列表/编辑/排序
│   ├── calendar.js         # 中间：时间线/日期导航/当前时间线/时间块渲染
│   ├── drag-drop.js        # 步骤 ↔ 日历 跨面板拖拽 + 时间块拖动
│   ├── detail-panel.js     # 右侧：任务详情/子任务/即时保存
│   ├── panel-resize.js     # 面板宽度/顺序拖拽调节 + 持久化
│   ├── export.js           # 导出当前计划为 JSON
│   └── app.js              # 入口：装配各模块、顶栏计划名、导出接线
└── README.md
```

---

## 🧱 技术栈

- **原生 HTML5 + CSS3 + JavaScript（ES Modules）**，无框架、无打包器
- **状态管理**：自研轻量 Store（发布/订阅）+ 存储抽象层
- **持久化**：`localStorage`（通过 `StorageAdapter` 接口隔离，未来可无缝替换为后端 API）
- **设计系统**：CSS 自定义属性（Design Tokens）+ 4px 间距基准 + 墨绿单一主题

### 数据模型

```text
Task      { id, title, description, createdAt, steps: Step[] }
Step      { id, taskId, title, standard, estimatedMinutes, order, completed, subtasks: Subtask[] }
Subtask   { id, title, completed }
ScheduleItem { id, stepId, date, startTime, endTime, completed, note }
```

---

## 💾 数据持久化与导出

- **自动保存**：所有改动（排期、编辑、完成态、面板布局）实时写入 `localStorage`，刷新/重开自动恢复。
- **导出格式**：`计划分解器-<计划名>-<日期>.json`，结构示例：

```json
{
  "app": "plan-decomposer",
  "schemaVersion": 1,
  "exportedAt": "2026-07-22T10:30:00.000Z",
  "plan": {
    "title": "写一份产品周报",
    "description": "",
    "steps": [
      { "id": "step_xxx", "title": "收集数据", "standard": "", "estimatedMinutes": 30,
        "completed": false, "subtasks": [{ "id": "sub_xxx", "title": "…", "completed": false }] }
    ]
  },
  "schedule": [
    { "id": "sch_xxx", "stepId": "step_xxx", "date": "2026-07-22",
      "startTime": "09:30", "endTime": "10:00", "completed": false }
  ]
}
```

> 当前版本仅「导出」；「导入 / 恢复」留待后续版本。

---

## ⌨️ 键盘可达性

- 面板顺序手柄：聚焦后 `←/→`（或 `↑/↓`）移动
- 日历时间块：`Tab` 聚焦，`Enter` / `空格` 打开详情
- 所有按钮、输入框、勾选框均可用键盘操作
- 开启系统「减少动态效果」后，动画与过渡自动降级

---

## 🧭 后续路线图

- **Step 8 · 接入真实 AI**：用大模型 API 替换 `ai-service.js` 的 Mock（需设计 Prompt / 调用 / 错误处理 / Key 管理）
- **导入 / 恢复**：读回导出的 JSON
- **重复计划**：同一任务周期性重复（每天 / 每周）多排程场景

---

© 计划分解器 · 纯前端单计划规划工具
