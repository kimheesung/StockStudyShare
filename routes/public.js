const express = require('express');
const path = require('path');
const db = require('../lib/db');
const { render, buildNav, escapeHtml, adBannerHtml } = require('../lib/helpers');
const router = express.Router();

// ── 메모리 스팟 가격 자동 업데이트 (Claude AI) ──
async function fetchMemoryPricesFromAI() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return;

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });
    const today = new Date().toISOString().slice(0, 10);

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `오늘 날짜: ${today}. 현재 반도체 메모리 스팟 가격을 알려줘. 정확한 최신 가격이 없으면 가장 최근 알려진 가격을 알려줘.

다음 항목을 JSON으로만 출력해:
- DDR5 16GB (PC 모듈) 스팟 가격 (USD)
- DDR4 8GB (PC 모듈) 스팟 가격 (USD)
- NAND 256GB TLC 스팟 가격 (USD)
- NAND 512GB TLC 스팟 가격 (USD)

형식: {"items":[{"type":"RAM","product":"DDR5 16GB","price":숫자,"unit":"USD"},...]}`
      }],
    });

    const content = response.content[0].text;
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return;

    const data = JSON.parse(jsonMatch[0]);
    if (!data.items || !Array.isArray(data.items)) return;

    for (const item of data.items) {
      if (!item.type || !item.product || !item.price) continue;
      // 오늘 이미 같은 제품 가격이 있으면 스킵
      const existing = db.prepare('SELECT id FROM memory_prices WHERE product = ? AND date = ?').get(item.product, today);
      if (!existing) {
        db.prepare('INSERT INTO memory_prices (type, product, price, unit, date) VALUES (?, ?, ?, ?, ?)').run(
          item.type, item.product, item.price, item.unit || 'USD', today
        );
      }
    }
    console.log(`[Memory Prices] Updated ${data.items.length} items for ${today}`);
  } catch (e) {
    console.error('[Memory Prices] AI fetch error:', e.message);
  }
}

// 서버 시작 시 + 매일 아침 7시(KST) 실행
(function scheduleMemoryPriceUpdate() {
  // 서버 시작 시 오늘 데이터 없으면 즉시 실행
  const today = new Date().toISOString().slice(0, 10);
  const existing = db.prepare('SELECT id FROM memory_prices WHERE date = ? LIMIT 1').get(today);
  if (!existing) {
    setTimeout(() => fetchMemoryPricesFromAI(), 10000); // 10초 후 실행
  }

  // 매시간 체크 → KST 7시(UTC 22시)면 업데이트
  setInterval(() => {
    const now = new Date();
    const kstHour = (now.getUTCHours() + 9) % 24;
    if (kstHour === 7 && now.getMinutes() < 5) {
      fetchMemoryPricesFromAI();
    }
  }, 5 * 60 * 1000); // 5분마다 체크
})();

// 시장 데이터 캐시 (5분)
let marketCache = { data: null, ts: 0 };
let investorCache = { data: null, ts: 0 };
let creditCache = { data: null, ts: 0 };
let topGainersCache = { data: null, ts: 0 };
let dartCache = { data: null, ts: 0 };
const CACHE_TTL = 5 * 60 * 1000;
const DART_CACHE_TTL = 30 * 60 * 1000; // 30분

const SYMBOLS = [
  // 지수
  { symbol: '^KS11', name: 'KOSPI', category: '지수' },
  { symbol: '^KQ11', name: 'KOSDAQ', category: '지수' },
  { symbol: '^GSPC', name: 'S&P 500', category: '지수' },
  { symbol: '^IXIC', name: 'NASDAQ', category: '지수' },
  { symbol: '^DJI', name: 'Dow Jones', category: '지수' },
  // 환율
  { symbol: 'KRW=X', name: 'USD/KRW', category: '환율' },
  { symbol: 'JPY=X', name: 'USD/JPY', category: '환율' },
  // 반도체
  { symbol: '^SOX', name: 'SOX 반도체지수', category: '반도체' },
  { symbol: '005930.KS', name: '삼성전자', category: '반도체' },
  { symbol: '000660.KS', name: 'SK하이닉스', category: '반도체' },
  { symbol: 'MU', name: 'RAM 선행 (Micron)', category: '반도체' },
  { symbol: 'WDC', name: 'NAND 선행 (WD)', category: '반도체' },
  // 원자재
  { symbol: 'GC=F', name: 'Gold', category: '원자재' },
  { symbol: 'CL=F', name: 'WTI Oil', category: '원자재' },
  // 암호화폐
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
             COALESCE(u.nickname, ap.display_name, u.name) as author_name
      FROM reports r
      JOIN users u ON r.author_id = u.id
      LEFT JOIN author_profiles ap ON r.author_id = ap.user_id
      WHERE r.status = 'on_sale' AND (r.type IS NULL OR r.type != 'visit_note')
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
               COALESCE(u.nickname, ap.display_name, u.name) as author_name
        FROM reports r
        JOIN users u ON r.author_id = u.id
        LEFT JOIN author_profiles ap ON r.author_id = ap.user_id
        WHERE r.status = 'on_sale' AND (r.type IS NULL OR r.type != 'visit_note')
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

// 광고 문의 페이지
router.get('/ad-inquiry', (req, res) => {
  const user = req.user;
  const html = render('views/ad-inquiry.html', {
    nav: user ? buildNav(user) : '<a href="/" class="logo">StockStudyShare</a>',
    userName: user ? escapeHtml(user.nickname || user.name || '') : '',
    userEmail: user ? escapeHtml(user.email || '') : '',
  });
  res.send(html);
});

// 광고 문의 제출
router.post('/ad-inquiry', (req, res) => {
  const { name, email, company, message } = req.body;
  if (!name || !email || !message) return res.json({ ok: false, error: '필수 항목을 입력해주세요.' });
  db.prepare('INSERT INTO ad_inquiries (user_id, name, email, company, message) VALUES (?, ?, ?, ?, ?)').run(
    req.user?.id || null, name, email, company || null, message
  );
  res.json({ ok: true });
});

// 활성 광고 조회 API (광고 제거 아이템 보유자는 빈 배열)
router.get('/api/ads', (req, res) => {
  // 광고 배너 숨김 설정 체크
  try {
    const setting = db.prepare("SELECT value FROM site_settings WHERE key = 'show_ad_banner'").get();
    if (setting && setting.value === 'false') return res.json([]);
  } catch {}
  if (req.user) {
    const hasAdRemove = db.prepare("SELECT id FROM shop_purchases WHERE user_id = ? AND item_key = 'ad_remove'").get(req.user.id);
    if (hasAdRemove) return res.json([]);
  }
  const position = req.query.position || 'loading';
  const ads = db.prepare('SELECT id, title, image_url, link_url, ad_type, adsense_code FROM ads WHERE is_active = 1 AND position = ? ORDER BY RANDOM() LIMIT 1').all(position);
  res.json(ads);
});

// 광고 배너 표시 여부 API
router.get('/api/show-ad-banner', (req, res) => {
  try {
    const setting = db.prepare("SELECT value FROM site_settings WHERE key = 'show_ad_banner'").get();
    res.json({ show: setting ? setting.value === 'true' : true });
  } catch { res.json({ show: true }); }
});

// DART 주요 공시 데이터
const DART_API_KEY = process.env.DART_API_KEY || '';
const DART_KEYWORDS = [
  { keyword: '전환사채권발행결정', label: '전환사채 발행', color: '#f87171', icon: '🔄' },
  { keyword: '유상증자결정', label: '유상증자', color: '#fb923c', icon: '💹' },
  { keyword: '제3자배정', label: '3자배정 유증', color: '#fbbf24', icon: '🎯' },
  { keyword: '매출액또는손익구조', label: '매출액 변동', color: '#4ade80', icon: '📈' },
  { keyword: '타법인주식및출자증권취득결정', label: '대규모 투자', color: '#60a5fa', icon: '🏗️' },
  { keyword: '주요사항보고서(대규모', label: '대규모 투자', color: '#60a5fa', icon: '🏗️' },
];

async function fetchDartDisclosures() {
  const now = Date.now();
  if (dartCache.data && (now - dartCache.ts) < DART_CACHE_TTL) return dartCache.data;

  if (!DART_API_KEY) {
    dartCache = { data: [], ts: now };
    return [];
  }

  try {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 3);
    const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '');

    const results = [];

    // KOSPI + KOSDAQ 주요사항보고 (pblntf_ty=B)
    for (const corpCls of ['Y', 'K']) {
      const params = new URLSearchParams({
        crtfc_key: DART_API_KEY,
        pblntf_ty: 'B',
        bgn_de: fmt(startDate),
        end_de: fmt(endDate),
        corp_cls: corpCls,
        page_count: '100',
        sort: 'date',
        sort_mth: 'desc',
      });
      const url = `https://opendart.fss.or.kr/api/list.json?${params}`;
      const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const json = await resp.json();

      if (json.status === '000' && json.list) {
        for (const item of json.list) {
          const matched = DART_KEYWORDS.find(k => item.report_nm.includes(k.keyword));
          if (matched) {
            results.push({
              corp_name: item.corp_name,
              stock_code: item.stock_code || '',
              report_nm: item.report_nm,
              rcept_dt: item.rcept_dt,
              rcept_no: item.rcept_no,
              corp_cls: item.corp_cls === 'Y' ? 'KOSPI' : 'KOSDAQ',
              label: matched.label,
              color: matched.color,
              icon: matched.icon,
            });
          }
        }
      }
    }

    // 매출액 변동 공시에서 어닝 데이터 추출 → DB 저장
    for (const r of results) {
      if (r.label === '매출액 변동') {
        try {
          // 보고서명에서 금액 추출 시도
          const nums = r.report_nm.match(/([\d,]+)\s*억/g);
          if (nums && nums.length >= 1) {
            const actual = parseInt(nums[0].replace(/[^\d]/g, ''));
            const estimate = nums.length >= 2 ? parseInt(nums[1].replace(/[^\d]/g, '')) : null;
            const surprise = estimate ? ((actual - estimate) / estimate * 100) : null;
            const dateStr = r.rcept_dt ? `${r.rcept_dt.slice(0,4)}-${r.rcept_dt.slice(4,6)}-${r.rcept_dt.slice(6,8)}` : null;
            const existing = db.prepare('SELECT id FROM earnings WHERE corp_name = ? AND rcept_no = ?').get(r.corp_name, r.rcept_no);
            if (!existing) {
              db.prepare(`INSERT OR IGNORE INTO earnings (corp_name, stock_code, market, period, revenue_actual, surprise_pct, rcept_no, reported_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
                r.corp_name, r.stock_code, r.corp_cls, dateStr || '', actual, surprise, r.rcept_no, dateStr
              );
            }
          }
        } catch {}
      }
    }

    // 최신순 정렬, 최대 20개
    results.sort((a, b) => b.rcept_dt.localeCompare(a.rcept_dt));
    const top = results.slice(0, 20);
    dartCache = { data: top, ts: now };
    return top;
  } catch (e) {
    console.error('DART API error:', e.message);
    return dartCache.data || [];
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

  const [marketData, investorData, creditData, topGainers, dartData] = await Promise.all([
    fetchMarketData(),
    fetchInvestorData(),
    fetchCreditData(),
    fetchTopGainers(),
    fetchDartDisclosures(),
  ]);

  // 카테고리별 그룹핑
  const categoryOrder = ['지수', '환율', '반도체', '원자재', '암호화폐'];
  const categoryIcons = { '지수': '📊', '반도체': '💾', '환율': '💱', '원자재': '🛢️', '암호화폐': '₿' };
  const grouped = {};
  for (const m of marketData) {
    if (!grouped[m.category]) grouped[m.category] = [];
    grouped[m.category].push(m);
  }

  const cards = categoryOrder.filter(cat => grouped[cat]).map(cat => {
    const items = grouped[cat].map(m => {
      if (m.price === null) {
        return `<div class="market-card"><div class="market-name">${m.name}</div><div class="market-price">--</div></div>`;
      }
      const isUp = m.change >= 0;
      const sign = isUp ? '+' : '';
      const cls = isUp ? 'up' : 'down';
      const priceStr = m.price >= 1000 ? m.price.toLocaleString(undefined, { maximumFractionDigits: 2 }) : m.price.toFixed(2);
      const pctStr = `${sign}${m.changePercent.toFixed(2)}%`;
      return `<div class="market-card">
        <div class="market-name">${m.name}</div>
        <div class="market-price">${priceStr}</div>
        <div class="market-change ${cls}"><span class="change-arrow">${isUp ? '&#9650;' : '&#9660;'}</span> ${pctStr}</div>
      </div>`;
    }).join('');
    // 반도체 그룹에 메모리 스팟 가격 추가
    let memoryHtml = '';
    if (cat === '반도체') {
      const memPrices = db.prepare('SELECT * FROM memory_prices WHERE date = (SELECT MAX(date) FROM memory_prices) ORDER BY type, product').all();
      if (memPrices.length > 0) {
        memoryHtml = '<div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.05)">'
          + '<div style="font-size:0.68rem;color:rgba(255,255,255,0.3);margin-bottom:6px">메모리 스팟 가격 (' + memPrices[0].date + ')</div>'
          + '<div class="market-group-items">'
          + memPrices.map(p => `<div class="market-card"><div class="market-name">${escapeHtml(p.product)}</div><div class="market-price">$${p.price.toFixed(2)}</div></div>`).join('')
          + '</div></div>';
      }
    }

    return `<div class="market-group">
      <div class="market-group-title">${categoryIcons[cat] || ''} ${cat}</div>
      <div class="market-group-items">${items}</div>
      ${memoryHtml}
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
           COALESCE(u.nickname, ap.display_name, u.name) as author_name, r.author_id,
           (SELECT COUNT(*) FROM orders WHERE report_id = r.id) as purchase_count
    FROM reports r
    JOIN users u ON r.author_id = u.id
    LEFT JOIN author_profiles ap ON r.author_id = ap.user_id
    WHERE r.status = 'on_sale' AND (r.type IS NULL OR r.type != 'visit_note')
    ORDER BY r.published_at DESC
    LIMIT 6
  `).all();

  // 핫한 리포트 (구매순 → 조회순, 6개)
  const twoWeeksAgo = new Date();
  twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
  const hotReports = db.prepare(`
    SELECT r.id, r.title, r.stock_name, r.sector, r.sale_price, r.published_at,
           COALESCE(u.nickname, ap.display_name, u.name) as author_name, r.author_id,
           (SELECT COUNT(*) FROM orders WHERE report_id = r.id) as purchase_count,
           (SELECT COUNT(*) FROM view_logs WHERE report_id = r.id AND created_at >= ?) as view_count
    FROM reports r
    JOIN users u ON r.author_id = u.id
    LEFT JOIN author_profiles ap ON r.author_id = ap.user_id
    WHERE r.status = 'on_sale' AND (r.type IS NULL OR r.type != 'visit_note')
    ORDER BY purchase_count DESC, view_count DESC, r.published_at DESC
    LIMIT 6
  `).all(twoWeeksAgo.toISOString());

  // 수익률 TOP: entry_price 있는 리포트의 실시간 수익률 계산
  const topReturnReports = await (async () => {
    const candidates = db.prepare(`
      SELECT r.id, r.title, r.stock_name, r.sector, r.sale_price, r.published_at,
             COALESCE(u.nickname, ap.display_name, u.name) as author_name, r.author_id,
             (SELECT COUNT(*) FROM orders WHERE report_id = r.id) as purchase_count,
             r.entry_price, r.stock_code, r.market_type
      FROM reports r
      JOIN users u ON r.author_id = u.id
      LEFT JOIN author_profiles ap ON r.author_id = ap.user_id
      WHERE r.status = 'on_sale' AND (r.type IS NULL OR r.type != 'visit_note')
        AND r.entry_price IS NOT NULL AND r.entry_price > 0
        AND r.stock_code IS NOT NULL AND r.stock_code != ''
      ORDER BY r.published_at DESC
      LIMIT 30
    `).all();
    if (candidates.length === 0) return [];

    const symbolMap = {};
    for (const r of candidates) {
      const code = r.stock_code.replace(/[^0-9A-Za-z]/g, '');
      symbolMap[r.id] = /^\d{6}$/.test(code) ? (r.market_type === 'KOSDAQ' ? `${code}.KQ` : `${code}.KS`) : code;
    }
    const uniqueSymbols = [...new Set(Object.values(symbolMap))];
    const priceMap = {};
    await Promise.all(uniqueSymbols.map(async (sym) => {
      try {
        const resp = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1d`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const json = await resp.json();
        const price = json.chart?.result?.[0]?.meta?.regularMarketPrice;
        if (price) priceMap[sym] = price;
      } catch {}
    }));

    const results = [];
    for (const r of candidates) {
      const currentPrice = priceMap[symbolMap[r.id]];
      if (!currentPrice) continue;
      const returnRate = ((currentPrice - r.entry_price) / r.entry_price) * 100;
      results.push({ ...r, currentPrice, returnRate });
    }
    results.sort((a, b) => b.returnRate - a.returnRate);
    return results.slice(0, 6);
  })();

  // 팔로우한 작성자의 리포트
  const followReports = db.prepare(`
    SELECT r.id, r.title, r.stock_name, r.sector, r.sale_price, r.published_at,
           COALESCE(u.nickname, ap.display_name, u.name) as author_name, r.author_id,
           (SELECT COUNT(*) FROM orders WHERE report_id = r.id) as purchase_count
    FROM reports r
    JOIN users u ON r.author_id = u.id
    LEFT JOIN author_profiles ap ON r.author_id = ap.user_id
    JOIN follows f ON f.author_id = r.author_id AND f.follower_id = ?
    WHERE r.status = 'on_sale' AND (r.type IS NULL OR r.type != 'visit_note')
    ORDER BY r.published_at DESC
    LIMIT 6
  `).all(req.user.id);

  // 로그인 유저의 구매 리포트 ID 목록
  const purchasedSet = new Set();
  const purchasedRows = db.prepare('SELECT report_id FROM orders WHERE user_id = ?').all(req.user.id);
  purchasedRows.forEach(o => purchasedSet.add(o.report_id));

  function buildReportCards(reports, extraFn) {
    if (reports.length === 0) {
      return '<div class="report-empty">표시할 리포트가 없습니다.</div>';
    }
    return reports.map(r => {
      const price = r.sale_price === 0 ? '무료' : `${r.sale_price.toLocaleString()}P`;
      const date = r.published_at ? new Date(r.published_at).toLocaleDateString('ko-KR') : '';
      const extra = extraFn ? extraFn(r) : `${r.purchase_count}명 구매`;
      const ownedTag = purchasedSet.has(r.id) ? '<span class="tag-owned">보유중</span>' : '';
      return `<a href="/reports/${r.id}" class="report-card">
        <div class="report-card-top">
          <div class="report-card-top-left">
            <span class="report-sector">${escapeHtml(r.sector || '기타')}</span>
            ${ownedTag}
          </div>
          <span class="report-price">${price}</span>
        </div>
        <h4 class="report-title">${escapeHtml(r.title)}</h4>
        <div class="report-stock">${escapeHtml(r.stock_name)}</div>
        <div class="report-meta">
          <span>${escapeHtml(r.author_name)}</span>
          <span>${date}</span>
        </div>
        <div class="report-purchases">${extra}</div>
        <div class="report-return" data-report-id="${r.id}" style="font-size:0.78rem;color:rgba(255,255,255,0.2);margin-top:4px"></div>
      </a>`;
    }).join('');
  }

  const latestCards = buildReportCards(latestReports);
  const hotCards = buildReportCards(hotReports, r => `${r.view_count || 0}회 조회 · ${r.purchase_count}명 구매`);

  const topReturnCards = buildReportCards(topReturnReports, r => {
    if (!r.returnRate && r.returnRate !== 0) return `발행가 ${Math.round(r.entry_price).toLocaleString()}원`;
    const isUp = r.returnRate >= 0;
    const sign = isUp ? '+' : '';
    const cls = isUp ? 'color:#ef4444' : 'color:#3b82f6';
    return `<span style="font-weight:700;${cls}">${sign}${r.returnRate.toFixed(2)}%</span> · 현재 ${Math.round(r.currentPrice).toLocaleString()}원`;
  });

  const followCards = followReports.length > 0
    ? buildReportCards(followReports)
    : '<div class="report-empty" style="padding:40px 20px">팔로우한 리포터가 없습니다.<br><a href="/reports?view=authors" style="display:inline-block;margin-top:14px;padding:10px 24px;background:linear-gradient(135deg,#4f46e5,#6366f1);border-radius:50px;color:#fff;text-decoration:none;font-size:0.88rem;font-weight:700;box-shadow:0 4px 16px rgba(79,70,229,0.3)">리포터 보기</a></div>';

  // 상승률 순위 HTML
  let topGainersHtml = '';
  if (topGainers && topGainers.length > 0) {
    topGainersHtml = topGainers.map((r, i) => {
      const isUp = r.changeRate >= 0;
      const sign = isUp ? '+' : '';
      const cls = isUp ? 'up' : 'down';
      const arrow = isUp ? '&#9650;' : '&#9660;';
      const price = r.sale_price === 0 ? '무료' : `${r.sale_price.toLocaleString()}P`;
      const ownedTag = purchasedSet.has(r.id) ? '<span class="tag-owned">보유중</span>' : '';
      const date = r.published_at ? new Date(r.published_at).toLocaleDateString('ko-KR') : '';
      return `<a href="/reports/${r.id}" class="report-card">
        <div class="report-card-top">
          <div class="report-card-top-left">
            <span class="report-sector">${escapeHtml(r.sector || '기타')}</span>
            ${ownedTag}
          </div>
          <span class="report-price">${price}</span>
        </div>
        <h4 class="report-title">${escapeHtml(r.title)}</h4>
        <div class="report-stock">${escapeHtml(r.stock_name)} (${escapeHtml(r.stock_code || '')})</div>
        <div class="report-meta">
          <span>${escapeHtml(r.author_name)}</span>
          <span>${date}</span>
        </div>
        <div class="report-purchases"><span class="${cls}" style="font-weight:700"><span style="font-size:0.7rem">${arrow}</span> ${sign}${r.changeRate.toFixed(2)}%</span> · 현재 ${r.currentPrice.toLocaleString()}원</div>
      </a>`;
    }).join('');
  } else {
    topGainersHtml = '<div class="report-empty">표시할 데이터가 없습니다.</div>';
  }

  // 주요 공시 카드 (가로 스크롤)
  function extractSummary(reportNm, label) {
    // 보고서명에서 금액/비율 등 핵심 숫자 추출
    const amountMatch = reportNm.match(/(\d[\d,]*)\s*원/);
    const pctMatch = reportNm.match(/(\d+\.?\d*)%/);
    const sharesMatch = reportNm.match(/(\d[\d,]*)\s*주/);
    if (amountMatch) {
      const num = parseInt(amountMatch[1].replace(/,/g, ''));
      if (num >= 100000000) return `${(num / 100000000).toFixed(0)}억원`;
      if (num >= 10000) return `${(num / 10000).toFixed(0)}만원`;
    }
    if (pctMatch) return `${pctMatch[1]}%`;
    if (sharesMatch) return `${sharesMatch[1]}주`;
    const shortName = reportNm.replace(/\(.*?\)/g, '').trim();
    if (label === '전환사채 발행') return 'CB 발행';
    if (label === '유상증자' || label === '3자배정 유증') return '유증 결정';
    if (label === '매출액 변동') return '실적 변동';
    if (label === '대규모 투자') return '투자 결정';
    return '';
  }

  const dartCards = dartData.length > 0 ? dartData.map(d => {
    const dateStr = d.rcept_dt ? `${d.rcept_dt.slice(0,4)}.${d.rcept_dt.slice(4,6)}.${d.rcept_dt.slice(6,8)}` : '';
    const dartUrl = `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${d.rcept_no}`;
    const summary = extractSummary(d.report_nm, d.label);
    return `<a href="${dartUrl}" target="_blank" class="dart-card">
      <div class="dart-badge" style="background:${d.color}20;color:${d.color};border:1px solid ${d.color}40">${d.icon} ${escapeHtml(d.label)}</div>
      <div class="dart-corp">${escapeHtml(d.corp_name)} <span class="dart-market">${d.corp_cls}</span></div>
      ${summary ? `<div class="dart-summary">${escapeHtml(summary)}</div>` : ''}
      <div class="dart-report">${escapeHtml(d.report_nm)}</div>
      <div class="dart-date">${dateStr}</div>
    </a>`;
  }).join('') : '<div style="min-width:280px;padding:30px;text-align:center;color:rgba(255,255,255,0.25);font-size:0.85rem">공시 데이터 없음</div>';

  // 실시간 실적 (어닝서프라이즈)
  const earnings = db.prepare('SELECT * FROM earnings ORDER BY reported_at DESC, created_at DESC LIMIT 10').all();
  const earningsCards = earnings.length > 0 ? earnings.map(e => {
    const isBeat = e.surprise_pct !== null && e.surprise_pct > 0;
    const isMiss = e.surprise_pct !== null && e.surprise_pct < 0;
    const surpriseStr = e.surprise_pct !== null ? `${e.surprise_pct > 0 ? '+' : ''}${e.surprise_pct.toFixed(1)}%` : '';
    const badgeStyle = isBeat ? 'background:rgba(239,68,68,0.15);color:#ef4444' : isMiss ? 'background:rgba(59,130,246,0.15);color:#3b82f6' : 'background:rgba(255,255,255,0.06);color:rgba(255,255,255,0.4)';
    const badgeText = isBeat ? '서프라이즈' : isMiss ? '미달' : '실적 발표';
    const dartUrl = e.rcept_no ? `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${e.rcept_no}` : '#';
    const revenueStr = e.revenue_actual ? `${e.revenue_actual.toLocaleString()}억` : '';
    return `<a href="${dartUrl}" target="_blank" class="earning-card">
      <div class="earning-badge" style="${badgeStyle}">${badgeText}</div>
      <div class="earning-corp">${escapeHtml(e.corp_name)} <span class="earning-market">${e.market || ''}</span></div>
      ${revenueStr ? `<div class="earning-revenue">매출 ${revenueStr}</div>` : ''}
      ${surpriseStr ? `<div class="earning-surprise" style="color:${isBeat ? '#ef4444' : '#3b82f6'};font-weight:900">${surpriseStr}</div>` : ''}
      <div class="earning-date">${e.reported_at || ''}</div>
    </a>`;
  }).join('') : '<div style="min-width:260px;padding:24px;text-align:center;color:rgba(255,255,255,0.2);font-size:0.82rem">실적 데이터 수집 중...</div>';

  const html = render('views/dashboard.html', {
    nav: buildNav(req.user),
    marketCards: cards,
    investorRows,
    creditRows,
    dartCards,
    earningsCards,
    updatedAt: new Date().toLocaleString('ko-KR'),
    adBanner: adBannerHtml(),
  });
  res.send(html);
});

// 리포트 대시보드
router.get('/report-dashboard', async (req, res) => {
  if (!req.isAuthenticated()) return res.redirect('/');

  const purchasedSet = new Set();
  const purchased = db.prepare('SELECT report_id FROM orders WHERE user_id = ?').all(req.user.id);
  purchased.forEach(o => purchasedSet.add(o.report_id));

  function buildCards(reports) {
    if (!reports.length) return '<div class="report-empty">표시할 리포트가 없습니다.</div>';
    return reports.map(r => {
      const price = r.sale_price === 0 ? '무료' : r.sale_price.toLocaleString() + 'P';
      const date = r.published_at ? new Date(r.published_at).toLocaleDateString('ko-KR') : '';
      const owned = purchasedSet.has(r.id) ? '<span class="tag-owned">보유중</span>' : '';
      return `<a href="/reports/${r.id}" class="report-card"><div class="report-card-top"><div class="report-card-top-left"><span class="report-sector">${escapeHtml(r.sector || '기타')}</span>${owned}</div><span class="report-price">${price}</span></div><h4 class="report-title">${escapeHtml(r.title)}</h4><div class="report-stock">${escapeHtml(r.stock_name)}</div><div class="report-meta"><span>${escapeHtml(r.author_name)}</span><span>${date}</span></div><div class="report-purchases">${r.purchase_count || 0}명 구매</div></a>`;
    }).join('');
  }

  const baseQ = `SELECT r.id, r.title, r.stock_name, r.sector, r.sale_price, r.published_at, r.stock_code,
    COALESCE(u.nickname, ap.display_name, u.name) as author_name, r.author_id,
    (SELECT COUNT(*) FROM orders WHERE report_id = r.id) as purchase_count
    FROM reports r JOIN users u ON r.author_id = u.id LEFT JOIN author_profiles ap ON r.author_id = ap.user_id
    WHERE r.status = 'on_sale' AND (r.type IS NULL OR r.type != 'visit_note')`;

  const latestReports = db.prepare(baseQ + ` ORDER BY r.published_at DESC LIMIT 12`).all();
  const twoWeeksAgo = new Date(); twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
  const hotReports = db.prepare(`SELECT r.id, r.title, r.stock_name, r.sector, r.sale_price, r.published_at,
    COALESCE(u.nickname, ap.display_name, u.name) as author_name, r.author_id,
    (SELECT COUNT(*) FROM orders WHERE report_id = r.id) as purchase_count,
    (SELECT COUNT(*) FROM view_logs WHERE report_id = r.id AND created_at >= ?) as view_count
    FROM reports r JOIN users u ON r.author_id = u.id LEFT JOIN author_profiles ap ON r.author_id = ap.user_id
    WHERE r.status = 'on_sale' AND (r.type IS NULL OR r.type != 'visit_note')
    ORDER BY view_count DESC LIMIT 12`).all(twoWeeksAgo.toISOString());
  const threeMonthsAgo = new Date(); threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
  const topReturnReports = db.prepare(baseQ + ` AND r.entry_price IS NOT NULL AND r.entry_price > 0 AND r.published_at <= ? ORDER BY r.published_at ASC LIMIT 12`).all(threeMonthsAgo.toISOString());
  const followReports = db.prepare(`SELECT r.id, r.title, r.stock_name, r.sector, r.sale_price, r.published_at,
    COALESCE(u.nickname, ap.display_name, u.name) as author_name, r.author_id,
    (SELECT COUNT(*) FROM orders WHERE report_id = r.id) as purchase_count
    FROM reports r JOIN users u ON r.author_id = u.id LEFT JOIN author_profiles ap ON r.author_id = ap.user_id
    JOIN follows f ON f.author_id = r.author_id AND f.follower_id = ?
    WHERE r.status = 'on_sale' AND (r.type IS NULL OR r.type != 'visit_note')
    ORDER BY r.published_at DESC LIMIT 12`).all(req.user.id);

  const latestCards = buildCards(latestReports);
  const hotCards = buildCards(hotReports);
  const topReturnCards = buildCards(topReturnReports);
  const followCards = buildCards(followReports);

  const html = `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
    <title>리포트 대시보드 - StockStudyShare</title>
    <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;700;900&display=swap" rel="stylesheet">
    <style>
      *{margin:0;padding:0;box-sizing:border-box}
      body{font-family:'Noto Sans KR',sans-serif;background:linear-gradient(135deg,#0f0c29,#302b63,#24243e);color:#fff;min-height:100vh}
      .container{max-width:1100px;margin:0 auto;padding:40px 20px}
      h1{font-size:1.6rem;font-weight:900;margin-bottom:20px}
      h1 .highlight{background:linear-gradient(135deg,#4f46e5,#06b6d4);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
      .report-tabs{display:flex;gap:0;margin-bottom:20px;border-bottom:1px solid rgba(255,255,255,0.08)}
      .report-tab{padding:12px 24px;background:none;border:none;border-bottom:2px solid transparent;color:rgba(255,255,255,0.4);font-size:0.95rem;font-weight:700;cursor:pointer;font-family:inherit;transition:all 0.2s}
      .report-tab:hover{color:rgba(255,255,255,0.7)}
      .report-tab.active{color:#fff;border-bottom-color:#6366f1}
      .report-tab-content{margin-bottom:8px}
      .report-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px;margin-bottom:36px}
      .report-card{display:block;padding:18px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:14px;text-decoration:none;color:#fff;transition:all 0.3s}
      .report-card:hover{background:rgba(255,255,255,0.07);transform:translateY(-3px);border-color:rgba(79,70,229,0.3)}
      .report-card-top{display:flex;justify-content:space-between;margin-bottom:8px;align-items:center;gap:6px}
      .report-card-top-left{display:flex;align-items:center;gap:6px}
      .report-sector{font-size:0.7rem;padding:2px 8px;background:rgba(6,182,212,0.15);color:#67e8f9;border-radius:10px}
      .report-price{font-size:0.8rem;font-weight:700;color:#fbbf24}
      .report-title{font-size:0.95rem;font-weight:700;margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .report-stock{font-size:0.8rem;color:#67e8f9;margin-bottom:6px}
      .report-meta{display:flex;justify-content:space-between;font-size:0.72rem;color:rgba(255,255,255,0.35)}
      .report-purchases{font-size:0.72rem;color:rgba(255,255,255,0.3);margin-top:4px}
      .report-empty{color:rgba(255,255,255,0.25);text-align:center;padding:30px;font-size:0.88rem}
      .tag-owned{display:inline-block;padding:2px 8px;background:rgba(74,222,128,0.15);color:#4ade80;border:1px solid rgba(74,222,128,0.3);border-radius:10px;font-size:0.68rem;font-weight:700;margin-left:6px}
      .see-all{display:inline-block;color:#a5b4fc;text-decoration:none;font-size:0.85rem;margin-bottom:36px}
      .see-all:hover{color:#fff}
    </style></head><body>
    <nav>${buildNav(req.user)}</nav>
    <div class="container">
      <h1>🏠 <span class="highlight">리포트</span> 대시보드</h1>
      <div class="report-tabs">
        <button class="report-tab active" onclick="switchTab('latest')">📝 최신</button>
        <button class="report-tab" onclick="switchTab('hot')">🔥 핫한</button>
        <button class="report-tab" onclick="switchTab('topReturn')">💰 수익률 TOP</button>
        <button class="report-tab" onclick="switchTab('follow')">⭐ 팔로우</button>
      </div>
      <div class="report-tab-content" id="tab-latest"><div class="report-grid">${latestCards}</div></div>
      <div class="report-tab-content" id="tab-hot" style="display:none"><div class="report-grid">${hotCards}</div></div>
      <div class="report-tab-content" id="tab-topReturn" style="display:none"><div class="report-grid">${topReturnCards}</div></div>
      <div class="report-tab-content" id="tab-follow" style="display:none"><div class="report-grid">${followCards}</div></div>
      <a href="/reports" class="see-all">전체 리포트 보기 →</a>
    </div>
    <script>
      function switchTab(name){
        document.querySelectorAll('.report-tab-content').forEach(function(el){el.style.display='none'});
        document.querySelectorAll('.report-tab').forEach(function(el){el.classList.remove('active')});
        document.getElementById('tab-'+name).style.display='block';
        event.target.classList.add('active');
      }
    </script></body></html>`;
  res.send(html);
});

// 공시 엑셀 다운로드
router.get('/api/dart-excel', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).send('로그인이 필요합니다.');
  const data = await fetchDartDisclosures();
  if (!data || data.length === 0) return res.status(404).send('데이터가 없습니다.');

  // CSV (엑셀 호환)
  const BOM = '\uFEFF';
  let csv = BOM + '날짜,기업명,시장,유형,보고서명,DART링크\n';
  for (const d of data) {
    const dateStr = d.rcept_dt ? `${d.rcept_dt.slice(0,4)}-${d.rcept_dt.slice(4,6)}-${d.rcept_dt.slice(6,8)}` : '';
    const url = `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${d.rcept_no}`;
    csv += `${dateStr},"${d.corp_name}",${d.corp_cls},${d.label},"${d.report_nm.replace(/"/g, '""')}",${url}\n`;
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="dart_disclosures_${new Date().toISOString().slice(0,10)}.csv"`);
  res.send(csv);
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

// 리포터 평균 수익률 API (최근 3개월 내 발행 리포트 수익률 합산 / 리포트 수)
router.get('/api/author-return/:authorId', async (req, res) => {
  try {
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setDate(threeMonthsAgo.getDate() - 90);

    const reports = db.prepare(`
      SELECT entry_price, stock_code, market_type, published_at FROM reports
      WHERE author_id = ? AND status = 'on_sale'
        AND entry_price IS NOT NULL AND entry_price > 0
        AND stock_code IS NOT NULL AND stock_code != ''
        AND published_at IS NOT NULL AND published_at >= ?
    `).all(req.params.authorId, threeMonthsAgo.toISOString());

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

    if (returns.length === 0) return res.json({ avgReturn: null, total: reports.length, counted: 0 });
    const avg = returns.reduce((a, b) => a + b, 0) / returns.length;
    res.json({ avgReturn: avg, count: returns.length, total: reports.length });
  } catch {
    res.json({ avgReturn: null });
  }
});

router.get('/logout', (req, res) => {
  req.logout(() => res.redirect('/'));
});

module.exports = router;
