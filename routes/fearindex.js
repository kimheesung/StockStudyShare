const express = require('express');
const db = require('../lib/db');
const { render, isLoggedIn, buildNav, escapeHtml } = require('../lib/helpers');
const router = express.Router();

// 비속어 사전
const PROFANITY_WORDS = [
  '시발', '씨발', '존나', '좆', '병신', '개새끼', '미친', '지랄', '꺼져', '닥쳐',
  '등신', '멍청', '바보', '찐따', '쓰레기', '죽어', '뒤져', '엿먹', '썅', '개같',
  'ㅅㅂ', 'ㅂㅅ', 'ㅈㄴ', 'ㅁㅊ', 'ㅈㄹ', 'ㄲㅈ', 'ㅆㅂ', 'ㅗ', '시바', '시빨',
  '꼴통', '호구', '먹튀', '사기', '개잡', '새끼', '놈아', '년아', '미놈', '어이없',
  '분노', '빡치', '열받', '화난', '짜증', '빠가', '또라이', '정신나간',
  '폭락', '망했', '폭망', '깡통', '물렸', '손절', '개미털', '작전', '세력놈',
];

// 네이버 종목 토론방 게시글 수집
async function fetchNaverDiscussion(stockCode) {
  try {
    const url = `https://finance.naver.com/item/board.naver?code=${stockCode}`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
    });
    const buf = Buffer.from(await resp.arrayBuffer());
    let html;
    try { html = require('iconv-lite').decode(buf, 'euc-kr'); } catch { html = buf.toString('utf8'); }

    const titles = [];
    // 게시글 제목 추출
    const titleMatches = html.match(/<td class="title"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/g) || [];
    for (const m of titleMatches) {
      const textMatch = m.match(/<a[^>]*>([\s\S]*?)<\/a>/);
      if (textMatch) {
        const title = textMatch[1].replace(/<[^>]*>/g, '').trim();
        if (title) titles.push(title);
      }
    }
    return titles;
  } catch (e) {
    console.error(`[Fear] Fetch error for ${stockCode}:`, e.message);
    return [];
  }
}

// 비속어 비율 계산
function analyzeProfanity(titles) {
  if (titles.length === 0) return { total: 0, profanity: 0, ratio: 0, words: [] };
  let profanityCount = 0;
  const foundWords = new Set();
  for (const title of titles) {
    const lower = title.toLowerCase();
    let hasProfanity = false;
    for (const word of PROFANITY_WORDS) {
      if (lower.includes(word)) {
        hasProfanity = true;
        foundWords.add(word);
      }
    }
    if (hasProfanity) profanityCount++;
  }
  return {
    total: titles.length,
    profanity: profanityCount,
    ratio: (profanityCount / titles.length * 100),
    words: [...foundWords].slice(0, 5),
  };
}

// 공포 레벨 판정
function getFearLevel(ratio) {
  if (ratio >= 30) return { level: 'extreme', emoji: '🔥', label: '극도 공포' };
  if (ratio >= 20) return { level: 'high', emoji: '😱', label: '높은 공포' };
  if (ratio >= 10) return { level: 'moderate', emoji: '😰', label: '보통' };
  if (ratio >= 5) return { level: 'normal', emoji: '😐', label: '평온' };
  return { level: 'calm', emoji: '😌', label: '매우 평온' };
}

// 데일리 크롤링 (주요 종목)
async function dailyFearCheck() {
  console.log('[Fear Index] Starting daily check...');
  const today = new Date().toISOString().slice(0, 10);

  // 이미 오늘 체크했으면 스킵
  const existing = db.prepare('SELECT id FROM fear_index WHERE checked_at = ? LIMIT 1').get(today);
  if (existing) { console.log('[Fear Index] Already checked today'); return; }

  // 주요 종목 리스트 (코스피/코스닥 주요 종목)
  const targets = [
    { code: '005930', name: '삼성전자', market: 'KOSPI' },
    { code: '000660', name: 'SK하이닉스', market: 'KOSPI' },
    { code: '373220', name: 'LG에너지솔루션', market: 'KOSPI' },
    { code: '005380', name: '현대차', market: 'KOSPI' },
    { code: '035420', name: 'NAVER', market: 'KOSPI' },
    { code: '035720', name: '카카오', market: 'KOSPI' },
    { code: '068270', name: '셀트리온', market: 'KOSPI' },
    { code: '006400', name: '삼성SDI', market: 'KOSPI' },
    { code: '051910', name: 'LG화학', market: 'KOSPI' },
    { code: '003670', name: '포스코퓨처엠', market: 'KOSPI' },
    { code: '247540', name: '에코프로비엠', market: 'KOSDAQ' },
    { code: '086520', name: '에코프로', market: 'KOSDAQ' },
    { code: '196170', name: '알테오젠', market: 'KOSDAQ' },
    { code: '403870', name: '에이피알', market: 'KOSDAQ' },
    { code: '028300', name: 'HLB', market: 'KOSDAQ' },
    { code: '377300', name: '카카오페이', market: 'KOSPI' },
    { code: '066570', name: 'LG전자', market: 'KOSPI' },
    { code: '055550', name: '신한지주', market: 'KOSPI' },
    { code: '105560', name: 'KB금융', market: 'KOSPI' },
    { code: '012330', name: '현대모비스', market: 'KOSPI' },
    { code: '034730', name: 'SK', market: 'KOSPI' },
    { code: '000270', name: '기아', market: 'KOSPI' },
    { code: '096530', name: '씨젠', market: 'KOSDAQ' },
    { code: '293490', name: '카카오게임즈', market: 'KOSDAQ' },
    { code: '352820', name: '하이브', market: 'KOSPI' },
    { code: '003490', name: '대한항공', market: 'KOSPI' },
    { code: '009150', name: '삼성전기', market: 'KOSPI' },
    { code: '272110', name: '케이엔제이', market: 'KOSDAQ' },
    { code: '030200', name: 'KT', market: 'KOSPI' },
    { code: '017670', name: 'SK텔레콤', market: 'KOSPI' },
  ];

  for (const stock of targets) {
    try {
      const titles = await fetchNaverDiscussion(stock.code);
      const result = analyzeProfanity(titles);
      const fear = getFearLevel(result.ratio);

      db.prepare(`INSERT OR REPLACE INTO fear_index
        (stock_code, stock_name, market, total_posts, profanity_count, profanity_ratio, fear_level, sample_words, checked_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        stock.code, stock.name, stock.market,
        result.total, result.profanity, result.ratio,
        fear.level, result.words.join(','), today
      );

      // 네이버 부하 방지
      await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      console.error(`[Fear] Error for ${stock.name}:`, e.message);
    }
  }
  console.log('[Fear Index] Daily check complete');
}

// 스케줄: 매일 자정(KST) 실행
(function scheduleFearCheck() {
  // 서버 시작 시 오늘 데이터 없으면 30초 후 실행
  const today = new Date().toISOString().slice(0, 10);
  const existing = db.prepare('SELECT id FROM fear_index WHERE checked_at = ? LIMIT 1').get(today);
  if (!existing) {
    setTimeout(() => dailyFearCheck(), 30000);
  }

  // 매 5분마다 체크 → KST 자정이면 실행
  setInterval(() => {
    const now = new Date();
    const kstHour = (now.getUTCHours() + 9) % 24;
    if (kstHour === 0 && now.getMinutes() < 5) {
      dailyFearCheck();
    }
  }, 5 * 60 * 1000);
})();

// 페이지
router.get('/', isLoggedIn, (req, res) => {
  const q = (req.query.q || '').trim();
  const latestDate = db.prepare('SELECT MAX(checked_at) as d FROM fear_index').get()?.d;

  let fearData;
  if (q) {
    fearData = db.prepare('SELECT * FROM fear_index WHERE checked_at = ? AND stock_name LIKE ? ORDER BY profanity_ratio DESC, total_posts DESC')
      .all(latestDate || '', `%${q}%`);
  } else {
    fearData = db.prepare('SELECT * FROM fear_index WHERE checked_at = ? ORDER BY profanity_ratio DESC, total_posts DESC')
      .all(latestDate || '');
  }

  // 요약 통계
  const topFear = fearData[0];
  const totalPosts = fearData.reduce((s, r) => s + r.total_posts, 0);

  // 행 렌더링
  const fearRows = fearData.length > 0 ? fearData.map((r, i) => {
    const rank = i + 1;
    const fear = getFearLevel(r.profanity_ratio);
    const rankCls = rank === 1 ? 'rank-1' : rank === 2 ? 'rank-2' : rank === 3 ? 'rank-3' : 'rank-default';
    const barWidth = Math.min(100, r.profanity_ratio * 2); // 50%=100% 바
    return `<div class="fear-row">
      <div class="fear-rank ${rankCls}">${rank}</div>
      <div class="fear-info">
        <div class="fear-stock">${escapeHtml(r.stock_name)}<span class="code">${r.stock_code}</span></div>
        <div class="fear-meta">${r.total_posts}개 게시글 · 비속어 ${r.profanity_count}개 · ${fear.label}</div>
      </div>
      <div class="fear-bar-wrap">
        <div class="fear-bar-bg"><div class="fear-bar bar-${fear.level}" style="width:${barWidth}%"></div></div>
      </div>
      <div class="fear-pct level-${fear.level}">${r.profanity_ratio.toFixed(1)}%</div>
      <div class="fear-emoji">${fear.emoji}</div>
    </div>`;
  }).join('') : '<div class="empty-text">아직 분석 데이터가 없습니다. 매일 자정에 자동 업데이트됩니다.</div>';

  const html = render('views/fear-index.html', {
    nav: buildNav(req.user),
    fearRows,
    topFearName: topFear ? escapeHtml(topFear.stock_name) : '-',
    topFearPct: topFear ? topFear.profanity_ratio.toFixed(1) : '0',
    totalStocks: String(fearData.length),
    totalPosts: totalPosts.toLocaleString(),
    updatedAt: latestDate || '데이터 수집 중...',
    currentQ: escapeHtml(q),
  });
  res.send(html);
});

module.exports = router;
