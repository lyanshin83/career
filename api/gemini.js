// Vercel Serverless Function — Google Gemini API 프록시
// admin.html에서 호출. Claude API 응답 형식과 통일

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ error: 'Gemini API key required' });

  const {
    prompt,
    maxTokens = 4096,
    model = 'gemini-2.5-flash',  // 기본 무료/저렴 모델
    temperature = 0.7
  } = req.body || {};

  if (!prompt) return res.status(400).json({ error: 'prompt required' });

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: maxTokens,
          temperature: temperature
        }
      })
    });

    const data = await response.json();

    if (!response.ok) {
      // Gemini 에러를 그대로 전달 (한도 초과·rate limit 감지용)
      return res.status(response.status).json({
        error: data.error?.message || 'Gemini API error',
        code: data.error?.code,
        status: data.error?.status,
        raw: data
      });
    }

    // Claude API 형식과 통일 (admin.html 단일 파서)
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    res.status(200).json({
      content: [{ type: 'text', text }],
      model: model,
      provider: 'gemini',
      usage: data.usageMetadata
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
