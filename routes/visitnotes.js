const express = require('express');
const db = require('../lib/db');
const { render, isLoggedIn, buildNav, escapeHtml, addPoints, notify } = require('../lib/helpers');
const router = express.Router();

// 탐방노트 목록
router.get('/', (req, res) => {
  const user = req.user;
  if (!user) return res.redirect('/');
  const { sector, q } = req.query;

  let sql = `SELECT r.*, COALESCE(u.nickname, u.name) as author_name, u.photo as author_photo,
             (SELECT COUNT(*) FROM orders WHERE report_id = r.id) as sales_count
             FROM reports r
             JOIN users u ON r.author_id = u.id
             WHERE r.type = 'visit_note' AND r.status = 'on_sale'`;
  const params = [];

  if (sector) { sql += ` AND r.sector = ?`; params.push(sector); }
  if (q) { sql += ` AND (r.title LIKE ? OR r.stock_name LIKE ?)`; params.push(`%${q}%`, `%${q}%`); }
  sql += ` ORDER BY r.published_at DESC`;

  const notes = db.prepare(sql).all(...params);

  // 구매 여부
  const purchasedSet = new Set();
  if (user) {
    db.prepare('SELECT report_id FROM orders WHERE user_id = ?').all(user.id).forEach(o => purchasedSet.add(o.report_id));
  }

  const noteCards = notes.length > 0 ? notes.map(r => {
    const price = r.sale_price === 0 ? '무료' : `${r.sale_price.toLocaleString()}P`;
    const date = r.published_at ? new Date(r.published_at).toLocaleDateString('ko-KR') : '';
    const visitDate = r.visit_date ? new Date(r.visit_date).toLocaleDateString('ko-KR') : '';
    const isPurchased = purchasedSet.has(r.id);
    return `
      <a href="/visit-notes/${r.id}" class="note-card">
        <div class="note-tags">
          <span class="tag-note">탐방노트</span>
          <span class="tag-market">${escapeHtml(r.market_type || '')}</span>
          <span class="tag-sector">${escapeHtml(r.sector || '')}</span>
          ${isPurchased ? '<span class="tag-purchased">구매함</span>' : ''}
        </div>
        <h3>${escapeHtml(r.title)}</h3>
        <p class="note-stock">${escapeHtml(r.stock_name)} ${r.stock_code ? '(' + escapeHtml(r.stock_code) + ')' : ''}</p>
        <p class="note-visit-info">${visitDate ? '탐방일: ' + visitDate : ''} ${r.visit_location ? '· ' + escapeHtml(r.visit_location) : ''}</p>
        <p class="note-summary">${escapeHtml((r.summary || '').slice(0, 120))}...</p>
        <div class="note-meta">
          <img src="${r.author_photo || ''}" alt="">
          <span>${escapeHtml(r.author_name)}</span>
          <span style="opacity:0.3">·</span>
          <span class="note-price">${price}</span>
          <span style="opacity:0.3">·</span>
          <span>${date}</span>
        </div>
        <div class="note-sales">${r.sales_count}명 구매</div>
      </a>`;
  }).join('') : '<p class="empty-text">아직 등록된 탐방노트가 없습니다.</p>';

  const sectorSel = (s) => sector === s ? 'selected' : '';
  const html = render('views/visit-note-list.html', {
    nav: buildNav(user),
    noteCards,
    currentQ: escapeHtml(q || ''),
    selIT: sectorSel('IT/반도체'), selBio: sectorSel('바이오/헬스케어'), selFin: sectorSel('금융'),
    selCon: sectorSel('소비재'), selEng: sectorSel('에너지/소재'), selInd: sectorSel('산업재'), selEtc: sectorSel('기타'),
  });
  res.send(html);
});

// 탐방노트 작성 폼
router.get('/new', isLoggedIn, (req, res) => {
  const html = render('views/visit-note-write.html', { nav: buildNav(req.user) });
  res.send(html);
});

// 탐방노트 제출
router.post('/new', isLoggedIn, (req, res) => {
  const { title, stock_name, stock_code, market_type, sector, visit_date, visit_location,
          visit_purpose, visit_findings, visit_impressions, summary, references_text,
          sale_price, max_buyers, holding_disclosure, conflict_disclosure, action } = req.body;

  if (!title || !stock_name || !summary || !visit_date || !visit_location || !visit_purpose || !visit_findings) {
    return res.status(400).send('필수 항목을 모두 입력해주세요.');
  }

  const status = action === 'draft' ? 'draft' : 'pending_admin'; // 관리자 승인만 필요

  const result = db.prepare(`INSERT INTO reports (
    type, author_id, title, stock_name, stock_code, market_type, sector,
    visit_date, visit_location, visit_purpose, visit_findings, visit_impressions,
    summary, references_text, sale_price, max_buyers, holding_disclosure, conflict_disclosure,
    status, visibility
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'visit_note', req.user.id, title, stock_name, stock_code || null, market_type || null, sector || null,
    visit_date, visit_location, visit_purpose, visit_findings, visit_impressions || null,
    summary, references_text || null, parseInt(sale_price) || 0, parseInt(max_buyers) || 0,
    holding_disclosure || '미보유', conflict_disclosure || '', status, 'public'
  );

  if (status === 'pending_admin') {
    // 관리자에게 알림
    const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
    if (admin) {
      notify(db, admin.id, 'report_pending_admin', '탐방노트 승인 요청',
        `${req.user.nickname || req.user.name}님이 탐방노트를 제출했습니다: ${title}`,
        '/admin/reports?status=pending_admin');
    }
  }

  res.redirect('/visit-notes');
});

// 탐방노트 상세
router.get('/:id', isLoggedIn, (req, res) => {
  const report = db.prepare(`
    SELECT r.*, COALESCE(u.nickname, u.name) as author_name, u.photo as author_photo
    FROM reports r JOIN users u ON r.author_id = u.id
    WHERE r.id = ? AND r.type = 'visit_note' AND r.status = 'on_sale'
  `).get(req.params.id);

  if (!report) return res.status(404).send('탐방노트를 찾을 수 없습니다.');

  let hasPurchased = false;
  if (req.user.id === report.author_id || req.user.role === 'admin') hasPurchased = true;
  else if (report.sale_price === 0) hasPurchased = true;
  else {
    const order = db.prepare('SELECT id FROM orders WHERE user_id = ? AND report_id = ?').get(req.user.id, report.id);
    hasPurchased = !!order;
  }

  const price = report.sale_price === 0 ? '무료' : `${report.sale_price.toLocaleString()}P`;
  let actionButton;
  if (hasPurchased) {
    actionButton = `<a href="/visit-notes/${report.id}/view" class="btn-primary">탐방노트 열람하기</a>`;
  } else {
    actionButton = `<form method="POST" action="/visit-notes/${report.id}/purchase" onsubmit="return confirm('정말 구매하시겠습니까?\\n${price}가 차감됩니다.')"><button type="submit" class="btn-primary">탐방노트 구매하기 (${price})</button></form>`;
  }

  const visitDate = report.visit_date ? new Date(report.visit_date).toLocaleDateString('ko-KR') : '';

  const html = `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
    <title>${escapeHtml(report.title)} - 탐방노트</title>
    <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;700;900&display=swap" rel="stylesheet">
    <style>
      *{margin:0;padding:0;box-sizing:border-box}
      body{font-family:'Noto Sans KR',sans-serif;background:linear-gradient(135deg,#0f0c29,#302b63,#24243e);color:#fff;min-height:100vh}
      nav{position:sticky;top:0;z-index:100;display:flex;justify-content:space-between;align-items:center;padding:16px 40px;background:rgba(15,12,41,0.95);backdrop-filter:blur(20px);border-bottom:1px solid rgba(255,255,255,0.05)}
      .logo{font-size:1.4rem;font-weight:900;background:linear-gradient(135deg,#4f46e5,#06b6d4);-webkit-background-clip:text;-webkit-text-fill-color:transparent;text-decoration:none}
      .container{max-width:800px;margin:0 auto;padding:40px 20px}
      .back-link{color:rgba(255,255,255,0.4);text-decoration:none;font-size:0.9rem;margin-bottom:20px;display:inline-block}
      .tag-note{display:inline-block;padding:4px 14px;border-radius:20px;font-size:0.78rem;font-weight:700;background:rgba(34,197,94,0.15);color:#4ade80;border:1px solid rgba(34,197,94,0.3);margin-bottom:12px}
      h1{font-size:1.6rem;font-weight:900;margin-bottom:8px}
      .note-stock{font-size:1.1rem;color:#67e8f9;margin-bottom:6px;font-weight:700}
      .visit-info{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:20px;font-size:0.85rem;color:rgba(255,255,255,0.5)}
      .visit-info span{display:flex;align-items:center;gap:4px}
      .author-row{display:flex;align-items:center;gap:12px;margin-bottom:24px}
      .author-row img{width:40px;height:40px;border-radius:50%;border:2px solid rgba(79,70,229,0.3)}
      .price-box{display:flex;align-items:center;justify-content:space-between;padding:20px 24px;background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.2);border-radius:16px;margin-bottom:24px}
      .price-label{font-size:0.85rem;color:rgba(255,255,255,0.5)}
      .price-value{font-size:1.5rem;font-weight:900;color:#fbbf24}
      .btn-primary{display:inline-block;padding:12px 32px;background:linear-gradient(135deg,#22c55e,#16a34a);border:none;border-radius:50px;color:#fff;font-size:0.95rem;font-weight:700;cursor:pointer;font-family:inherit;text-decoration:none;transition:all 0.3s;box-shadow:0 4px 20px rgba(34,197,94,0.3)}
      .summary-card{padding:24px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:16px;margin-bottom:20px}
      .summary-card h3{font-size:1rem;font-weight:700;margin-bottom:12px;color:#4ade80}
      .summary-card p{color:rgba(255,255,255,0.6);line-height:1.8;font-size:0.92rem;white-space:pre-wrap}
    </style></head><body>
    <nav>${buildNav(req.user)}</nav>
    <div class="container">
      <a href="/visit-notes" class="back-link">&larr; 탐방노트 목록</a>
      <span class="tag-note">탐방노트</span>
      <h1>${escapeHtml(report.title)}</h1>
      <div class="note-stock">${escapeHtml(report.stock_name)} ${report.stock_code ? '(' + escapeHtml(report.stock_code) + ')' : ''}</div>
      <div class="visit-info">
        <span>📅 ${visitDate}</span>
        <span>📍 ${escapeHtml(report.visit_location || '')}</span>
        <span>${escapeHtml(report.market_type || '')} · ${escapeHtml(report.sector || '')}</span>
      </div>
      <div class="author-row">
        <img src="${report.author_photo || ''}" alt="">
        <div>
          <div style="font-weight:700">${escapeHtml(report.author_name)}</div>
          <div style="font-size:0.78rem;color:rgba(255,255,255,0.3)">${report.published_at ? new Date(report.published_at).toLocaleDateString('ko-KR') : ''}</div>
        </div>
      </div>
      <div class="price-box">
        <div><div class="price-label">가격</div><div class="price-value">${price}</div></div>
        ${actionButton}
      </div>
      <div class="summary-card"><h3>요약</h3><p>${escapeHtml(report.summary)}</p></div>
      <div style="padding:16px 20px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.05);border-radius:12px;font-size:0.8rem;color:rgba(255,255,255,0.3)">
        보유 여부: ${escapeHtml(report.holding_disclosure || '')} · 이해충돌: ${escapeHtml(report.conflict_disclosure || '')}
      </div>
    </div></body></html>`;
  res.send(html);
});

// 탐방노트 구매
router.post('/:id/purchase', isLoggedIn, (req, res) => {
  const report = db.prepare("SELECT * FROM reports WHERE id = ? AND type = 'visit_note' AND status = 'on_sale'").get(req.params.id);
  if (!report) return res.status(404).send('탐방노트를 찾을 수 없습니다.');
  if (req.user.id === report.author_id) return res.redirect(`/visit-notes/${report.id}/view`);

  if (report.max_buyers > 0) {
    const cnt = db.prepare('SELECT COUNT(*) as c FROM orders WHERE report_id = ?').get(report.id).c;
    if (cnt >= report.max_buyers) return res.status(400).send('구매 가능 인원이 마감되었습니다.');
  }

  if (report.sale_price > 0) {
    const buyer = db.prepare('SELECT points FROM users WHERE id = ?').get(req.user.id);
    if (!buyer || buyer.points < report.sale_price) return res.status(400).send('포인트가 부족합니다.');
  }

  const existing = db.prepare('SELECT id FROM orders WHERE user_id = ? AND report_id = ?').get(req.user.id, report.id);
  if (!existing) {
    const tx = db.transaction(() => {
      db.prepare('INSERT INTO orders (user_id, report_id, amount, payment_status) VALUES (?, ?, ?, ?)').run(
        req.user.id, report.id, report.sale_price, 'completed'
      );

      if (report.sale_price > 0) {
        const price = report.sale_price;
        // 구매자 포인트 차감
        db.prepare('UPDATE users SET points = points - ? WHERE id = ?').run(price, req.user.id);
        db.prepare('INSERT INTO point_logs (user_id, amount, type, description, related_report_id) VALUES (?, ?, ?, ?, ?)').run(
          req.user.id, -price, 'purchase', `탐방노트 구매: ${report.title}`, report.id
        );

        // 작성자 70%
        const authorAmount = Math.floor(price * 0.70);
        db.prepare('UPDATE users SET points = points + ? WHERE id = ?').run(authorAmount, report.author_id);
        db.prepare('INSERT INTO point_logs (user_id, amount, type, description, related_user_id, related_report_id) VALUES (?, ?, ?, ?, ?, ?)').run(
          report.author_id, authorAmount, 'sales_revenue', `탐방노트 판매 수익 (70%): ${report.title}`, req.user.id, report.id
        );

        // 플랫폼(admin) 25%
        const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
        const adminAmount = Math.floor(price * 0.25);
        if (admin) {
          db.prepare('UPDATE users SET points = points + ? WHERE id = ?').run(adminAmount, admin.id);
          db.prepare('INSERT INTO point_logs (user_id, amount, type, description, related_user_id, related_report_id) VALUES (?, ?, ?, ?, ?, ?)').run(
            admin.id, adminAmount, 'sales_commission', `탐방노트 수수료 (25%): ${report.title}`, req.user.id, report.id
          );
        }

        // 작성자 추천인 5%
        const authorUser = db.prepare('SELECT referrer_id FROM users WHERE id = ?').get(report.author_id);
        if (authorUser?.referrer_id) {
          const refAmount = Math.floor(price * 0.05);
          if (refAmount > 0) {
            db.prepare('UPDATE users SET points = points + ? WHERE id = ?').run(refAmount, authorUser.referrer_id);
            db.prepare('INSERT INTO point_logs (user_id, amount, type, description, related_user_id, related_report_id) VALUES (?, ?, ?, ?, ?, ?)').run(
              authorUser.referrer_id, refAmount, 'referral_bonus', `탐방노트 추천인 보너스 (5%): ${report.title}`, req.user.id, report.id
            );
          }
        }
      }
    });
    tx();
  }

  res.redirect(`/visit-notes/${report.id}/view`);
});

// 탐방노트 열람 (구매 후)
router.get('/:id/view', isLoggedIn, (req, res) => {
  const report = db.prepare(`
    SELECT r.*, COALESCE(u.nickname, u.name) as author_name
    FROM reports r JOIN users u ON r.author_id = u.id
    WHERE r.id = ? AND r.type = 'visit_note'
  `).get(req.params.id);
  if (!report) return res.status(404).send('탐방노트를 찾을 수 없습니다.');

  const isOwner = req.user.id === report.author_id;
  const isAdmin = req.user.role === 'admin';
  const isFree = report.sale_price === 0;
  const hasPurchased = !!db.prepare('SELECT id FROM orders WHERE user_id = ? AND report_id = ?').get(req.user.id, report.id);
  if (!isOwner && !isAdmin && !isFree && !hasPurchased) return res.redirect(`/visit-notes/${report.id}`);

  const visitDate = report.visit_date ? new Date(report.visit_date).toLocaleDateString('ko-KR') : '';

  const sections = [
    { title: '탐방 목적', content: report.visit_purpose },
    { title: '탐방 내용 / 발견사항', content: report.visit_findings },
    { title: '투자 시사점 / 소감', content: report.visit_impressions },
    { title: '요약', content: report.summary },
    { title: '참고 자료', content: report.references_text },
  ].filter(s => s.content).map(s => `
    <div style="padding:28px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:20px;margin-bottom:20px">
      <h3 style="font-size:1.1rem;font-weight:700;margin-bottom:14px;color:#4ade80">${s.title}</h3>
      <p style="color:rgba(255,255,255,0.7);line-height:1.8;font-size:0.95rem;white-space:pre-wrap">${escapeHtml(s.content)}</p>
    </div>
  `).join('');

  const html = `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
    <title>${escapeHtml(report.title)} - 탐방노트 열람</title>
    <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;700;900&display=swap" rel="stylesheet">
    <style>
      *{margin:0;padding:0;box-sizing:border-box}body{font-family:'Noto Sans KR',sans-serif;background:linear-gradient(135deg,#0f0c29,#302b63,#24243e);color:#fff;min-height:100vh}
      @media print{body{display:none}}
      nav{position:sticky;top:0;z-index:100;display:flex;justify-content:space-between;align-items:center;padding:16px 40px;background:rgba(15,12,41,0.95);backdrop-filter:blur(20px);border-bottom:1px solid rgba(255,255,255,0.05)}
      .logo{font-size:1.4rem;font-weight:900;background:linear-gradient(135deg,#4f46e5,#06b6d4);-webkit-background-clip:text;-webkit-text-fill-color:transparent;text-decoration:none}
      .container{max-width:800px;margin:0 auto;padding:40px 20px}
      .back-link{color:rgba(255,255,255,0.4);text-decoration:none;font-size:0.9rem;margin-bottom:20px;display:inline-block}
      .watermark{position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:50;overflow:hidden}
      .watermark-text{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-35deg);font-size:3rem;font-weight:900;color:rgba(255,255,255,0.06);white-space:nowrap;user-select:none;width:300%;text-align:center;line-height:3}
    </style></head><body>
    <div class="watermark"><div class="watermark-text">${escapeHtml(req.user.email || req.user.name)} ${escapeHtml(req.user.email || req.user.name)} ${escapeHtml(req.user.email || req.user.name)}<br>${escapeHtml(req.user.email || req.user.name)} ${escapeHtml(req.user.email || req.user.name)} ${escapeHtml(req.user.email || req.user.name)}</div></div>
    <nav>${buildNav(req.user)}</nav>
    <div class="container" style="position:relative;z-index:10">
      <a href="/visit-notes/${report.id}" class="back-link">&larr; 탐방노트 상세</a>
      <div style="display:inline-block;padding:4px 14px;border-radius:20px;font-size:0.78rem;font-weight:700;background:rgba(34,197,94,0.15);color:#4ade80;border:1px solid rgba(34,197,94,0.3);margin-bottom:12px">탐방노트</div>
      <h1 style="font-size:1.8rem;font-weight:900;margin-bottom:8px">${escapeHtml(report.title)}</h1>
      <div style="font-size:1.1rem;color:#67e8f9;margin-bottom:8px">${escapeHtml(report.stock_name)} ${report.stock_code ? '(' + escapeHtml(report.stock_code) + ')' : ''}</div>
      <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:8px;font-size:0.85rem;color:rgba(255,255,255,0.5)">
        <span>📅 ${visitDate}</span>
        <span>📍 ${escapeHtml(report.visit_location || '')}</span>
      </div>
      <div style="color:rgba(255,255,255,0.4);font-size:0.9rem;margin-bottom:32px">${escapeHtml(report.author_name)} · ${report.published_at ? new Date(report.published_at).toLocaleDateString('ko-KR') : ''}</div>
      ${sections}
      <div style="margin-top:32px;padding:20px;background:rgba(255,255,255,0.03);border-radius:12px;border:1px solid rgba(255,255,255,0.08)">
        <h4 style="font-size:0.9rem;color:rgba(255,255,255,0.4);margin-bottom:8px">공시 사항</h4>
        <p style="font-size:0.85rem;color:rgba(255,255,255,0.3)">보유 여부: ${escapeHtml(report.holding_disclosure || '')}</p>
        <p style="font-size:0.85rem;color:rgba(255,255,255,0.3)">이해충돌: ${escapeHtml(report.conflict_disclosure || '')}</p>
      </div>
    </div></body></html>`;
  res.send(html);
});

module.exports = router;
