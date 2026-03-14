const express = require('express');
const path = require('path');
const db = require('../lib/db');
const { render, buildNav, escapeHtml } = require('../lib/helpers');
const router = express.Router();

// 시장 데이터 캐시 (5분)
let marketCache = { data: null, ts: 0 };
let investorCache = { data: null, ts: 0 };
let creditCache = { data: null, ts: 0 };
let topGainersCache = { data: null, ts: 0 };
const CACHE_TTL = 5 * 60 * 1000;

const SYMBOLS = [
  { symbol: '^KS11', name: 'KOSPI', category: '국내' },
  { symbol: '^KQ11', name: 'KOSDAQ', category: '국내' },
  { symbol: '^GSPC', name: 'S&P 500', category: '미국' },
  { symbol: '^IXIC', name: 'NASDAQ', category: '미국' },
  { symbol: '^DJI', name: 'Dow Jones', category: '미국' },
  { symbol: 'KRW=X', name: 'USD/KRW', category: '환율' },
  { symbol: 'JPY=X', name: 'USD/JPY', category: '환율' },
  { symbol: 'GC=F', name: 'Gold', category: '원자재' },
  { symbol: 'CL=F', name: 'WTI Oil', category: '원자재' },
  { symbol: 'BTC-USD', name: 'Bitcoin', category: '암호화폐' },
];

async function fetchMarketData() {
  const now = Date.now();
  if (marketCache.data && (now - marketCache.ts) < CACHE_TTL) {
    return marketCache.data;
  }

  try {
    const results = await Promise.all(SYMBOLS.map(async (s) => {
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s.symbol)}?interval=1d&range=1d`;
        const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const json = await resp.json();
        const meta = json.chart?.result?.[0]?.meta;
        if (!meta) return { ...s, price: null, change: null, changePercent: null };
        const price = meta.regularMarketPrice;
        const prevClose = meta.chartPreviousClose || meta.previousClose;
        const change = prevClose ? price - prevClose : 0;
        const changePercent = prevClose ? (change / prevClose) * 100 : 0;
        return { ...s, price, change, changePercent, prevClose };
      } catch { return { ...s, price: null, change: null, changePercent: null }; }
    }));

    marketCache = { data: results, ts: now };
    return results;
  } catch (e) {
    console.error('Market data fetch error:', e.message);
    return marketCache.data || SYMBOLS.map(s => ({ ...s, price: null, change: null, changePercent: null }));
  }
}

// 투자자별 매매동향 (네이버 금융 스크래핑)
async function fetchInvestorData() {
  const now = Date.now();
  if (investorCache.data && (now - investorCache.ts) < CACHE_TTL) {
    return investorCache.data;
  }

  try {
    const resp = await fetch('https://finance.naver.com/sise/investorDealTrendDay.naver', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
    });
    const html = await resp.text();

    // 테이블에서 최근 거래일 데이터 파싱
    const rows = [];
    // 각 투자자 유형별 순매수 금액 추출 (억원)
    // HTML 테이블 구조: 날짜, 개인, 외국인, 기관...
    const tableMatch = html.match(/<table[^>]*class="type2"[^>]*>([\s\S]*?)<\/table>/);
    if (tableMatch) {
      const trMatches = tableMatch[1].match(/<tr[^>]*>([\s\S]*?)<\/tr>/g) || [];
      for (const tr of trMatches) {
        const tds = tr.match(/<td[^>]*>([\s\S]*?)<\/td>/g);
        if (!tds || tds.length < 6) continue;
        const clean = (s) => s.replace(/<[^>]*>/g, '').replace(/,/g, '').trim();
        const date = clean(tds[0]);
        if (!/\d{4}\.\d{2}\.\d{2}/.test(date) && !/\d{2}\.\d{2}/.test(date)) continue;
        const individual = clean(tds[1]);
        const foreign = clean(tds[2]);
        const institutional = clean(tds[3]);
        if (!individual || individual === '') continue;
        rows.push({
          date,
          individual: parseInt(individual) || 0,
          foreign: parseInt(foreign) || 0,
          institutional: parseInt(institutional) || 0,
        });
        if (rows.length >= 5) break;
      }
    }

    const result = rows.length > 0 ? rows : null;
    investorCache = { data: result, ts: now };
    return result;
  } catch (e) {
    console.error('Investor data fetch error:', e.message);
    return investorCache.data || null;
  }
}

// 신용잔고 데이터 (네이버 금융)
async function fetchCreditData() {
  const now = Date.now();
  if (creditCache.data && (now - creditCache.ts) < CACHE_TTL) {
    return creditCache.data;
  }

  try {
    const resp = await fetch('https://finance.naver.com/sise/sise_credit.naver', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
    });
    const html = await resp.text();

    const rows = [];
    const tableMatch = html.match(/<table[^>]*class="type2"[^>]*>([\s\S]*?)<\/table>/);
    if (tableMatch) {
      const trMatches = tableMatch[1].match(/<tr[^>]*>([\s\S]*?)<\/tr>/g) || [];
      for (const tr of trMatches) {
        const tds = tr.match(/<td[^>]*>([\s\S]*?)<\/td>/g);
        if (!tds || tds.length < 5) continue;
        const clean = (s) => s.replace(/<[^>]*>/g, '').replace(/,/g, '').trim();
        const date = clean(tds[0]);
        if (!/\d{4}\.\d{2}\.\d{2}/.test(date) && !/\d{2}\.\d{2}/.test(date)) continue;
        const newCredit = clean(tds[1]);
        const repayment = clean(tds[2]);
        const balance = clean(tds[3]);
        if (!balance || balance === '') continue;
        rows.push({
          date,
          newCredit: parseInt(newCredit) || 0,
          repayment: parseInt(repayment) || 0,
          balance: parseInt(balance) || 0,
        });
        if (rows.length >= 5) break;
      }
    }

    const result = rows.length > 0 ? rows : null;
    creditCache = { data: result, ts: now };
    return result;
  } catch (e) {
    console.error('Credit data fetch error:', e.message);
    return creditCache.data || null;
  }
}

// 지난주 리포트 상승률 순위
async function fetchTopGainers() {
  const now = Date.now();
  if (topGainersCache.data && (now - topGainersCache.ts) < CACHE_TTL) {
    return topGainersCache.data;
  }

  try {
    // 지난주 월~일 범위 계산
    const today = new Date();
    const dayOfWeek = today.getDay(); // 0=일, 1=월, ...
    const lastSunday = new Date(today);
    lastSunday.setDate(today.getDate() - dayOfWeek);
    lastSunday.setHours(23, 59, 59, 999);
    const lastMonday = new Date(lastSunday);
    lastMonday.setDate(lastSunday.getDate() - 6);
    lastMonday.setHours(0, 0, 0, 0);

    // 지난주에 발행되었거나 on_sale 상태인 리포트 중 stock_code와 base_price가 있는 것
    const reports = db.prepare(`
      SELECT r.id, r.title, r.stock_name, r.stock_code, r.market_type, r.base_price, r.sector,
             r.sale_price, r.published_at,
             COALESCE(ap.display_name, u.name) as author_name
      FROM reports r
      JOIN users u ON r.author_id = u.id
      LEFT JOIN author_profiles ap ON r.author_id = ap.user_id
      WHERE r.status = 'on_sale'
        AND r.stock_code IS NOT NULL AND r.stock_code != ''
        AND r.base_price IS NOT NULL AND r.base_price > 0
        AND r.published_at >= ? AND r.published_at <= ?
      ORDER BY r.published_at DESC
      LIMIT 20
    `).all(lastMonday.toISOString(), lastSunday.toISOString());

    if (reports.length === 0) {
      // 지난주 리포트가 없으면 최근 리포트로 대체
      const fallbackReports = db.prepare(`
        SELECT r.id, r.title, r.stock_name, r.stock_code, r.market_type, r.base_price, r.sector,
               r.sale_price, r.published_at,
               COALESCE(ap.display_name, u.name) as author_name
        FROM reports r
        JOIN users u ON r.author_id = u.id
        LEFT JOIN author_profiles ap ON r.author_id = ap.user_id
        WHERE r.status = 'on_sale'
          AND r.stock_code IS NOT NULL AND r.stock_code != ''
          AND r.base_price IS NOT NULL AND r.base_price > 0
        ORDER BY r.published_at DESC
        LIMIT 20
      `).all();
      if (fallbackReports.length === 0) {
        topGainersCache = { data: [], ts: now };
        return [];
      }
      reports.push(...fallbackReports);
    }

    // Yahoo Finance 심볼 변환 (한국 주식)
    const symbolMap = {};
    for (const r of reports) {
      const code = r.stock_code.replace(/[^0-9A-Za-z]/g, '');
      let symbol;
      if (/^\d{6}$/.test(code)) {
        symbol = r.market_type === 'KOSDAQ' ? `${code}.KQ` : `${code}.KS`;
      } else {
        symbol = code;
      }
      symbolMap[r.id] = symbol;
    }

    const uniqueSymbols = [...new Set(Object.values(symbolMap))];
    const priceMap = {};
    await Promise.all(uniqueSymbols.map(async (sym) => {
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1d`;
        const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const json = await resp.json();
        const price = json.chart?.result?.[0]?.meta?.regularMarketPrice;
        if (price) priceMap[sym] = price;
      } catch {}
    }));

    // 상승률 계산
    const gainers = [];
    for (const r of reports) {
      const symbol = symbolMap[r.id];
      const currentPrice = priceMap[symbol];
      if (!currentPrice) continue;
      const changeRate = ((currentPrice - r.base_price) / r.base_price) * 100;
      gainers.push({ ...r, currentPrice, changeRate });
    }

    // 상승률 높은 순으로 정렬
    gainers.sort((a, b) => b.changeRate - a.changeRate);
    const top = gainers.slice(0, 5);

    topGainersCache = { data: top, ts: now };
    return top;
  } catch (e) {
    console.error('Top gainers fetch error:', e.message);
    return topGainersCache.data || [];
  }
}

router.get('/', (req, res) => {
  if (req.isAuthenticated()) {
    return res.redirect('/dashboard');
  }
  res.sendFile(path.join(__dirname, '..', 'views', 'home.html'));
});

router.get('/dashboard', async (req, res) => {
  if (!req.isAuthenticated()) return res.redirect('/');

  const [marketData, investorData, creditData, topGainers] = await Promise.all([
    fetchMarketData(),
    fetchInvestorData(),
    fetchCreditData(),
    fetchTopGainers(),
  ]);

  const cards = marketData.map(m => {
    if (m.price === null) {
      return `<div class="market-card">
        <div class="market-name">${m.name}</div>
        <div class="market-category">${m.category}</div>
        <div class="market-price">--</div>
      </div>`;
    }

    const isUp = m.change >= 0;
    const sign = isUp ? '+' : '';
    const cls = isUp ? 'up' : 'down';
    const priceStr = m.price >= 1000 ? m.price.toLocaleString(undefined, { maximumFractionDigits: 2 }) : m.price.toFixed(2);
    const changeStr = `${sign}${m.change.toFixed(2)}`;
    const pctStr = `${sign}${m.changePercent.toFixed(2)}%`;

    return `<div class="market-card">
      <div class="market-header">
        <div class="market-name">${m.name}</div>
        <div class="market-category">${m.category}</div>
      </div>
      <div class="market-price">${priceStr}</div>
      <div class="market-change ${cls}">
        <span class="change-arrow">${isUp ? '&#9650;' : '&#9660;'}</span>
        ${changeStr} (${pctStr})
      </div>
    </div>`;
  }).join('');

  // 투자자별 매매동향 테이블
  let investorRows = '';
  if (investorData && investorData.length > 0) {
    investorRows = investorData.map(r => {
      const fmtNum = (n) => {
        const cls = n > 0 ? 'up' : n < 0 ? 'down' : '';
        const sign = n > 0 ? '+' : '';
        return `<span class="investor-val ${cls}">${sign}${n.toLocaleString()}</span>`;
      };
      return `<tr>
        <td>${r.date}</td>
        <td>${fmtNum(r.individual)}</td>
        <td>${fmtNum(r.foreign)}</td>
        <td>${fmtNum(r.institutional)}</td>
      </tr>`;
    }).join('');
  } else {
    investorRows = '<tr><td colspan="4" style="text-align:center;color:rgba(255,255,255,0.3);padding:20px">데이터를 불러오는 중...</td></tr>';
  }

  // 신용잔고 테이블
  let creditRows = '';
  if (creditData && creditData.length > 0) {
    creditRows = creditData.map(r => {
      return `<tr>
        <td>${r.date}</td>
        <td>${r.newCredit.toLocaleString()}</td>
        <td>${r.repayment.toLocaleString()}</td>
        <td>${r.balance.toLocaleString()}</td>
      </tr>`;
    }).join('');
  } else {
    creditRows = '<tr><td colspan="4" style="text-align:center;color:rgba(255,255,255,0.3);padding:20px">데이터를 불러오는 중...</td></tr>';
  }

  // 최신 리포트 (on_sale 상태, 최신순 6개)
  const latestReports = db.prepare(`
    SELECT r.id, r.title, r.stock_name, r.sector, r.sale_price, r.published_at,
           COALESCE(ap.display_name, u.name) as author_name, r.author_id,
           (SELECT COUNT(*) FROM orders WHERE report_id = r.id) as purchase_count
    FROM reports r
    JOIN users u ON r.author_id = u.id
    LEFT JOIN author_profiles ap ON r.author_id = ap.user_id
    WHERE r.status = 'on_sale'
    ORDER BY r.published_at DESC
    LIMIT 6
  `).all();

  // 핫한 리포트 (최근 2주간 조회수 기준, 6개)
  const twoWeeksAgo = new Date();
  twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
  const hotReports = db.prepare(`
    SELECT r.id, r.title, r.stock_name, r.sector, r.sale_price, r.published_at,
           COALESCE(ap.display_name, u.name) as author_name, r.author_id,
           (SELECT COUNT(*) FROM orders WHERE report_id = r.id) as purchase_count,
           (SELECT COUNT(*) FROM view_logs WHERE report_id = r.id AND created_at >= ?) as view_count
    FROM reports r
    JOIN users u ON r.author_id = u.id
    LEFT JOIN author_profiles ap ON r.author_id = ap.user_id
    WHERE r.status = 'on_sale'
    ORDER BY view_count DESC, r.published_at DESC
    LIMIT 6
  `).all(twoWeeksAgo.toISOString());

  // 3개월 수익률 최고 리포트
  const threeMonthsAgo = new Date();
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
  const topReturnReports = db.prepare(`
    SELECT r.id, r.title, r.stock_name, r.sector, r.sale_price, r.published_at,
           COALESCE(ap.display_name, u.name) as author_name, r.author_id,
           (SELECT COUNT(*) FROM orders WHERE report_id = r.id) as purchase_count,
           r.entry_price, r.stock_code, r.market_type
    FROM reports r
    JOIN users u ON r.author_id = u.id
    LEFT JOIN author_profiles ap ON r.author_id = ap.user_id
    WHERE r.status = 'on_sale'
      AND r.entry_price IS NOT NULL AND r.entry_price > 0
      AND r.published_at <= ?
    ORDER BY r.published_at ASC
    LIMIT 30
  `).all(threeMonthsAgo.toISOString());

  // 팔로우한 작성자의 리포트
  const followReports = db.prepare(`
    SELECT r.id, r.title, r.stock_name, r.sector, r.sale_price, r.published_at,
           COALESCE(ap.display_name, u.name) as author_name, r.author_id,
           (SELECT COUNT(*) FROM orders WHERE report_id = r.id) as purchase_count
    FROM reports r
    JOIN users u ON r.author_id = u.id
    LEFT JOIN author_profiles ap ON r.author_id = ap.user_id
    JOIN follows f ON f.author_id = r.author_id AND f.follower_id = ?
    WHERE r.status = 'on_sale'
    ORDER BY r.published_at DESC
    LIMIT 6
  `).all(req.user.id);

  function buildReportCards(reports, extraFn) {
    if (reports.length === 0) {
      return '<div class="report-empty">표시할 리포트가 없습니다.</div>';
    }
    return reports.map(r => {
      const price = r.sale_price === 0 ? '무료' : `${r.sale_price.toLocaleString()}P`;
      const date = r.published_at ? new Date(r.published_at).toLocaleDateString('ko-KR') : '';
      const extra = extraFn ? extraFn(r) : `${r.purchase_count}명 구매`;
      return `<a href="/reports/${r.id}" class="report-card">
        <div class="report-card-top">
          <span class="report-sector">${escapeHtml(r.sector || '기타')}</span>
          <span class="report-price">${price}</span>
        </div>
        <h4 class="report-title">${escapeHtml(r.title)}</h4>
        <div class="report-stock">${escapeHtml(r.stock_name)}</div>
        <div class="report-meta">
          <span>${escapeHtml(r.author_name)}</span>
          <span>${date}</span>
        </div>
        <div class="report-purchases">${extra}</div>
      </a>`;
    }).join('');
  }

  const latestCards = buildReportCards(latestReports);
  const hotCards = buildReportCards(hotReports, r => `${r.view_count || 0}회 조회 · ${r.purchase_count}명 구매`);

  // 3개월 수익률 카드: entry_price 대비 현재가는 클라이언트에서 로드하므로 entry_price 기반으로 표시
  const topReturnCards = buildReportCards(topReturnReports, r => {
    return `<span style="font-size:0.72rem;color:rgba(255,255,255,0.3)">발행가 ${Math.round(r.entry_price).toLocaleString()}원</span>`;
  });

  const followCards = buildReportCards(followReports);

  // 상승률 순위 HTML
  let topGainersHtml = '';
  if (topGainers && topGainers.length > 0) {
    topGainersHtml = topGainers.map((r, i) => {
      const rank = i + 1;
      const isUp = r.changeRate >= 0;
      const sign = isUp ? '+' : '';
      const cls = isUp ? 'up' : 'down';
      const arrow = isUp ? '&#9650;' : '&#9660;';
      const price = r.sale_price === 0 ? '무료' : `${r.sale_price.toLocaleString()}P`;
      return `<a href="/reports/${r.id}" class="gainer-row">
        <div class="gainer-rank rank-${rank}">${rank}</div>
        <div class="gainer-info">
          <div class="gainer-title">${escapeHtml(r.title)}</div>
          <div class="gainer-stock">${escapeHtml(r.stock_name)} (${escapeHtml(r.stock_code)})</div>
          <div class="gainer-author">${escapeHtml(r.author_name)} · ${price}</div>
        </div>
        <div class="gainer-price-area">
          <div class="gainer-current">${r.currentPrice.toLocaleString()}원</div>
          <div class="gainer-base">기준가 ${r.base_price.toLocaleString()}원</div>
          <div class="gainer-change ${cls}"><span class="change-arrow">${arrow}</span> ${sign}${r.changeRate.toFixed(2)}%</div>
        </div>
      </a>`;
    }).join('');
  } else {
    topGainersHtml = '<div class="report-empty">표시할 데이터가 없습니다.</div>';
  }

  const html = render('views/dashboard.html', {
    nav: buildNav(req.user),
    marketCards: cards,
    investorRows,
    creditRows,
    latestCards,
    hotCards,
    topReturnCards,
    followCards,
    topGainersHtml,
    updatedAt: new Date().toLocaleString('ko-KR'),
  });
  res.send(html);
});

// 시장 데이터 API (자동 새로고침용)
router.get('/api/market', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'unauthorized' });
  const [data, investor, credit] = await Promise.all([
    fetchMarketData(),
    fetchInvestorData(),
    fetchCreditData(),
  ]);
  res.json({ data, investor, credit, updatedAt: new Date().toISOString() });
});

// 팔로우/언팔로우 API
router.post('/api/follow/:authorId', (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'unauthorized' });
  if (req.params.authorId === req.user.id) return res.status(400).json({ error: 'cannot follow yourself' });
  try {
    db.prepare('INSERT OR IGNORE INTO follows (follower_id, author_id) VALUES (?, ?)').run(req.user.id, req.params.authorId);
    res.json({ ok: true, followed: true });
  } catch (e) {
    res.status(500).json({ error: 'failed' });
  }
});

router.post('/api/unfollow/:authorId', (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'unauthorized' });
  db.prepare('DELETE FROM follows WHERE follower_id = ? AND author_id = ?').run(req.user.id, req.params.authorId);
  res.json({ ok: true, followed: false });
});

// 종목 검색 API (KRX 데이터)
let stockListCache = { data: null, ts: 0 };
const STOCK_CACHE_TTL = 24 * 60 * 60 * 1000; // 24시간

// KRX 업종 → 앱 섹터 매핑
function mapSector(industry) {
  if (!industry) return '기타';
  const s = industry;
  if (/반도체|전자부품|컴퓨터|소프트웨어|통신|전기장비|디스플레이/.test(s)) return 'IT/반도체';
  if (/의약|의료|바이오|제약/.test(s)) return '바이오/헬스케어';
  if (/은행|금융|보험|증권|저축/.test(s)) return '금융';
  if (/식품|음료|의복|섬유|소매|도매|유통|숙박|오락|방송|게임|교육/.test(s)) return '소비재';
  if (/화학|석유|가스|금속|광물|에너지|전기|비금속/.test(s)) return '에너지/소재';
  if (/기계|자동차|운수|건설|조선|항공|철도|건축/.test(s)) return '산업재';
  return '기타';
}

async function fetchStockList() {
  const now = Date.now();
  if (stockListCache.data && (now - stockListCache.ts) < STOCK_CACHE_TTL) {
    return stockListCache.data;
  }

  try {
    const resp = await fetch('https://kind.krx.co.kr/corpgeneral/corpList.do?method=download', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        'Referer': 'https://kind.krx.co.kr/corpgeneral/corpList.do?method=loadInitPage',
      },
    });
    const buf = Buffer.from(await resp.arrayBuffer());
    // EUC-KR → UTF-8 변환
    const { TextDecoder } = require('util');
    let html;
    try {
      html = new TextDecoder('euc-kr').decode(buf);
    } catch {
      html = buf.toString('utf8');
    }

    const rows = html.match(/<tr>([\s\S]*?)<\/tr>/g) || [];
    const stocks = [];
    for (let i = 1; i < rows.length; i++) {
      const tds = (rows[i].match(/<td[^>]*>([\s\S]*?)<\/td>/g) || [])
        .map(t => t.replace(/<[^>]*>/g, '').trim());
      if (tds.length < 4) continue;
      const name = tds[0];
      const marketRaw = tds[1];
      const code = tds[2];
      const industry = tds[3];
      if (!name || !code) continue;
      stocks.push({
        name,
        code,
        market: marketRaw === '코스닥' ? 'KOSDAQ' : 'KOSPI',
        sector: mapSector(industry),
        industry,
      });
    }

    stockListCache = { data: stocks, ts: now };
    console.log(`KRX stock list loaded: ${stocks.length} stocks`);
    return stocks;
  } catch (e) {
    console.error('KRX stock list fetch error:', e.message);
    return stockListCache.data || [];
  }
}

// 서버 시작 시 미리 로드
fetchStockList();

router.get('/api/stock-search', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'unauthorized' });
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);

  const stocks = await fetchStockList();
  const results = stocks
    .filter(s => s.name.includes(q) || s.code.includes(q))
    .slice(0, 10);
  res.json(results);
});

// 리포트 수익률 API
router.get('/api/report-performance/:id', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'unauthorized' });

  const report = db.prepare(`
    SELECT id, stock_code, market_type, published_at, entry_price
    FROM reports WHERE id = ?
  `).get(req.params.id);

  if (!report || !report.stock_code || !report.published_at) {
    return res.json({ error: 'no_data', message: '수익률 데이터를 계산할 수 없습니다.' });
  }

  const code = report.stock_code.replace(/[^0-9A-Za-z]/g, '');
  let symbol;
  if (/^\d{6}$/.test(code)) {
    symbol = report.market_type === 'KOSDAQ' ? `${code}.KQ` : `${code}.KS`;
  } else {
    symbol = code;
  }

  try {
    // entry_price가 없으면 발행 다음날 시초가를 가져와서 저장
    let entryPrice = report.entry_price;
    if (!entryPrice) {
      const pubDate = new Date(report.published_at);
      // 발행일 다음날
      const nextDay = new Date(pubDate);
      nextDay.setDate(nextDay.getDate() + 1);
      // 최소 1영업일 지나야 시초가 확인 가능
      const now = new Date();
      if (now < nextDay) {
        return res.json({ error: 'too_early', message: '발행 다음 거래일 이후 수익률이 계산됩니다.' });
      }

      // 발행일~발행일+5일 범위에서 첫 거래일의 시초가를 가져옴
      const period1 = Math.floor(nextDay.getTime() / 1000);
      const period2 = Math.floor(nextDay.getTime() / 1000) + (5 * 86400);
      const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d`;
      const chartResp = await fetch(chartUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const chartJson = await chartResp.json();
      const opens = chartJson.chart?.result?.[0]?.indicators?.quote?.[0]?.open;
      if (opens && opens.length > 0 && opens[0] != null) {
        entryPrice = opens[0];
        // DB에 저장
        db.prepare('UPDATE reports SET entry_price = ? WHERE id = ?').run(entryPrice, report.id);
      } else {
        return res.json({ error: 'no_price', message: '시초가 데이터를 아직 가져올 수 없습니다.' });
      }
    }

    // 현재가 조회 (v8 chart API)
    const quoteUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
    const quoteResp = await fetch(quoteUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const quoteJson = await quoteResp.json();
    const currentPrice = quoteJson.chart?.result?.[0]?.meta?.regularMarketPrice;

    if (!currentPrice) {
      return res.json({ error: 'no_quote', message: '현재가를 가져올 수 없습니다.' });
    }
    const totalReturn = ((currentPrice - entryPrice) / entryPrice) * 100;

    // 기간별 수익률 계산을 위한 과거 시점 가격 조회
    const pubDate = new Date(report.published_at);
    const now = new Date();
    const periods = [
      { label: '1주', key: 'week1', days: 7 },
      { label: '1개월', key: 'month1', days: 30 },
      { label: '3개월', key: 'month3', days: 90 },
      { label: '6개월', key: 'month6', days: 180 },
      { label: '1년', key: 'year1', days: 365 },
    ];

    const daysSincePublish = Math.floor((now - pubDate) / (1000 * 60 * 60 * 24));

    // 기간별 수익률: 발행 시점(entry_price) 기준으로 해당 기간 후 종가
    // 각 기간 시점의 가격을 가져오기 위해 historical data 조회
    const histPeriod1 = Math.floor(pubDate.getTime() / 1000);
    const histPeriod2 = Math.floor(now.getTime() / 1000);
    const histUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${histPeriod1}&period2=${histPeriod2}&interval=1d`;
    const histResp = await fetch(histUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const histJson = await histResp.json();
    const timestamps = histJson.chart?.result?.[0]?.timestamp || [];
    const closes = histJson.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];

    const performance = {};
    for (const p of periods) {
      if (daysSincePublish < p.days) {
        performance[p.key] = null; // 아직 해당 기간 미경과
      } else {
        // 발행일로부터 해당 기간 후 시점의 종가 찾기
        const targetTime = pubDate.getTime() / 1000 + (p.days * 86400);
        let closestIdx = -1;
        let minDiff = Infinity;
        for (let i = 0; i < timestamps.length; i++) {
          const diff = Math.abs(timestamps[i] - targetTime);
          if (diff < minDiff) { minDiff = diff; closestIdx = i; }
        }
        if (closestIdx >= 0 && closes[closestIdx] != null) {
          performance[p.key] = ((closes[closestIdx] - entryPrice) / entryPrice) * 100;
        } else {
          performance[p.key] = null;
        }
      }
    }

    res.json({
      entryPrice,
      currentPrice,
      totalReturn,
      daysSincePublish,
      publishedAt: report.published_at,
      performance,
      periods: periods.map(p => ({
        label: p.label,
        key: p.key,
        days: p.days,
        available: daysSincePublish >= p.days,
        returnRate: performance[p.key],
      })),
    });
  } catch (e) {
    console.error('Report performance error:', e.message);
    res.json({ error: 'fetch_error', message: '수익률 데이터를 가져오는데 실패했습니다.' });
  }
});

// 리포터 평균 수익률 API
router.get('/api/author-return/:authorId', async (req, res) => {
  try {
    const reports = db.prepare(`
      SELECT entry_price, stock_code, market_type FROM reports
      WHERE author_id = ? AND status = 'on_sale'
        AND entry_price IS NOT NULL AND entry_price > 0
        AND stock_code IS NOT NULL AND stock_code != ''
    `).all(req.params.authorId);

    if (reports.length === 0) return res.json({ avgReturn: null });

    const returns = [];
    await Promise.all(reports.map(async (r) => {
      try {
        const code = r.stock_code.replace(/[^0-9A-Za-z]/g, '');
        const symbol = /^\d{6}$/.test(code) ? (r.market_type === 'KOSDAQ' ? `${code}.KQ` : `${code}.KS`) : code;
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
        const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const json = await resp.json();
        const price = json.chart?.result?.[0]?.meta?.regularMarketPrice;
        if (price && r.entry_price) {
          returns.push(((price - r.entry_price) / r.entry_price) * 100);
        }
      } catch {}
    }));

    if (returns.length === 0) return res.json({ avgReturn: null });
    const avg = returns.reduce((a, b) => a + b, 0) / returns.length;
    res.json({ avgReturn: avg, count: returns.length });
  } catch {
    res.json({ avgReturn: null });
  }
});

router.get('/logout', (req, res) => {
  req.logout(() => res.redirect('/'));
});

module.exports = router;
