const express = require('express');
const db = require('../lib/db');
const { render, isLoggedIn, buildNav, escapeHtml, addPoints } = require('../lib/helpers');
const router = express.Router();

// 내 프로필
router.get('/profile', isLoggedIn, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const html = `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
    <title>프로필 설정 - StockStudyShare</title>
    <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;700;900&display=swap" rel="stylesheet">
    <style>
      *{margin:0;padding:0;box-sizing:border-box}
      body{font-family:'Noto Sans KR',sans-serif;background:linear-gradient(135deg,#0f0c29,#302b63,#24243e);color:#fff;min-height:100vh}
      nav{position:sticky;top:0;z-index:100;display:flex;justify-content:space-between;align-items:center;padding:16px 40px;background:rgba(255,255,255,0.03);backdrop-filter:blur(20px);backdrop-filter:blur(20px);border-bottom:1px solid rgba(255,255,255,0.08)}
      .logo{font-size:1.4rem;font-weight:900;background:linear-gradient(135deg,#4f46e5,#06b6d4);-webkit-background-clip:text;-webkit-text-fill-color:transparent;text-decoration:none}
      .nav-links{display:flex;align-items:center;gap:24px}
      
      .nav-item{padding:8px 16px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.08);border-radius:50px;color:rgba(255,255,255,0.5);text-decoration:none;font-size:0.82rem;font-weight:600;transition:all 0.3s}.nav-item:hover{background:rgba(79,70,229,0.1);border-color:rgba(79,70,229,0.4);color:#a5b4fc;transform:translateY(-1px)}
      .user-area{display:flex;align-items:center;gap:16px}
      .user-area img{width:36px;height:36px;border-radius:50%;border:2px solid rgba(79,70,229,0.5)}
      .logout-btn{padding:8px 20px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.08);border-radius:50px;color:rgba(255,255,255,0.5);text-decoration:none;font-size:0.85rem}
      .container{max-width:600px;margin:0 auto;padding:40px 20px}
      h1{font-size:1.5rem;font-weight:900;margin-bottom:24px}
      h1 .highlight{background:linear-gradient(135deg,#4f46e5,#06b6d4);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
      .profile-photo-section{text-align:center;margin-bottom:32px}
      .profile-photo{width:100px;height:100px;border-radius:50%;border:3px solid rgba(79,70,229,0.5);object-fit:cover}
      .photo-name{font-size:0.85rem;color:rgba(255,255,255,0.4);margin-top:8px}
      .form-group{margin-bottom:20px}
      .form-group label{display:block;font-size:0.9rem;font-weight:700;margin-bottom:6px;color:rgba(255,255,255,0.8)}
      .form-group .hint{font-size:0.78rem;color:rgba(255,255,255,0.3);margin-bottom:6px}
      .form-group input,.form-group select{width:100%;padding:12px 16px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:12px;color:#fff;font-size:0.95rem;font-family:inherit}
      .form-group input:focus{outline:none;border-color:rgba(79,70,229,0.5)}
      .form-group input:disabled{opacity:0.5;cursor:not-allowed}
      .info-card{padding:16px 20px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:12px;margin-bottom:20px}
      .info-card .info-label{font-size:0.8rem;color:rgba(255,255,255,0.4)}
      .info-card .info-value{font-size:0.95rem;font-weight:700;margin-top:2px}
      .btn-save{display:block;width:100%;padding:14px;background:linear-gradient(135deg,#4f46e5,#6366f1);border:none;border-radius:14px;color:#fff;font-size:1rem;font-weight:700;cursor:pointer;font-family:inherit;transition:all 0.3s;margin-top:28px}
      .btn-save:hover{transform:translateY(-2px);box-shadow:0 8px 30px rgba(79,70,229,0.5)}
      .btn-save:disabled{opacity:0.5;cursor:default;transform:none;box-shadow:none}
      .msg{padding:12px 16px;border-radius:10px;margin-bottom:16px;font-size:0.88rem;display:none}
      .msg.success{display:block;background:rgba(74,222,128,0.1);border:1px solid rgba(74,222,128,0.2);color:#4ade80}
      .msg.error{display:block;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.2);color:#ef4444}
      .role-badge{display:inline-block;padding:4px 12px;border-radius:10px;font-size:0.78rem;font-weight:700}
    </style></head><body>
    <nav>${buildNav(req.user)}</nav>
    <div class="container">
      <h1><span class="highlight">프로필</span> 설정</h1>

      <div id="msg" class="msg"></div>

      <div class="profile-photo-section">
        <img src="${user.photo || ''}" class="profile-photo" alt="프로필">
        <div class="photo-name">Google 계정 프로필 사진</div>
      </div>

      <form id="profile-form">
        <div class="form-group">
          <label>닉네임</label>
          <div class="hint">2~20자, 한글/영문/숫자/공백/밑줄(_) 사용 가능</div>
          <input type="text" name="nickname" id="nickname" value="${escapeHtml(user.nickname || '')}" required minlength="2" maxlength="20">
        </div>

        <div class="form-group">
          <label>이름 (Google 계정)</label>
          <input type="text" value="${escapeHtml(user.name)}" disabled>
        </div>

        <div class="form-group">
          <label>이메일</label>
          <input type="text" value="${escapeHtml(user.email || '')}" disabled>
        </div>

        <div style="display:flex;gap:16px">
          <div class="info-card" style="flex:1">
            <div class="info-label">역할</div>
            <div class="info-value">${{'user':'일반유저','study_member':'스터디원','study_leader':'스터디장','admin':'관리자'}[user.role] || user.role}</div>
          </div>
          <div class="info-card" style="flex:1">
            <div class="info-label">보유 포인트</div>
            <div class="info-value" style="color:#fbbf24">${(user.points || 0).toLocaleString()}P</div>
          </div>
          <div class="info-card" style="flex:1">
            <div class="info-label">가입일</div>
            <div class="info-value">${new Date(user.joined_at).toLocaleDateString('ko-KR')}</div>
          </div>
        </div>

        <button type="submit" class="btn-save" id="btn-save">저장하기</button>
      </form>
    </div>
    <script>
      document.getElementById('profile-form').addEventListener('submit', function(e) {
        e.preventDefault();
        var btn = document.getElementById('btn-save');
        var msg = document.getElementById('msg');
        btn.disabled = true;
        btn.textContent = '저장 중...';
        msg.className = 'msg';

        fetch('/my/profile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ nickname: document.getElementById('nickname').value.trim() })
        }).then(function(r) { return r.json(); }).then(function(data) {
          btn.disabled = false;
          btn.textContent = '저장하기';
          if (data.ok) {
            msg.textContent = '프로필이 저장되었습니다.';
            msg.className = 'msg success';
            setTimeout(function() { window.location.reload(); }, 1000);
          } else {
            msg.textContent = data.error || '오류가 발생했습니다.';
            msg.className = 'msg error';
          }
        }).catch(function() {
          btn.disabled = false;
          btn.textContent = '저장하기';
          msg.textContent = '네트워크 오류가 발생했습니다.';
          msg.className = 'msg error';
        });
      });
    </script></body></html>`;
  res.send(html);
});

// 프로필 저장
router.post('/profile', isLoggedIn, (req, res) => {
  const nickname = (req.body.nickname || '').trim();

  if (!nickname || nickname.length < 2 || nickname.length > 20) {
    return res.json({ ok: false, error: '닉네임은 2~20자여야 합니다.' });
  }
  if (!/^[가-힣a-zA-Z0-9_ ]+$/.test(nickname)) {
    return res.json({ ok: false, error: '닉네임은 한글, 영문, 숫자, 공백, 밑줄(_)만 사용할 수 있습니다.' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE nickname = ? AND id != ?').get(nickname, req.user.id);
  if (existing) {
    return res.json({ ok: false, error: '이미 사용 중인 닉네임입니다.' });
  }

  db.prepare('UPDATE users SET nickname = ? WHERE id = ?').run(nickname, req.user.id);
  req.user.nickname = nickname;

  res.json({ ok: true });
});

// 내 구매내역
router.get('/purchases', isLoggedIn, (req, res) => {
  const orders = db.prepare(`
    SELECT o.*, r.title, r.stock_name, r.stock_code, r.author_id,
           u.name as author_name, ap.display_name
    FROM orders o
    JOIN reports r ON o.report_id = r.id
    JOIN users u ON r.author_id = u.id
    LEFT JOIN author_profiles ap ON r.author_id = ap.user_id
    WHERE o.user_id = ?
    ORDER BY o.created_at DESC
  `).all(req.user.id);

  const rows = orders.map(o => {
    const displayName = o.display_name || o.author_name;
    const price = o.amount === 0 ? '무료' : `${o.amount.toLocaleString()}P`;
    return `
      <tr>
        <td><a href="/reports/${o.report_id}/view">${escapeHtml(o.title)}</a></td>
        <td>${escapeHtml(o.stock_name)}</td>
        <td>${escapeHtml(displayName)}</td>
        <td>${price}</td>
        <td>${new Date(o.created_at).toLocaleDateString('ko-KR')}</td>
        <td><a href="/reports/${o.report_id}/view" class="btn-sm">열람</a></td>
      </tr>`;
  }).join('');

  const html = render('views/my-purchases.html', {
    nav: buildNav(req.user),
    purchaseRows: rows || '<tr><td colspan="6" class="empty-text">구매 내역이 없습니다.</td></tr>',
    totalCount: String(orders.length),
  });
  res.send(html);
});

// 포인트 충전 페이지
router.get('/points', isLoggedIn, (req, res) => {
  const logs = db.prepare('SELECT * FROM point_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').all(req.user.id);

  const pointHistory = logs.length > 0 ? logs.map(l => {
    const isPlus = l.amount > 0;
    return `
      <div class="history-item">
        <div>
          <div class="desc">${escapeHtml(l.description || l.type)}</div>
          <div class="date">${new Date(l.created_at).toLocaleString('ko-KR')}</div>
        </div>
        <div class="amount ${isPlus ? 'plus' : 'minus'}">${isPlus ? '+' : ''}${l.amount.toLocaleString()}P</div>
      </div>`;
  }).join('') : '<p class="empty-text">포인트 내역이 없습니다.</p>';

  const html = render('views/points.html', {
    nav: buildNav(req.user),
    currentPoints: (req.user.points || 0).toLocaleString(),
    nickname: escapeHtml(req.user.nickname || req.user.name),
    pointHistory,
  });
  res.send(html);
});

// 포인트 충전 처리
router.post('/points/purchase', isLoggedIn, (req, res) => {
  const points = parseInt(req.body.points);
  const price = parseInt(req.body.price);

  // 유효한 상품인지 확인
  const validPlans = [
    { points: 100000, price: 100000 },
    { points: 1000000, price: 1000000 },
  ];
  const plan = validPlans.find(p => p.points === points && p.price === price);
  if (!plan) {
    return res.json({ ok: false, error: '유효하지 않은 상품입니다.' });
  }

  // mock 결제: 바로 포인트 지급
  addPoints(db, req.user.id, plan.points, 'charge', `포인트 충전 (${plan.price.toLocaleString()}원)`, null);

  res.json({ ok: true });
});

// 작성자 지원 폼
router.get('/author-apply', isLoggedIn, (req, res) => {
  if (req.user.role === 'study_leader' || req.user.role === 'admin') {
    return res.redirect('/author/dashboard');
  }

  const existing = db.prepare('SELECT * FROM author_applications WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(req.user.id);
  if (existing && existing.status === 'pending') {
    return res.redirect('/my/author-apply-status');
  }

  // 반려된 경우 이전 내용 미리 채워주기
  const prev = (existing && existing.status === 'rejected') ? existing : null;

  const html = render('views/author-apply.html', {
    nav: buildNav(req.user),
    userName: escapeHtml(req.user.name),
    userEmail: escapeHtml(req.user.email || ''),
    prevIntro: escapeHtml(prev?.intro || ''),
    prevCareer: escapeHtml(prev?.career || ''),
    prevLinks: escapeHtml(prev?.external_links || ''),
    prevSample: escapeHtml(prev?.sample_report || ''),
    isReapply: prev ? 'true' : '',
    rejectMemo: escapeHtml(prev ? (existing.admin_memo || '') : ''),
  });
  res.send(html);
});

// 작성자 지원 제출
router.post('/author-apply', isLoggedIn, (req, res) => {
  const { intro, career, external_links, sample_report } = req.body;

  if (!intro || !career) {
    return res.status(400).send('필수 항목을 모두 입력해주세요.');
  }

  // 중복 제출 방지: pending 상태 지원서가 있으면 거부
  const existing = db.prepare("SELECT id FROM author_applications WHERE user_id = ? AND status = 'pending'").get(req.user.id);
  if (existing) {
    return res.redirect('/my/author-apply-status');
  }

  db.prepare(`INSERT INTO author_applications (user_id, intro, career, external_links, sample_report)
              VALUES (?, ?, ?, ?, ?)`).run(
    req.user.id, intro, career, external_links || '', sample_report || ''
  );

  // 작성자 지원 시 역할 변경 없음 (관리자가 스터디장으로 지정)

  res.redirect('/my/author-apply-status');
});

// 지원 상태 확인
router.get('/author-apply-status', isLoggedIn, (req, res) => {
  const app = db.prepare('SELECT * FROM author_applications WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(req.user.id);

  if (!app) return res.redirect('/my/author-apply');

  const statusMap = { pending: '심사 중', approved: '승인됨', rejected: '반려됨' };

  const memoSection = app.admin_memo
    ? `<div class="memo-card"><h3>관리자 메모</h3><p>${escapeHtml(app.admin_memo)}</p></div>`
    : '';

  const reapplySection = app.status === 'rejected'
    ? `<div style="text-align:center;margin-top:24px"><a href="/my/author-apply" class="btn-reapply">다시 지원하기</a></div>`
    : '';

  const html = render('views/author-apply-status.html', {
    nav: buildNav(req.user),
    status: statusMap[app.status] || app.status,
    statusClass: app.status,
    intro: escapeHtml(app.intro),
    career: escapeHtml(app.career),
    appliedAt: new Date(app.created_at).toLocaleDateString('ko-KR'),
    memoSection,
    reapplySection,
  });
  res.send(html);
});

module.exports = router;
