// api/decompose.js — Vercel 无服务器函数（Node.js / CommonJS）
// 作为前端与大模型之间的中转：Key 存于 Vercel 环境变量，不进前端、不进 git。
// 默认对接 DeepSeek（OpenAI 兼容接口），可通过环境变量切换到任意兼容服务商。

const SYSTEM_PROMPT = `你是一位资深的执行型项目拆解专家。用户会给你一段「计划描述」，你必须把它拆解为**只针对这个计划本身**、具体、可落地的执行步骤。

【必须遵守的硬规则】
1. 禁止泛泛的通用流程步骤。每一步都必须是这个计划独有的具体动作，绝不能输出放之四海而皆准的套路。
   - ❌ 严禁作为独立步骤出现：「明确目标」「制定计划」「执行」「检查与调整」「总结复盘」「准备资源」「评估风险」「收集资料」这类脱离具体内容的词（除非在该计划里有明确专属的落地形式，例如"明确本次发布会预算上限 50 万"）。
   - ✅ 正确示范：「撰写产品需求文档 PRD 并组织评审」「搭建官网落地页并接入预约表单」「联系 3 家供应商比价并确定主供应商」。
2. 步骤标题须含具体名词/动词/数字/产物，让人一看就知道做什么、产出是什么，且不超过 18 字。
3. 步骤顺序按该计划真实的执行先后排列，不要套用"计划-执行-检查"的教科书三段论。
4. 每个步骤包含：
   - title: 具体步骤标题（≤18 字）
   - estimatedMinutes: 预计耗时（整数分钟，5–480）
   - standard: 这一步"完成标准/交付物"一句话，要具体、可作为验收依据（禁止"完成该步骤"这类空话）
   - subtasks: 2–3 条可勾选子动作，每条须写清具体做什么（禁止"确认输入产出""自检结果"这类模板句；例如"导出竞品功能对比表""预约拍摄场地并付定金"）
5. 若描述中出现了具体对象（产品名、人数、日期、预算、平台、技术栈等），步骤里要体现进去。
6. 步骤数 4–8 个；计划较小则 4 个即可，不要为凑数增加无效步骤。

只输出 JSON，不要任何解释文字或 markdown 代码块。严格格式：
{"steps":[{"title":"","estimatedMinutes":0,"standard":"","subtasks":[{"title":""}]}]}`;

/** 读取请求体（Vercel Node 函数 req 为流，需手动收集） */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/** 清洗模型输出，保证字段类型安全、长度受限 */
function sanitizeSteps(steps) {
  if (!Array.isArray(steps)) return [];
  return steps
    .map((s) => ({
      title: String(s.title || '未命名步骤').slice(0, 40),
      estimatedMinutes: Math.min(300, Math.max(5, Number(s.estimatedMinutes) || 30)),
      standard: String(s.standard || '').slice(0, 200),
      subtasks: Array.isArray(s.subtasks)
        ? s.subtasks.slice(0, 3).map((t) => ({
            title: String(t && t.title ? t.title : '').slice(0, 100),
            completed: false,
          }))
        : [],
    }))
    .filter((s) => s.title.trim());
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
  try {
    const raw = await readBody(req);
    const parsed = raw ? JSON.parse(raw) : {};
    description = String(parsed.description || '');
    variant = Number.isFinite(Number(parsed.variant)) ? Number(parsed.variant) : 0;
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

    // Vercel Hobby 函数最长 10s，给上游留 8s 超时，避免函数被平台强制杀掉变成无信息 502
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

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
            content: `请分解这个计划：${description}${variantHint}`,
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
    const steps = sanitizeSteps(parsed.steps);
    if (!steps.length) return res.status(502).json({ error: 'EMPTY_STEPS' });
    return res.status(200).json({ steps });
  } catch (e) {
    const isTimeout = e && e.name === 'AbortError';
    const message = isTimeout
      ? '上游模型接口超时（8s 内未响应），请检查 API 可用性或更换服务商。'
      : String(e && e.message ? e.message : e);
    console.error('[decompose] failed:', message, { base, model: model.slice(0, 30) });
    return res.status(502).json({ error: 'DECOMPOSE_FAILED', message });
  }
};
