const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../lib/db');
const { render, isLoggedIn, buildNav, escapeHtml, addPoints, adBannerHtml } = require('../lib/helpers');
const router = express.Router();

const profileUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), 'uploads', 'profiles');
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.jpg';
      cb(null, `${req.user.id}_${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|gif|webp)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('이미지 파일만 업로드 가능합니다.'));
  },
});

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
      .profile-photo{width:100px;height:100px;border-radius:50%;border:3px solid rgba(79,70,229,0.5);object-fit:cover;cursor:pointer;transition:opacity 0.2s}
      .profile-photo:hover{opacity:0.7}
      .photo-name{font-size:0.85rem;color:rgba(255,255,255,0.4);margin-top:8px}
      .photo-actions{display:flex;gap:8px;justify-content:center;margin-top:10px}
      .btn-photo{padding:6px 16px;border-radius:10px;font-size:0.78rem;font-weight:700;cursor:pointer;font-family:inherit;transition:all 0.2s;border:none}
      .btn-photo-upload{background:linear-gradient(135deg,#4f46e5,#6366f1);color:#fff}
      .btn-photo-upload:hover{transform:translateY(-1px);box-shadow:0 2px 12px rgba(79,70,229,0.4)}
      .btn-photo-reset{background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);color:rgba(255,255,255,0.5)}
      .btn-photo-reset:hover{color:#ef4444;border-color:rgba(239,68,68,0.3)}
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
        <img src="${escapeHtml(user.custom_photo || user.photo || '')}" class="profile-photo" id="profile-img" alt="프로필" onclick="document.getElementById('photo-input').click()">
        <div class="photo-name" id="photo-label">${user.custom_photo ? '커스텀 프로필 사진' : 'Google 계정 프로필 사진'}</div>
        <input type="file" id="photo-input" accept="image/jpeg,image/png,image/gif,image/webp" style="display:none" onchange="uploadPhoto(this)">
        <div class="photo-actions">
          <button type="button" class="btn-photo btn-photo-upload" onclick="document.getElementById('photo-input').click()">사진 변경</button>
          ${user.custom_photo ? '<button type="button" class="btn-photo btn-photo-reset" onclick="resetPhoto()">기본으로 되돌리기</button>' : ''}
        </div>
      </div>

      <form id="profile-form">
        <div class="form-group">
          <label>닉네임</label>
          <div class="hint">2~20자, 한글/영문/숫자/공백/밑줄(_) 사용 가능</div>
          <input type="text" name="nickname" id="nickname" value="${escapeHtml(user.nickname || '')}" required minlength="2" maxlength="20">
        </div>

        <div class="form-group">
          <label>자기소개</label>
          <div class="hint">리포터 보기 등에서 표시됩니다. (최대 200자)</div>
          <textarea id="bio" name="bio" maxlength="200" rows="3" style="width:100%;padding:12px 16px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:12px;color:#fff;font-size:0.95rem;font-family:inherit;resize:vertical">${escapeHtml(user.bio || '')}</textarea>
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
      function uploadPhoto(input) {
        if (!input.files || !input.files[0]) return;
        var file = input.files[0];
        if (file.size > 5 * 1024 * 1024) { alert('파일 크기는 5MB 이하만 가능합니다.'); return; }
        var formData = new FormData();
        formData.append('photo', file);
        var img = document.getElementById('profile-img');
        img.style.opacity = '0.5';
        fetch('/my/profile/photo', { method: 'POST', body: formData, credentials: 'same-origin' })
          .then(function(r) { return r.json(); })
          .then(function(data) {
            if (data.ok) {
              window.location.reload();
            } else {
              alert(data.error || '업로드에 실패했습니다.');
              img.style.opacity = '1';
            }
          }).catch(function() { alert('오류가 발생했습니다.'); img.style.opacity = '1'; });
      }
      function resetPhoto() {
        if (!confirm('Google 계정 프로필 사진으로 되돌리시겠습니까?')) return;
        fetch('/my/profile/photo', { method: 'DELETE', credentials: 'same-origin' })
          .then(function(r) { return r.json(); })
          .then(function(data) {
            if (data.ok) window.location.reload();
            else alert(data.error || '오류가 발생했습니다.');
          }).catch(function() { alert('오류가 발생했습니다.'); });
      }
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
          body: JSON.stringify({ nickname: document.getElementById('nickname').value.trim(), bio: document.getElementById('bio').value.trim() })
        }).then(function(r) { return r.json(); }).then(function(data) {
          btn.disabled = false;
          btn.textContent = '저장하기';
          if (data.ok) {
            msg.textContent = '프로필이 저장되었습니다. 대시보드로 이동합니다.';
            msg.className = 'msg success';
            setTimeout(function() { window.location.href = '/dashboard'; }, 1000);
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

// 프로필 사진 업로드
router.post('/profile/photo', isLoggedIn, profileUpload.single('photo'), (req, res) => {
  if (!req.file) return res.json({ ok: false, error: '이미지 파일을 선택해주세요.' });
  const photoUrl = `/uploads/profiles/${req.file.filename}`;

  // 이전 커스텀 사진 삭제
  const user = db.prepare('SELECT custom_photo FROM users WHERE id = ?').get(req.user.id);
  if (user?.custom_photo) {
    const oldPath = path.join(__dirname, '..', user.custom_photo);
    try { fs.unlinkSync(oldPath); } catch {}
  }

  db.prepare('UPDATE users SET custom_photo = ? WHERE id = ?').run(photoUrl, req.user.id);
  req.user.custom_photo = photoUrl;
  res.json({ ok: true, photoUrl });
});

// 프로필 사진 초기화 (Google 사진으로 되돌리기)
router.delete('/profile/photo', isLoggedIn, (req, res) => {
  const user = db.prepare('SELECT custom_photo FROM users WHERE id = ?').get(req.user.id);
  if (user?.custom_photo) {
    const oldPath = path.join(__dirname, '..', user.custom_photo);
    try { fs.unlinkSync(oldPath); } catch {}
  }
  db.prepare('UPDATE users SET custom_photo = NULL WHERE id = ?').run(req.user.id);
  req.user.custom_photo = null;
  res.json({ ok: true });
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

  const bio = (req.body.bio || '').trim().slice(0, 200);

  db.prepare('UPDATE users SET nickname = ?, bio = ? WHERE id = ?').run(nickname, bio || null, req.user.id);
  req.user.nickname = nickname;
  req.user.bio = bio || null;

  res.json({ ok: true });
});

// 내 구매내역
router.get('/purchases', isLoggedIn, (req, res) => {
  const orders = db.prepare(`
    SELECT o.*, r.title, r.stock_name, r.stock_code, r.author_id,
           COALESCE(u.nickname, ap.display_name, u.name) as author_name
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
    adBanner: adBannerHtml(),
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
    adBanner: adBannerHtml(),
  });
  res.send(html);
});

// 상점
router.get('/shop', isLoggedIn, (req, res) => {
  const user = db.prepare('SELECT points FROM users WHERE id = ?').get(req.user.id);

  // 광고 제거 보유 확인
  const hasAdRemove = !!db.prepare("SELECT id FROM shop_purchases WHERE user_id = ? AND item_key = 'ad_remove'").get(req.user.id);

  // 내 보유 아이템
  const myPurchases = db.prepare("SELECT * FROM shop_purchases WHERE user_id = ? ORDER BY created_at DESC").all(req.user.id);
  const itemNames = { ad_remove: '광고 제거', skip_monthly: '리포트 회피권 (월간)', skip_annual: '리포트 회피권 (연간)' };
  const itemIcons = { ad_remove: '🚫', skip_monthly: '🛡️', skip_annual: '🛡️' };

  const myItems = myPurchases.length > 0 ? myPurchases.map(p => {
    const expired = p.expires_at && new Date(p.expires_at) < new Date();
    const expStr = p.expires_at ? (expired ? '만료됨 (' + new Date(p.expires_at).toLocaleDateString('ko-KR') + ')' : new Date(p.expires_at).toLocaleDateString('ko-KR') + '까지') : '영구';
    return `<div class="my-item">
      <span class="my-item-icon">${itemIcons[p.item_key] || '📦'}</span>
      <div class="my-item-info">
        <div class="my-item-name">${escapeHtml(itemNames[p.item_key] || p.item_key)}</div>
        <div class="my-item-exp">${expStr} · ${new Date(p.created_at).toLocaleDateString('ko-KR')} 구매</div>
      </div>
      ${!expired ? '<span class="my-item-active">사용중</span>' : ''}
    </div>`;
  }).join('') : '<div class="empty-text">구매한 아이템이 없습니다.</div>';

  // 가입 스터디방 목록
  const rooms = db.prepare('SELECT sr.id, sr.name FROM study_rooms sr JOIN study_members sm ON sr.id = sm.room_id WHERE sm.user_id = ?').all(req.user.id);
  const studyRoomOptions = rooms.length > 0
    ? rooms.map(r => `<option value="${r.id}">${escapeHtml(r.name)}</option>`).join('')
    : '<option value="">가입된 스터디방 없음</option>';

  const html = render('views/shop.html', {
    nav: buildNav(req.user),
    myPoints: (user?.points || 0).toLocaleString(),
    adRemoveOwned: hasAdRemove ? 'owned' : '',
    adRemoveDisabled: hasAdRemove ? 'disabled' : '',
    adRemoveText: hasAdRemove ? '보유중' : '구매하기',
    myItems,
    studyRoomOptions,
  });
  res.send(html);
});

// 상점 구매
router.post('/shop/purchase', isLoggedIn, (req, res) => {
  const { item_key, price, study_room_id } = req.body;

  const validItems = {
    ad_remove: { price: 100000, needRoom: false, duration: null },
    skip_monthly: { price: 100000, needRoom: true, duration: 30 },
    skip_annual: { price: 1000000, needRoom: true, duration: 365 },
  };

  const item = validItems[item_key];
  if (!item || item.price !== price) return res.json({ ok: false, error: '유효하지 않은 상품입니다.' });

  // 중복 구매 체크 (광고 제거)
  if (item_key === 'ad_remove') {
    const existing = db.prepare("SELECT id FROM shop_purchases WHERE user_id = ? AND item_key = 'ad_remove'").get(req.user.id);
    if (existing) return res.json({ ok: false, error: '이미 보유 중입니다.' });
  }

  // 포인트 확인
  const user = db.prepare('SELECT points FROM users WHERE id = ?').get(req.user.id);
  if (!user || user.points < item.price) {
    return res.json({ ok: false, error: `포인트가 부족합니다. (보유: ${(user?.points || 0).toLocaleString()}P)` });
  }

  // 스터디방 확인
  let roomId = null;
  if (item.needRoom) {
    roomId = parseInt(study_room_id);
    if (!roomId) return res.json({ ok: false, error: '스터디방을 선택해주세요.' });
    const isMember = db.prepare('SELECT id FROM study_members WHERE room_id = ? AND user_id = ?').get(roomId, req.user.id);
    if (!isMember) return res.json({ ok: false, error: '해당 스터디방의 멤버가 아닙니다.' });
  }

  const expiresAt = item.duration ? new Date(Date.now() + item.duration * 86400000).toISOString() : null;

  const purchaseTx = db.transaction(() => {
    // 포인트 차감
    db.prepare('UPDATE users SET points = points - ? WHERE id = ?').run(item.price, req.user.id);
    db.prepare('INSERT INTO point_logs (user_id, amount, type, description) VALUES (?, ?, ?, ?)').run(
      req.user.id, -item.price, 'shop', `상점 구매: ${item_key}`
    );

    // 구매 기록
    db.prepare('INSERT INTO shop_purchases (user_id, item_key, price, study_room_id, expires_at) VALUES (?, ?, ?, ?, ?)').run(
      req.user.id, item_key, item.price, roomId, expiresAt
    );

    // 스터디방 포인트 합산 (회피권)
    if (roomId) {
      db.prepare('UPDATE study_rooms SET points = points + ? WHERE id = ?').run(item.price, roomId);
      db.prepare('INSERT INTO study_point_logs (room_id, amount, type, description) VALUES (?, ?, ?, ?)').run(
        roomId, item.price, 'shop_item', `리포트 회피권 구매 (${req.user.nickname || req.user.name})`
      );
    }
  });
  purchaseTx();

  res.json({ ok: true });
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

// ── 쪽지(DM) 시스템 ──

// 쪽지 목록
router.get('/messages', isLoggedIn, (req, res) => {
  const threads = db.prepare(`
    SELECT dt.*,
      (SELECT content FROM dm_messages WHERE thread_id = dt.id ORDER BY created_at DESC LIMIT 1) as last_message,
      (SELECT COUNT(*) FROM dm_messages WHERE thread_id = dt.id AND is_read = 0 AND sender_id != ?) as unread_count
    FROM dm_threads dt
    WHERE dt.user_id = ?
    ORDER BY dt.updated_at DESC
  `).all(req.user.id, req.user.id);

  const threadRows = threads.length > 0 ? threads.map(t => {
    const timeAgo = getTimeAgo(t.updated_at);
    return `<a href="/my/messages/${t.id}" class="thread-row ${t.unread_count > 0 ? 'unread' : ''}">
      <div class="thread-main">
        <div class="thread-subject">${escapeHtml(t.subject)}${t.unread_count > 0 ? ' <span class="unread-badge">' + t.unread_count + '</span>' : ''}</div>
        <div class="thread-preview">${escapeHtml((t.last_message || '').slice(0, 60))}</div>
      </div>
      <div class="thread-time">${timeAgo}</div>
    </a>`;
  }).join('') : '<div class="empty-text">쪽지가 없습니다.</div>';

  const html = `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
    <title>쪽지함 - StockStudyShare</title>
    <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;700;900&display=swap" rel="stylesheet">
    <style>
      *{margin:0;padding:0;box-sizing:border-box}
      body{font-family:'Noto Sans KR',sans-serif;background:linear-gradient(135deg,#0f0c29,#302b63,#24243e);color:#fff;min-height:100vh}
      .container{max-width:700px;margin:0 auto;padding:40px 20px}
      .back-link{color:rgba(255,255,255,0.4);text-decoration:none;font-size:0.9rem;margin-bottom:20px;display:inline-block}
      h1{font-size:1.5rem;font-weight:900;margin-bottom:20px}
      h1 .highlight{background:linear-gradient(135deg,#4f46e5,#06b6d4);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
      .thread-row{display:flex;align-items:center;gap:14px;padding:16px 20px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:14px;margin-bottom:8px;text-decoration:none;color:#fff;transition:all 0.2s}
      .thread-row:hover{background:rgba(255,255,255,0.06)}
      .thread-row.unread{border-left:3px solid #4f46e5;background:rgba(79,70,229,0.05)}
      .thread-main{flex:1;min-width:0}
      .thread-subject{font-size:0.95rem;font-weight:700;margin-bottom:4px}
      .thread-preview{font-size:0.82rem;color:rgba(255,255,255,0.4);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .thread-time{font-size:0.75rem;color:rgba(255,255,255,0.25);flex-shrink:0}
      .unread-badge{display:inline-block;padding:1px 7px;background:#4f46e5;color:#fff;border-radius:10px;font-size:0.68rem;font-weight:700;margin-left:6px}
      .btn-new{display:inline-block;padding:10px 24px;background:linear-gradient(135deg,#4f46e5,#6366f1);border-radius:50px;color:#fff;text-decoration:none;font-size:0.85rem;font-weight:700;margin-bottom:20px}
      .empty-text{color:rgba(255,255,255,0.25);text-align:center;padding:40px;font-size:0.9rem}
    </style></head><body>
    <nav>${buildNav(req.user)}</nav>
    <div class="container">
      <a href="/dashboard" class="back-link">&larr; 대시보드</a>
      <h1><span class="highlight">쪽지함</span></h1>
      <a href="/my/messages/new" class="btn-new">+ 새 쪽지</a>
      ${threadRows}
    </div></body></html>`;
  res.send(html);
});

// 새 쪽지 작성
router.get('/messages/new', isLoggedIn, (req, res) => {
  const subject = req.query.subject || '';
  const html = `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
    <title>새 쪽지 - StockStudyShare</title>
    <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;700;900&display=swap" rel="stylesheet">
    <style>
      *{margin:0;padding:0;box-sizing:border-box}
      body{font-family:'Noto Sans KR',sans-serif;background:linear-gradient(135deg,#0f0c29,#302b63,#24243e);color:#fff;min-height:100vh}
      .container{max-width:600px;margin:0 auto;padding:40px 20px}
      .back-link{color:rgba(255,255,255,0.4);text-decoration:none;font-size:0.9rem;margin-bottom:20px;display:inline-block}
      h1{font-size:1.5rem;font-weight:900;margin-bottom:20px}
      h1 .highlight{background:linear-gradient(135deg,#4f46e5,#06b6d4);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
      .form-group{margin-bottom:20px}
      .form-group label{display:block;font-size:0.9rem;font-weight:700;margin-bottom:8px;color:rgba(255,255,255,0.8)}
      .form-group input,.form-group textarea{width:100%;padding:14px 18px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:14px;color:#fff;font-size:0.95rem;font-family:inherit}
      .form-group input:focus,.form-group textarea:focus{outline:none;border-color:rgba(79,70,229,0.5)}
      .form-group textarea{min-height:150px;resize:vertical;line-height:1.7}
      .btn-send{width:100%;padding:16px;background:linear-gradient(135deg,#4f46e5,#6366f1);border:none;border-radius:14px;color:#fff;font-size:1rem;font-weight:700;cursor:pointer;font-family:inherit}
      .btn-send:disabled{opacity:0.5}
    </style></head><body>
    <nav>${buildNav(req.user)}</nav>
    <div class="container">
      <a href="/my/messages" class="back-link">&larr; 쪽지함</a>
      <h1><span class="highlight">관리자에게</span> 쪽지 보내기</h1>
      <div class="form-group">
        <label>제목</label>
        <input type="text" id="inp-subject" value="${escapeHtml(subject)}" placeholder="문의 제목">
      </div>
      <div class="form-group">
        <label>내용</label>
        <textarea id="inp-content" placeholder="문의 내용을 작성해주세요..."></textarea>
      </div>
      <button class="btn-send" id="btn-send" onclick="sendMessage()">보내기</button>
    </div>
    <script>
      function sendMessage() {
        var subject = document.getElementById('inp-subject').value.trim();
        var content = document.getElementById('inp-content').value.trim();
        if (!subject || !content) { alert('제목과 내용을 입력해주세요.'); return; }
        var btn = document.getElementById('btn-send');
        btn.disabled = true; btn.textContent = '전송 중...';
        fetch('/my/messages/new', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
          body: JSON.stringify({ subject: subject, content: content })
        }).then(function(r) { return r.json(); }).then(function(d) {
          if (d.ok) window.location.href = '/my/messages/' + d.threadId;
          else { alert(d.error); btn.disabled = false; btn.textContent = '보내기'; }
        });
      }
    </script></body></html>`;
  res.send(html);
});

// 새 쪽지 전송
router.post('/messages/new', isLoggedIn, (req, res) => {
  const { subject, content } = req.body;
  if (!subject || !content) return res.json({ ok: false, error: '제목과 내용을 입력해주세요.' });

  const result = db.prepare('INSERT INTO dm_threads (user_id, subject) VALUES (?, ?)').run(req.user.id, subject);
  const threadId = result.lastInsertRowid;
  db.prepare('INSERT INTO dm_messages (thread_id, sender_id, content) VALUES (?, ?, ?)').run(threadId, req.user.id, content);

  // 관리자에게 알림
  const { notify } = require('../lib/helpers');
  const admins = db.prepare("SELECT id FROM users WHERE role = 'admin'").all();
  const userName = req.user.nickname || req.user.name;
  for (const admin of admins) {
    notify(db, admin.id, 'points', '새 쪽지', `${userName}님이 쪽지를 보냈습니다: ${subject}`, '/admin/messages/' + threadId);
  }

  res.json({ ok: true, threadId });
});

// 쪽지 대화 보기
router.get('/messages/:id', isLoggedIn, (req, res) => {
  const thread = db.prepare('SELECT * FROM dm_threads WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!thread) return res.status(404).send('쪽지를 찾을 수 없습니다.');

  // 읽음 처리
  db.prepare('UPDATE dm_messages SET is_read = 1 WHERE thread_id = ? AND sender_id != ?').run(thread.id, req.user.id);

  const messages = db.prepare(`
    SELECT dm.*, u.nickname, u.name, u.photo, u.role
    FROM dm_messages dm
    JOIN users u ON dm.sender_id = u.id
    WHERE dm.thread_id = ?
    ORDER BY dm.created_at ASC
  `).all(thread.id);

  const msgHtml = messages.map(m => {
    const isMe = m.sender_id === req.user.id;
    const displayName = m.nickname || m.name;
    const roleBadge = m.role === 'admin' ? '<span style="font-size:0.65rem;padding:2px 6px;background:rgba(168,85,247,0.2);color:#c084fc;border-radius:6px;margin-left:4px">관리자</span>' : '';
    return `<div class="msg ${isMe ? 'msg-me' : 'msg-other'}">
      <div class="msg-header"><span class="msg-name">${escapeHtml(displayName)}${roleBadge}</span><span class="msg-time">${getTimeAgo(m.created_at)}</span></div>
      <div class="msg-content">${escapeHtml(m.content)}</div>
    </div>`;
  }).join('');

  const html = `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
    <title>${escapeHtml(thread.subject)} - 쪽지</title>
    <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;700;900&display=swap" rel="stylesheet">
    <style>
      *{margin:0;padding:0;box-sizing:border-box}
      body{font-family:'Noto Sans KR',sans-serif;background:linear-gradient(135deg,#0f0c29,#302b63,#24243e);color:#fff;min-height:100vh}
      .container{max-width:700px;margin:0 auto;padding:40px 20px}
      .back-link{color:rgba(255,255,255,0.4);text-decoration:none;font-size:0.9rem;margin-bottom:20px;display:inline-block}
      h1{font-size:1.3rem;font-weight:900;margin-bottom:20px}
      .msg{padding:14px 18px;border-radius:14px;margin-bottom:10px;max-width:85%}
      .msg-me{background:rgba(79,70,229,0.15);border:1px solid rgba(79,70,229,0.25);margin-left:auto}
      .msg-other{background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08)}
      .msg-header{display:flex;justify-content:space-between;margin-bottom:6px;font-size:0.78rem}
      .msg-name{font-weight:700;color:rgba(255,255,255,0.7)}
      .msg-time{color:rgba(255,255,255,0.25)}
      .msg-content{font-size:0.9rem;color:rgba(255,255,255,0.6);line-height:1.7;white-space:pre-wrap}
      .reply-form{display:flex;gap:10px;margin-top:20px;padding-top:20px;border-top:1px solid rgba(255,255,255,0.06)}
      .reply-form textarea{flex:1;padding:12px 16px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:14px;color:#fff;font-size:0.9rem;font-family:inherit;min-height:60px;resize:none}
      .reply-form textarea:focus{outline:none;border-color:rgba(79,70,229,0.5)}
      .btn-reply{padding:12px 24px;background:linear-gradient(135deg,#4f46e5,#6366f1);border:none;border-radius:14px;color:#fff;font-size:0.85rem;font-weight:700;cursor:pointer;font-family:inherit;align-self:flex-end}
    </style></head><body>
    <nav>${buildNav(req.user)}</nav>
    <div class="container">
      <a href="/my/messages" class="back-link">&larr; 쪽지함</a>
      <h1>${escapeHtml(thread.subject)}</h1>
      ${msgHtml}
      <div class="reply-form">
        <textarea id="reply-input" placeholder="답장을 입력하세요..."></textarea>
        <button class="btn-reply" onclick="sendReply()">답장</button>
      </div>
    </div>
    <script>
      function sendReply() {
        var content = document.getElementById('reply-input').value.trim();
        if (!content) return;
        fetch('/my/messages/${thread.id}/reply', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
          body: JSON.stringify({ content: content })
        }).then(function(r) { return r.json(); }).then(function(d) {
          if (d.ok) window.location.reload();
          else alert(d.error);
        });
      }
    </script></body></html>`;
  res.send(html);
});

// 답장
router.post('/messages/:id/reply', isLoggedIn, (req, res) => {
  const thread = db.prepare('SELECT * FROM dm_threads WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!thread) return res.json({ ok: false, error: '쪽지를 찾을 수 없습니다.' });

  const { content } = req.body;
  if (!content) return res.json({ ok: false, error: '내용을 입력해주세요.' });

  db.prepare('INSERT INTO dm_messages (thread_id, sender_id, content) VALUES (?, ?, ?)').run(thread.id, req.user.id, content);
  db.prepare("UPDATE dm_threads SET updated_at = datetime('now') WHERE id = ?").run(thread.id);

  const { notify } = require('../lib/helpers');
  const admins = db.prepare("SELECT id FROM users WHERE role = 'admin'").all();
  const userName = req.user.nickname || req.user.name;
  for (const admin of admins) {
    notify(db, admin.id, 'points', '쪽지 답장', `${userName}님이 답장했습니다: ${thread.subject}`, '/admin/messages/' + thread.id);
  }

  res.json({ ok: true });
});

function getTimeAgo(dateStr) {
  const diff = Math.floor((Date.now() - new Date(dateStr + 'Z').getTime()) / 1000);
  if (diff < 60) return '방금 전';
  if (diff < 3600) return Math.floor(diff / 60) + '분 전';
  if (diff < 86400) return Math.floor(diff / 3600) + '시간 전';
  if (diff < 604800) return Math.floor(diff / 86400) + '일 전';
  return new Date(dateStr).toLocaleDateString('ko-KR');
}

module.exports = router;
