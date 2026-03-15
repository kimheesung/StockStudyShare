const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../lib/db');
const { render, isLoggedIn, isStudyLeader, buildNav, escapeHtml, notify, adBannerHtml } = require('../lib/helpers');
const router = express.Router();

// 지원서 파일 업로드 설정
const applyUploadDir = path.join(__dirname, '..', 'uploads', 'applications');
if (!fs.existsSync(applyUploadDir)) fs.mkdirSync(applyUploadDir, { recursive: true });
const applyUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, applyUploadDir),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.pdf', '.doc', '.docx'].includes(ext)) cb(null, true);
    else cb(new Error('PDF 또는 Word 파일만 업로드 가능합니다.'));
  },
});

// 스터디방 목록 - 모집중 우선, 최근 리포트 올라온 순
router.get('/', isLoggedIn, (req, res) => {
  const searchQ = (req.query.q || '').trim();

  // 전체 스터디방: 모집중(pending 지원 받는 방) 우선, 최근 리포트 순
  let sql = `
    SELECT sr.*, sr.points, u.name as owner_name, u.photo as owner_photo,
           (SELECT COUNT(*) FROM study_members WHERE room_id = sr.id) as member_count,
           (SELECT COUNT(*) FROM study_applications WHERE room_id = sr.id AND status = 'pending') as pending_apps,
           (SELECT MAX(r.published_at) FROM reports r
            JOIN study_members sm2 ON sm2.user_id = r.author_id AND sm2.room_id = sr.id
            WHERE r.status = 'on_sale') as latest_report_at,
           (SELECT COUNT(*) FROM study_members WHERE room_id = sr.id AND user_id = ?) as is_member,
           (SELECT COUNT(*) FROM study_applications WHERE room_id = sr.id AND user_id = ? AND status = 'pending') as my_pending
    FROM study_rooms sr
    JOIN users u ON sr.owner_id = u.id`;
  const params = [req.user.id, req.user.id];
  if (searchQ) {
    sql += ` WHERE sr.name LIKE ? OR sr.description LIKE ?`;
    params.push(`%${searchQ}%`, `%${searchQ}%`);
  }
  sql += ` ORDER BY
      sr.points DESC,
      latest_report_at DESC NULLS LAST,
      sr.created_at DESC`;
  const allRooms = db.prepare(sql).all(...params);

  const roomCards = allRooms.map(r => {
    const isMember = r.is_member > 0;
    const isOwner = r.owner_id === req.user.id;
    const isRecruiting = r.pending_apps > 0 || true; // 모든 방은 지원 가능

    // 상태 뱃지
    let statusBadge = '';
    if (isOwner) {
      statusBadge = '<span class="badge-leader">스터디장</span>';
    } else if (isMember) {
      statusBadge = '<span class="badge-member">가입됨</span>';
    } else {
      statusBadge = '<span class="badge-recruiting">모집중</span>';
    }

    // 액션 버튼
    const isLocked = (r.points || 0) <= 0;
    let actionHtml = '';
    if (isMember && isLocked) {
      actionHtml = `<a href="/study/${r.id}/charge?locked=1" class="btn-enter" style="background:rgba(239,68,68,0.15);border-color:rgba(239,68,68,0.3);color:#ef4444">포인트 충전 필요</a>`;
    } else if (isMember) {
      actionHtml = `<a href="/study/${r.id}" class="btn-enter">입장하기</a>`;
    } else if (r.my_pending > 0) {
      actionHtml = '<span class="apply-status pending">지원 심사중</span>';
    } else {
      actionHtml = `<button type="button" class="btn-apply" onclick="openApplyModal(${r.id}, '${escapeHtml(r.name).replace(/'/g, "\\'")}')">지원하기</button>`;
    }

    // 최근 리포트 날짜
    const recentReport = r.latest_report_at
      ? `최근 리포트: ${new Date(r.latest_report_at).toLocaleDateString('ko-KR')}`
      : '리포트 없음';

    const roomPts = (r.points || 0).toLocaleString();
    return `<div class="study-card">
      <div class="study-card-header">
        <h3>${escapeHtml(r.name)}</h3>
        ${statusBadge}
      </div>
      <div class="study-card-desc">${escapeHtml((r.description || '').slice(0, 80))}</div>
      <div class="study-card-meta">
        <span>${r.member_count}/${r.max_members || 20}명</span>
        <span>${escapeHtml(r.owner_name)} 운영</span>
        <span>${recentReport}</span>
        <span style="color:#fbbf24;font-weight:700">${roomPts}P</span>
      </div>
      <div class="study-card-action">${actionHtml}</div>
    </div>`;
  }).join('');

  const canCreate = req.user.role === 'study_leader' || req.user.role === 'admin';

  // 스터디장 지원 상태 확인
  let leaderApplyStatus = 'none'; // none, pending, rejected
  if (req.user.role === 'user' || req.user.role === 'study_member') {
    const app = db.prepare("SELECT status FROM leader_applications WHERE user_id = ? ORDER BY created_at DESC LIMIT 1").get(req.user.id);
    if (app) leaderApplyStatus = app.status;
  }
  const showLeaderApply = (req.user.role === 'user' || req.user.role === 'study_member') && leaderApplyStatus !== 'pending';

  const html = render('views/study-list.html', {
    nav: buildNav(req.user),
    roomCards,
    hasRooms: allRooms.length > 0 ? 'true' : '',
    canCreate: canCreate ? 'true' : '',
    showLeaderApply: showLeaderApply ? 'true' : '',
    leaderApplyStatus,
    currentQ: escapeHtml(searchQ),
    userPoints: String((db.prepare('SELECT points FROM users WHERE id = ?').get(req.user.id) || {}).points || 0),
    adBanner: adBannerHtml(),
  });
  res.send(html);
});

// 스터디장 지원 폼
router.get('/leader-apply', isLoggedIn, (req, res) => {
  if (req.user.role === 'study_leader' || req.user.role === 'admin') {
    return res.redirect('/study');
  }

  const existing = db.prepare("SELECT * FROM leader_applications WHERE user_id = ? ORDER BY created_at DESC LIMIT 1").get(req.user.id);
  if (existing && existing.status === 'pending') {
    return res.redirect('/study/leader-apply-status');
  }

  const prev = (existing && existing.status === 'rejected') ? existing : null;

  const html = render('views/leader-apply.html', {
    nav: buildNav(req.user),
    userName: escapeHtml(req.user.name),
    userEmail: escapeHtml(req.user.email || ''),
    prevStudyName: escapeHtml(prev?.study_name || ''),
    prevStudyPlan: escapeHtml(prev?.study_plan || ''),
    isReapply: prev ? 'true' : '',
    rejectMemo: escapeHtml(prev ? (existing.admin_memo || '') : ''),
  });
  res.send(html);
});

// 스터디장 지원 제출
router.post('/leader-apply', isLoggedIn, (req, res) => {
  const { study_name, report_cycle, quality_plan, agreement, leader_intro } = req.body;
  const sectors = Array.isArray(req.body.sectors) ? req.body.sectors.join(', ') : (req.body.sectors || '');

  if (!study_name || !agreement || !quality_plan || !report_cycle) {
    return res.status(400).send('필수 항목을 모두 입력해주세요.');
  }

  const existing = db.prepare("SELECT id FROM leader_applications WHERE user_id = ? AND status = 'pending'").get(req.user.id);
  if (existing) {
    return res.redirect('/study/leader-apply-status');
  }

  // 운영계획을 구조화하여 study_plan에 저장
  const fullPlan = [
    `[리포트 제출 주기] ${report_cycle}`,
    `[주력 섹터] ${sectors || '미선택'}`,
    `[품질 관리 방안]\n${quality_plan.trim()}`,
    leader_intro ? `[스터디장 소개]\n${leader_intro.trim()}` : '',
  ].filter(Boolean).join('\n\n');

  db.prepare('INSERT INTO leader_applications (user_id, study_name, study_plan, agreement) VALUES (?, ?, ?, ?)').run(
    req.user.id, study_name.trim(), fullPlan, agreement.trim()
  );

  // 관리자에게 알림
  const applicantName = req.user.nickname || req.user.name;
  const admins = db.prepare("SELECT id FROM users WHERE role = 'admin'").all();
  for (const admin of admins) {
    notify(db, admin.id, 'report_pending_admin', '스터디장 지원',
      `${applicantName}님이 스터디장으로 지원했습니다. (${study_name.trim()})`,
      '/admin/authors');
  }

  res.redirect('/study/leader-apply-status');
});

// 스터디장 지원 상태 확인
router.get('/leader-apply-status', isLoggedIn, (req, res) => {
  const app = db.prepare('SELECT * FROM leader_applications WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(req.user.id);
  if (!app) return res.redirect('/study/leader-apply');

  const statusMap = { pending: '심사 중', approved: '승인됨', rejected: '반려됨' };

  const memoSection = app.admin_memo
    ? `<div class="memo-card"><h3>관리자 메모</h3><p>${escapeHtml(app.admin_memo)}</p></div>`
    : '';

  const reapplySection = app.status === 'rejected'
    ? `<div style="text-align:center;margin-top:24px"><a href="/study/leader-apply" class="btn-reapply">다시 지원하기</a></div>`
    : '';

  const html = render('views/leader-apply-status.html', {
    nav: buildNav(req.user),
    status: statusMap[app.status] || app.status,
    statusClass: app.status,
    studyName: escapeHtml(app.study_name),
    studyPlan: escapeHtml(app.study_plan),
    agreement: escapeHtml(app.agreement),
    appliedAt: new Date(app.created_at).toLocaleDateString('ko-KR'),
    memoSection,
    reapplySection,
  });
  res.send(html);
});

// 스터디방 생성 (스터디장/관리자만)
router.post('/create', isLoggedIn, isStudyLeader, (req, res) => {
  const { name, description } = req.body;
  const reportCycleMonths = parseInt(req.body.report_cycle_months) || 3;
  if (!name || !name.trim()) return res.status(400).send('스터디방 이름을 입력해주세요.');
  if (![1, 2, 3].includes(reportCycleMonths)) return res.status(400).send('유효하지 않은 주기입니다.');

  const result = db.prepare('INSERT INTO study_rooms (name, description, owner_id, report_cycle_months) VALUES (?, ?, ?, ?)').run(
    name.trim(), description || '', req.user.id, reportCycleMonths
  );

  const roomId = result.lastInsertRowid;

  // 기본 100만 포인트 지급
  db.prepare('UPDATE study_rooms SET points = 1000000 WHERE id = ?').run(roomId);
  db.prepare('INSERT INTO study_point_logs (room_id, amount, type, description) VALUES (?, ?, ?, ?)').run(
    roomId, 1000000, 'initial', '스터디방 개설 기본 포인트 지급'
  );

  // 스터디장도 멤버로 추가
  db.prepare('INSERT INTO study_members (room_id, user_id) VALUES (?, ?)').run(roomId, req.user.id);

  res.redirect(`/study/${roomId}`);
});

// 스터디방 포인트 내역 (멤버 열람 가능)
router.get('/:id/points', isLoggedIn, (req, res) => {
  const room = db.prepare('SELECT * FROM study_rooms WHERE id = ?').get(req.params.id);
  if (!room) return res.status(404).send('스터디방을 찾을 수 없습니다.');
  const isMember = db.prepare('SELECT id FROM study_members WHERE room_id = ? AND user_id = ?').get(room.id, req.user.id);
  if (!isMember) return res.status(403).send('이 스터디방의 멤버가 아닙니다.');

  const logs = db.prepare('SELECT * FROM study_point_logs WHERE room_id = ? ORDER BY created_at DESC LIMIT 100').all(room.id);

  const typeLabels = {
    sales_revenue: '판매 수익',
    monthly_fee: '월 운영비',
    admin_adjust: '관리자 조정',
    member_fee: '가입비 수입',
  };

  const logRows = logs.length > 0 ? logs.map(l => `
    <tr>
      <td>${new Date(l.created_at).toLocaleDateString('ko-KR')}</td>
      <td>${typeLabels[l.type] || l.type}</td>
      <td style="color:${l.amount >= 0 ? '#4ade80' : '#ef4444'};font-weight:700">${l.amount >= 0 ? '+' : ''}${l.amount.toLocaleString()}P</td>
      <td style="color:rgba(255,255,255,0.5);font-size:0.85rem">${escapeHtml(l.description || '')}</td>
    </tr>
  `).join('') : '<tr><td colspan="4" style="text-align:center;color:rgba(255,255,255,0.3);padding:30px">포인트 내역이 없습니다.</td></tr>';

  const html = `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
    <title>스터디방 포인트 - ${escapeHtml(room.name)}</title>
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
      .container{max-width:900px;margin:0 auto;padding:40px 20px}
      .back-link{color:rgba(255,255,255,0.4);text-decoration:none;font-size:0.9rem;margin-bottom:20px;display:inline-block}
      h1{font-size:1.5rem;font-weight:900;margin-bottom:8px}
      h1 .highlight{background:linear-gradient(135deg,#4f46e5,#06b6d4);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
      .balance-card{display:flex;align-items:center;gap:20px;padding:24px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:16px;margin:20px 0 30px}
      .balance-amount{font-size:2rem;font-weight:900;color:#fbbf24}
      .balance-label{font-size:0.85rem;color:rgba(255,255,255,0.5)}
      table{width:100%;border-collapse:collapse;margin-top:10px}
      th{text-align:left;padding:12px 16px;font-size:0.8rem;color:rgba(255,255,255,0.4);border-bottom:1px solid rgba(255,255,255,0.06)}
      td{padding:12px 16px;font-size:0.9rem;border-bottom:1px solid rgba(255,255,255,0.06)}
    </style></head><body>
    <nav>${buildNav(req.user)}</nav>
    <div class="container">
      <a href="/study/${room.id}" class="back-link">&larr; ${escapeHtml(room.name)}</a>
      <h1><span class="highlight">스터디방</span> 포인트 관리</h1>
      <div class="balance-card">
        <div>
          <div class="balance-label">현재 잔액</div>
          <div class="balance-amount">${(room.points || 0).toLocaleString()}P</div>
        </div>
      </div>
      <table>
        <thead><tr><th>날짜</th><th>유형</th><th>금액</th><th>설명</th></tr></thead>
        <tbody>${logRows}</tbody>
      </table>
    </div></body></html>`;
  res.send(html);
});

// 스터디방 포인트 충전 페이지 (스터디장 + 스터디원 모두 가능)
router.get('/:id/charge', isLoggedIn, (req, res) => {
  const room = db.prepare('SELECT * FROM study_rooms WHERE id = ?').get(req.params.id);
  if (!room) return res.status(404).send('스터디방을 찾을 수 없습니다.');
  const isMember = db.prepare('SELECT id FROM study_members WHERE room_id = ? AND user_id = ?').get(room.id, req.user.id);
  if (!isMember) return res.status(403).send('스터디방 멤버만 충전할 수 있습니다.');

  const currentUser = db.prepare('SELECT points FROM users WHERE id = ?').get(req.user.id);
  const html = render('views/study-charge.html', {
    nav: buildNav(req.user),
    roomId: String(room.id),
    roomName: escapeHtml(room.name),
    roomPoints: (room.points || 0).toLocaleString(),
    myPoints: String(currentUser?.points || 0),
  });
  res.send(html);
});

// 스터디방 포인트 충전 처리 (스터디장 + 스터디원 모두 가능)
router.post('/:id/charge', isLoggedIn, (req, res) => {
  const room = db.prepare('SELECT * FROM study_rooms WHERE id = ?').get(req.params.id);
  if (!room) return res.status(404).json({ error: '스터디방을 찾을 수 없습니다.' });
  const isMember = db.prepare('SELECT id FROM study_members WHERE room_id = ? AND user_id = ?').get(room.id, req.user.id);
  if (!isMember) return res.status(403).json({ error: '스터디방 멤버만 충전할 수 있습니다.' });

  const points = parseInt(req.body.points);
  const price = parseInt(req.body.price);
  const method = req.body.method || 'purchase';
  const validPlans = [
    { points: 100000, price: 100000 },
    { points: 1000000, price: 1000000 },
  ];
  const plan = validPlans.find(p => p.points === points && p.price === price);
  if (!plan) return res.json({ ok: false, error: '유효하지 않은 상품입니다.' });

  if (method === 'transfer') {
    // 내 포인트에서 차감하여 스터디방 충전
    const currentUser = db.prepare('SELECT points FROM users WHERE id = ?').get(req.user.id);
    if (!currentUser || currentUser.points < plan.points) {
      return res.json({ ok: false, error: `포인트가 부족합니다. (보유: ${(currentUser?.points || 0).toLocaleString()}P / 필요: ${plan.points.toLocaleString()}P)` });
    }

    const transferTx = db.transaction(() => {
      // 개인 포인트 차감
      db.prepare('UPDATE users SET points = points - ? WHERE id = ?').run(plan.points, req.user.id);
      db.prepare('INSERT INTO point_logs (user_id, amount, type, description) VALUES (?, ?, ?, ?)').run(
        req.user.id, -plan.points, 'study_charge', `스터디방 포인트 충전: ${room.name}`
      );
      // 스터디방 포인트 충전
      db.prepare('UPDATE study_rooms SET points = points + ? WHERE id = ?').run(plan.points, room.id);
      db.prepare('INSERT INTO study_point_logs (room_id, amount, type, description) VALUES (?, ?, ?, ?)').run(
        room.id, plan.points, 'member_transfer', `${req.user.name || '멤버'} 포인트 이전 충전`
      );
    });
    transferTx();
  } else {
    // 실제 구매(결제): 기존 mock 결제 방식
    db.prepare('UPDATE study_rooms SET points = points + ? WHERE id = ?').run(plan.points, room.id);
    db.prepare('INSERT INTO study_point_logs (room_id, amount, type, description) VALUES (?, ?, ?, ?)').run(
      room.id, plan.points, 'purchase', `${req.user.name || '멤버'} 결제 충전`
    );
  }

  const updated = db.prepare('SELECT points FROM study_rooms WHERE id = ?').get(room.id);
  res.json({ ok: true, activated: updated.points >= 100000 });
});

// 스터디방 지원
router.post('/:id/apply', isLoggedIn, applyUpload.single('report_file'), (req, res) => {
  const room = db.prepare('SELECT * FROM study_rooms WHERE id = ?').get(req.params.id);
  if (!room) return res.status(404).send('스터디방을 찾을 수 없습니다.');

  // 블랙유저 체크
  const userInfo = db.prepare('SELECT points, is_blacklisted FROM users WHERE id = ?').get(req.user.id);
  if (userInfo?.is_blacklisted) {
    return res.status(403).send('블랙리스트에 등록된 유저는 스터디방에 가입할 수 없습니다. 관리자에게 문의하세요.');
  }

  // 포인트 부족 체크 (가입비 10,000P)
  const currentUser = userInfo;
  if (!currentUser || currentUser.points < 10000) {
    return res.redirect('/my/points?need=10000&reason=study_join');
  }

  // 이미 멤버인지 확인
  const isMember = db.prepare('SELECT id FROM study_members WHERE room_id = ? AND user_id = ?').get(room.id, req.user.id);
  if (isMember) return res.redirect(`/study/${room.id}`);

  // 정원 초과 체크
  const currentCount = db.prepare('SELECT COUNT(*) as c FROM study_members WHERE room_id = ?').get(room.id).c;
  const maxMembers = room.max_members || 20;
  if (currentCount >= maxMembers) {
    return res.status(400).send('이 스터디방은 정원이 가득 찼습니다.');
  }

  // 이미 pending 지원이 있는지 확인
  const existing = db.prepare("SELECT id FROM study_applications WHERE room_id = ? AND user_id = ? AND status = 'pending'").get(room.id, req.user.id);
  if (existing) return res.redirect('/study');

  const intro = req.body.intro || '';
  const message = req.body.message || '';
  const filePath = req.file ? req.file.filename : null;

  db.prepare('INSERT INTO study_applications (room_id, user_id, message, intro, file_path) VALUES (?, ?, ?, ?, ?)').run(
    room.id, req.user.id, message, intro, filePath
  );

  // 스터디장에게 지원 알림
  const applicantName = req.user.nickname || req.user.name;
  notify(db, room.owner_id, 'study_approved', '새 스터디 지원', `"${room.name}" 스터디방에 ${applicantName}님이 지원했습니다.`, `/study/${room.id}/applications`);

  res.redirect('/study');
});

// 스터디방 상세
router.get('/:id', isLoggedIn, (req, res) => {
  const room = db.prepare('SELECT * FROM study_rooms WHERE id = ?').get(req.params.id);
  if (!room) return res.status(404).send('스터디방을 찾을 수 없습니다.');

  // 멤버인지 확인
  const isMember = db.prepare('SELECT id FROM study_members WHERE room_id = ? AND user_id = ?').get(room.id, req.user.id);
  if (!isMember) return res.status(403).send('이 스터디방의 멤버가 아닙니다.');

  // 리포트 미제출 자동 탈퇴 체크
  const cycleMonths = room.report_cycle_months || 1;
  const cutoffDate = new Date();
  cutoffDate.setMonth(cutoffDate.getMonth() - cycleMonths);
  const cutoffISO = cutoffDate.toISOString();

  const allMembers = db.prepare('SELECT user_id FROM study_members WHERE room_id = ?').all(room.id);
  for (const m of allMembers) {
    if (m.user_id === room.owner_id) continue; // 스터디장은 제외
    const lastReport = db.prepare(`
      SELECT created_at FROM reports
      WHERE author_id = ? AND study_room_id = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(m.user_id, room.id);
    const joinDate = db.prepare('SELECT joined_at FROM study_members WHERE room_id = ? AND user_id = ?').get(room.id, m.user_id);

    // 가입일이 주기보다 이전이고, 리포트가 없거나 마지막 리포트가 주기보다 오래된 경우
    if (joinDate && joinDate.joined_at < cutoffISO) {
      if (!lastReport || lastReport.created_at < cutoffISO) {
        // 자동 탈퇴
        db.prepare('DELETE FROM study_members WHERE room_id = ? AND user_id = ?').run(room.id, m.user_id);
        const otherMembership = db.prepare('SELECT id FROM study_members WHERE user_id = ?').get(m.user_id);
        if (!otherMembership) {
          db.prepare("UPDATE users SET role = 'user' WHERE id = ? AND role = 'study_member'").run(m.user_id);
        }
      }
    }
  }

  // 탈퇴 후 다시 멤버인지 확인 (본인이 탈퇴되었을 수 있음)
  const stillMember = db.prepare('SELECT id FROM study_members WHERE room_id = ? AND user_id = ?').get(room.id, req.user.id);
  if (!stillMember) return res.redirect('/study?kicked=1');

  // 포인트 0 이하면 잠금 → 충전 페이지로
  if ((room.points || 0) <= 0) {
    return res.redirect(`/study/${room.id}/charge?locked=1`);
  }

  const isOwner = room.owner_id === req.user.id;

  // 멤버 목록
  const members = db.prepare(`
    SELECT u.id, u.name, u.photo, u.role, sm.joined_at
    FROM study_members sm
    JOIN users u ON sm.user_id = u.id
    WHERE sm.room_id = ?
    ORDER BY sm.joined_at ASC
  `).all(room.id);

  const memberCards = members.map(m => {
    const isRoomOwner = m.id === room.owner_id;
    const kickBtn = (isOwner && m.id !== req.user.id)
      ? `<form method="POST" action="/study/${room.id}/kick" style="display:inline"><input type="hidden" name="user_id" value="${m.id}"><button type="submit" class="btn-kick">내보내기</button></form>`
      : '';
    return `<div class="member-card">
      <img src="${m.photo || ''}" alt="">
      <div class="member-info">
        <span class="member-name">${escapeHtml(m.name)}</span>
        ${isRoomOwner ? '<span class="owner-badge">스터디장</span>' : '<span class="member-badge">스터디원</span>'}
      </div>
      ${kickBtn}
    </div>`;
  }).join('');

  // 대기중인 지원서 수 (스터디장에게만 표시)
  let pendingCount = 0;
  if (isOwner) {
    pendingCount = db.prepare("SELECT COUNT(*) as c FROM study_applications WHERE room_id = ? AND status = 'pending'").get(room.id).c;
  }

  // 스터디원들의 리포트: study_published + on_sale(이 스터디방 소속)
  const memberIds = members.map(m => m.id);
  const placeholders = memberIds.map(() => '?').join(',');
  const reports = db.prepare(`
    SELECT r.id, r.title, r.stock_name, r.sector, r.sale_price, r.published_at, r.created_at,
           r.status, r.visibility, COALESCE(u.nickname, ap.display_name, u.name) as author_name, r.author_id
    FROM reports r
    JOIN users u ON r.author_id = u.id
    LEFT JOIN author_profiles ap ON r.author_id = ap.user_id
    WHERE (r.status IN ('study_published', 'on_sale', 'pending_leader', 'pending_admin'))
      AND r.study_room_id = ?
    ORDER BY r.created_at DESC
  `).all(room.id);

  // 스터디장 승인 대기 리포트 수
  let pendingLeaderCount = 0;
  if (isOwner) {
    pendingLeaderCount = reports.filter(r => r.status === 'pending_leader').length;
  }

  const reportCards = reports.length > 0 ? reports.map(r => {
    let tag = '스터디 전용';
    let tagStyle = 'color:#4ade80';
    if (r.visibility === 'public' && r.status === 'on_sale') { tag = '외부 판매중'; tagStyle = 'color:#a5b4fc'; }
    else if (r.status === 'pending_leader') { tag = '스터디장 승인 대기'; tagStyle = 'color:#fbbf24'; }
    else if (r.status === 'pending_admin') { tag = '관리자 승인 대기'; tagStyle = 'color:#fb923c'; }

    const viewLink = (r.status === 'study_published' || r.status === 'on_sale')
      ? `/reports/${r.id}/view` : '#';
    const leaderBtn = (isOwner && r.status === 'pending_leader')
      ? `<div style="display:flex;gap:6px;margin-top:8px">
          <form method="POST" action="/study/${room.id}/reports/${r.id}/approve" style="display:inline"><button class="btn-apply" style="padding:5px 14px;font-size:0.75rem">승인</button></form>
          <form method="POST" action="/study/${room.id}/reports/${r.id}/reject" style="display:inline"><button class="btn-kick" style="padding:5px 14px;font-size:0.75rem;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.2);color:#ef4444;border-radius:8px;cursor:pointer;font-family:inherit">반려</button></form>
         </div>` : '';

    // 투표 집계
    const likes = db.prepare("SELECT COUNT(*) as c FROM study_report_votes WHERE report_id = ? AND vote = 'like'").get(r.id).c;
    const dislikes = db.prepare("SELECT COUNT(*) as c FROM study_report_votes WHERE report_id = ? AND vote = 'dislike'").get(r.id).c;
    const myVote = db.prepare('SELECT vote FROM study_report_votes WHERE report_id = ? AND user_id = ?').get(r.id, req.user.id);
    const isMineReport = r.author_id === req.user.id;
    const showVote = ['study_published', 'on_sale'].includes(r.status) && !isMineReport;

    const voteHtml = showVote ? `
      <div style="display:flex;gap:8px;margin-top:10px;align-items:center" onclick="event.stopPropagation()">
        <button onclick="voteReport(${room.id},${r.id},'like',this)" style="padding:4px 14px;border-radius:20px;font-size:0.78rem;cursor:pointer;font-family:inherit;border:none;transition:all 0.15s;${myVote?.vote === 'like' ? 'background:rgba(74,222,128,0.2);color:#4ade80;border:1px solid rgba(74,222,128,0.3)' : 'background:rgba(255,255,255,0.05);color:rgba(255,255,255,0.4);border:1px solid rgba(255,255,255,0.08)'}">👍 ${likes}</button>
        <button onclick="voteReport(${room.id},${r.id},'dislike',this)" style="padding:4px 14px;border-radius:20px;font-size:0.78rem;cursor:pointer;font-family:inherit;border:none;transition:all 0.15s;${myVote?.vote === 'dislike' ? 'background:rgba(239,68,68,0.2);color:#ef4444;border:1px solid rgba(239,68,68,0.3)' : 'background:rgba(255,255,255,0.05);color:rgba(255,255,255,0.4);border:1px solid rgba(255,255,255,0.08)'}">👎 ${dislikes}</button>
      </div>` : (likes + dislikes > 0 ? `<div style="font-size:0.72rem;color:rgba(255,255,255,0.25);margin-top:8px">👍 ${likes} · 👎 ${dislikes}</div>` : '');

    return `<div class="report-card" ${viewLink !== '#' ? `onclick="window.location='${viewLink}'" style="cursor:pointer"` : ''}>
      <div class="report-card-top">
        <span class="report-sector">${escapeHtml(r.sector || '기타')}</span>
        <span class="report-price" style="${tagStyle};font-size:0.75rem">${tag}</span>
      </div>
      <h4 class="report-title">${escapeHtml(r.title)}</h4>
      <div class="report-stock">${escapeHtml(r.stock_name)}</div>
      <div class="report-meta">
        <span>${escapeHtml(r.author_name)}</span>
        <span>${new Date(r.created_at).toLocaleDateString('ko-KR')}</span>
      </div>
      ${leaderBtn}
      ${voteHtml}
    </div>`;
  }).join('') : '<div class="empty-msg">스터디원이 올린 리포트가 아직 없습니다.</div>';

  const html = render('views/study-room.html', {
    nav: buildNav(req.user),
    roomName: escapeHtml(room.name),
    roomDesc: escapeHtml(room.description || ''),
    roomId: String(room.id),
    isOwner: isOwner ? 'true' : '',
    memberCount: String(members.length),
    memberCards,
    reportCards,
    pendingCount: String(pendingCount),
    pendingLeaderCount: String(pendingLeaderCount),
    roomPoints: (room.points || 0).toLocaleString(),
    maxMembers: String(room.max_members || 20),
    reportCycleMonths: String(room.report_cycle_months || 1),
    nextChargeDate: (() => {
      const last = new Date(room.last_charged_at);
      const next = new Date(last);
      next.setMonth(next.getMonth() + 1);
      return next.toLocaleDateString('ko-KR');
    })(),
  });
  res.send(html);
});

// 스터디장 리포트 승인 (외부 공개 1차 승인)
router.post('/:id/reports/:reportId/approve', isLoggedIn, (req, res) => {
  const room = db.prepare('SELECT * FROM study_rooms WHERE id = ?').get(req.params.id);
  if (!room || room.owner_id !== req.user.id) return res.status(403).send('권한이 없습니다.');

  const report = db.prepare("SELECT * FROM reports WHERE id = ? AND study_room_id = ? AND status = 'pending_leader'").get(req.params.reportId, room.id);
  if (!report) return res.status(404).send('리포트를 찾을 수 없습니다.');

  // 1차 승인 → 관리자 승인 대기로 변경
  db.prepare("UPDATE reports SET status = 'pending_admin', updated_at = datetime('now') WHERE id = ?").run(report.id);

  // 작성자에게 알림
  notify(db, report.author_id, 'report_pending_admin', '리포트 1차 승인 완료', `"${report.title}" 리포트가 스터디장 승인을 통과했습니다. 관리자 최종 승인을 기다리고 있습니다.`, `/author/dashboard`);
  // 관리자에게 알림
  const admins = db.prepare("SELECT id FROM users WHERE role = 'admin'").all();
  for (const admin of admins) {
    notify(db, admin.id, 'report_pending_admin', '리포트 승인 요청', `"${report.title}" 리포트가 스터디장 1차 승인을 통과했습니다. 최종 검수해주세요.`, `/admin/reports/${report.id}`);
  }

  res.redirect(`/study/${room.id}`);
});

// 스터디장 리포트 반려
router.post('/:id/reports/:reportId/reject', isLoggedIn, (req, res) => {
  const room = db.prepare('SELECT * FROM study_rooms WHERE id = ?').get(req.params.id);
  if (!room || room.owner_id !== req.user.id) return res.status(403).send('권한이 없습니다.');

  const report = db.prepare("SELECT * FROM reports WHERE id = ? AND study_room_id = ? AND status = 'pending_leader'").get(req.params.reportId, room.id);
  if (!report) return res.status(404).send('리포트를 찾을 수 없습니다.');

  db.prepare("UPDATE reports SET status = 'rejected', updated_at = datetime('now') WHERE id = ?").run(report.id);

  // 작성자에게 반려 알림
  notify(db, report.author_id, 'report_rejected', '리포트 반려', `"${report.title}" 리포트가 스터디장에 의해 반려되었습니다. 수정 후 다시 제출해주세요.`, `/author/reports/${report.id}/edit`);

  res.redirect(`/study/${room.id}`);
});

// 지원서 관리 (스터디장만)
router.get('/:id/applications', isLoggedIn, (req, res) => {
  const room = db.prepare('SELECT * FROM study_rooms WHERE id = ?').get(req.params.id);
  if (!room || room.owner_id !== req.user.id) return res.status(403).send('권한이 없습니다.');

  const apps = db.prepare(`
    SELECT sa.*, u.name, u.email, u.photo
    FROM study_applications sa
    JOIN users u ON sa.user_id = u.id
    WHERE sa.room_id = ? AND sa.status = 'pending'
    ORDER BY sa.created_at DESC
  `).all(room.id);

  const appCards = apps.length > 0 ? apps.map(a => {
    const fileLink = a.file_path
      ? `<a href="/uploads/applications/${a.file_path}" target="_blank" style="color:#a5b4fc;text-decoration:none;font-size:0.8rem;display:inline-flex;align-items:center;gap:4px">&#128206; 첨부 리포트 보기</a>`
      : '';
    return `
    <div class="app-card">
      <div class="app-user">
        <img src="${a.photo || ''}" alt="">
        <div>
          <div class="app-name">${escapeHtml(a.name)}</div>
          <div class="app-email">${escapeHtml(a.email || '')}</div>
        </div>
      </div>
      ${a.intro ? `<div class="app-intro"><strong>자기소개</strong><p>${escapeHtml(a.intro)}</p></div>` : ''}
      ${a.message ? `<div class="app-msg"><strong>메시지</strong> ${escapeHtml(a.message)}</div>` : ''}
      ${fileLink}
      <div class="app-date">${new Date(a.created_at).toLocaleDateString('ko-KR')} 지원</div>
      <div class="app-actions">
        <form method="POST" action="/study/${room.id}/applications/${a.id}/review" style="display:inline">
          <button name="action" value="approve" class="btn-sm btn-approve">승인</button>
          <button name="action" value="reject" class="btn-sm btn-reject">거절</button>
        </form>
      </div>
    </div>`;
  }).join('') : '<div class="empty-msg">대기중인 지원서가 없습니다.</div>';

  const html = render('views/study-applications.html', {
    nav: buildNav(req.user),
    roomName: escapeHtml(room.name),
    roomId: String(room.id),
    appCards,
    totalCount: String(apps.length),
  });
  res.send(html);
});

// 지원서 심사 (승인/거절)
router.post('/:id/applications/:appId/review', isLoggedIn, (req, res) => {
  const room = db.prepare('SELECT * FROM study_rooms WHERE id = ?').get(req.params.id);
  if (!room || room.owner_id !== req.user.id) return res.status(403).send('권한이 없습니다.');

  const app = db.prepare('SELECT * FROM study_applications WHERE id = ? AND room_id = ?').get(req.params.appId, room.id);
  if (!app) return res.status(404).send('지원서를 찾을 수 없습니다.');

  const { action } = req.body;

  if (action === 'approve') {
    // 최대 인원 체크
    const currentCount = db.prepare('SELECT COUNT(*) as c FROM study_members WHERE room_id = ?').get(room.id).c;
    const maxMembers = room.max_members || 20;
    if (currentCount >= maxMembers) {
      return res.status(400).send(`스터디방 최대 인원(${maxMembers}명)을 초과할 수 없습니다.`);
    }
    // 가입비 10,000P 차감
    const applicant = db.prepare('SELECT points FROM users WHERE id = ?').get(app.user_id);
    if (!applicant || applicant.points < 10000) {
      return res.status(400).send('지원자의 포인트가 부족합니다. (가입비 10,000P 필요)');
    }
    db.prepare('UPDATE users SET points = points - 10000 WHERE id = ?').run(app.user_id);
    db.prepare("INSERT INTO point_logs (user_id, amount, type, description) VALUES (?, -10000, 'study_join', ?)").run(
      app.user_id, `스터디방 가입비: ${room.name}`
    );
    db.prepare("UPDATE study_applications SET status = 'approved' WHERE id = ?").run(app.id);
    // 멤버로 추가
    db.prepare('INSERT OR IGNORE INTO study_members (room_id, user_id) VALUES (?, ?)').run(room.id, app.user_id);
    // 역할이 일반유저면 스터디원으로 변경
    db.prepare("UPDATE users SET role = 'study_member' WHERE id = ? AND role = 'user'").run(app.user_id);
    // 지원자에게 승인 알림
    notify(db, app.user_id, 'study_approved', '스터디 가입 승인', `"${room.name}" 스터디방에 가입되었습니다!`, `/study/${room.id}`);
  } else if (action === 'reject') {
    db.prepare("UPDATE study_applications SET status = 'rejected' WHERE id = ?").run(app.id);
    // 지원자에게 거절 알림
    notify(db, app.user_id, 'study_rejected', '스터디 가입 거절', `"${room.name}" 스터디방 가입이 거절되었습니다.`, `/study`);
  }

  res.redirect(`/study/${room.id}/applications`);
});

// 스터디방 설정 변경 (스터디장만)
router.post('/:id/settings', isLoggedIn, (req, res) => {
  const room = db.prepare('SELECT * FROM study_rooms WHERE id = ?').get(req.params.id);
  if (!room || room.owner_id !== req.user.id) return res.status(403).send('권한이 없습니다.');

  const reportCycleMonths = parseInt(req.body.report_cycle_months);
  if (![1, 2, 3].includes(reportCycleMonths)) return res.status(400).send('유효하지 않은 주기입니다.');

  db.prepare('UPDATE study_rooms SET report_cycle_months = ? WHERE id = ?').run(reportCycleMonths, room.id);
  res.redirect(`/study/${room.id}`);
});

// 멤버 내보내기 (스터디장만)
router.post('/:id/kick', isLoggedIn, (req, res) => {
  const room = db.prepare('SELECT * FROM study_rooms WHERE id = ?').get(req.params.id);
  if (!room || room.owner_id !== req.user.id) return res.status(403).send('권한이 없습니다.');

  const { user_id } = req.body;
  if (user_id === room.owner_id) return res.status(400).send('스터디장은 내보낼 수 없습니다.');

  db.prepare('DELETE FROM study_members WHERE room_id = ? AND user_id = ?').run(room.id, user_id);

  // 다른 스터디방에 속해있지 않으면 일반유저로 변경
  const otherMembership = db.prepare('SELECT id FROM study_members WHERE user_id = ? AND room_id != ?').get(user_id, room.id);
  if (!otherMembership) {
    db.prepare("UPDATE users SET role = 'user' WHERE id = ? AND role = 'study_member'").run(user_id);
  }

  res.redirect(`/study/${room.id}`);
});

// 스터디방 나가기
router.post('/:id/leave', isLoggedIn, (req, res) => {
  const room = db.prepare('SELECT * FROM study_rooms WHERE id = ?').get(req.params.id);
  if (!room) return res.status(404).send('스터디방을 찾을 수 없습니다.');

  // 스터디장은 나갈 수 없음 (방 삭제는 별도)
  if (room.owner_id === req.user.id) {
    return res.status(400).send('스터디장은 방을 나갈 수 없습니다. 방을 삭제하려면 관리자에게 문의하세요.');
  }

  db.prepare('DELETE FROM study_members WHERE room_id = ? AND user_id = ?').run(room.id, req.user.id);

  // 다른 스터디방에 속해있지 않으면 일반유저로 변경
  const otherMembership = db.prepare('SELECT id FROM study_members WHERE user_id = ?').get(req.user.id);
  if (!otherMembership) {
    db.prepare("UPDATE users SET role = 'user' WHERE id = ? AND role = 'study_member'").run(req.user.id);
  }

  res.redirect('/study');
});

// 스터디 리포트 좋아요/싫어요 투표
router.post('/:id/reports/:reportId/vote', isLoggedIn, (req, res) => {
  const room = db.prepare('SELECT * FROM study_rooms WHERE id = ?').get(req.params.id);
  if (!room) return res.json({ ok: false, error: '스터디방을 찾을 수 없습니다.' });

  const isMember = db.prepare('SELECT id FROM study_members WHERE room_id = ? AND user_id = ?').get(room.id, req.user.id);
  if (!isMember) return res.json({ ok: false, error: '스터디방 멤버만 투표할 수 있습니다.' });

  const report = db.prepare('SELECT * FROM reports WHERE id = ? AND study_room_id = ?').get(req.params.reportId, room.id);
  if (!report) return res.json({ ok: false, error: '리포트를 찾을 수 없습니다.' });

  // 자기 리포트 투표 방지
  if (report.author_id === req.user.id) return res.json({ ok: false, error: '자신의 리포트에는 투표할 수 없습니다.' });

  const vote = req.body.vote; // 'like' or 'dislike'
  if (!['like', 'dislike'].includes(vote)) return res.json({ ok: false, error: '잘못된 투표입니다.' });

  // 중복 투표 체크
  const existing = db.prepare('SELECT id, vote FROM study_report_votes WHERE report_id = ? AND user_id = ?').get(report.id, req.user.id);
  if (existing) {
    if (existing.vote === vote) {
      // 같은 투표 → 취소
      db.prepare('DELETE FROM study_report_votes WHERE id = ?').run(existing.id);
    } else {
      // 다른 투표 → 변경
      db.prepare('UPDATE study_report_votes SET vote = ? WHERE id = ?').run(vote, existing.id);
    }
  } else {
    db.prepare('INSERT INTO study_report_votes (report_id, room_id, user_id, vote) VALUES (?, ?, ?, ?)').run(
      report.id, room.id, req.user.id, vote
    );
  }

  // 투표 결과 집계
  const likes = db.prepare("SELECT COUNT(*) as c FROM study_report_votes WHERE report_id = ? AND vote = 'like'").get(report.id).c;
  const dislikes = db.prepare("SELECT COUNT(*) as c FROM study_report_votes WHERE report_id = ? AND vote = 'dislike'").get(report.id).c;
  const totalMembers = db.prepare('SELECT COUNT(*) as c FROM study_members WHERE room_id = ?').get(room.id).c;
  const myVote = db.prepare('SELECT vote FROM study_report_votes WHERE report_id = ? AND user_id = ?').get(report.id, req.user.id);

  // 70% 이상 싫어요 → 작성자 제명
  let kicked = false;
  if (totalMembers > 1 && dislikes >= Math.ceil(totalMembers * 0.7)) {
    // 작성자가 스터디장이면 제명 불가
    if (report.author_id !== room.owner_id) {
      const kickTx = db.transaction(() => {
        // 멤버에서 제거
        db.prepare('DELETE FROM study_members WHERE room_id = ? AND user_id = ?').run(room.id, report.author_id);
        // 제명 기록
        db.prepare('INSERT INTO study_kicks (user_id, room_id, reason) VALUES (?, ?, ?)').run(
          report.author_id, room.id, `리포트 "${report.title}" 싫어요 ${dislikes}/${totalMembers} (70% 초과)`
        );
        // 작성자에게 알림
        notify(db, report.author_id, 'study_rejected', '스터디방 제명',
          `"${room.name}" 스터디방에서 리포트 평가(싫어요 ${dislikes}/${totalMembers})로 제명되었습니다.`,
          '/study');

        // 3번 이상 제명 → 블랙리스트
        const kickCount = db.prepare('SELECT COUNT(*) as c FROM study_kicks WHERE user_id = ?').get(report.author_id).c;
        if (kickCount >= 3) {
          db.prepare('UPDATE users SET is_blacklisted = 1 WHERE id = ?').run(report.author_id);
          notify(db, report.author_id, 'report_rejected', '블랙리스트 등록',
            `${kickCount}번 이상 스터디방에서 제명되어 블랙리스트에 등록되었습니다.`,
            '/my/profile');
          // 관리자에게 알림
          const admins = db.prepare("SELECT id FROM users WHERE role = 'admin'").all();
          for (const admin of admins) {
            notify(db, admin.id, 'report_pending_admin', '블랙유저 등록',
              `${report.author_id} 유저가 ${kickCount}번 제명되어 블랙리스트에 등록되었습니다.`,
              '/admin/users');
          }
        }
      });
      kickTx();
      kicked = true;
    }
  }

  res.json({ ok: true, likes, dislikes, myVote: myVote?.vote || null, kicked });
});

module.exports = router;
