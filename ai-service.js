// ai-service.js — AI 任务分解服务
// Step 8：decomposeTask 改为异步，优先调用 /api/decompose（Vercel 无服务器函数，真实大模型）；
//         若未配置 AI_API_KEY 或调用失败，则优雅回退到本地模板 Mock，保证 UI 永远可用。
// 接口：decomposeTask(description, variant = 0) -> Promise<{ steps: StepSeed[], usedMock: boolean }>
// StepSeed = { title, estimatedMinutes, standard, subtasks:[{title,completed}] }

/**
 * 模板库。
 * 每个模板含 keywords（命中其一即采用）与 variants（多套分解方案，用于「重新生成全部」切换）。
 * 每套 variant 是一组步骤种子：{ title, estimatedMinutes, standard }
 */
const TEMPLATES = [
  {
    keywords: ['发布会', '产品发布', 'launch', '上线发布'],
    variants: [
      [
        { title: '明确目标与受众', estimatedMinutes: 30, standard: '产出一份目标与受众清单' },
        { title: '制定主题与议程', estimatedMinutes: 45, standard: '确定发布会主题与流程时间表' },
        { title: '确定场地与时间', estimatedMinutes: 30, standard: '场地预订确认、时间敲定' },
        { title: '邀请嘉宾与媒体', estimatedMinutes: 60, standard: '嘉宾名单与媒体邀请发出' },
        { title: '准备物料与演示', estimatedMinutes: 90, standard: 'PPT、Demo、礼品就绪' },
        { title: '全流程彩排', estimatedMinutes: 60, standard: '走场一遍并修正问题' },
        { title: '会后复盘', estimatedMinutes: 30, standard: '整理反馈与数据' },
      ],
      [
        { title: '拆解发布目标', estimatedMinutes: 30, standard: '量化本次发布 KPI' },
        { title: '设计核心信息', estimatedMinutes: 45, standard: '一句话价值主张定稿' },
        { title: '搭建落地页', estimatedMinutes: 90, standard: '报名/预约页上线' },
        { title: '预热传播', estimatedMinutes: 60, standard: '社媒预告排期发布' },
        { title: '现场执行清单', estimatedMinutes: 45, standard: '人员分工与应急预案' },
        { title: '数据回收', estimatedMinutes: 30, standard: '埋点与转化统计就绪' },
      ],
    ],
  },
  {
    keywords: ['论文', '毕业论文', '写论文', 'thesis', '文献'],
    variants: [
      [
        { title: '选题与文献综述', estimatedMinutes: 120, standard: '确定题目，精读 20+ 文献' },
        { title: '确定大纲与研究方法', estimatedMinutes: 90, standard: '章节框架与实验设计定稿' },
        { title: '数据采集 / 实验', estimatedMinutes: 180, standard: '完成主体的数据与实验' },
        { title: '撰写初稿', estimatedMinutes: 240, standard: '各章首稿完成' },
        { title: '修改润色', estimatedMinutes: 120, standard: '逻辑与语言优化' },
        { title: '排版与查重', estimatedMinutes: 60, standard: '格式规范、查重达标' },
        { title: '定稿提交', estimatedMinutes: 30, standard: '终稿导出并提交' },
      ],
    ],
  },
  {
    keywords: ['学习', '入门', '学', '掌握', '基础'],
    variants: [
      [
        { title: '明确目标与资源', estimatedMinutes: 30, standard: '锁定学习内容与资料来源' },
        { title: '制定学习路线', estimatedMinutes: 45, standard: '产出阶段化学习地图' },
        { title: '基础概念学习', estimatedMinutes: 90, standard: '核心概念理解无误' },
        { title: '动手实践', estimatedMinutes: 120, standard: '完成最小可运行示例' },
        { title: '做项目巩固', estimatedMinutes: 180, standard: '独立做出一个小项目' },
        { title: '复盘总结', estimatedMinutes: 60, standard: '沉淀笔记与心得' },
      ],
    ],
  },
  {
    keywords: ['健身', '减肥', '运动', '增肌', '塑形'],
    variants: [
      [
        { title: '评估身体状况', estimatedMinutes: 30, standard: '体测与风险排查' },
        { title: '设定目标', estimatedMinutes: 20, standard: '明确可衡量的目标' },
        { title: '制定训练计划', estimatedMinutes: 45, standard: '周计划排定' },
        { title: '饮食规划', estimatedMinutes: 30, standard: '热量与营养配比' },
        { title: '执行训练', estimatedMinutes: 60, standard: '完成当日训练' },
        { title: '记录与调整', estimatedMinutes: 15, standard: '打卡并微调计划' },
      ],
    ],
  },
  {
    keywords: ['旅行', '旅游', '出游', '自驾', '出行'],
    variants: [
      [
        { title: '确定目的地与预算', estimatedMinutes: 45, standard: '目的地清单与预算上限' },
        { title: '查攻略订机票', estimatedMinutes: 60, standard: '机票/车票下单' },
        { title: '订住宿', estimatedMinutes: 30, standard: '住宿确认' },
        { title: '规划每日行程', estimatedMinutes: 60, standard: '逐日路线敲定' },
        { title: '准备行李', estimatedMinutes: 30, standard: '行李清单核对' },
        { title: '购买保险', estimatedMinutes: 15, standard: '旅行险生效' },
      ],
    ],
  },
  {
    keywords: ['面试', '求职', '笔试', '复试'],
    variants: [
      [
        { title: '研究公司与岗位', estimatedMinutes: 60, standard: '公司与 JD 要点整理' },
        { title: '梳理简历与经历', estimatedMinutes: 90, standard: 'STAR 案例准备' },
        { title: '准备自我介绍', estimatedMinutes: 45, standard: '1/3 分钟版本定稿' },
        { title: '模拟常见题', estimatedMinutes: 120, standard: '完成一轮模拟问答' },
        { title: '准备反向提问', estimatedMinutes: 60, standard: '列出想问的问题' },
        { title: '仪表与物料', estimatedMinutes: 30, standard: '着装与资料就绪' },
      ],
    ],
  },
  {
    keywords: ['考试', '备考', '考研', '公考', '复习', '考证'],
    variants: [
      [
        { title: '明确大纲与教材', estimatedMinutes: 60, standard: '资料与范围锁定' },
        { title: '制定复习计划', estimatedMinutes: 45, standard: '阶段时间表' },
        { title: '基础轮学习', estimatedMinutes: 180, standard: '通读教材一遍' },
        { title: '刷题强化', estimatedMinutes: 180, standard: '专项题量达标' },
        { title: '模拟考试', estimatedMinutes: 120, standard: '全真模考一次' },
        { title: '查漏补缺', estimatedMinutes: 90, standard: '薄弱点专项突破' },
        { title: '调整状态', estimatedMinutes: 30, standard: '作息与心态调整' },
      ],
    ],
  },
  {
    keywords: ['写作', '公众号', '博客', '文章', '推文', '文案'],
    variants: [
      [
        { title: '选题与受众', estimatedMinutes: 30, standard: '确定主题与读者' },
        { title: '列提纲', estimatedMinutes: 30, standard: '结构与论点定稿' },
        { title: '收集素材', estimatedMinutes: 60, standard: '案例与数据齐备' },
        { title: '撰写初稿', estimatedMinutes: 120, standard: '全文首稿完成' },
        { title: '配图排版', estimatedMinutes: 45, standard: '视觉与版式优化' },
        { title: '校对发布', estimatedMinutes: 30, standard: '校对无误并发布' },
      ],
    ],
  },
  {
    keywords: ['创业', '项目启动', '启动', '立项', 'mvp'],
    variants: [
      [
        { title: '验证需求', estimatedMinutes: 90, standard: '用户访谈与痛点确认' },
        { title: '画商业模式', estimatedMinutes: 60, standard: '商业模式画布完成' },
        { title: '组建团队', estimatedMinutes: 60, standard: '核心角色到位' },
        { title: 'MVP 开发', estimatedMinutes: 240, standard: '最小可用产品跑通' },
        { title: '找早期用户', estimatedMinutes: 120, standard: '获取首批种子用户' },
        { title: '复盘迭代', estimatedMinutes: 60, standard: '数据驱动下一轮' },
      ],
    ],
  },
  {
    keywords: ['读书', '阅读', '看书'],
    variants: [
      [
        { title: '选书与设定目标', estimatedMinutes: 15, standard: '确定阅读书目' },
        { title: '制定阅读计划', estimatedMinutes: 20, standard: '每日页数拆解' },
        { title: '通读', estimatedMinutes: 120, standard: '完成全书通读' },
        { title: '做笔记', estimatedMinutes: 60, standard: '金句与框架摘录' },
        { title: '输出感悟', estimatedMinutes: 45, standard: '写一篇读后感' },
      ],
    ],
  },
  {
    keywords: ['备婚', '婚礼', '结婚'],
    variants: [
      [
        { title: '定预算与风格', estimatedMinutes: 60, standard: '总预算与风格定调' },
        { title: '选日期与场地', estimatedMinutes: 45, standard: '档期与场地锁定' },
        { title: '邀宾客', estimatedMinutes: 60, standard: '名单与请柬发出' },
        { title: '找四大金刚', estimatedMinutes: 90, standard: '摄影摄像化妆主持签约' },
        { title: '采购物资', estimatedMinutes: 60, standard: '婚品与布置到位' },
        { title: '彩排', estimatedMinutes: 30, standard: '流程走场' },
      ],
    ],
  },
];

/**
 * 兜底通用模板（未命中任何关键词时使用）。
 * 注意：这里只是「未接入 AI 时的示例」，会带上用户输入的主题词，避免完全千篇一律；
 * 真正想要针对具体计划的分解，请在 Vercel 配置 AI_API_KEY 启用真实模型。
 * @param {string} description 用户描述的计划
 */
function buildFallback(description) {
  // 取描述前 14 个字作为主题词，避免截断在词中间造成乱码（按字符截断，非字节）
  const topic = (description || '').trim().slice(0, 14) || '这个计划';
  return [
    { title: `明确「${topic}」的目标与验收标准`, estimatedMinutes: 30, standard: '写下可衡量、可验收的目标' },
    { title: `拆解「${topic}」的关键子任务`, estimatedMinutes: 45, standard: '列出 3-5 个关键子任务' },
    { title: `为「${topic}」排出时间表`, estimatedMinutes: 30, standard: '排定起止时间与里程碑' },
    { title: `推进「${topic}」的第一步`, estimatedMinutes: 60, standard: '完成一个最小启动动作' },
    { title: `对照目标检查「${topic}」`, estimatedMinutes: 30, standard: '对照目标校正方向' },
  ];
}

/**
 * 为单步生成 AI 子任务提示（Mock）。
 * 真实模型接入后由 decomposeTask 直接产出 subtasks，此处仅作演示填充。
 * @param {{title:string}} step
 * @returns {Array<{title:string, completed:boolean}>}
 */
function seedSubtasks(step) {
  const t = step.title || '这一步';
  return [
    { title: `确认「${t}」的输入与产出标准`, completed: false },
    { title: `执行「${t}」并自检结果`, completed: false },
    { title: `记录「${t}」的问题与改进点`, completed: false },
  ];
}

/**
 * 本地模板 Mock 分解（同步，作为真实 AI 的兜底）。
 * @param {string} description 用户描述的计划
 * @param {number} variant 方案变体序号（用于「重新生成全部」循环切换）
 * @returns {{ steps: Array<{title:string, estimatedMinutes:number, standard:string, subtasks:Array}> }}
 */
export function mockDecompose(description, variant = 0) {
  const text = (description || '').toLowerCase();
  const hit = TEMPLATES.find((tpl) =>
    tpl.keywords.some((k) => text.includes(k.toLowerCase()))
  );

  let variants;
  if (hit) {
    variants = hit.variants;
  } else {
    // 未命中关键词：用带主题词的兜底模板（包成 variants 保证 variant 取模安全）
    variants = [buildFallback(description)];
  }

  const steps = variants[variant % variants.length];
  // 返回副本，避免调用方意外修改模板；并为每步附带子任务提示
  return {
    steps: steps.map((s) => ({
      ...s,
      subtasks: seedSubtasks(s),
    })),
  };
}

/**
 * 分解任务（异步）：优先调用真实 AI（/api/decompose），失败/未配置则回退本地 Mock。
 * @param {string} description 用户描述的计划
 * @param {number} variant 方案变体序号
 * @returns {Promise<{ steps: Array, usedMock: boolean }>}
 */
export async function decomposeTask(description, variant = 0) {
  try {
    const res = await fetch('/api/decompose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description, variant }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data || !Array.isArray(data.steps) || !data.steps.length) {
      throw new Error('empty steps');
    }
    return { steps: data.steps, usedMock: false };
  } catch {
    // 未配置 AI_API_KEY 或网络/解析失败 → 回退本地模板，保证始终可用
    return { ...mockDecompose(description, variant), usedMock: true };
  }
}
