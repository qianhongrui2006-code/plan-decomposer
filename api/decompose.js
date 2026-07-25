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

B. 正常生成计划（默认，精简结构）：
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
      "duration_minutes": 180
    }
  ]
}}

【生成规则】
1. 任务标题必须动词开头（阅读 / 编写 / 搭建 / 调试 / 拍摄 / 整理），禁止「理解」「掌握」「学习」「明确目标」「制定计划」这类状态词或空泛流程词。
2. 【硬性约束：总天数必须从用户描述中精确提取】
   • 用户说"今天""明天""今天内""一天内""单日" → 总天数 = 1，plan 中只有 day=1 的任务，禁止生成 day=2 或更多；
   • 用户说"一周""7天" → 总天数 = 7；说"两周""14天" → 总天数 = 14；
   • 用户说"三天" → 总天数 = 3；说"一个月" → 总天数 = 30；
   • 若用户未明确时间范围，默认按 1 天（单日计划）处理。
   总任务数必须等于总天数（1 天就 1 个任务，或同一天 2-3 个子任务但 day 都 =1）。不允许任何空白天，也不允许超出生成。如果单个任务撑不满一天，同一天安排 2-3 个不同主题的任务（它们的 day 相同）。
3. 【硬性约束：每天时长必须填满】每天的任务总时长必须达到日投入能力的 90%-110%。举例：用户日投入 3 小时（180 分钟），则每一天的所有任务 duration_minutes 之和必须 ≈ 180 分钟（允许 160-200 分钟浮动）。禁止出现"日投3小时却只排1小时"的情况。
4. 【硬性约束：天数连续无跳号】day 从 1 开始连续递增到总天数。同一天多个任务时 day 相同，跨天时 day 必须正好 +1，不能从第4天直接跳到第6天。
5. 【单日计划特殊规则】当总天数 = 1 时：
   • milestones 最多 1 个（或省略），绝对禁止出现"第1-3天"等多日阶段；
   • 所有任务的 day 必须 = 1；
   • 任务标题要体现"今天"的紧迫感（如"上午背完...""下午复习..."），不要出现"明天""后天"等跨天表述。
9. 【追问必须动态、场景化，禁止模板三件套】
   不要不问场景就固定问「基础水平 / 每天时间 / 方向侧重」。你必须先分析用户描述，判断哪些是 AI 拆分计划时必须知道、但用户没说的信息，只追问真正缺失的关键信息。
   
   追问原则：
   • 单日任务（用户提到"今天""明天"或明显是 1 天内的事）→ 不要问"每天能投入多少时间"，应该问"今天大约有多少时间""你习惯用单词书还是 APP"等当日相关信息；
   • 多日计划（用户提到"一周""两周""一个月"）→ 才需要确认"每天/每周能投入多少时间"；
   • 大项目（跨部门、多人、预算复杂）→ 问团队规模、关键节点、预算范围；
   • 学习计划 → 问当前基础水平（零基础/入门/进阶）、已有资源（教材/课程/设备）、偏好的学习方式（视频/阅读/动手）；
   • 健身/饮食计划 → 问身体状况、有无器材、饮食禁忌；
   • 如果用户描述已经包含某项信息 → 绝对不要再问同一类问题；
   • 如果信息基本完整 → 直接生成计划，不要硬凑追问。
   
   追问数量：最多 2 个，最少 0 个（信息足够时直接生成）。每个问题简短具体，括号内附 2-4 个候选答案方便勾选，例如：「你今天大约有多少时间背单词？（30 分钟 / 1 小时 / 2 小时）」。
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

/** 带指数退避重试的 fetch，遇到限流码自动等 2-4s 再试（最多 2 次） */
async function fetchWithRetry(url, options, maxRetries = 2) {
  let lastErr = null;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      const res = await fetch(url, options);
      if (res.ok) return res;
      const text = await res.text();
      // 限流 / 服务器忙 → 重试
      const isRateLimited =
        res.status === 429 ||
        res.status === 503 ||
        (text && (text.includes('50609') || text.includes('rate limiting') || text.includes('too busy')));
      if (isRateLimited && i < maxRetries) {
        const delay = 2000 + Math.random() * 2000; // 2-4s 随机退避
        console.log(`[decompose] rate limited (attempt ${i + 1}), retry in ${Math.round(delay)}ms`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      // 非限流错误直接抛
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      err.body = text;
      throw err;
    } catch (e) {
      lastErr = e;
      if (i < maxRetries && (e.name === 'AbortError' || e.code === 'ECONNRESET')) {
        const delay = 2000 + Math.random() * 2000;
        console.log(`[decompose] network error (attempt ${i + 1}), retry in ${Math.round(delay)}ms`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error('fetchWithRetry exhausted');
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
    const upstream = await fetchWithRetry(`${base}/chat/completions`, {
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
