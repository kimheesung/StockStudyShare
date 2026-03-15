const express = require('express');
const db = require('../lib/db');
const { isLoggedIn, buildNav, render, escapeHtml } = require('../lib/helpers');
const router = express.Router();

const DART_API_KEY = process.env.DART_API_KEY || '';
const DART_BASE = 'https://opendart.fss.or.kr/api';

// 주가 영향 공시 키워드
const IMPORTANT_KEYWORDS = [
  // 전환사채
  '전환사채', 'CB발행', '전환사채권발행',
  // 유상증자
  '유상증자', '제3자배정', '3자배정', '주주배정',
  // 매출 변동
  '매출액', '영업이익', '당기순이익', '매출액또는손익',
  // 대규모 투자
  '타법인주식및출자증권취득', '신규시설투자', '타법인주식',
  '단일판매', '단일공급', '대규모',
  // 기타 중요
  '최대주주변경', '자기주식', '무상증자', '주식분할',
  '합병', '분할', '영업양수', '영업양도',
  '상장폐지', '관리종목',
];

// DART 공시 캐시 (메모리)
let cachedDisclosures = [];
let lastFetchTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5분

async function fetchImportantDisclosures() {
  if (!DART_API_KEY) return [];
  if (Date.now() - lastFetchTime < CACHE_TTL && cachedDisclosures.length > 0) {
    return cachedDisclosures;
  }

  try {
    // 최근 3일간 공시 조회
    const today = new Date();
    const threeDaysAgo = new Date(today);
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

    const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '');
    const url = `${DART_BASE}/list.json?crtfc_key=${DART_API_KEY}&bgn_de=${fmt(threeDaysAgo)}&end_de=${fmt(today)}&page_no=1&page_count=100`;

    const resp = await fetch(url);
    const data = await resp.json();

    if (data.status !== '000' || !data.list) return cachedDisclosures;

    // 키워드 필터링
    const filtered = data.list.filter(item => {
      const title = item.report_nm || '';
      return IMPORTANT_KEYWORDS.some(kw => title.includes(kw));
    });

    // 카테고리 분류
    cachedDisclosures = filtered.map(item => {
      const title = item.report_nm.trim();
      let category = '기타';
      let impact = 'neutral'; // positive, negative, neutral

      if (title.includes('전환사채') || title.includes('CB')) {
        category = '전환사채(CB)';
        impact = 'negative';
      } else if (title.includes('3자배정') || title.includes('제3자배정')) {
        category = '3자배정 유증';
        impact = 'positive';
      } else if (title.includes('유상증자') || title.includes('주주배정')) {
        category = '유상증자';
        impact = 'negative';
      } else if (title.includes('매출액') || title.includes('영업이익') || title.includes('당기순이익')) {
        category = '실적 변동';
        impact = title.includes('감소') ? 'negative' : title.includes('증가') ? 'positive' : 'neutral';
      } else if (title.includes('타법인주식') || title.includes('신규시설투자') || title.includes('대규모')) {
        category = '대규모 투자';
        impact = 'positive';
      } else if (title.includes('자기주식')) {
        category = '자사주';
        impact = title.includes('취득') ? 'positive' : 'neutral';
      } else if (title.includes('최대주주변경')) {
        category = '최대주주 변경';
        impact = 'neutral';
      } else if (title.includes('합병') || title.includes('분할')) {
        category = 'M&A/분할';
        impact = 'neutral';
      } else if (title.includes('무상증자') || title.includes('주식분할')) {
        category = '무상증자/분할';
        impact = 'positive';
      }

      const marketMap = { Y: 'KOSPI', K: 'KOSDAQ', N: '코넥스', E: '기타' };

      return {
        corpName: item.corp_name,
        stockCode: item.stock_code || '',
        market: marketMap[item.corp_cls] || '',
        title,
        category,
        impact,
        date: item.rcept_dt,
        rceptNo: item.rcept_no,
        dartUrl: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${item.rcept_no}`,
      };
    });

    lastFetchTime = Date.now();
    return cachedDisclosures;
  } catch (e) {
    console.error('DART fetch error:', e.message);
    return cachedDisclosures;
  }
}

// 주요 공시 페이지
router.get('/', isLoggedIn, async (req, res) => {
  const disclosures = await fetchImportantDisclosures();
  const filterCat = req.query.category || '';

  const filtered = filterCat
    ? disclosures.filter(d => d.category === filterCat)
    : disclosures;

  // 카테고리별 개수
  const catCounts = {};
  disclosures.forEach(d => { catCounts[d.category] = (catCounts[d.category] || 0) + 1; });

  const catTabs = Object.entries(catCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([cat, cnt]) => `<a href="/dart?category=${encodeURIComponent(cat)}" class="cat-tab ${filterCat === cat ? 'active' : ''}">${escapeHtml(cat)} <span>${cnt}</span></a>`)
    .join('');

  const impactIcon = { positive: '🟢', negative: '🔴', neutral: '🟡' };
  const impactLabel = { positive: '호재', negative: '악재', neutral: '중립' };

  const rows = filtered.length > 0 ? filtered.map(d => `
    <a href="${escapeHtml(d.dartUrl)}" target="_blank" class="disc-row ${d.impact}">
      <div class="disc-signal"><div class="signal-light ${d.impact}"></div></div>
      <div class="disc-main">
        <div class="disc-header">
          <span class="disc-corp">${escapeHtml(d.corpName)}</span>
          <span class="disc-code">${escapeHtml(d.stockCode)}</span>
          <span class="disc-market">${escapeHtml(d.market)}</span>
        </div>
        <div class="disc-title">${escapeHtml(d.title)}</div>
        <div class="disc-meta">
          <span class="disc-cat">${escapeHtml(d.category)}</span>
          <span class="disc-impact-label ${d.impact}">${impactLabel[d.impact] || ''}</span>
          <span class="disc-date">${d.date ? d.date.slice(0, 4) + '.' + d.date.slice(4, 6) + '.' + d.date.slice(6) : ''}</span>
        </div>
      </div>
      <div class="disc-arrow">→</div>
    </a>
  `).join('') : '<div class="empty-text">조회된 주요 공시가 없습니다.</div>';

  const html = `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
    <title>주요 공시 - StockStudyShare</title>
    <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;700;900&display=swap" rel="stylesheet">
    <style>
      *{margin:0;padding:0;box-sizing:border-box}
      body{font-family:'Noto Sans KR',sans-serif;background:linear-gradient(135deg,#0f0c29,#302b63,#24243e);color:#fff;min-height:100vh}
      .container{max-width:900px;margin:0 auto;padding:40px 20px}
      h1{font-size:1.6rem;font-weight:900;margin-bottom:8px}
      h1 .highlight{background:linear-gradient(135deg,#ef4444,#f59e0b);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
      .sub-text{color:rgba(255,255,255,0.4);font-size:0.88rem;margin-bottom:24px}
      .cat-bar{display:flex;gap:8px;margin-bottom:20px;flex-wrap:wrap}
      .cat-tab{padding:8px 16px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:50px;color:rgba(255,255,255,0.5);text-decoration:none;font-size:0.8rem;font-weight:600;transition:all 0.2s}
      .cat-tab:hover{background:rgba(255,255,255,0.08);color:#fff}
      .cat-tab.active{background:rgba(79,70,229,0.2);border-color:rgba(79,70,229,0.4);color:#a5b4fc}
      .cat-tab span{font-weight:900;margin-left:4px}
      .all-tab{padding:8px 16px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:50px;color:rgba(255,255,255,0.5);text-decoration:none;font-size:0.8rem;font-weight:600}
      .count{font-size:0.85rem;color:rgba(255,255,255,0.3);margin-bottom:16px}
      .disc-row{display:flex;align-items:center;gap:14px;padding:16px 20px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:14px;margin-bottom:8px;text-decoration:none;color:#fff;transition:all 0.2s}
      .disc-row:hover{background:rgba(255,255,255,0.06);border-color:rgba(79,70,229,0.2)}
      .disc-row.positive{border-left:3px solid #4ade80}
      .disc-row.negative{border-left:3px solid #ef4444}
      .disc-row.neutral{border-left:3px solid #fbbf24}
      .disc-signal{width:36px;height:36px;border-radius:50%;background:rgba(255,255,255,0.04);display:flex;align-items:center;justify-content:center;flex-shrink:0}
      .signal-light{width:18px;height:18px;border-radius:50%;box-shadow:0 0 8px currentColor}
      .signal-light.positive{background:#4ade80;color:#4ade80;box-shadow:0 0 12px rgba(74,222,128,0.6)}
      .signal-light.negative{background:#ef4444;color:#ef4444;box-shadow:0 0 12px rgba(239,68,68,0.6)}
      .signal-light.neutral{background:#fbbf24;color:#fbbf24;box-shadow:0 0 12px rgba(251,191,36,0.6)}
      .disc-main{flex:1;min-width:0}
      .disc-header{display:flex;align-items:center;gap:8px;margin-bottom:4px}
      .disc-corp{font-weight:900;font-size:0.95rem}
      .disc-code{font-size:0.75rem;color:rgba(255,255,255,0.3);background:rgba(255,255,255,0.06);padding:2px 8px;border-radius:6px}
      .disc-market{font-size:0.7rem;color:#67e8f9}
      .disc-title{font-size:0.88rem;color:rgba(255,255,255,0.6);margin-bottom:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .disc-meta{display:flex;gap:10px;font-size:0.75rem}
      .disc-cat{padding:2px 8px;background:rgba(79,70,229,0.15);color:#a5b4fc;border-radius:8px;font-weight:700}
      .disc-impact-label{font-weight:700}
      .disc-impact-label.positive{color:#4ade80}
      .disc-impact-label.negative{color:#ef4444}
      .disc-impact-label.neutral{color:#fbbf24}
      .disc-date{color:rgba(255,255,255,0.25)}
      .disc-arrow{color:rgba(255,255,255,0.15);font-size:1.2rem;flex-shrink:0}
      .empty-text{color:rgba(255,255,255,0.25);text-align:center;padding:40px;font-size:0.9rem}
    </style></head><body>
    <nav>${buildNav(req.user)}</nav>
    <div class="container">
      <h1>📢 <span class="highlight">주요 공시</span></h1>
      <p class="sub-text">전환사채, 유상증자, 실적 변동, 대규모 투자 등 주가에 영향을 주는 공시만 필터링합니다.</p>

      <div class="cat-bar">
        <a href="/dart" class="all-tab ${!filterCat ? 'cat-tab active' : ''}">전체 <span>${disclosures.length}</span></a>
        ${catTabs}
      </div>

      <p class="count">${filtered.length}건</p>
      ${rows}
    </div></body></html>`;
  res.send(html);
});

// API: 주요 공시 JSON (대시보드용)
router.get('/api/important', async (req, res) => {
  const disclosures = await fetchImportantDisclosures();
  res.json({ count: disclosures.length, items: disclosures.slice(0, 20) });
});

module.exports = router;
