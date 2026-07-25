// api/decompose.js — Vercel 无服务器函数（Node.js / CommonJS）
// 作为前端与大模型之间的中转：Key 存于 Vercel 环境变量，不进前端、不进 git。
// 默认对接 DeepSeek（OpenAI 兼容接口），可通过环境变量切换到任意兼容服务商。
//
// 输出两种结构（二选一）：
//   A. 信息严重不足 → { questions: [...] }      （AI 追问，先澄清再生成）
//   B. 正常生成     → { steps: [...], plan }    （里程碑 + 富任务结构）

const SYSTEM_PROMPT = `你是一位执行型计划拆解设计师。用户输入目标后，你要把模糊愿望拆成「用户今天打开就能执行」的具体动作。

【输出格式（严格 JSON，两种结构二选一）】
A. 缺少关键信息时（见规则 9 的信息清单，任一缺失即属此类）：
{"clarifying_questions": ["问题1（候选答案A / 候选答案B / 候选答案C）", "问题2（候选答案…）", "问题3（候选答案…）"]}

B. 正常生成计划（默认）：
{"plan": {
  "title": "计划标题（≤20字）",
  "daily_capacity": "建议每天投入时间，如 2 小时",
  "milestones": [
    {"title": "阶段名", "day_range": "第1-3天", "deliverable": "该阶段结束时的可交付成果"}
  ],
  "tasks": [
    {
      "title": "任务标题（动词开头，≤18字）",
      "milestone": "所属阶段名（必须与 milestones 中某项 title 完全一致）",
      "day": 1,
      "duration_minutes": 45,
      "resource": {"name": "具体资源名称", "url": "链接或精确搜索关键词", "type": "article|video|practice"},
      "steps": ["具体动作1", "具体动作2"],
      "output": "产出物描述",
      "checklist": ["可验证的检查项1", "检查项2"]
    }
  ]
}}

【生成规则】
1. 任务标题必须动词开头（阅读 / 编写 / 搭建 / 调试 / 拍摄 / 整理），禁止「理解」「掌握」「学习」「明确目标」「制定计划」这类状态词或空泛流程词。
2. 每个任务必须绑定一个具体资源（官方文档、具体教程名、具体工具 / 平台），禁止「网上找资料」「看教程」这类空泛资源；url 给真实链接或精确到可直接搜索的关键词。
3. steps 是该任务独有的执行动作（1-2 条即可），每条都是可直接执行的具体动作；严禁模板句。
4. checklist 是完成后的自查验收标准（1-2 条），必须可验证。
5. output 是该任务做完要留下的具体东西（一句话）。
6. 任务量铺满周期但不要贪多：总任务数 5-7 个（周期短就取少）。里程碑 2 个即可，每个里程碑 2-4 个任务。优先保证任务可执行，不要为凑数写冗长内容。
7. 天数连续覆盖：里程碑 day_range 横跨 N 天时，其下任务的 day 要逐天铺开，相邻任务的 day 间隔不得超过 1 天。
8. 每日负荷接近日投入能力：每天的任务总时长 ≈ 日投入能力的 70%-130%（用户未给出日投入时按每天 2 小时估算）。
9. 【追问前置，宁问勿猜】生成计划前，先核对以下关键信息清单：
   ① 当前基础 / 经验水平（零基础 / 有了解 / 有经验）——影响任务起点与难度；
   ② 每日可投入时间——影响每天的任务量与总进度安排；
   ③ 方向侧重（仅当目标本身有歧义时，如「前端设计」可偏视觉 UI 也可偏代码实现，「学英语」可偏口语也可偏应试）。
   以上任一信息在用户描述中没有明确给出时，必须优先返回 clarifying_questions（2-3 个），禁止自行假设后直接生成计划。三个信息都明确时才可直接生成 plan。
   每个问题要简短具体，并在括号内附 2-4 个候选答案，方便用户快速勾选式回答，例如：「你每天大约能投入多少时间？（30 分钟 / 1 小时 / 2 小时 / 3 小时以上）」。
   若用户已提供补充回答（answers）或被明确要求直接生成（skipClarify），则必须输出 plan 结构，不再提问。
10. 若描述中出现具体对象（产品名、人数、日期、预算、平台、技术栈），任务里要体现进去。

只输出 JSON，不要任何解释文字或 markdown 代码块。`;

/** 读取请求体（Vercel Node 函数 req 为流，需手动收集） */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const RESOURCE_TYPES = new Set(['article', 'video', 'practice', 'other']);

/** 清洗单个任务，保证字段类型安全、长度受限 */
function sanitizeTask(t) {
  const res = t && typeof t.resource === 'object' && t.resource ? t.resource : {};
  const resType = RESOURCE_TYPES.has(res.type) ? res.type : 'article';
  return {
    title: String(t.title || '未命名任务').slice(0, 40),
    milestone: String(t.milestone || '').slice(0, 30) || null,
    day: Number.isFinite(Number(t.day)) ? Math.max(1, Math.round(Number(t.day))) : null,
    estimatedMinutes: Math.min(480, Math.max(5, Number(t.duration_minutes) || Number(t.estimatedMinutes) || 30)),
    resource:
      res.name || res.url
        ? {
            name: String(res.name || '').slice(0, 60),
            url: String(res.url || '').slice(0, 200),
            type: resType,
          }
        : null,
    subtasks: Array.isArray(t.steps)
      ? t.steps.slice(0, 5).map((x) => ({ title: String(x || '').slice(0, 100), completed: false })).filter((x) => x.title.trim())
      : [],
    output: String(t.output || '').slice(0, 120),
    checklist: Array.isArray(t.checklist)
      ? t.checklist.slice(0, 3).map((x) => ({ title: String(x || '').slice(0, 100), completed: false })).filter((x) => x.title.trim())
      : [],
  };
}

/** 清洗计划级元信息 */
function sanitizePlanMeta(plan) {
  return {
    title: String(plan.title || '').slice(0, 40),
    dailyCapacity: String(plan.daily_capacity || '').slice(0, 40),
    milestones: Array.isArray(plan.milestones)
      ? plan.milestones.slice(0, 4).map((m) => ({
          title: String(m.title || '').slice(0, 30),
          dayRange: String(m.day_range || '').slice(0, 20),
          deliverable: String(m.deliverable || '').slice(0, 80),
        })).filter((m) => m.title.trim())
      : [],
  };
}

/** 清洗追问列表 */
function sanitizeQuestions(qs) {
  if (!Array.isArray(qs)) return [];
  return qs.slice(0, 3).map((q) => String(q || '').slice(0, 120)).filter((q) => q.trim());
}

module.exports = async (req, res) => {
  // 允许跨域（同源一般不必，但便于本地调试）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });

  const apiKey = process.env.AI_API_KEY;
  if (!apiKey) {
    return res
      .status(500)
      .json({ error: 'AI_NOT_CONFIGURED', message: '未配置 AI_API_KEY 环境变量' });
  }

  const base = (process.env.AI_API_BASE || 'https://api.deepseek.com/v1').replace(/\/$/, '');
  const model = process.env.AI_MODEL || 'deepseek-chat';

  let description = '';
  let variant = 0;
  let answers = [];
  let skipClarify = false;
  try {
    const raw = await readBody(req);
    const parsed = raw ? JSON.parse(raw) : {};
    description = String(parsed.description || '');
    variant = Number.isFinite(Number(parsed.variant)) ? Number(parsed.variant) : 0;
    answers = Array.isArray(parsed.answers)
      ? parsed.answers
          .slice(0, 5)
          .map((x) => ({ q: String((x && x.q) || '').slice(0, 120), a: String((x && x.a) || '').slice(0, 300) }))
          .filter((x) => x.q && x.a)
      : [];
    skipClarify = !!parsed.skipClarify;
  } catch {
    return res.status(400).json({ error: 'BAD_REQUEST' });
  }
  if (!description.trim()) {
    return res.status(400).json({ error: 'EMPTY_DESCRIPTION' });
  }

  try {
    const variantHint =
      variant > 0
        ? `\n\n（这是第 ${variant + 1} 次生成，请换一个不同的拆解角度或侧重点，避免与常见套路重复。）`
        : '';
    // 用户已回答追问：把问答作为补充上下文，并要求直接产出计划
    const answersHint = answers.length
      ? `\n\n用户已补充回答以下问题：\n${answers.map((x, i) => `${i + 1}. ${x.q}：${x.a}`).join('\n')}\n请基于以上信息直接生成计划（输出 plan 结构，不要再提问）。`
      : '';
    const skipHint = !answers.length && skipClarify
      ? '\n\n请直接生成计划（输出 plan 结构，不要提问）。'
      : '';

    // Vercel Hobby 函数已通过 vercel.json 配置 maxDuration=60s；这里给上游留 58s 超时
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 58000);

    console.log(`[decompose] model=${model} base=${base} descLen=${description.length}`);
    const upstream = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: `请分解这个计划：${description}${answersHint}${skipHint}${variantHint}`,
          },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.6,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!upstream.ok) {
      const detail = await upstream.text();
      return res
        .status(502)
        .json({ error: 'UPSTREAM_ERROR', status: upstream.status, detail: detail.slice(0, 300) });
    }

    const data = await upstream.json();
    const content = (data.choices && data.choices[0] && data.choices[0].message.content) || '{}';
    // 兜底去除可能的 ```json 代码块包裹
    const cleaned = content
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```$/i, '')
      .trim();
    const parsed = JSON.parse(cleaned);

    // A. AI 追问：用户尚未补充回答且未要求跳过时，把问题透传给前端
    const questions = sanitizeQuestions(parsed.clarifying_questions);
    if (questions.length && !answers.length && !skipClarify) {
      return res.status(200).json({ questions });
    }

    // B. 正常生成计划
    const plan = parsed.plan && typeof parsed.plan === 'object' ? parsed.plan : {};
    const rawTasks = Array.isArray(plan.tasks) ? plan.tasks : Array.isArray(parsed.steps) ? parsed.steps : [];
    const steps = rawTasks.map(sanitizeTask).filter((s) => s.title.trim()).slice(0, 12);
    if (!steps.length) return res.status(502).json({ error: 'EMPTY_STEPS' });
    return res.status(200).json({ steps, plan: sanitizePlanMeta(plan) });
  } catch (e) {
    const isTimeout = e && e.name === 'AbortError';
    const message = isTimeout
      ? '上游模型接口超时（55s 内未响应），请检查 API 可用性或更换更快的模型（如 Pro/deepseek-ai/DeepSeek-V3）。'
      : String(e && e.message ? e.message : e);
    console.error('[decompose] failed:', message, { base, model: model.slice(0, 30) });
    return res.status(502).json({ error: 'DECOMPOSE_FAILED', message });
  }
};
