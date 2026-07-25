// api/enrich-task.js — Vercel 无服务器函数（Node.js / CommonJS）
// 懒加载补充单任务的资源、执行步骤、验收清单、产出物。
// 输入仅 taskTitle（18 字标题），输出极短 JSON，15s 内必然完成。

const SYSTEM_PROMPT = `你是一位任务详情补充员。你会收到一条已完成拆解的任务标题，请为该任务补充可执行的具体信息。

【输出格式（严格 JSON）】
{
  "resource": {"name": "最推荐的一个学习资源名称（教材/教程/工具/平台）", "url": "链接或精确搜索关键词", "type": "article|video|practice"},
  "steps": ["可直接执行的步骤1", "可直接执行的步骤2"],
  "checklist": ["可验证的验收标准1", "可验证的验收标准2"],
  "output": "做完该任务后留下的具体产出物（一句话）"
}

【规则】
1. resource 必须具体（官方文档名、具体教程标题、具体工具名），禁止"网上找资料"。
2. steps 是 2 条可直接执行的动作，与该任务标题紧密相关，禁止模板句。
3. checklist 是 2 条可验证的验收标准（如"能不看资料写出布局代码"）。
4. output 是一句话，描述做完后留下的具体东西。

只输出 JSON，不要任何解释。`;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const RESOURCE_TYPES = new Set(['article', 'video', 'practice', 'other']);

function sanitize(data) {
  const res = data && typeof data.resource === 'object' && data.resource ? data.resource : {};
  const resType = RESOURCE_TYPES.has(res.type) ? res.type : 'article';
  return {
    resource:
      res.name || res.url
        ? {
            name: String(res.name || '').slice(0, 60),
            url: String(res.url || '').slice(0, 200),
            type: resType,
          }
        : null,
    steps: (Array.isArray(data.steps) ? data.steps : []).slice(0, 3).map((s) => String(s || '').slice(0, 120)).filter((s) => s.trim()),
    checklist: (Array.isArray(data.checklist) ? data.checklist : []).slice(0, 3).map((c) => String(c || '').slice(0, 100)).filter((c) => c.trim()),
    output: String(data.output || '').slice(0, 120),
  };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
  }

  const apiKey = process.env.AI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'AI_NOT_CONFIGURED' });
  }

  const base = (process.env.AI_API_BASE || 'https://api.deepseek.com/v1').replace(/\/$/, '');
  const model = process.env.AI_MODEL || 'deepseek-chat';

  let taskTitle = '';
  let context = '';
  try {
    const raw = await readBody(req);
    const parsed = raw ? JSON.parse(raw) : {};
    taskTitle = String(parsed.taskTitle || '').slice(0, 60);
    context = String(parsed.context || '').slice(0, 200);
  } catch {
    return res.status(400).json({ error: 'BAD_REQUEST' });
  }
  if (!taskTitle.trim()) {
    return res.status(400).json({ error: 'EMPTY_TASK' });
  }

  try {
    const userMsg = context
      ? `为以下任务补充详情：${taskTitle}\n背景：${context}`
      : `为以下任务补充详情：${taskTitle}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 14000);

    const upstream = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMsg },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.5,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!upstream.ok) {
      const detail = await upstream.text();
      return res.status(502).json({ error: 'UPSTREAM_ERROR', status: upstream.status, detail: detail.slice(0, 200) });
    }

    const data = await upstream.json();
    const rawContent = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';

    let parsed;
    try {
      // 兼容模型在外层套 ```json ... ``` 的情况
      let cleaned = rawContent.trim();
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      }
      parsed = JSON.parse(cleaned);
    } catch {
      return res.status(500).json({ error: 'PARSE_ERROR', raw: rawContent.slice(0, 400) });
    }

    return res.status(200).json(sanitize(parsed));
  } catch (e) {
    if (e.name === 'AbortError') {
      return res.status(504).json({ error: 'TIMEOUT' });
    }
    return res.status(500).json({ error: 'DECOMPOSE_FAILED', message: String(e).slice(0, 200) });
  }
};
