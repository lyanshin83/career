// Vercel Function — 매일 9시 자동 채용공고 검색 (GitHub Actions Cron이 호출)
// 8개 사이트 검색 + Claude 정리 + GitHub commit (jobs/auto-found.json)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, x-cron-secret');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // Cron 시크릿 체크 (선택 — 무단 호출 방지)
  const cronSecret = req.headers['x-cron-secret'];
  const expectedSecret = process.env.CRON_SECRET;
  if (expectedSecret && cronSecret !== expectedSecret) {
    return res.status(401).json({ error: 'Invalid cron secret' });
  }

  const apiKey = req.headers['x-api-key'] || process.env.CLAUDE_API_KEY;
  const githubToken = req.headers['x-github-token'] || process.env.GITHUB_TOKEN;
  const githubOwner = req.headers['x-github-owner'] || process.env.GITHUB_OWNER;
  const githubRepo = req.headers['x-github-repo'] || process.env.GITHUB_REPO;

  if (!apiKey) return res.status(401).json({ error: 'Claude API key required' });

  // 검색 키워드 (사용자 패턴 기반 — 추후 동적으로 변경 가능)
  const searchKeywords = req.body?.keywords || [
    '마케팅 본부장',
    '디지털 마케팅 팀장 IMC',
    '퍼포먼스 마케팅 팀장',
    '브랜드 마케팅 본부장 D2C',
    '광고대행사 본부장',
    '그로스 마케팅 헤드',
    '건기식 마케팅 팀장',
    'CMO 시니어'
  ];

  const results = [];
  const errors = [];

  try {
    // Claude로 검색 키워드별 추천 공고 생성
    // (실제 사이트 스크래핑은 anti-bot 위험 → Claude의 일반 지식 + WebSearch는 별도)
    // 사용자가 검색 키워드 + 권장 사이트 URL로 직접 확인
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
          content: `오늘 날짜 ${new Date().toISOString().split('T')[0]} 기준, 마케팅 시니어 본부장(16년) 지원자에게 추천할 만한 한국 채용 사이트 검색 결과를 JSON으로 정리해주세요.

[검색 키워드]
${searchKeywords.map((k, i) => `${i + 1}. "${k}"`).join('\n')}

[지원자 프로필]
- 마케팅 시니어 16년, 본부장/팀장급
- 광고대행 + D2C 양립
- 메타 Advantage+·구글 PMax·생성형 AI 직접 운영

[응답 형식 — JSON만]
{
  "searchedAt": "${new Date().toISOString()}",
  "keywords": [...검색 키워드들...],
  "sites": [
    {
      "name": "사람인",
      "searchUrl": "https://www.saramin.co.kr/zf_user/jobs/list/job-category?cat_mcls=14",
      "recommendedFilter": "마케팅·시니어 필터"
    },
    {
      "name": "잡코리아",
      "searchUrl": "https://www.jobkorea.co.kr/Search/?stext=...",
      "recommendedFilter": "..."
    },
    {"name": "리멤버", "searchUrl": "...", "recommendedFilter": "..."},
    {"name": "원티드", "searchUrl": "...", "recommendedFilter": "..."},
    {"name": "링크드인", "searchUrl": "https://www.linkedin.com/jobs/search/?keywords=...", "recommendedFilter": "..."},
    {"name": "잡플래닛", "searchUrl": "...", "recommendedFilter": "..."},
    {"name": "워크넷", "searchUrl": "https://www.work.go.kr/...", "recommendedFilter": "..."},
    {"name": "인크루트", "searchUrl": "...", "recommendedFilter": "..."}
  ],
  "tips": [
    "오늘의 추천 검색 키워드 1-2개",
    "주의할 점"
  ],
  "summary": "한 줄 요약"
}`
        }]
      })
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.json();
      throw new Error('Claude: ' + (err.error?.message || claudeRes.status));
    }

    const data = await claudeRes.json();
    let text = data.content[0].text.trim();
    text = text.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/\s*```\s*$/, '').trim();
    const searchResult = JSON.parse(text);
    results.push(searchResult);

    // GitHub에 자동 commit (옵션 — 토큰 있을 때)
    if (githubToken && githubOwner && githubRepo) {
      try {
        const filePath = 'jobs/auto-found.json';
        const apiUrl = `https://api.github.com/repos/${githubOwner}/${githubRepo}/contents/${filePath}`;

        // 기존 파일 SHA 가져오기
        let sha = null;
        try {
          const getRes = await fetch(apiUrl, {
            headers: { Authorization: `Bearer ${githubToken}`, Accept: 'application/vnd.github+json' }
          });
          if (getRes.ok) {
            const fileData = await getRes.json();
            sha = fileData.sha;
          }
        } catch {}

        const content = JSON.stringify({
          lastUpdated: new Date().toISOString(),
          ...searchResult
        }, null, 2);

        const body = {
          message: `Auto-search ${new Date().toISOString().split('T')[0]}`,
          content: Buffer.from(content, 'utf-8').toString('base64'),
          branch: 'main'
        };
        if (sha) body.sha = sha;

        const putRes = await fetch(apiUrl, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${githubToken}`,
            'Content-Type': 'application/json',
            Accept: 'application/vnd.github+json'
          },
          body: JSON.stringify(body)
        });

        if (!putRes.ok) {
          const err = await putRes.json();
          errors.push('GitHub commit 실패: ' + err.message);
        }
      } catch (err) {
        errors.push('GitHub commit 에러: ' + err.message);
      }
    }

    res.status(200).json({
      success: true,
      result: searchResult,
      githubCommitted: !!(githubToken && githubOwner && githubRepo && errors.length === 0),
      errors
    });
  } catch (err) {
    res.status(500).json({ error: err.message, errors });
  }
}
