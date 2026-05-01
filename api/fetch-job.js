// Vercel Function — 채용공고 URL 자동 추출
// URL 받아서 → 페이지 fetch → HTML 정리 → Claude로 회사/포지션/본문 추출

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = req.headers['x-api-key'] || process.env.CLAUDE_API_KEY;
  const { url } = req.body || {};

  if (!apiKey) return res.status(401).json({ error: 'Claude API key required (헤더 또는 Vercel 환경변수 CLAUDE_API_KEY)' });
  if (!url) return res.status(400).json({ error: 'URL required' });
  if (!url.startsWith('http')) return res.status(400).json({ error: 'URL must start with http(s)://' });

  try {
    // 1. 페이지 fetch (브라우저 위장)
    const fetchRes = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
        'Cache-Control': 'no-cache'
      }
    });

    if (!fetchRes.ok) {
      return res.status(400).json({
        error: `페이지 가져오기 실패 (${fetchRes.status}). 사이트 차단 가능성 — 수동 입력 권장`
      });
    }

    const html = await fetchRes.text();

    // 2. HTML → 텍스트 (script·style 제거 + 태그 제거)
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
      .replace(/<svg[\s\S]*?<\/svg>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&[a-z]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 25000); // Claude 토큰 안전

    if (text.length < 200) {
      return res.status(400).json({
        error: 'JS 렌더링 사이트로 보임. 본문 추출 실패. 페이지 직접 열어서 본문 복사·붙여넣기 권장',
        textLength: text.length
      });
    }

    // 3. Claude로 정리
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
          content: `다음 채용공고 페이지 텍스트에서 정보를 JSON으로 추출해줘.

[URL] ${url}

[페이지 텍스트]
${text}

[추출 형식 — JSON만, 마크다운 코드블록 ❌, 설명 ❌]
{
  "company": "회사명 (㈜ 등 정확히)",
  "position": "포지션 (정확히)",
  "jdText": "공고 본문 정리 — 회사 소개·주요 업무·자격 요건·우대사항·채용 절차·연봉 등 핵심만 마크다운으로",
  "deadline": "마감일 YYYY-MM-DD 형식 또는 null"
}`
        }]
      })
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.json();
      return res.status(claudeRes.status).json({
        error: 'Claude API 실패: ' + (err.error?.message || claudeRes.status)
      });
    }

    const claudeData = await claudeRes.json();
    let resultText = claudeData.content[0].text.trim();
    resultText = resultText.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/\s*```\s*$/, '').trim();

    let result;
    try {
      result = JSON.parse(resultText);
    } catch (err) {
      return res.status(500).json({
        error: 'AI 응답 파싱 실패',
        raw: resultText.slice(0, 500)
      });
    }

    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
