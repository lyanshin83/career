// Vercel Function — 유사 공고 추천
// admin에 저장된 공고들 패턴 분석 → 비슷한 공고 검색 키워드 + 인접 카테고리 추천

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = req.headers['x-api-key'];
  const { jobs } = req.body || {};

  if (!apiKey) return res.status(401).json({ error: 'Claude API key required' });
  if (!jobs || !Array.isArray(jobs) || jobs.length === 0) {
    return res.status(400).json({ error: 'jobs array required (at least 1)' });
  }

  // 공고 요약 (토큰 절약)
  const summary = jobs.slice(0, 20).map((j, i) => `
[${i + 1}] ${j.company} · ${j.position}
출처: ${j.source || '-'} | 매칭: ${j.matchScore || '-'} | 상태: ${j.status || '-'}
키워드: ${(j.jdText || '').slice(0, 300)}
`).join('\n');

  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        messages: [{
          role: 'user',
          content: `다음은 마케팅 시니어 본부장(16년) 지원자가 지원·검토한 공고 ${jobs.length}개입니다. 패턴을 분석해서 비슷한 공고 추천 정보를 JSON으로만 답변해주세요.

[지원·검토 공고]
${summary}

[지원자 프로필]
- 광고대행 7년 + 자체 브랜드 D2C 5년+ (16년)
- NHN커머스 7년, VT코스메틱 1억→20억, 닥터미라클 7.7억, 시즈노프 IMC, 푸드케어 -50%
- 메타 Advantage+·구글 PMax·ChatGPT·GA4 AI 직접 운영

[응답 — JSON만, 마크다운 ❌]
{
  "patterns": {
    "직군": ["..."],
    "회사단계": ["..."],
    "산업": ["..."],
    "공통키워드": ["..."],
    "선호위치": ["..."],
    "연봉밴드": "..."
  },
  "similarSearchKeywords": [
    "검색 키워드 1",
    "검색 키워드 2",
    "..."
  ],
  "adjacentCategories": [
    {"name": "인접 직군 1", "reason": "왜 적합한지", "searchTerms": ["..."]},
    {"name": "인접 직군 2", "reason": "...", "searchTerms": ["..."]}
  ],
  "recommendedSites": [
    {"site": "사람인", "url": "https://www.saramin.co.kr/...", "filter": "추천 검색 조건"},
    {"site": "잡코리아", "url": "...", "filter": "..."},
    {"site": "리멤버", "url": "...", "filter": "..."},
    {"site": "원티드", "url": "...", "filter": "..."},
    {"site": "잡플래닛", "url": "...", "filter": "..."},
    {"site": "워크넷", "url": "...", "filter": "..."},
    {"site": "링크드인", "url": "...", "filter": "..."},
    {"site": "인크루트", "url": "...", "filter": "..."}
  ],
  "warnings": ["주의할 패턴 (중복 지원·과한 직군 변경 등)"],
  "summary": "한 줄 요약"
}`
        }]
      })
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.json();
      return res.status(claudeRes.status).json({ error: 'Claude API: ' + (err.error?.message || claudeRes.status) });
    }

    const data = await claudeRes.json();
    let text = data.content[0].text.trim();
    text = text.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/\s*```\s*$/, '').trim();

    let result;
    try {
      result = JSON.parse(text);
    } catch (err) {
      return res.status(500).json({ error: 'AI 응답 파싱 실패', raw: text.slice(0, 500) });
    }

    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
