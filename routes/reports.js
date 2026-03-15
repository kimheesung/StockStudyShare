const express = require('express');
const db = require('../lib/db');
const { render, isLoggedIn, buildNav, escapeHtml, addPoints, adBannerHtml, notify } = require('../lib/helpers');
const router = express.Router();

// 리포트 목록
router.get('/', (req, res) => {
  const user = req.user;
  const { sector, market, sort, q } = req.query;

  let sql = `SELECT r.*, COALESCE(u.nickname, u.name) as author_name, u.photo as author_photo,
             ap.display_name, ap.bio as author_bio,
             (SELECT COUNT(*) FROM orders WHERE report_id = r.id) as sales_count,
             (SELECT AVG(rating) FROM report_ratings WHERE report_id = r.id) as avg_rating,
             (SELECT COUNT(*) FROM report_ratings WHERE report_id = r.id) as rating_count
             FROM reports r
             JOIN users u ON r.author_id = u.id
             LEFT JOIN author_profiles ap ON r.author_id = ap.user_id
             WHERE r.status = 'on_sale'`;
  const params = [];

  if (sector) { sql += ` AND r.sector = ?`; params.push(sector); }
  if (market) { sql += ` AND r.market_type = ?`; params.push(market); }
  if (q) { sql += ` AND (r.title LIKE ? OR r.stock_name LIKE ? OR r.stock_code LIKE ?)`; params.push(`%${q}%`, `%${q}%`, `%${q}%`); }

  if (sort === 'price_asc') sql += ` ORDER BY r.sale_price ASC`;
  else if (sort === 'price_desc') sql += ` ORDER BY r.sale_price DESC`;
  else if (sort === 'sales') sql += ` ORDER BY sales_count DESC`;
  else if (sort === 'return') sql += ` ORDER BY CASE WHEN r.entry_price > 0 THEN 1 ELSE 0 END DESC, r.published_at ASC`;
  else sql += ` ORDER BY r.published_at DESC`;

  const reports = db.prepare(sql).all(...params);

  // 로그인 유저의 구매 리포트 ID 목록
  const purchasedSet = new Set();
  if (user) {
    const purchased = db.prepare('SELECT report_id FROM orders WHERE user_id = ?').all(user.id);
    purchased.forEach(o => purchasedSet.add(o.report_id));
  }

  // 리포터별 평균 수익률 캐시
  const authorReturnCache = {};
  function getAuthorAvgReturn(authorId) {
    if (authorReturnCache[authorId] !== undefined) return authorReturnCache[authorId];
    const authorReports = db.prepare(`
      SELECT entry_price, base_price FROM reports
      WHERE author_id = ? AND status = 'on_sale' AND entry_price IS NOT NULL AND entry_price > 0
    `).all(authorId);
    if (authorReports.length === 0) { authorReturnCache[authorId] = null; return null; }
    // entry_price 기반 수익률은 현재가가 필요하므로 base_price 대비 entry_price로 근사
    // 실제로는 base_price(공개 당시 주가)와 entry_price(다음날 시초가)만 DB에 있음
    // 여기선 표시만 하고 실제 수익률은 클라이언트에서 로드
    authorReturnCache[authorId] = 'load';
    return 'load';
  }

  const reportCards = reports.length > 0 ? reports.map(r => {
    const displayName = escapeHtml(r.author_name || r.display_name);
    const price = r.sale_price === 0 ? '무료' : `${r.sale_price.toLocaleString()}P`;
    const bio = r.author_bio ? escapeHtml(r.author_bio.slice(0, 50)) + (r.author_bio.length > 50 ? '...' : '') : '';
    const isPurchased = purchasedSet.has(r.id);
    return `
      <a href="/reports/${r.id}" class="report-card-full">
        <div class="report-body">
          <div class="report-card-tags">
            <span class="tag-market">${escapeHtml(r.market_type || '')}</span>
            <span class="tag-sector">${escapeHtml(r.sector || '')}</span>
            ${isPurchased ? '<span class="tag-purchased">구매함</span>' : ''}
          </div>
          <h3>${escapeHtml(r.title)}</h3>
          <p class="report-stock">${escapeHtml(r.stock_name)} ${r.stock_code ? '(' + escapeHtml(r.stock_code) + ')' : ''}</p>
          <p class="report-summary">${escapeHtml((r.summary || '').slice(0, 100))}...</p>
          <div class="report-stats">
            <span class="stat-sales">${r.sales_count}명 구매</span>
            <span class="stat-rating">${r.avg_rating ? `<span style="color:#fbbf24">&#9733;</span> ${Number(r.avg_rating).toFixed(1)} (${r.rating_count}명)` : '<span style="color:rgba(255,255,255,0.2)">평가 없음</span>'}</span>
            <span class="stat-return" data-report-id="${r.id}">수익률 로딩중...</span>
          </div>
          ${bio ? `<div class="report-author-bio">${bio}</div>` : ''}
          <div class="report-meta-full">
            <img src="${r.author_photo || ''}" class="report-author-photo">
            <span class="author-name">${displayName}</span>
            <span class="dot">·</span>
            <span class="report-price">${price}</span>
            <span class="dot">·</span>
            <span>${r.published_at ? new Date(r.published_at).toLocaleDateString('ko-KR') : ''}</span>
          </div>
        </div>
      </a>`;
  }).join('') : '<p class="empty-text">아직 판매 중인 리포트가 없습니다.</p>';

  // 리포터 목록 (최신 리포트 작성 순)
  const authors = db.prepare(`
    SELECT u.id, u.name, u.photo, u.custom_photo, u.role, u.nickname,
           COALESCE(u.nickname, ap.display_name, u.name) as display_name,
           COALESCE(ap.bio, u.bio) as bio, ap.sectors,
           (SELECT COUNT(*) FROM reports WHERE author_id = u.id AND status = 'on_sale') as report_count,
           (SELECT COUNT(*) FROM orders o JOIN reports r2 ON o.report_id = r2.id WHERE r2.author_id = u.id) as total_sales,
           (SELECT MAX(published_at) FROM reports WHERE author_id = u.id AND status = 'on_sale') as latest_published,
           (SELECT AVG(rr.rating) FROM report_ratings rr JOIN reports r3 ON rr.report_id = r3.id WHERE r3.author_id = u.id) as avg_rating,
           (SELECT COUNT(*) FROM report_ratings rr2 JOIN reports r4 ON rr2.report_id = r4.id WHERE r4.author_id = u.id) as rating_count,
           (SELECT COUNT(*) FROM follows WHERE author_id = u.id) as follower_count
    FROM users u
    LEFT JOIN author_profiles ap ON u.id = ap.user_id
    WHERE (SELECT COUNT(*) FROM reports WHERE author_id = u.id AND status = 'on_sale') > 0
    ORDER BY latest_published DESC
  `).all();

  // 로그인 유저의 팔로우 목록
  const myFollows = new Set();
  if (user) {
    const follows = db.prepare('SELECT author_id FROM follows WHERE follower_id = ?').all(user.id);
    follows.forEach(f => myFollows.add(f.author_id));
  }

  const authorCards = authors.length > 0 ? authors.map(a => {
    const bio = a.bio ? escapeHtml(a.bio.slice(0, 80)) + (a.bio.length > 80 ? '...' : '') : '소개가 없습니다.';
    const ratingStr = a.avg_rating ? `<span style="color:#fbbf24">&#9733;</span> ${Number(a.avg_rating).toFixed(1)} (${a.rating_count})` : '평가 없음';
    const latestDate = a.latest_published ? new Date(a.latest_published).toLocaleDateString('ko-KR') : '';
    const isFollowing = myFollows.has(a.id);
    const isSelf = user && user.id === a.id;
    const followBtn = isSelf ? '' : (user
      ? `<button class="btn-follow ${isFollowing ? 'following' : ''}" data-author-id="${a.id}" onclick="toggleAuthorFollow(this)">${isFollowing ? '팔로잉' : '팔로우'}</button>`
      : '');
    return `<a href="/author-profile/${a.id}" class="author-card">
      <div class="author-card-header">
        <img src="${a.custom_photo || a.photo || ''}" alt="">
        <div style="flex:1">
          <div class="author-card-name">${escapeHtml(a.display_name)}</div>
          ${a.sectors ? `<span class="author-card-role">${escapeHtml(a.sectors)}</span>` : ''}
        </div>
        ${followBtn}
      </div>
      <div class="author-card-bio">${bio}</div>
      <div class="author-card-stats">
        <span>팔로워 <span class="val">${a.follower_count}</span></span>
        <span>리포트 <span class="val">${a.report_count}</span>건</span>
        <span>판매 <span class="val">${a.total_sales}</span>건</span>
        <span>${ratingStr}</span>
        <span class="author-avg-return" data-author-id="${a.id}">수익률 로딩중...</span>
        <span>최근 ${latestDate}</span>
      </div>
    </a>`;
  }).join('') : '<p class="empty-text">아직 리포터가 없습니다.</p>';

  const html = render('views/report-list.html', {
    nav: buildNav(user),
    reportCards,
    authorCards,
    currentSector: sector || '',
    currentMarket: market || '',
    currentSort: sort || '',
    currentQ: q || '',
    isLoggedIn: user ? 'true' : '',
    adBanner: adBannerHtml(),
  });
  res.send(html);
});

// 리포트 상세
router.get('/:id', (req, res) => {
  const user = req.user;
  const report = db.prepare(`
    SELECT r.*, COALESCE(u.nickname, u.name) as author_name, u.photo as author_photo,
           ap.display_name, ap.bio, ap.sectors as author_sectors
    FROM reports r
    JOIN users u ON r.author_id = u.id
    LEFT JOIN author_profiles ap ON r.author_id = ap.user_id
    WHERE r.id = ? AND r.status = 'on_sale'
  `).get(req.params.id);

  if (!report) return res.status(404).send('리포트를 찾을 수 없습니다.');

  let hasPurchased = false;
  let isAuthorOfReport = false;
  let isStudyMate = false;
  if (user) {
    if (user.id === report.author_id || user.role === 'admin') {
      hasPurchased = true;
      isAuthorOfReport = user.id === report.author_id;
    } else if (report.sale_price === 0) {
      hasPurchased = true;
    } else {
      const order = db.prepare('SELECT id FROM orders WHERE user_id = ? AND report_id = ?').get(user.id, report.id);
      hasPurchased = !!order;
    }
  }

  const displayName = report.author_name || report.display_name;
  const price = report.sale_price === 0 ? '무료' : `${report.sale_price.toLocaleString()}P`;

  let actionButton;
  if (!user) {
    actionButton = `<a href="/auth/google" class="btn-primary">로그인하고 구매하기</a>`;
  } else if (isAuthorOfReport) {
    actionButton = `<span style="display:inline-block;padding:8px 20px;background:rgba(74,222,128,0.12);border:1px solid rgba(74,222,128,0.3);border-radius:50px;color:#4ade80;font-size:0.88rem;font-weight:700;margin-right:12px">&#9989; 내가 발행한 리포트</span><a href="/reports/${report.id}/view" class="btn-primary">리포트 열람하기</a>`;
  } else if (hasPurchased) {
    actionButton = `<span style="display:inline-block;padding:8px 20px;background:rgba(79,70,229,0.12);border:1px solid rgba(79,70,229,0.3);border-radius:50px;color:#a5b4fc;font-size:0.88rem;font-weight:700;margin-right:12px">&#128179; 보유중</span><a href="/reports/${report.id}/view" class="btn-primary">리포트 열람하기</a>`;
  } else {
    actionButton = `<button type="button" class="btn-primary" onclick="openPurchaseModal()">리포트 구매하기 (${price})</button>`;
  }

  // 팔로우 버튼
  let followButton = '';
  if (user && user.id !== report.author_id) {
    const isFollowing = !!db.prepare('SELECT id FROM follows WHERE follower_id = ? AND author_id = ?').get(user.id, report.author_id);
    followButton = `<button class="follow-btn ${isFollowing ? 'following' : ''}" data-author-id="${report.author_id}" onclick="toggleFollow(this)">${isFollowing ? '팔로잉' : '팔로우'}</button>`;
  }

  const html = render('views/report-detail.html', {
    nav: buildNav(user),
    title: escapeHtml(report.title),
    stockName: escapeHtml(report.stock_name),
    stockCode: escapeHtml(report.stock_code || ''),
    marketType: escapeHtml(report.market_type || ''),
    sector: escapeHtml(report.sector || ''),
    summary: escapeHtml(report.summary),
    authorName: escapeHtml(displayName),
    authorPhoto: report.author_photo || '',
    authorBio: escapeHtml(report.bio || ''),
    authorId: report.author_id,
    price,
    publishedAt: report.published_at ? new Date(report.published_at).toLocaleDateString('ko-KR') : '',
    actionButton,
    followButton,
    reportId: String(report.id),
    isLoggedIn: user ? 'true' : '',
    salePrice: String(report.sale_price),
    userPoints: user ? String(user.points || 0) : '0',
    holdingDisclosure: escapeHtml(report.holding_disclosure || ''),
    conflictDisclosure: escapeHtml(report.conflict_disclosure || ''),
    adBanner: adBannerHtml(),
  });
  res.send(html);
});

// 구매
router.post('/:id/purchase', isLoggedIn, (req, res) => {
  const report = db.prepare('SELECT * FROM reports WHERE id = ? AND status = ?').get(req.params.id, 'on_sale');
  if (!report) return res.status(404).send('리포트를 찾을 수 없습니다.');

  // 자기 리포트 구매 방지
  if (req.user.id === report.author_id) {
    return res.redirect(`/reports/${report.id}/view`);
  }

  // max_buyers 체크
  if (report.max_buyers > 0) {
    const buyerCount = db.prepare('SELECT COUNT(*) as c FROM orders WHERE report_id = ?').get(report.id).c;
    if (buyerCount >= report.max_buyers) {
      return res.status(400).send('이 리포트의 구매 가능 인원이 마감되었습니다.');
    }
  }

  // 포인트 잔액 확인
  if (report.sale_price > 0) {
    const buyer = db.prepare('SELECT points FROM users WHERE id = ?').get(req.user.id);
    if (!buyer || buyer.points < report.sale_price) {
      return res.status(400).send(`포인트가 부족합니다. 현재 ${(buyer?.points || 0).toLocaleString()}P / 필요 ${report.sale_price.toLocaleString()}P`);
    }
  }

  const existing = db.prepare('SELECT id FROM orders WHERE user_id = ? AND report_id = ?').get(req.user.id, report.id);
  if (!existing) {
    const purchaseTransaction = db.transaction(() => {
      // 주문 생성
      db.prepare('INSERT INTO orders (user_id, report_id, amount, payment_status) VALUES (?, ?, ?, ?)').run(
        req.user.id, report.id, report.sale_price, 'completed'
      );

      if (report.sale_price > 0) {
        const price = report.sale_price;

        // 구매자 포인트 차감
        db.prepare('UPDATE users SET points = points - ? WHERE id = ?').run(price, req.user.id);
        db.prepare('INSERT INTO point_logs (user_id, amount, type, description, related_report_id) VALUES (?, ?, ?, ?, ?)').run(
          req.user.id, -price, 'purchase', `리포트 구매: ${report.title}`, report.id
        );

        // 스터디방 리포트 수익 분배
        if (report.study_room_id) {
          // 구매자의 추천인 확인
          const buyerUser = db.prepare('SELECT referrer_id FROM users WHERE id = ?').get(req.user.id);
          const hasReferrer = buyerUser?.referrer_id;

          // 작성자 70%
          const authorAmount = Math.floor(price * 0.70);
          db.prepare('UPDATE users SET points = points + ? WHERE id = ?').run(authorAmount, report.author_id);
          db.prepare('INSERT INTO point_logs (user_id, amount, type, description, related_user_id, related_report_id) VALUES (?, ?, ?, ?, ?, ?)').run(
            report.author_id, authorAmount, 'sales_revenue', `리포트 판매 수익 (70%): ${report.title}`, req.user.id, report.id
          );

          // admin
          const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
          const adminRate = hasReferrer ? 0.20 : 0.25;
          const adminAmount = Math.floor(price * adminRate);
          if (admin) {
            db.prepare('UPDATE users SET points = points + ? WHERE id = ?').run(adminAmount, admin.id);
            db.prepare('INSERT INTO point_logs (user_id, amount, type, description, related_user_id, related_report_id) VALUES (?, ?, ?, ?, ?, ?)').run(
              admin.id, adminAmount, 'sales_commission', `리포트 판매 수수료 (${Math.round(adminRate * 100)}%): ${report.title}`, req.user.id, report.id
            );
          }

          // 추천인 5% (있을 경우만)
          if (hasReferrer) {
            const referralAmount = Math.floor(price * 0.05);
            if (referralAmount > 0) {
              db.prepare('UPDATE users SET points = points + ? WHERE id = ?').run(referralAmount, buyerUser.referrer_id);
              db.prepare('INSERT INTO point_logs (user_id, amount, type, description, related_user_id, related_report_id) VALUES (?, ?, ?, ?, ?, ?)').run(
                buyerUser.referrer_id, referralAmount, 'referral_bonus', `추천인 보너스 (5%): ${report.title}`, req.user.id, report.id
              );
            }
          }

          // 스터디방 5%
          const studyAmount = Math.floor(price * 0.05);
          if (studyAmount > 0) {
            db.prepare('UPDATE study_rooms SET points = points + ? WHERE id = ?').run(studyAmount, report.study_room_id);
            // 스터디방 포인트 로그
            db.prepare('INSERT INTO study_point_logs (room_id, amount, type, description) VALUES (?, ?, ?, ?)').run(
              report.study_room_id, studyAmount, 'sales_revenue', `리포트 판매 수익 (5%): ${report.title}`
            );
          }
        } else {
          // 스터디방 외 리포트: 기존 방식 (구매자에게 10% 캐시백)
          const buyerPoints = Math.floor(price * 0.1);
          if (buyerPoints > 0) {
            addPoints(db, req.user.id, buyerPoints, 'purchase', `리포트 구매 캐시백: ${report.title}`, report.id);
          }
        }
      }
    });

    purchaseTransaction();
  }

  res.redirect(`/reports/${report.id}?purchased=1`);
});

// 웹 뷰어
router.get('/:id/view', isLoggedIn, (req, res) => {
  const report = db.prepare(`
    SELECT r.*, COALESCE(u.nickname, u.name) as author_name, ap.display_name
    FROM reports r
    JOIN users u ON r.author_id = u.id
    LEFT JOIN author_profiles ap ON r.author_id = ap.user_id
    WHERE r.id = ?
  `).get(req.params.id);

  if (!report) return res.status(404).send('리포트를 찾을 수 없습니다.');

  // 접근 권한 확인
  const isOwner = req.user.id === report.author_id;
  const isAdminUser = req.user.role === 'admin';
  const isFree = report.sale_price === 0;
  const hasPurchased = !!db.prepare('SELECT id FROM orders WHERE user_id = ? AND report_id = ?').get(req.user.id, report.id);
  // 스터디방 전용 리포트: 같은 스터디방 멤버만 열람 가능
  const isStudyRoomMember = report.study_room_id
    ? !!db.prepare('SELECT id FROM study_members WHERE room_id = ? AND user_id = ?').get(report.study_room_id, req.user.id)
    : false;

  // study_published는 같은 스터디방 멤버만
  if (report.status === 'study_published' && !isOwner && !isAdminUser && !isStudyRoomMember) {
    return res.status(403).send('이 리포트는 스터디방 멤버만 열람할 수 있습니다.');
  }

  if (!isOwner && !isAdminUser && !isFree && !hasPurchased) {
    return res.redirect(`/reports/${report.id}`);
  }

  // 열람 로그
  db.prepare('INSERT INTO view_logs (user_id, report_id, ip, user_agent) VALUES (?, ?, ?, ?)').run(
    req.user.id, report.id, req.ip, req.get('User-Agent') || ''
  );

  const displayName = report.author_name || report.display_name;

  // 평가 데이터
  const ratingStats = db.prepare('SELECT AVG(rating) as avg, COUNT(*) as cnt FROM report_ratings WHERE report_id = ?').get(report.id);
  const myRating = db.prepare('SELECT rating FROM report_ratings WHERE user_id = ? AND report_id = ?').get(req.user.id, report.id);
  const canRate = hasPurchased && !myRating && !isOwner;

  const html = render('views/report-viewer.html', {
    nav: buildNav(req.user),
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
    authorName: escapeHtml(displayName),
    publishedAt: report.published_at ? new Date(report.published_at).toLocaleDateString('ko-KR') : '',
    watermarkText: `${req.user.email || req.user.name}`,
    reportId: String(report.id),
    avgRating: ratingStats.avg ? ratingStats.avg.toFixed(1) : '0.0',
    ratingCount: String(ratingStats.cnt || 0),
    myRating: myRating ? String(myRating.rating) : '0',
    canRate: canRate ? 'true' : '',
    reportSalePrice: String(report.sale_price || 0),
    adBanner: adBannerHtml(),
  });
  res.send(html);
});

// 리포트 별점 평가
router.post('/:id/rate', isLoggedIn, (req, res) => {
  const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
  if (!report) return res.status(404).json({ error: '리포트를 찾을 수 없습니다.' });

  // 구매자만 평가 가능
  const order = db.prepare('SELECT id FROM orders WHERE user_id = ? AND report_id = ?').get(req.user.id, report.id);
  if (!order) return res.status(403).json({ error: '리포트를 구매한 사람만 평가할 수 있습니다.' });

  // 이미 평가했는지 확인
  const existing = db.prepare('SELECT id FROM report_ratings WHERE user_id = ? AND report_id = ?').get(req.user.id, report.id);
  if (existing) return res.status(400).json({ error: '이미 평가하셨습니다.' });

  const rating = parseInt(req.body.rating);
  if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: '1~5 사이의 별점을 선택해주세요.' });

  const reward = report.sale_price >= 10000 ? 1000 : 0;
  const rateTransaction = db.transaction(() => {
    db.prepare('INSERT INTO report_ratings (user_id, report_id, rating) VALUES (?, ?, ?)').run(req.user.id, report.id, rating);
    if (reward > 0) {
      addPoints(db, req.user.id, reward, 'rating_reward', `리포트 평가 보상: ${report.title}`, report.id);
    }
  });
  rateTransaction();

  const stats = db.prepare('SELECT AVG(rating) as avg, COUNT(*) as cnt FROM report_ratings WHERE report_id = ?').get(report.id);

  res.json({ ok: true, avgRating: stats.avg, ratingCount: stats.cnt, reward });
});

// 신고 폼
router.get('/:id/flag', isLoggedIn, (req, res) => {
  const report = db.prepare('SELECT id, title, author_id FROM reports WHERE id = ? AND status = ?').get(req.params.id, 'on_sale');
  if (!report) return res.status(404).send('리포트를 찾을 수 없습니다.');

  // 자기 리포트 신고 방지
  if (req.user.id === report.author_id) return res.redirect(`/reports/${report.id}`);

  // 이미 신고 여부
  const alreadyFlagged = !!db.prepare('SELECT id FROM report_flags WHERE reporter_id = ? AND report_id = ?').get(req.user.id, report.id);
  const flagCount = db.prepare('SELECT COUNT(*) as c FROM report_flags WHERE report_id = ?').get(report.id).c;

  const html = render('views/report-flag.html', {
    nav: buildNav(req.user),
    reportId: String(report.id),
    reportTitle: escapeHtml(report.title),
    alreadyFlagged: alreadyFlagged ? 'true' : '',
    flagCount: String(flagCount),
  });
  res.send(html);
});

// 신고 제출
router.post('/:id/flag', isLoggedIn, (req, res) => {
  const { reason, detail } = req.body;
  const report = db.prepare('SELECT id, title, author_id FROM reports WHERE id = ? AND status = ?').get(req.params.id, 'on_sale');
  if (!report) return res.status(404).send('리포트를 찾을 수 없습니다.');

  // 중복 신고 체크
  const existing = db.prepare('SELECT id FROM report_flags WHERE reporter_id = ? AND report_id = ?').get(req.user.id, report.id);
  if (existing) return res.redirect(`/reports/${report.id}?flagged=already`);

  // 자기 리포트 신고 방지
  if (req.user.id === report.author_id) return res.redirect(`/reports/${report.id}`);

  db.prepare('INSERT INTO report_flags (reporter_id, report_id, reason, detail) VALUES (?, ?, ?, ?)').run(
    req.user.id, report.id, reason, detail || ''
  );

  const flagCount = db.prepare('SELECT COUNT(*) as c FROM report_flags WHERE report_id = ?').get(report.id).c;

  // 5건 이상 신고 시 자동 판매중지
  if (flagCount >= 5) {
    db.prepare("UPDATE reports SET status = 'suspended' WHERE id = ? AND status = 'on_sale'").run(report.id);

    // 작성자에게 알림
    notify(db, report.author_id, 'report_rejected', '리포트 판매 중지',
      `"${report.title}" 리포트가 신고 ${flagCount}건 누적으로 판매가 일시 중지되었습니다. 관리자 검토 후 처리됩니다.`,
      `/author/dashboard`);

    // 관리자에게 알림
    const admins = db.prepare("SELECT id FROM users WHERE role = 'admin'").all();
    for (const admin of admins) {
      notify(db, admin.id, 'report_pending_admin', '리포트 신고 누적',
        `"${report.title}" 리포트가 신고 ${flagCount}건으로 자동 판매중지되었습니다. 확인이 필요합니다.`,
        `/admin/reports?status=suspended`);
    }
  }

  res.redirect(`/reports/${report.id}?flagged=1`);
});

module.exports = router;
