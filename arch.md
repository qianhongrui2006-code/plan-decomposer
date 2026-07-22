# 计划分解器 - 架构文档

## 1. 技术栈

### 1.1 前端框架
- **HTML5 + 原生 JavaScript**：为保持项目轻量、易理解和快速迭代，采用无框架方案
- **CSS3**：使用 CSS 变量构建设计系统
- **原生 Drag and Drop API**：实现左侧到中间、以及时间线内部的拖拽

### 1.2 构建工具
- 无需复杂构建工具
- 使用原生 ES Modules
- 可选：Vite 作为轻量开发服务器（如后续需要）

### 1.3 AI 集成
- 使用大模型 API 进行任务分解
- 提供模拟/演示模式，方便离线开发和测试
- AI 返回结构化 JSON，便于解析为步骤列表

### 1.4 数据持久化
- `localStorage` 保存任务、步骤、日程安排
- 数据版本控制，便于后续迁移

---

## 2. 项目结构

```
计划分解器A/
├── index.html              # 主页面
├── css/
│   ├── tokens.css          # 设计令牌（颜色、字体、间距等）
│   ├── base.css            # 基础样式与重置
│   ├── layout.css          # 三栏布局
│   ├── components.css      # 组件样式
│   └── responsive.css      # 响应式适配
├── js/
│   ├── app.js              # 应用入口，初始化
│   ├── store.js            # 数据存储与状态管理
│   ├── ai-service.js       # AI 分解服务
│   ├── drag-drop.js        # 拖拽逻辑
│   ├── calendar.js         # 时间日历渲染与交互
│   ├── task-panel.js       # 左侧任务面板逻辑
│   ├── detail-panel.js     # 右侧详情面板逻辑
│   └── utils.js            # 工具函数
├── assets/
│   └── icons/              # SVG 图标
├── prd.md                  # 产品需求文档
├── arch.md                 # 架构文档
└── project_state.md        # 项目状态与任务追踪
```

---

## 3. 模块职责

### 3.1 app.js
- 应用启动入口
- 初始化各模块
- 订阅全局事件

### 3.2 store.js
- 集中式状态管理
- 提供 CRUD API：
  - `addTask(task)`
  - `getTask(id)`
  - `updateTask(id, patch)`
  - `deleteTask(id)`
  - `addStep(step)` / `updateStep` / `deleteStep`
  - `addSchedule(item)` / `updateSchedule` / `deleteSchedule`
- 自动同步 localStorage
- 发出状态变更事件

### 3.3 ai-service.js
- `decomposeTask(description)`：接收任务描述，返回步骤数组
- 支持两种模式：
  - **mock 模式**：本地预设分解逻辑，用于演示
  - **api 模式**：调用远程 AI API
- 对 AI 返回结果进行校验和格式化

### 3.4 drag-drop.js
- 封装拖拽逻辑
- 处理：
  - 左侧步骤卡片开始拖拽
  - 时间线拖拽进入/离开/放置
  - 时间块位置调整
  - 时间块时长调整
- 提供事件回调供其他模块消费

### 3.5 calendar.js
- 渲染时间日历面板
- 计算时间块位置与高度
- 处理日期切换
- 渲染当前时间线

### 3.6 task-panel.js
- 渲染左侧 AI 任务分解面板
- 处理用户输入与 AI 分解请求
- 管理步骤列表的增删改查
- 初始化步骤卡片的拖拽

### 3.7 detail-panel.js
- 渲染右侧任务详情面板
- 处理任务选中状态
- 处理详情编辑与保存

### 3.8 utils.js
- 时间格式化/解析
- ID 生成
- 日期计算
- 数据校验

---

## 4. 数据流

```
用户输入 → task-panel.js
    ↓
ai-service.js 分解任务
    ↓
store.js 保存 Task + Steps
    ↓
task-panel.js 渲染步骤列表
    ↓
用户拖拽 Step → drag-drop.js
    ↓
calendar.js 计算时间位置
    ↓
store.js 保存 ScheduleItem
    ↓
calendar.js 渲染时间块
    ↓
用户点击时间块 → detail-panel.js 显示详情
    ↓
用户编辑 → store.js 更新 → 重新渲染
```

---

## 5. 关键算法

### 5.1 时间块位置计算
```javascript
function getTopByTime(timeStr, startHour = 6, hourHeight = 80) {
  const [hours, minutes] = timeStr.split(':').map(Number);
  const totalMinutes = (hours - startHour) * 60 + minutes;
  return (totalMinutes / 60) * hourHeight;
}
```

### 5.2 时长转换
```javascript
function getHeightByDuration(minutes, hourHeight = 80) {
  return (minutes / 60) * hourHeight;
}
```

### 5.3 拖拽时时间吸附
- 默认按 15 分钟吸附
- 计算鼠标位置对应的最接近的 15 分钟刻度

---

## 6. 设计系统

### 6.1 CSS 变量
- 颜色：`--color-primary-500`, `--color-bg`, `--color-surface`
- 间距：`--space-1` 到 `--space-16`
- 字体：`--font-sans`, `--font-mono`
- 阴影：`--shadow-sm`, `--shadow-md`, `--shadow-lg`
- 圆角：`--radius-sm`, `--radius-md`, `--radius-lg`

### 6.2 组件规范
- 按钮：三种变体（primary / secondary / ghost），三种尺寸
- 输入框：统一边框、焦点状态、错误状态
- 卡片：统一圆角、阴影、悬停效果
- 时间块：按状态区分颜色（未完成/已完成/选中）

---

## 7. 扩展性考虑

- 模块间通过事件和 store 解耦
- AI 服务可替换为不同后端
- 存储层可扩展为 IndexedDB 或后端 API
- 响应式布局支持未来增加移动端优化
