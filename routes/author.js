const express = require('express');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const path = require('path');
const db = require('../lib/db');
const { render, isLoggedIn, isAuthor, buildNav, escapeHtml, notify, adBannerHtml } = require('../lib/helpers');
const router = express.Router();

const fs = require('fs');

// 파일 업로드 설정 (메모리 저장, 10MB 제한) - AI 분석용
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.pdf', '.doc', '.docx'].includes(ext)) cb(null, true);
    else cb(new Error('PDF 또는 Word 파일만 업로드 가능합니다.'));
  },
});

// 리포트 PDF 업로드 설정 (디스크 저장, 20MB 제한)
const reportPdfDir = path.join(__dirname, '..', 'uploads', 'reports');
if (!fs.existsSync(reportPdfDir)) fs.mkdirSync(reportPdfDir, { recursive: true });
const reportPdfUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, reportPdfDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')),
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() === '.pdf') cb(null, true);
    else cb(new Error('PDF 파일만 업로드 가능합니다.'));
  },
});

// 작성자 대시보드
router.get('/dashboard', isLoggedIn, isAuthor, (req, res) => {
  const reports = db.prepare(`
    SELECT r.*,
    (SELECT COUNT(*) FROM orders WHERE report_id = r.id) as sales_count,
    (SELECT COALESCE(SUM(amount), 0) FROM orders WHERE report_id = r.id) as total_revenue
    FROM reports r WHERE r.author_id = ? ORDER BY r.created_at DESC
  `).all(req.user.id);

  const totalSales = reports.reduce((sum, r) => sum + r.sales_count, 0);
  const totalRevenue = reports.reduce((sum, r) => sum + r.total_revenue, 0);
  const statusMap = {
    draft: '임시저장', study_published: '스터디 공개',
    pending_leader: '스터디장 승인 대기', pending_admin: '관리자 승인 대기',
    submitted: '검수 대기', on_sale: '외부 판매중', rejected: '반려됨', suspended: '판매중지'
  };

  const reportRows = reports.map(r => `
    <tr>
      <td>${escapeHtml(r.title)}</td>
      <td>${escapeHtml(r.stock_name)}</td>
      <td><span class="status-badge status-${r.status}">${statusMap[r.status] || r.status}</span></td>
      <td>${r.sale_price === 0 ? '무료' : r.sale_price.toLocaleString() + 'P'}</td>
      <td>${r.sales_count}</td>
      <td>
        ${['draft','rejected','pending_leader','pending_admin','submitted','study_published'].includes(r.status) ? `<a href="/author/reports/${r.id}/edit" class="btn-sm">수정</a>` : ''}
        ${r.status === 'on_sale' ? `<a href="/reports/${r.id}" class="btn-sm">보기</a>` : ''}
        ${r.status === 'study_published' ? `<button class="btn-sm btn-publish" onclick="openPublishModal(${r.id}, '${escapeHtml(r.title).replace(/'/g, "\\'")}')">외부 판매</button>` : ''}
        <button class="btn-sm btn-delete" onclick="openDeleteModal(${r.id}, '${escapeHtml(r.title).replace(/'/g, "\\'")}')" style="background:rgba(239,68,68,0.15);color:#ef4444;border:1px solid rgba(239,68,68,0.3);cursor:pointer;font-family:inherit;margin-left:4px">삭제</button>
      </td>
    </tr>
  `).join('');

  let profile = db.prepare('SELECT * FROM author_profiles WHERE user_id = ?').get(req.user.id);
  if (!profile) {
    db.prepare('INSERT OR IGNORE INTO author_profiles (user_id, display_name, bio, sectors) VALUES (?, ?, ?, ?)').run(req.user.id, req.user.name, '', '');
    profile = db.prepare('SELECT * FROM author_profiles WHERE user_id = ?').get(req.user.id);
  }

  const html = render('views/author-dashboard.html', {
    nav: buildNav(req.user),
    totalReports: String(reports.length),
    totalSales: String(totalSales),
    totalRevenue: totalRevenue.toLocaleString(),
    reportRows: reportRows || '<tr><td colspan="6" class="empty-text">작성한 리포트가 없습니다.</td></tr>',
    displayName: escapeHtml(profile?.display_name || req.user.name),
    bio: escapeHtml(profile?.bio || ''),
    sectors: escapeHtml(profile?.sectors || ''),
    adBanner: adBannerHtml(),
  });
  res.send(html);
});

// 프로필 업데이트
router.post('/profile', isLoggedIn, isAuthor, (req, res) => {
  const { display_name, bio, sectors } = req.body;
  db.prepare(`INSERT INTO author_profiles (user_id, display_name, bio, sectors)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(user_id) DO UPDATE SET display_name=excluded.display_name, bio=excluded.bio, sectors=excluded.sectors`)
    .run(req.user.id, display_name || req.user.name, bio || '', sectors || '');
  res.redirect('/author/dashboard');
});

// Claude AI를 이용한 리포트 분석
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

async function analyzeWithClaude(text) {
  if (!anthropic) throw new Error('ANTHROPIC_API_KEY가 설정되지 않았습니다.');

  // 텍스트가 너무 길면 앞부분만 사용 (토큰 절약)
  const truncated = text.slice(0, 15000);

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4000,
    messages: [{
      role: 'user',
      content: `아래는 주식 리서치 리포트 또는 기업분석 자료에서 추출한 텍스트입니다.
이 텍스트를 분석하여 다음 항목들을 JSON 형식으로 추출해주세요.

**추출 항목:**
- stockName: 분석 대상 종목명 (회사명만, "삼성전자", "케이엔제이" 등. "기업분석", "보고서" 같은 접미사 제외)
- stockCode: 종목코드 (6자리 숫자, 없으면 빈 문자열)
- title: 리포트 제목 (종목명과 다른, 리포트의 핵심 주제를 나타내는 제목)
- summary: 리포트 요약 (핵심 내용 2~5문장)
- thesis: 투자 논거 (이 종목에 투자해야 하는 핵심 이유)
- investmentPoints: 투자 포인트 (구체적인 투자 포인트들, 실적 분석, 성장 동력 등)
- valuationBasis: 밸류에이션 근거 (목표주가, PER, PBR, 적정가 산출 근거 등)
- risks: 리스크 요인 (투자 위험 요소들)
- bearCase: Bear Case (최악의 시나리오, 하방 리스크)
- references: 참고자료/면책조항 (출처, disclaimer 등)

**규칙:**
1. 각 항목은 원문의 내용을 충실히 반영하되, 자연스러운 한국어로 정리해주세요.
2. 원문에 해당 내용이 없는 항목은 빈 문자열("")로 남겨주세요.
3. stockName은 반드시 회사명만 넣어주세요 (예: "삼성전자", "케이엔제이", "LG에너지솔루션")
4. 투자 포인트가 여러 개면 줄바꿈으로 구분해주세요.
5. JSON만 출력하세요. 다른 설명은 불필요합니다.

**텍스트:**
${truncated}`
    }],
  });

  const content = response.content[0].text;
  // JSON 파싱 (코드블록 감싸져 있을 수 있으므로 추출)
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('AI 응답에서 JSON을 파싱할 수 없습니다.');
  return JSON.parse(jsonMatch[0]);
}

// 파일/URL에서 텍스트 추출 + Claude AI 분석 API
router.post('/reports/extract', isLoggedIn, isAuthor, upload.single('file'), async (req, res) => {
  try {
    // 포인트 체크 및 차감
    const currentUser = db.prepare('SELECT points FROM users WHERE id = ?').get(req.user.id);
    if (!currentUser || currentUser.points < 100) {
      return res.json({ error: '포인트가 부족합니다. (필요: 100P, 보유: ' + (currentUser?.points || 0) + 'P)' });
    }
    db.prepare('UPDATE users SET points = points - 100 WHERE id = ?').run(req.user.id);
    db.prepare("INSERT INTO point_logs (user_id, amount, type, description) VALUES (?, -100, 'ai_analysis', 'AI 리포트 분석')").run(req.user.id);

    let text = '';
    let pdfBuffer = null;

    if (req.file) {
      const ext = path.extname(req.file.originalname).toLowerCase();
      if (ext === '.pdf') {
        pdfBuffer = req.file.buffer;
        const data = await pdfParse(req.file.buffer);
        text = data.text;
      } else if (ext === '.docx' || ext === '.doc') {
        const result = await mammoth.extractRawText({ buffer: req.file.buffer });
        text = result.value;
      }
    } else if (req.body.url) {
      let url = req.body.url.trim();
      // SSRF 방지: 허용된 프로토콜 및 외부 호스트만 허용
      let parsedUrl;
      try { parsedUrl = new URL(url); } catch { return res.json({ error: '유효하지 않은 URL입니다.' }); }
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) return res.json({ error: 'http/https URL만 허용됩니다.' });
      const hostname = parsedUrl.hostname.toLowerCase();
      if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0' || hostname.startsWith('10.') || hostname.startsWith('172.') || hostname.startsWith('192.168.') || hostname === '169.254.169.254' || hostname.endsWith('.internal') || hostname === '[::1]') {
        return res.json({ error: '내부 네트워크 주소는 허용되지 않습니다.' });
      }

      // 네이버 블로그: 모바일 URL로 변환 (본문이 SSR로 포함됨)
      if (hostname === 'blog.naver.com' || hostname === 'm.blog.naver.com') {
        url = url.replace('blog.naver.com', 'm.blog.naver.com');
      }
      // 티스토리: m. 프리픽스 추가
      if (hostname.endsWith('.tistory.com') && !hostname.startsWith('m.')) {
        url = url.replace('://', '://m.');
      }

      // 노션: 비공식 API로 텍스트 추출
      if (hostname.endsWith('.notion.site') || hostname === 'www.notion.so' || hostname === 'notion.so') {
        const pageIdMatch = url.match(/([a-f0-9]{32})/);
        if (pageIdMatch) {
          const notionResp = await fetch(`https://notion-api.splitbee.io/v1/page/${pageIdMatch[1]}`);
          const notionData = await notionResp.json();
          const texts = [];
          for (const [id, block] of Object.entries(notionData)) {
            const v = block.value;
            if (v && v.properties && v.properties.title) {
              const t = v.properties.title.map(seg => seg[0]).join('');
              if (t.trim()) texts.push(t.trim());
            }
          }
          text = texts.join('\n');
        }
        if (!text) return res.json({ error: '노션 페이지에서 텍스트를 추출할 수 없습니다. 페이지가 공개 상태인지 확인해주세요.' });
      }

      if (!text) {
      const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)' }, redirect: 'follow' });
      const contentType = resp.headers.get('content-type') || '';

      if (contentType.includes('pdf')) {
        const buf = Buffer.from(await resp.arrayBuffer());
        pdfBuffer = buf;
        const data = await pdfParse(buf);
        text = data.text;
      } else if (contentType.includes('word') || contentType.includes('officedocument')) {
        const buf = Buffer.from(await resp.arrayBuffer());
        const result = await mammoth.extractRawText({ buffer: buf });
        text = result.value;
      } else {
        // HTML 페이지일 경우 텍스트 추출
        const html = await resp.text();
        text = html.replace(/<script[\s\S]*?<\/script>/gi, '')
                    .replace(/<style[\s\S]*?<\/style>/gi, '')
                    .replace(/<[^>]*>/g, '\n')
                    .replace(/\n{3,}/g, '\n\n')
                    .trim();
      }
      } // end if (!text)
    }

    if (!text) return res.json({ error: '텍스트를 추출할 수 없습니다.' });

    // Claude AI로 분석 시도, 실패 시 기존 정규식 파싱 폴백
    let parsed;
    try {
      if (!anthropic) throw new Error('API key not set');
      parsed = await analyzeWithClaude(text);
    } catch (aiError) {
      console.error('Claude AI 분석 실패, 정규식 폴백:', aiError.message);
      parsed = parseReportText(text);
    }

    res.json({ ok: true, text, parsed });
  } catch (e) {
    console.error('Extract error:', e.message);
    res.json({ error: '파일 처리 중 오류가 발생했습니다: ' + e.message });
  }
});

// 텍스트에서 리포트 섹션 자동 파싱
function parseReportText(text) {
  const result = {
    title: '', stockName: '', stockCode: '',
    summary: '', thesis: '', investmentPoints: '',
    valuationBasis: '', risks: '', bearCase: '', references: ''
  };
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return result;

  // 전체 텍스트 (검색용)
  const fullText = text;
  // 상단 영역 (메타정보 추출용, 상위 30줄 또는 전체의 20%)
  const headerLines = lines.slice(0, Math.max(30, Math.floor(lines.length * 0.2)));

  // ── 1. 종목코드 추출 (6자리 숫자, 다양한 패턴) ──
  const codePatterns = [
    // (005930), （005930）, [005930]
    /[\(（\[]\s*(\d{6})\s*[\)）\]]/,
    // 종목코드: 005930, 코드: 005930
    /(?:종목\s*코드|코드|stock\s*code|ticker)[\s:：]*(\d{6})/i,
    // A005930, KR005930 등
    /[A-Z]{0,2}(\d{6})(?:\s*\.K[SQ])?/,
    // 단독 6자리 숫자 (날짜/페이지 제외)
    /(?<!\d)(\d{6})(?!\d)/,
  ];

  for (const pat of codePatterns) {
    for (const line of headerLines) {
      // 날짜 패턴(20xxxx, 2025xx 등)이나 페이지 번호 제외
      const m = line.match(pat);
      if (m && m[1] && !/^20[0-3]\d/.test(m[1]) && !/^(page|p\.|페이지)/i.test(line)) {
        result.stockCode = m[1];
        break;
      }
    }
    if (result.stockCode) break;
  }

  // ── 2. 종목명 추출 (다양한 패턴, 우선순위별) ──
  const stockNameCandidates = [];

  for (const line of headerLines) {
    // 패턴 A: "종목명: xxx", "종목: xxx", "Company: xxx"
    const labelMatch = line.match(/(?:종목[명\s]*|company\s*|기업[명\s]*)[:：]\s*(.+)/i);
    if (labelMatch) {
      const name = labelMatch[1].replace(/[\(（].*[\)）]/, '').trim();
      if (name) stockNameCandidates.push({ name, priority: 1 });
    }

    // 패턴 B: "삼성전자(005930)" 또는 "삼성전자 (005930)" - 종목명+코드 조합
    const nameCodeMatch = line.match(/([가-힣A-Za-z][가-힣A-Za-z\s]{0,20})\s*[\(（]\s*(\d{6})\s*[\)）]/);
    if (nameCodeMatch) {
      const name = nameCodeMatch[1].trim();
      if (name.length >= 2) {
        stockNameCandidates.push({ name, priority: 0 });
        if (!result.stockCode) result.stockCode = nameCodeMatch[2];
      }
    }

    // 패턴 C: "005930 삼성전자" - 코드+종목명 순서
    const codeNameMatch = line.match(/(\d{6})\s+([가-힣][가-힣A-Za-z\s]{1,20})/);
    if (codeNameMatch) {
      const name = codeNameMatch[2].trim();
      if (name.length >= 2) {
        stockNameCandidates.push({ name, priority: 1 });
        if (!result.stockCode) result.stockCode = codeNameMatch[1];
      }
    }

    // 패턴 D: "Buy 삼성전자", "매수 삼성전자", "Hold LG에너지솔루션"
    const ratingMatch = line.match(/(?:Buy|Sell|Hold|Strong Buy|매수|매도|중립|비중확대|비중축소|Trading Buy|Outperform|Underperform|시장수익률|목표주가|Not Rated)\s+([가-힣][가-힣A-Za-z0-9\s]{1,20})/i);
    if (ratingMatch) {
      const name = ratingMatch[1].replace(/\s*[\(（].*/, '').trim();
      if (name.length >= 2) stockNameCandidates.push({ name, priority: 2 });
    }

    // 패턴 E: "삼성전자 Buy", "삼성전자 매수"
    const nameRatingMatch = line.match(/^([가-힣][가-힣A-Za-z0-9\s]{1,20})\s+(?:Buy|Sell|Hold|Strong Buy|매수|매도|중립|비중확대|비중축소|Trading Buy|Outperform|Underperform|시장수익률|Not Rated)/i);
    if (nameRatingMatch) {
      const name = nameRatingMatch[1].replace(/\s*[\(（].*/, '').trim();
      if (name.length >= 2) stockNameCandidates.push({ name, priority: 2 });
    }
  }

  // DB에서 종목코드로 종목명 역추적
  if (stockNameCandidates.length === 0 && result.stockCode) {
    try {
      const stock = db.prepare('SELECT name FROM stocks WHERE code = ?').get(result.stockCode);
      if (stock) stockNameCandidates.push({ name: stock.name, priority: 0 });
    } catch {}
  }

  // 우선순위 순으로 정렬하여 최적 종목명 선택
  if (stockNameCandidates.length > 0) {
    stockNameCandidates.sort((a, b) => a.priority - b.priority);
    result.stockName = stockNameCandidates[0].name;
  }

  // ── 3. 제목 추출 ──
  // 증권사 리포트에서 제목은 보통 종목명 근처에 있는 가장 눈에 띄는 문구
  const titleExclude = ['종목명', '종목코드', 'page', '페이지', 'www.', 'http', '증권', '리서치', '본 조사', '이 자료'];
  const titleCandidates = [];

  for (let i = 0; i < Math.min(20, lines.length); i++) {
    const line = lines[i];
    const lower = line.toLowerCase();
    // 너무 짧거나 너무 긴 줄, 숫자만 있는 줄 제외
    if (line.length < 3 || line.length > 120) continue;
    if (/^\d+$/.test(line)) continue;
    if (titleExclude.some(ex => lower.includes(ex.toLowerCase()))) continue;
    // 이미 종목명으로 사용된 줄 제외
    if (line === result.stockName) continue;
    // 종목코드만 포함된 줄 제외
    if (/^\d{6}$/.test(line.replace(/\D/g, '')) && line.length < 15) continue;

    // 제목다운 줄 점수 매기기
    let score = 0;
    // 적절한 길이 (10~60자)
    if (line.length >= 10 && line.length <= 60) score += 3;
    else if (line.length >= 5 && line.length <= 80) score += 1;
    // 한글 비율이 높으면 보너스
    const koreanChars = (line.match(/[가-힣]/g) || []).length;
    if (koreanChars / line.length > 0.3) score += 2;
    // 종목명을 포함하면 보너스
    if (result.stockName && line.includes(result.stockName)) score += 2;
    // 특수문자로 시작하지 않으면 보너스
    if (/^[가-힣A-Za-z0-9"']/.test(line)) score += 1;
    // 날짜/숫자 위주가 아니면 보너스
    if (!/^\d{4}[.\-\/]/.test(line)) score += 1;

    titleCandidates.push({ line, score, idx: i });
  }

  titleCandidates.sort((a, b) => b.score - a.score || a.idx - b.idx);
  if (titleCandidates.length > 0) {
    result.title = titleCandidates[0].line;
    // 제목이 종목명을 포함하고 있으면 그대로 사용, 아니면 종목명 + 제목 형태도 고려
  }

  // ── 4. 목표주가/투자의견 추출 (추가 메타정보) ──
  let targetPrice = '';
  let investmentOpinion = '';
  for (const line of headerLines) {
    // 목표주가: 80,000원
    const tpMatch = line.match(/목표\s*주가[\s:：]*([0-9,]+)\s*원?/);
    if (tpMatch && !targetPrice) targetPrice = tpMatch[1];
    // 투자의견: 매수
    const opMatch = line.match(/투자\s*의견[\s:：]*(매수|매도|중립|Hold|Buy|Sell|비중확대|비중축소|Trading Buy|Strong Buy|Outperform|Underperform|시장수익률|Not Rated)/i);
    if (opMatch && !investmentOpinion) investmentOpinion = opMatch[1];
  }

  // ── 5. 섹션 키워드 매핑 (확장) ──
  const sectionMap = [
    {
      keys: ['요약', 'summary', 'executive summary', '개요', '핵심 요약', '리포트 요약',
             'overview', '결론', 'conclusion', 'key takeaway', '핵심 내용', '주요 내용',
             '보고서 요약', '핵심요약', '투자 요약', 'highlight'],
      field: 'summary'
    },
    {
      keys: ['투자 논거', 'thesis', '투자논거', '핵심 논거', '투자 아이디어', 'investment thesis',
             '투자의견', '투자 의견', '투자 판단', '종목 분석', '기업 분석', '기업분석', '종목분석',
             '투자포인트 및 논거', '핵심 투자논거'],
      field: 'thesis'
    },
    {
      keys: ['투자 포인트', 'investment point', '투자포인트', '핵심 포인트', '긍정적 요인',
             '성장 동력', '핵심 투자포인트', 'key point', '실적 분석', '실적분석', '매출 분석',
             '사업 분석', '사업분석', '성장성', '경쟁력', '성장동력', '핵심 경쟁력',
             '실적 전망', '실적전망', '사업 현황', '사업현황', '핵심 사업', '수익성',
             '영업이익', '실적 리뷰', '실적리뷰', '분기 실적', '이익 전망', '매출 전망',
             '산업 동향', '산업동향', '시장 동향', '시장동향', '업황'],
      field: 'investmentPoints'
    },
    {
      keys: ['밸류에이션', 'valuation', '적정가', '목표가', '목표주가', 'target price',
             'fair value', '적정 주가', '적정주가', '주가 전망', '주가전망', '목표 주가',
             '밸류에이션 분석', 'peer comparison', '상대가치', '절대가치', 'dcf',
             'sum of the parts', 'sotp', 'per 분석', 'pbr 분석', 'ev/ebitda',
             '수익 추정', '수익추정', '실적 추정', '실적추정', '추정치'],
      field: 'valuationBasis'
    },
    {
      keys: ['리스크', 'risk', '위험', '주요 리스크', '우려', '부정적', '약점', '주의',
             '위험 요인', '위험요인', '리스크 요인', '리스크요인', '불확실성',
             '하방 리스크', '하방리스크', '우려 사항', '우려사항', '변수'],
      field: 'risks'
    },
    {
      keys: ['bear case', 'bear-case', 'bearcase', '하방', '최악', '하락 시나리오',
             'worst case', '비관', '비관적 시나리오', '하방 시나리오', 'downside'],
      field: 'bearCase'
    },
    {
      keys: ['참고', 'reference', '출처', '자료 출처', 'source', '각주', 'disclaimer',
             '면책', '법적 고지', '유의사항', '투자 유의', '투자유의', '이해관계',
             '작성자', '애널리스트', 'analyst', '컴플라이언스'],
      field: 'references'
    },
  ];

  // ── 6. 섹션 파싱 (개선된 헤더 감지) ──
  let currentField = null;
  const fieldTexts = {};
  const contentLines = [];

  // 섹션 헤더인지 판별하는 함수
  function detectSection(line) {
    const lower = line.toLowerCase().replace(/[#*\-=_▶▷●■□◆◇※·•→►⦁⏵⯈]/g, '').trim();
    // 빈 줄이면 스킵
    if (!lower) return null;

    for (const sec of sectionMap) {
      for (const key of sec.keys) {
        const keyLower = key.toLowerCase();
        // 정확 매치 또는 줄 시작이 키워드인 경우
        if (lower === keyLower || lower.startsWith(keyLower + ' ') || lower.startsWith(keyLower + ':') || lower.startsWith(keyLower + '：')) {
          return sec.field;
        }
        // 줄이 충분히 짧고(헤더스러움) 키워드 포함
        if (line.length <= 40 && lower.includes(keyLower)) {
          return sec.field;
        }
        // 숫자+마침표 접두사: "1. 요약", "I. 투자 포인트"
        const numberedMatch = lower.match(/^(?:\d+\.|[ivx]+\.|[①②③④⑤⑥])\s*(.*)/i);
        if (numberedMatch && numberedMatch[1].includes(keyLower)) {
          return sec.field;
        }
      }
    }

    // 추가: 길이 40 이하이고 대괄호/꺾쇠 등으로 감싸진 헤더
    const bracketMatch = lower.match(/^[\[【<〈《「『]\s*(.*?)\s*[\]】>〉》」』]/);
    if (bracketMatch) {
      for (const sec of sectionMap) {
        if (sec.keys.some(k => bracketMatch[1].includes(k.toLowerCase()))) return sec.field;
      }
    }

    return null;
  }

  // 메타정보 영역(상단)과 본문 영역 구분
  // 보통 처음 몇 줄은 증권사명, 날짜, 종목명, 목표주가 등 메타정보
  let bodyStartIdx = 0;
  for (let i = 0; i < Math.min(25, lines.length); i++) {
    const section = detectSection(lines[i]);
    if (section) {
      bodyStartIdx = i;
      break;
    }
    // 긴 문장이 나오면 본문 시작으로 간주 (메타정보는 보통 짧음)
    if (lines[i].length > 80 && i > 3) {
      bodyStartIdx = i;
      break;
    }
  }
  // 아무 섹션 헤더도 못 찾았으면 상단 5줄 이후를 본문으로
  if (bodyStartIdx === 0) bodyStartIdx = Math.min(5, lines.length);

  // 상단 메타정보에서 추가 종목명 추출 시도
  if (!result.stockName) {
    for (let i = 0; i < bodyStartIdx; i++) {
      const line = lines[i];
      // "케이엔제이 기업분석 보고서" → "케이엔제이" 패턴
      const reportSuffixMatch = line.match(/^([가-힣A-Za-z][가-힣A-Za-z0-9]{1,15})\s+(?:기업\s*분석|종목\s*분석|분석\s*보고서|보고서|리포트|리서치|투자\s*의견|실적\s*분석|탐방\s*보고서)/);
      if (reportSuffixMatch) {
        result.stockName = reportSuffixMatch[1].trim();
        break;
      }
      // 짧은 한글 단어(2~10자)가 단독으로 있는 줄 = 종목명일 가능성
      if (/^[가-힣A-Za-z][가-힣A-Za-z0-9\s]{1,15}$/.test(line) && line.length <= 20) {
        const commonWords = ['리포트', '분석', '보고서', '투자', '의견', '종목', '기업', '전망',
          '리서치', '섹터', '증권', '연구', '자료', '보고', '결론', '요약'];
        if (!commonWords.some(w => line.includes(w))) {
          result.stockName = line.trim();
          break;
        }
      }
    }
  }

  // 본문 섹션 파싱
  for (let i = bodyStartIdx; i < lines.length; i++) {
    const line = lines[i];
    const section = detectSection(line);

    if (section) {
      currentField = section;
      // 헤더 줄 자체에 내용이 붙어있는 경우: "요약: 삼성전자는..."
      const colonIdx = line.search(/[:：]/);
      if (colonIdx !== -1 && colonIdx < line.length - 5) {
        const afterColon = line.slice(colonIdx + 1).trim();
        if (afterColon.length > 10) {
          fieldTexts[currentField] = (fieldTexts[currentField] || '') + afterColon + '\n';
        }
      }
    } else {
      if (currentField) {
        fieldTexts[currentField] = (fieldTexts[currentField] || '') + line + '\n';
      } else {
        contentLines.push(line);
      }
    }
  }

  // ── 7. 섹션 파싱 결과 적용 ──
  for (const [k, v] of Object.entries(fieldTexts)) {
    result[k] = v.trim();
  }

  // ── 8. 목표주가/투자의견을 요약 또는 thesis에 보충 ──
  if (targetPrice || investmentOpinion) {
    const meta = [];
    if (investmentOpinion) meta.push(`투자의견: ${investmentOpinion}`);
    if (targetPrice) meta.push(`목표주가: ${targetPrice}원`);
    const metaStr = meta.join(' | ');

    if (!result.summary) {
      result.summary = metaStr;
    } else if (!result.summary.includes('목표주가') && !result.summary.includes('투자의견')) {
      result.summary = metaStr + '\n\n' + result.summary;
    }
  }

  // ── 9. 섹션 매칭 안 된 내용 분배 (개선) ──
  if (contentLines.length > 0) {
    // 문단 단위로 분리 (연속된 줄들을 하나의 문단으로)
    const paragraphs = [];
    let currentPara = [];
    for (const line of contentLines) {
      if (line.length < 3 || /^[-=_·•]+$/.test(line)) {
        if (currentPara.length > 0) {
          paragraphs.push(currentPara.join('\n'));
          currentPara = [];
        }
      } else {
        currentPara.push(line);
      }
    }
    if (currentPara.length > 0) paragraphs.push(currentPara.join('\n'));

    if (paragraphs.length > 0) {
      // 섹션이 비어있으면 문단을 순서대로 배분
      const emptyFields = [];
      if (!result.summary) emptyFields.push('summary');
      if (!result.thesis) emptyFields.push('thesis');
      if (!result.investmentPoints) emptyFields.push('investmentPoints');
      if (!result.valuationBasis) emptyFields.push('valuationBasis');
      if (!result.risks) emptyFields.push('risks');

      if (emptyFields.length > 0) {
        // 키워드 기반으로 문단을 섹션에 매칭 시도
        const keywordHints = {
          summary: ['요약', '결론', '핵심', '전체적', 'summary', '종합'],
          thesis: ['투자', '논거', '이유', '근거', '판단', '전략'],
          investmentPoints: ['매출', '영업이익', '성장', '실적', '사업', '시장', '점유율', '수익', '전년', '전분기', 'yoy', 'qoq'],
          valuationBasis: ['per', 'pbr', 'ev', '목표', '적정', '밸류', '주가', '배수', '할인', 'dcf', '가치'],
          risks: ['리스크', '위험', '우려', '하락', '부정', '감소', '악화', '둔화', '경쟁'],
        };

        for (const para of paragraphs) {
          const lower = para.toLowerCase();
          let bestField = null;
          let bestScore = 0;

          for (const field of emptyFields) {
            const hints = keywordHints[field] || [];
            const score = hints.filter(h => lower.includes(h)).length;
            if (score > bestScore) {
              bestScore = score;
              bestField = field;
            }
          }

          if (bestField && bestScore >= 1) {
            result[bestField] = (result[bestField] ? result[bestField] + '\n\n' : '') + para;
          }
        }

        // 키워드 매칭 안 된 문단들은 비어있는 섹션에 순차 배분
        const unmatchedParas = paragraphs.filter(p => {
          return !Object.values(result).some(v => v && v.includes(p));
        });

        const stillEmpty = emptyFields.filter(f => !result[f]);
        if (unmatchedParas.length > 0 && stillEmpty.length > 0) {
          // 가장 중요한 빈 필드부터 채움
          const parasPerField = Math.max(1, Math.ceil(unmatchedParas.length / stillEmpty.length));
          let paraIdx = 0;
          for (const field of stillEmpty) {
            const chunk = unmatchedParas.slice(paraIdx, paraIdx + parasPerField);
            if (chunk.length > 0) {
              result[field] = chunk.join('\n\n').trim();
            }
            paraIdx += parasPerField;
          }
        }
      }
    }
  }

  // ── 10. 종목명 최종 폴백 ──
  if (!result.stockName && result.title) {
    // 제목에서 한글 단어(회사명처럼 보이는 것) 추출
    const words = result.title.match(/[가-힣]{2,}/g);
    if (words && words.length > 0) {
      const exclude = ['리포트', '분석', '보고서', '투자', '의견', '종목', '기업', '전망', '리서치',
        '섹터', '실적', '전환', '성장', '확대', '개선', '하락', '상승', '기대', '우려',
        '반등', '돌파', '수혜', '핵심', '글로벌', '국내'];
      const candidate = words.find(w => !exclude.includes(w));
      if (candidate) result.stockName = candidate;
    }
  }

  // ── 11. 종목명 정리 (불필요한 접미사/접두사 제거) ──
  if (result.stockName) {
    result.stockName = result.stockName
      .replace(/\s*[\(（].*[\)）]/, '')   // 괄호 내용 제거
      .replace(/\s*(주|㈜|Inc\.|Corp\.|Co\.,?\s*Ltd\.?).*$/i, '')  // 법인격 접미사 제거
      .trim();
    // "케이엔제이 기업분석 보고서" → "케이엔제이" 같은 패턴 정리
    const suffixWords = ['기업분석', '기업 분석', '종목분석', '종목 분석', '분석보고서', '분석 보고서',
      '보고서', '리포트', '리서치', '분석', '투자의견', '투자 의견', '기업리뷰', '기업 리뷰',
      '탐방보고서', '탐방 보고서', '실적분석', '실적 분석', 'report', 'analysis', 'review'];
    for (const suffix of suffixWords) {
      const idx = result.stockName.toLowerCase().indexOf(suffix.toLowerCase());
      if (idx > 0) {
        result.stockName = result.stockName.slice(0, idx).trim();
        break;
      }
    }
    // 접두사 제거: "종목명 케이엔제이" → "케이엔제이"
    result.stockName = result.stockName.replace(/^(?:종목[명\s]*|기업[명\s]*|회사[명\s]*)[:：]?\s*/i, '').trim();
    // 빈 문자열이 되면 다시 비우기
    if (result.stockName.length < 2) result.stockName = '';
  }

  // ── 12. 제목에서도 불필요한 접미사 정리 ──
  if (result.title && result.stockName) {
    // 제목이 종목명과 동일하면 비우기 (더 나은 제목을 위해)
    if (result.title.trim() === result.stockName.trim()) {
      result.title = '';
    }
  }

  return result;
}

// 유저가 속한 스터디방 옵션 생성
// 내 리포트 옵션 생성
function getMyReportOptions(userId) {
  const reports = db.prepare(`
    SELECT id, title, stock_name, created_at FROM reports
    WHERE author_id = ? ORDER BY created_at DESC LIMIT 30
  `).all(userId);
  if (reports.length === 0) return '';
  return reports.map(r =>
    `<option value="${r.id}">${escapeHtml(r.stock_name)} - ${escapeHtml(r.title)} (${new Date(r.created_at).toLocaleDateString('ko-KR')})</option>`
  ).join('');
}

function getStudyRoomOptions(userId, selectedId) {
  const rooms = db.prepare(`
    SELECT sr.id, sr.name FROM study_rooms sr
    JOIN study_members sm ON sm.room_id = sr.id
    WHERE sm.user_id = ?
    ORDER BY sr.name
  `).all(userId);
  if (rooms.length === 0) return '<option value="">가입된 스터디방이 없습니다</option>';
  return rooms.map(r =>
    `<option value="${r.id}" ${String(r.id) === String(selectedId) ? 'selected' : ''}>${escapeHtml(r.name)}</option>`
  ).join('');
}

// 리포트 작성 폼
router.get('/reports/new', isLoggedIn, isAuthor, (req, res) => {
  // 스터디 가입 여부 확인
  const membership = db.prepare('SELECT id FROM study_members WHERE user_id = ? LIMIT 1').get(req.user.id);
  if (!membership) {
    const html = render('views/report-write-blocked.html', {
      nav: buildNav(req.user),
    });
    return res.send(html);
  }

  const html = render('views/report-write.html', {
    nav: buildNav(req.user),
    mode: 'new',
    reportId: '',
    title: '',
    stockName: '',
    stockCode: '',
    marketType: '',
    sector: '',
    summary: '',
    thesis: '',
    investmentPoints: '',
    valuationBasis: '',
    risks: '',
    bearCase: '',
    referencesText: '',
    holdingDisclosure: '',
    conflictDisclosure: '',
    basePrice: '',
    salePrice: '',
    visibility: 'study_only',
    maxBuyers: '0',
    studyRoomOptions: getStudyRoomOptions(req.user.id, ''),
    myReportOptions: getMyReportOptions(req.user.id),
  });
  res.send(html);
});

// 종목 현재가 조회 (Yahoo Finance v8)
async function fetchCurrentPrice(stockCode, marketType) {
  if (!stockCode) return 0;
  const code = stockCode.replace(/[^0-9A-Za-z]/g, '');
  let symbol;
  if (/^\d{6}$/.test(code)) {
    symbol = marketType === 'KOSDAQ' ? `${code}.KQ` : `${code}.KS`;
  } else {
    symbol = code;
  }
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
    const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const json = await resp.json();
    return json.chart?.result?.[0]?.meta?.regularMarketPrice || 0;
  } catch { return 0; }
}

// 리포트 저장 (새로 작성)
router.post('/reports/new', isLoggedIn, isAuthor, reportPdfUpload.single('report_pdf'), async (req, res) => {
  const action = req.body.action; // 'draft' or 'submit'
  const visibilityRaw = req.body.visibility || 'study_only';
  // both = 스터디 + 외부 동시 공개 → DB에는 'public'으로 저장 (스터디방에도 연결)
  const visibility = (visibilityRaw === 'both') ? 'public' : visibilityRaw;

  let status = 'draft';
  if (action === 'submit') {
    if (visibilityRaw === 'study_only') {
      status = 'study_published';
    } else {
      // both 또는 public → 승인 프로세스
      status = 'pending_leader';
    }
  }

  const studyRoomId = parseInt(req.body.study_room_id) || null;
  const salePrice = (visibility === 'public') ? (parseInt(req.body.sale_price) || 0) : 0;
  const maxBuyers = (visibility === 'public') ? (parseInt(req.body.max_buyers) || 0) : 0;

  const publishedAt = (status !== 'draft') ? new Date().toISOString() : null;

  // 제출 시 현재 주가를 기준가로 자동 설정
  let basePrice = 0;
  if (status !== 'draft') {
    basePrice = await fetchCurrentPrice(req.body.stock_code, req.body.market_type);
  }

  const pdfPath = req.file ? `/uploads/reports/${req.file.filename}` : null;

  db.prepare(`INSERT INTO reports
    (author_id, title, stock_name, stock_code, market_type, sector, summary, thesis,
     investment_points, valuation_basis, risks, bear_case, references_text,
     holding_disclosure, conflict_disclosure, base_price, sale_price,
     visibility, max_buyers, study_room_id, status, published_at, pdf_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    req.user.id, req.body.title, req.body.stock_name, req.body.stock_code || '',
    req.body.market_type || '', req.body.sector || '', req.body.summary,
    req.body.thesis || '', req.body.investment_points || '', req.body.valuation_basis || '',
    req.body.risks || '', req.body.bear_case || '', req.body.references_text || '',
    req.body.holding_disclosure || '', req.body.conflict_disclosure || '',
    basePrice, salePrice, visibility, maxBuyers, studyRoomId, status,
    publishedAt, pdfPath
  );

  // 스터디장 승인 필요 시 스터디장에게 알림
  if (status === 'pending_leader' && studyRoomId) {
    const room = db.prepare('SELECT owner_id, name FROM study_rooms WHERE id = ?').get(studyRoomId);
    if (room) {
      notify(db, room.owner_id, 'report_pending_admin', '리포트 승인 요청', `"${req.body.title}" 리포트가 외부 공개 승인을 요청했습니다.`, `/study/${studyRoomId}`);
    }
  }

  // 리포트 발행 시 팔로워에게 알림
  if (status === 'study_published' || status === 'pending_leader') {
    const followers = db.prepare('SELECT follower_id FROM follows WHERE author_id = ?').all(req.user.id);
    const authorName = req.user.nickname || req.user.name;
    for (const f of followers) {
      notify(db, f.follower_id, 'new_report', `${authorName}님의 새 리포트`, `"${req.body.title}" (${req.body.stock_name}) 리포트가 등록되었습니다.`, `/reports`);
    }
  }

  res.redirect('/author/dashboard');
});

// 리포트 수정 폼
router.get('/reports/:id/edit', isLoggedIn, isAuthor, (req, res) => {
  const report = db.prepare('SELECT * FROM reports WHERE id = ? AND author_id = ?').get(req.params.id, req.user.id);
  if (!report) return res.status(404).send('리포트를 찾을 수 없습니다.');
  if (!['draft', 'rejected', 'pending_leader', 'pending_admin', 'submitted', 'study_published'].includes(report.status)) {
    return res.status(400).send('수정할 수 없는 상태입니다. (판매중/판매중지 상태에서는 수정 불가)');
  }

  const html = render('views/report-write.html', {
    nav: buildNav(req.user),
    mode: 'edit',
    reportId: String(report.id),
    title: escapeHtml(report.title),
    stockName: escapeHtml(report.stock_name),
    stockCode: escapeHtml(report.stock_code || ''),
    marketType: escapeHtml(report.market_type || ''),
    sector: escapeHtml(report.sector || ''),
    summary: escapeHtml(report.summary),
    thesis: escapeHtml(report.thesis || ''),
    investmentPoints: escapeHtml(report.investment_points || ''),
    valuationBasis: escapeHtml(report.valuation_basis || ''),
    risks: escapeHtml(report.risks || ''),
    bearCase: escapeHtml(report.bear_case || ''),
    referencesText: escapeHtml(report.references_text || ''),
    holdingDisclosure: escapeHtml(report.holding_disclosure || ''),
    conflictDisclosure: escapeHtml(report.conflict_disclosure || ''),
    basePrice: String(report.base_price || ''),
    salePrice: String(report.sale_price || ''),
    visibility: report.visibility || 'study_only',
    maxBuyers: String(report.max_buyers || 0),
    studyRoomOptions: getStudyRoomOptions(req.user.id, report.study_room_id),
    myReportOptions: getMyReportOptions(req.user.id),
  });
  res.send(html);
});

// 리포트 수정 저장
router.post('/reports/:id/edit', isLoggedIn, isAuthor, async (req, res) => {
  const report = db.prepare('SELECT * FROM reports WHERE id = ? AND author_id = ?').get(req.params.id, req.user.id);
  if (!report) return res.status(404).send('리포트를 찾을 수 없습니다.');
  if (!['draft', 'rejected', 'pending_leader', 'pending_admin', 'submitted', 'study_published'].includes(report.status)) {
    return res.status(400).send('수정할 수 없는 상태입니다. (판매중/판매중지 상태에서는 수정 불가)');
  }

  const action = req.body.action;
  const visibilityRaw = req.body.visibility || 'study_only';
  const visibility = (visibilityRaw === 'both') ? 'public' : visibilityRaw;

  let status = 'draft';
  if (action === 'submit') {
    if (visibilityRaw === 'study_only') {
      status = 'study_published';
    } else {
      status = 'pending_leader';
    }
  }

  const studyRoomId = parseInt(req.body.study_room_id) || null;
  const salePrice = (visibility === 'public') ? (parseInt(req.body.sale_price) || 0) : 0;
  const maxBuyers = (visibility === 'public') ? (parseInt(req.body.max_buyers) || 0) : 0;

  const publishedAt = (status !== 'draft' && !report.published_at) ? new Date().toISOString() : null;

  // 제출 시 현재 주가를 기준가로 자동 설정
  let basePrice = report.base_price || 0;
  if (status !== 'draft' && !report.published_at) {
    basePrice = await fetchCurrentPrice(req.body.stock_code, req.body.market_type);
  }

  db.prepare(`UPDATE reports SET
    title=?, stock_name=?, stock_code=?, market_type=?, sector=?, summary=?, thesis=?,
    investment_points=?, valuation_basis=?, risks=?, bear_case=?, references_text=?,
    holding_disclosure=?, conflict_disclosure=?, base_price=?, sale_price=?,
    visibility=?, max_buyers=?, study_room_id=?, status=?,
    updated_at=datetime('now'),
    published_at=COALESCE(published_at, ?)
    WHERE id = ? AND author_id = ?`).run(
    req.body.title, req.body.stock_name, req.body.stock_code || '',
    req.body.market_type || '', req.body.sector || '', req.body.summary,
    req.body.thesis || '', req.body.investment_points || '', req.body.valuation_basis || '',
    req.body.risks || '', req.body.bear_case || '', req.body.references_text || '',
    req.body.holding_disclosure || '', req.body.conflict_disclosure || '',
    basePrice, salePrice, visibility, maxBuyers, studyRoomId, status,
    publishedAt,
    req.params.id, req.user.id
  );

  res.redirect('/author/dashboard');
});

// 스터디 공개 → 외부 판매 전환 신청
router.post('/reports/:id/request-public', isLoggedIn, isAuthor, (req, res) => {
  const report = db.prepare('SELECT * FROM reports WHERE id = ? AND author_id = ?').get(req.params.id, req.user.id);
  if (!report) return res.status(404).send('리포트를 찾을 수 없습니다.');
  if (report.status !== 'study_published') {
    return res.status(400).send('스터디 공개 상태의 리포트만 외부 판매로 전환할 수 있습니다.');
  }

  const salePrice = parseInt(req.body.sale_price) || 0;
  const maxBuyers = parseInt(req.body.max_buyers) || 0;

  db.prepare(`UPDATE reports SET
    visibility = 'public', sale_price = ?, max_buyers = ?,
    status = 'pending_leader', updated_at = datetime('now')
    WHERE id = ?`).run(salePrice, maxBuyers, report.id);

  res.redirect('/author/dashboard');
});

// 리포트 삭제 정보 조회 (환불 금액 등)
// 내 리포트 데이터 불러오기 API
router.get('/reports/:id/data', isLoggedIn, isAuthor, (req, res) => {
  const report = db.prepare('SELECT * FROM reports WHERE id = ? AND author_id = ?').get(req.params.id, req.user.id);
  if (!report) return res.json({ error: '리포트를 찾을 수 없습니다.' });
  res.json({
    ok: true,
    parsed: {
      stockName: report.stock_name || '',
      stockCode: report.stock_code || '',
      title: report.title || '',
      summary: report.summary || '',
      thesis: report.thesis || '',
      investmentPoints: report.investment_points || '',
      valuationBasis: report.valuation_basis || '',
      risks: report.risks || '',
      bearCase: report.bear_case || '',
      references: report.references_text || '',
    },
    meta: {
      marketType: report.market_type || '',
      sector: report.sector || '',
    }
  });
});

router.get('/reports/:id/delete-info', isLoggedIn, isAuthor, (req, res) => {
  const report = db.prepare('SELECT * FROM reports WHERE id = ? AND author_id = ?').get(req.params.id, req.user.id);
  if (!report) return res.json({ error: '리포트를 찾을 수 없습니다.' });

  // 구매자 목록과 환불 금액 조회
  const orders = db.prepare('SELECT user_id, amount FROM orders WHERE report_id = ?').all(report.id);
  const totalRefund = orders.reduce((sum, o) => sum + o.amount, 0);
  const myPoints = db.prepare('SELECT points FROM users WHERE id = ?').get(req.user.id);

  res.json({
    buyerCount: orders.length,
    totalRefund,
    myPoints: myPoints ? myPoints.points : 0,
  });
});

// 리포트 삭제 (환불 처리 포함)
router.post('/reports/:id/delete', isLoggedIn, isAuthor, (req, res) => {
  const report = db.prepare('SELECT * FROM reports WHERE id = ? AND author_id = ?').get(req.params.id, req.user.id);
  if (!report) return res.json({ ok: false, error: '리포트를 찾을 수 없습니다.' });

  const orders = db.prepare('SELECT user_id, amount FROM orders WHERE report_id = ?').all(report.id);
  const totalRefund = orders.reduce((sum, o) => sum + o.amount, 0);

  // 포인트 체크
  const author = db.prepare('SELECT points FROM users WHERE id = ?').get(req.user.id);
  if (totalRefund > 0 && (!author || author.points < totalRefund)) {
    return res.json({ ok: false, error: `포인트가 부족합니다. (필요: ${totalRefund.toLocaleString()}P, 보유: ${(author?.points || 0).toLocaleString()}P)` });
  }

  // 트랜잭션으로 환불 + 삭제 처리
  const deleteTransaction = db.transaction(() => {
    // 1. 구매자들에게 환불
    for (const order of orders) {
      if (order.amount > 0) {
        db.prepare('UPDATE users SET points = points + ? WHERE id = ?').run(order.amount, order.user_id);
        db.prepare("INSERT INTO point_logs (user_id, amount, type, description, related_report_id) VALUES (?, ?, 'refund', ?, ?)").run(
          order.user_id, order.amount, `리포트 삭제 환불: ${report.title}`, report.id
        );
      }
    }

    // 2. 작성자 포인트 차감
    if (totalRefund > 0) {
      db.prepare('UPDATE users SET points = points - ? WHERE id = ?').run(totalRefund, req.user.id);
      db.prepare("INSERT INTO point_logs (user_id, amount, type, description, related_report_id) VALUES (?, ?, 'refund_deduct', ?, ?)").run(
        req.user.id, -totalRefund, `리포트 삭제 환불 차감 (${orders.length}명): ${report.title}`, report.id
      );
    }

    // 3. 관련 데이터 삭제
    db.prepare('DELETE FROM orders WHERE report_id = ?').run(report.id);
    db.prepare('DELETE FROM view_logs WHERE report_id = ?').run(report.id);
    db.prepare('DELETE FROM report_ratings WHERE report_id = ?').run(report.id);
    db.prepare('DELETE FROM report_review_logs WHERE report_id = ?').run(report.id);
    db.prepare('DELETE FROM report_flags WHERE report_id = ?').run(report.id);

    // 4. 알림
    for (const order of orders) {
      notify(db, order.user_id, 'points', '리포트 구매 환불', `"${report.title}" 리포트가 삭제되어 ${order.amount.toLocaleString()}P가 환불되었습니다.`, '/my/points');
    }

    // 5. 리포트 삭제
    db.prepare('DELETE FROM reports WHERE id = ?').run(report.id);
  });

  deleteTransaction();
  res.json({ ok: true });
});

module.exports = router;
