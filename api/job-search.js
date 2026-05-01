// 잡사이트 자동 검색 → AI 적합도 점수 → 60점 이상 필터
// 원티드 GraphQL 우선 + 사람인 HTML fallback (anti-bot 위험 있음)
// AI 평가는 Gemini 2.5 Flash 사용 (무료 티어 / 매우 저렴)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-gemini-key, x-api-key');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const geminiKey = req.headers['x-gemini-key'] || process.env.GEMINI_API_KEY;
  if (!geminiKey) return res.status(401).json({ error: 'Gemini API key required (https://aistudio.google.com/apikey 에서 무료 발급)' });

  const {
    keywords = ['마케팅 본부장', '퍼포먼스 마케팅 팀장', '브랜드 마케팅 본부장'],
    minScore = 60,
    maxJobs = 30,
    profile = '마케팅 시니어 본부장 (16년) — 광고대행 7년(NHN커머스) + 자체 브랜드 D2C 4사 5년 / 본부장·실장·팀장 가능 / VT코스메틱 1억→20억, 닥터미라클 7.7억, 푸드케어 250억 매출 책임 / 메타 Advantage+·구글 PMax·생성형 AI 직접 운영'
  } = req.body || {};

  const allJobs = [];
  const errors = [];
  const sourcesAttempted = [];

  // ============ 1. 원티드 GraphQL 시도 (가장 안정) ============
  for (const kw of keywords.slice(0, 3)) {
    sourcesAttempted.push(`원티드 [${kw}]`);
    try {
      const url = `https://www.wanted.co.kr/api/chaos/jobs/v4/jobs?country=kr&keyword=${encodeURIComponent(kw)}&years=10&limit=15&offset=0&job_sort=job.latest_order`;
      const r = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json',
          'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8'
        }
      });
      if (r.ok) {
        const data = await r.json();
        const items = data?.data || [];
        for (const j of items) {
          allJobs.push({
            source: '원티드',
            company: j.company?.name || j.company_name || '미상',
            position: j.position || j.title || '',
            url: j.id ? `https://www.wanted.co.kr/wd/${j.id}` : (j.url || ''),
            jdText: j.intro || j.description || j.summary || '',
            deadline: j.due_time || '',
            location: j.address?.location || '',
            keyword: kw
          });
        }
      } else {
        errors.push(`원티드 [${kw}]: HTTP ${r.status}`);
      }
    } catch (e) {
      errors.push(`원티드 [${kw}] 에러: ${e.message}`);
    }
  }

  // ============ 2. 사람인 HTML 시도 (anti-bot 위험) ============
  for (const kw of keywords.slice(0, 2)) {
    sourcesAttempted.push(`사람인 [${kw}]`);
    try {
      const url = `https://www.saramin.co.kr/zf_user/search?searchword=${encodeURIComponent(kw)}&go=&flag=n&searchType=search&searchMode=&exp_cd=8`;
      const r = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'ko-KR,ko;q=0.9'
        }
      });
      if (r.ok) {
        const html = await r.text();
        // 사람인 검색 결과 카드 정규식 파싱 (구조 변하면 깨질 수 있음)
        const itemRegex = /<div[^>]+class="[^"]*item_recruit[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/gi;
        const titleRegex = /<a[^>]+href="([^"]+)"[^>]*title="([^"]+)"/i;
        const companyRegex = /<a[^>]+class="[^"]*company_nm[^"]*"[^>]*>\s*<strong[^>]*>([^<]+)<\/strong>/i;
        let count = 0;
        let m;
        while ((m = itemRegex.exec(html)) !== null && count < 15) {
          const itemHtml = m[1];
          const titleMatch = itemHtml.match(titleRegex);
          const companyMatch = itemHtml.match(companyRegex);
          if (titleMatch) {
            allJobs.push({
              source: '사람인',
              company: companyMatch ? companyMatch[1].trim() : '미상',
              position: titleMatch[2].trim(),
              url: titleMatch[1].startsWith('http') ? titleMatch[1] : 'https://www.saramin.co.kr' + titleMatch[1],
              jdText: '',
              deadline: '',
              location: '',
              keyword: kw
            });
            count++;
          }
        }
      } else {
        errors.push(`사람인 [${kw}]: HTTP ${r.status} (anti-bot 가능성)`);
      }
    } catch (e) {
      errors.push(`사람인 [${kw}] 에러: ${e.message}`);
    }
  }

  // ============ 중복 제거 (URL 기준) ============
  const uniqueJobs = [];
  const seen = new Set();
  for (const j of allJobs) {
    const key = j.url || `${j.source}-${j.company}-${j.position}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueJobs.push(j);
    }
  }

  // ============ 3. 각 공고 AI 적합도 점수 (Claude Haiku, 빠름·저비용) ============
  const evalLimit = Math.min(uniqueJobs.length, maxJobs);
  const scored = [];

  for (let i = 0; i < evalLimit; i++) {
    const job = uniqueJobs[i];
    if (!job.position) continue;
    try {
      const prompt = `마케팅 시니어 본부장 지원자에 대한 채용공고 적합도를 0-100점 숫자만 답변하세요. 설명 없이 숫자만.

[지원자]
${profile}

[공고]
회사: ${job.company}
포지션: ${job.position}
요약: ${(job.jdText || '').slice(0, 600)}
사이트: ${job.source}

평가 기준: 직무 매칭 / 시니어급 적합 / 카테고리(광고대행·D2C·이커머스 등) 매칭 / 본부장·실장·팀장급 여부.

응답 — 숫자만 (예: 72):`;

      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 30, temperature: 0.3 }
        })
      });

      if (r.ok) {
        const data = await r.json();
        const text = (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
        const scoreMatch = text.match(/\d+/);
        const score = scoreMatch ? parseInt(scoreMatch[0], 10) : 0;
        if (score >= minScore) {
          scored.push({ ...job, matchScore: score });
        }
      } else {
        const err = await r.json().catch(() => ({}));
        errors.push(`Gemini 평가 [${job.company}]: ${err.error?.message || r.status}`);
      }
    } catch (e) {
      errors.push(`AI 평가 [${job.company}] 에러: ${e.message}`);
    }
  }

  // 점수 내림차순 정렬
  scored.sort((a, b) => b.matchScore - a.matchScore);

  res.status(200).json({
    success: true,
    keywords,
    minScore,
    sourcesAttempted,
    totalFetched: uniqueJobs.length,
    totalEvaluated: evalLimit,
    matched: scored.length,
    jobs: scored,
    errors
  });
}
