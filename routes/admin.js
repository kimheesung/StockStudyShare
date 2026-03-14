const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../lib/db');
const { render, isLoggedIn, isAdmin, buildNav, escapeHtml, addPoints, notify } = require('../lib/helpers');
const router = express.Router();

const adUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(__dirname, '..', 'uploads', 'ads');
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.jpg';
      cb(null, `ad_${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\//.test(file.mimetype)) cb(null, true);
    else cb(new Error('이미지 파일만 업로드 가능합니다.'));
  },
});

// 관리자 대시보드
router.get('/', isLoggedIn, isAdmin, (req, res) => {
  const totalUsers = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const totalAuthors = db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'study_leader'").get().c;
  const pendingApps = db.prepare("SELECT COUNT(*) as c FROM leader_applications WHERE status = 'pending'").get().c;
  const pendingReports = db.prepare("SELECT COUNT(*) as c FROM reports WHERE status IN ('submitted', 'pending_admin')").get().c;
  const totalOrders = db.prepare('SELECT COUNT(*) as c FROM orders').get().c;
  const totalRevenue = db.prepare('SELECT COALESCE(SUM(amount), 0) as s FROM orders').get().s;
  const pendingFlags = db.prepare("SELECT COUNT(*) as c FROM report_flags WHERE status = 'pending'").get().c;
  const totalReports = db.prepare('SELECT COUNT(*) as c FROM reports').get().c;
  const pendingVisitNotes = db.prepare("SELECT COUNT(*) as c FROM reports WHERE type = 'visit_note' AND status IN ('submitted', 'pending_admin')").get().c;

  const html = render('views/admin-dashboard.html', {
    nav: buildNav(req.user),
    totalUsers: String(totalUsers),
    totalAuthors: String(totalAuthors),
    pendingApps: String(pendingApps),
    pendingReports: String(pendingReports),
    totalOrders: String(totalOrders),
    totalRevenue: totalRevenue.toLocaleString(),
    pendingFlags: String(pendingFlags),
    totalReports: String(totalReports),
    pendingVisitNotes: String(pendingVisitNotes),
  });
  res.send(html);
});

// 스터디장 지원서 관리
router.get('/authors', isLoggedIn, isAdmin, (req, res) => {
  const statusFilter = req.query.status || 'pending';
  const apps = db.prepare(`
    SELECT a.*, u.name, u.email, u.photo
    FROM leader_applications a
    JOIN users u ON a.user_id = u.id
    WHERE a.status = ?
    ORDER BY a.created_at DESC
  `).all(statusFilter);

  const rows = apps.map(a => `
    <tr>
      <td><img src="${a.photo || ''}" class="table-avatar"> ${escapeHtml(a.name)}</td>
      <td>${escapeHtml(a.email || '')}</td>
      <td>${escapeHtml(a.study_name)}</td>
      <td>${escapeHtml((a.study_plan || '').slice(0, 40))}...</td>
      <td>${new Date(a.created_at).toLocaleDateString('ko-KR')}</td>
      <td><a href="/admin/authors/${a.id}" class="btn-sm">상세보기</a></td>
    </tr>
  `).join('');

  const html = render('views/admin-authors.html', {
    nav: buildNav(req.user),
    rows: rows || '<tr><td colspan="6" class="empty-text">지원서가 없습니다.</td></tr>',
    currentStatus: statusFilter,
    totalCount: String(apps.length),
  });
  res.send(html);
});

// 스터디장 지원서 상세 심사
router.get('/authors/:id', isLoggedIn, isAdmin, (req, res) => {
  const app = db.prepare(`
    SELECT a.*, u.name, u.email, u.photo, u.role
    FROM leader_applications a
    JOIN users u ON a.user_id = u.id
    WHERE a.id = ?
  `).get(req.params.id);

  if (!app) return res.status(404).send('지원서를 찾을 수 없습니다.');

  const html = render('views/admin-author-review.html', {
    nav: buildNav(req.user),
    appId: String(app.id),
    name: escapeHtml(app.name),
    email: escapeHtml(app.email || ''),
    photo: app.photo || '',
    studyName: escapeHtml(app.study_name),
    studyPlan: escapeHtml(app.study_plan),
    agreement: escapeHtml(app.agreement),
    status: app.status,
    adminMemo: escapeHtml(app.admin_memo || ''),
    appliedAt: new Date(app.created_at).toLocaleDateString('ko-KR'),
    isPending: app.status === 'pending' ? 'true' : '',
  });
  res.send(html);
});

// 스터디장 지원서 심사 처리
router.post('/authors/:id/review', isLoggedIn, isAdmin, (req, res) => {
  const { action, admin_memo } = req.body;
  const app = db.prepare('SELECT * FROM leader_applications WHERE id = ?').get(req.params.id);
  if (!app) return res.status(404).send('지원서를 찾을 수 없습니다.');

  if (action === 'approve') {
    db.prepare("UPDATE leader_applications SET status = 'approved', admin_memo = ?, reviewed_at = datetime('now') WHERE id = ?")
      .run(admin_memo || '', app.id);
    db.prepare("UPDATE users SET role = 'study_leader' WHERE id = ?").run(app.user_id);
    const user = db.prepare('SELECT name FROM users WHERE id = ?').get(app.user_id);
    db.prepare('INSERT OR IGNORE INTO author_profiles (user_id, display_name) VALUES (?, ?)')
      .run(app.user_id, user.name);
    notify(db, app.user_id, 'report_approved', '스터디장 승인 완료', '스터디장 지원이 승인되었습니다! 이제 스터디방을 만들 수 있습니다.', '/study');
  } else if (action === 'reject') {
    db.prepare("UPDATE leader_applications SET status = 'rejected', admin_memo = ?, reviewed_at = datetime('now') WHERE id = ?")
      .run(admin_memo || '', app.id);
    notify(db, app.user_id, 'report_rejected', '스터디장 지원 반려', `스터디장 지원이 반려되었습니다.${admin_memo ? ' 사유: ' + admin_memo : ''}`, '/leader/apply/status');
  }

  res.redirect('/admin/authors');
});

// 리포트 검수 목록
router.get('/reports', isLoggedIn, isAdmin, (req, res) => {
  const statusFilter = req.query.status || 'pending_admin';
  const typeFilter = req.query.type || '';
  let reports;
  if (statusFilter === 'all') {
    reports = db.prepare(`
      SELECT r.*, COALESCE(u.nickname, u.name) as author_name, r.visibility,
             (SELECT COUNT(*) FROM orders WHERE report_id = r.id) as sales_count
      FROM reports r
      JOIN users u ON r.author_id = u.id
      ${typeFilter ? "WHERE r.type = ?" : ""}
      ORDER BY r.created_at DESC
    `).all(...(typeFilter ? [typeFilter] : []));
  } else {
    reports = db.prepare(`
      SELECT r.*, COALESCE(u.nickname, u.name) as author_name, r.visibility,
             (SELECT COUNT(*) FROM orders WHERE report_id = r.id) as sales_count
      FROM reports r
      JOIN users u ON r.author_id = u.id
      WHERE r.status = ? ${typeFilter ? "AND r.type = ?" : ""}
      ORDER BY r.created_at DESC
    `).all(...(typeFilter ? [statusFilter, typeFilter] : [statusFilter]));
  }

  const visLabel = { study_only: '스터디 전용', public: '외부 공개' };
  const statusLabel = {
    draft: '임시저장', study_published: '스터디 공개', pending_leader: '스터디장 대기',
    pending_admin: '검수 대기', on_sale: '판매중', rejected: '반려됨', suspended: '판매중지'
  };
  const statusColor = {
    draft: 'rgba(255,255,255,0.1);color:rgba(255,255,255,0.5)',
    study_published: 'rgba(74,222,128,0.15);color:#4ade80',
    pending_leader: 'rgba(251,191,36,0.15);color:#fbbf24',
    pending_admin: 'rgba(251,191,36,0.2);color:#fbbf24',
    on_sale: 'rgba(74,222,128,0.2);color:#4ade80',
    rejected: 'rgba(239,68,68,0.15);color:#ef4444',
    suspended: 'rgba(239,68,68,0.1);color:#f87171',
  };
  const rows = reports.map(r => `
    <tr>
      <td>${r.type === 'visit_note' ? '<span style="font-size:0.68rem;padding:2px 8px;border-radius:6px;background:rgba(34,197,94,0.15);color:#4ade80;margin-right:6px">탐방</span>' : ''}${escapeHtml(r.title)}</td>
      <td>${escapeHtml(r.stock_name)}</td>
      <td>${escapeHtml(r.author_name)}</td>
      <td><span style="font-size:0.75rem;padding:2px 8px;border-radius:8px;${r.visibility === 'public' ? 'background:rgba(79,70,229,0.15);color:#a5b4fc' : 'background:rgba(74,222,128,0.15);color:#4ade80'}">${visLabel[r.visibility] || r.visibility}</span></td>
      <td><span style="font-size:0.72rem;padding:2px 8px;border-radius:8px;background:${statusColor[r.status] || 'rgba(255,255,255,0.1);color:#fff'}">${statusLabel[r.status] || r.status}</span></td>
      <td>${r.sale_price === 0 ? '무료' : r.sale_price.toLocaleString() + 'P'}</td>
      <td>${r.sales_count > 0
        ? `<span style="cursor:pointer;text-decoration:underline;color:#a5b4fc" onclick="showBuyers(${r.id}, '${escapeHtml(r.title).replace(/'/g, "\\'")}')">${r.sales_count}건</span>`
        : '<span style="color:rgba(255,255,255,0.3)">0건</span>'}</td>
      <td>${new Date(r.created_at).toLocaleDateString('ko-KR')}</td>
      <td><a href="/admin/reports/${r.id}" class="btn-sm">상세보기</a></td>
    </tr>
  `).join('');

  const html = render('views/admin-reports.html', {
    nav: buildNav(req.user),
    rows: rows || '<tr><td colspan="6" class="empty-text">검수 대기 리포트가 없습니다.</td></tr>',
    currentStatus: statusFilter,
    totalCount: String(reports.length),
  });
  res.send(html);
});

// 리포트 상세 검수
// 리포트 구매자 목록 API
router.get('/reports/:id/buyers', isLoggedIn, isAdmin, (req, res) => {
  const buyers = db.prepare(`
    SELECT o.amount, o.created_at as purchased_at,
           u.name, u.nickname, u.email, u.photo
    FROM orders o
    JOIN users u ON o.user_id = u.id
    WHERE o.report_id = ?
    ORDER BY o.created_at DESC
  `).all(req.params.id);
  res.json({ buyers });
});

router.get('/reports/:id', isLoggedIn, isAdmin, (req, res) => {
  const report = db.prepare(`
    SELECT r.*, COALESCE(u.nickname, u.name) as author_name
    FROM reports r
    JOIN users u ON r.author_id = u.id
    WHERE r.id = ?
  `).get(req.params.id);

  if (!report) return res.status(404).send('리포트를 찾을 수 없습니다.');

  const html = render('views/admin-report-review.html', {
    nav: buildNav(req.user),
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
    authorName: escapeHtml(report.author_name),
    salePrice: report.sale_price === 0 ? '무료' : report.sale_price.toLocaleString() + 'P',
    status: report.status,
    canReview: (report.status === 'submitted' || report.status === 'pending_admin' || report.status === 'on_sale' || report.status === 'suspended') ? 'true' : '',
    createdAt: report.created_at || '',
    publishedAt: report.published_at || '',
    isVisitNote: report.type === 'visit_note' ? 'true' : '',
    visitDate: escapeHtml(report.visit_date || ''),
    visitLocation: escapeHtml(report.visit_location || ''),
    visitPurpose: escapeHtml(report.visit_purpose || ''),
    visitFindings: escapeHtml(report.visit_findings || ''),
    visitImpressions: escapeHtml(report.visit_impressions || ''),
  });
  res.send(html);
});

// 리포트 검수 처리
router.post('/reports/:id/review', isLoggedIn, isAdmin, (req, res) => {
  const { action, reason } = req.body;
  const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
  if (!report) return res.status(404).send('리포트를 찾을 수 없습니다.');

  // 상태 검증: 적합한 상태에서만 액션 허용
  const allowedActions = {
    submitted: ['approve', 'reject'],
    pending_admin: ['approve', 'reject'],
    on_sale: ['suspend'],
    suspended: ['approve'],
  };
  const allowed = allowedActions[report.status] || [];
  if (!allowed.includes(action)) return res.status(400).send('현재 상태에서 수행할 수 없는 액션입니다.');

  let newStatus;
  if (action === 'approve') newStatus = 'on_sale';
  else if (action === 'reject') newStatus = 'rejected';
  else if (action === 'suspend') newStatus = 'suspended';
  else return res.status(400).send('잘못된 액션입니다.');

  db.prepare("UPDATE reports SET status = ?, published_at = CASE WHEN ? = 'on_sale' THEN datetime('now') ELSE published_at END, updated_at = datetime('now') WHERE id = ?")
    .run(newStatus, newStatus, report.id);

  db.prepare('INSERT INTO report_review_logs (report_id, reviewer_id, action, reason) VALUES (?, ?, ?, ?)')
    .run(report.id, req.user.id, action, reason || '');

  // 리포트 승인(게재) 시 작성자에게 포인트 지급 + 알림
  if (action === 'approve' && newStatus === 'on_sale') {
    addPoints(db, report.author_id, 100, 'publish', `리포트 게재 승인: ${report.title}`, report.id);
    notify(db, report.author_id, 'report_approved', '리포트 판매 승인', `"${report.title}" 리포트가 관리자 승인을 받아 외부 판매가 시작되었습니다! 🎉`, `/reports/${report.id}`);
    // 팔로워에게 알림
    const author = db.prepare('SELECT nickname, name FROM users WHERE id = ?').get(report.author_id);
    const authorName = author?.nickname || author?.name || '작성자';
    const followers = db.prepare('SELECT follower_id FROM follows WHERE author_id = ?').all(report.author_id);
    for (const f of followers) {
      notify(db, f.follower_id, 'new_report', `${authorName}님의 새 리포트`, `"${report.title}" (${report.stock_name}) 리포트가 판매 시작되었습니다.`, `/reports/${report.id}`);
    }
  } else if (action === 'reject') {
    notify(db, report.author_id, 'report_rejected', '리포트 반려', `"${report.title}" 리포트가 관리자에 의해 반려되었습니다.${reason ? ' 사유: ' + reason : ''}`, `/author/reports/${report.id}/edit`);
  } else if (action === 'suspend') {
    notify(db, report.author_id, 'report_rejected', '리포트 판매 중지', `"${report.title}" 리포트의 판매가 중지되었습니다.${reason ? ' 사유: ' + reason : ''}`, `/author/dashboard`);
  }

  res.redirect('/admin/reports');
});

// 리포트 날짜 수정
router.post('/reports/:id/dates', isLoggedIn, isAdmin, (req, res) => {
  const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
  if (!report) return res.status(404).send('리포트를 찾을 수 없습니다.');

  const { created_at, published_at } = req.body;

  if (created_at) {
    db.prepare('UPDATE reports SET created_at = ? WHERE id = ?').run(created_at, report.id);
  }
  if (published_at) {
    db.prepare('UPDATE reports SET published_at = ?, entry_price = NULL WHERE id = ?').run(published_at, report.id);
  }

  res.redirect(`/admin/reports/${report.id}`);
});

// 회원 관리
router.get('/users', isLoggedIn, isAdmin, (req, res) => {
  const users = db.prepare(`
    SELECT u.*, ref.nickname as referrer_nickname
    FROM users u LEFT JOIN users ref ON u.referrer_id = ref.id
    ORDER BY u.joined_at DESC
  `).all();
  const roleMap = { user: '일반유저', study_member: '스터디원', study_leader: '스터디장', admin: '관리자' };
  const allRoles = ['user', 'study_member', 'study_leader', 'admin'];

  const rows = users.map(u => {
    const isSelf = u.id === req.user.id;
    const roleOptions = allRoles.map(r =>
      `<option value="${r}" ${u.role === r ? 'selected' : ''}>${roleMap[r]}</option>`
    ).join('');
    const roleCell = isSelf
      ? `<span class="role-badge role-${u.role}">${roleMap[u.role] || u.role}</span>`
      : `<form class="role-form" onsubmit="event.preventDefault();changeRole('${u.id}',this)">
           <select name="role" class="role-select">${roleOptions}</select>
           <button type="submit" class="btn-sm">변경</button>
           <span class="btn-saved"><span class="check-icon">&#10003;</span> 저장됨</span>
         </form>`;
    return `
      <tr>
        <td><img src="${u.photo || ''}" class="table-avatar"> ${escapeHtml(u.name)}</td>
        <td>${escapeHtml(u.nickname || '-')}</td>
        <td>${escapeHtml(u.email || '')}</td>
        <td style="color:#fbbf24;font-weight:700">${(u.points || 0).toLocaleString()}P</td>
        <td>${escapeHtml(u.referrer_nickname || '-')}</td>
        <td>${roleCell}</td>
        <td>${new Date(u.joined_at).toLocaleDateString('ko-KR')}</td>
      </tr>`;
  }).join('');

  const html = render('views/admin-users.html', {
    nav: buildNav(req.user),
    rows,
    totalCount: String(users.length),
  });
  res.send(html);
});

// 회원 역할 변경
router.post('/users/:id/role', isLoggedIn, isAdmin, (req, res) => {
  const { role } = req.body;
  const validRoles = ['user', 'study_member', 'study_leader', 'admin'];
  if (!validRoles.includes(role)) return res.status(400).send('잘못된 역할입니다.');

  if (req.params.id === req.user.id) return res.status(400).send('자신의 역할은 변경할 수 없습니다.');

  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, req.params.id);

  // 스터디장으로 변경 시 작성자 프로필 자동 생성
  if (role === 'study_leader') {
    const user = db.prepare('SELECT name FROM users WHERE id = ?').get(req.params.id);
    if (user) {
      db.prepare('INSERT OR IGNORE INTO author_profiles (user_id, display_name) VALUES (?, ?)').run(req.params.id, user.name);
    }
  }

  // AJAX 요청이면 JSON 응답
  if (req.is('json') || req.headers.accept?.includes('application/json')) {
    return res.json({ ok: true, role });
  }
  res.redirect('/admin/users');
});

// 신고 관리
router.get('/flags', isLoggedIn, isAdmin, (req, res) => {
  const statusFilter = req.query.status || 'pending';
  const flags = db.prepare(`
    SELECT f.*, r.title as report_title, u.name as reporter_name
    FROM report_flags f
    JOIN reports r ON f.report_id = r.id
    JOIN users u ON f.reporter_id = u.id
    WHERE f.status = ?
    ORDER BY f.created_at DESC
  `).all(statusFilter);

  const rows = flags.map(f => `
    <tr>
      <td>${escapeHtml(f.report_title)}</td>
      <td>${escapeHtml(f.reporter_name)}</td>
      <td>${escapeHtml(f.reason)}</td>
      <td>${escapeHtml((f.detail || '').slice(0, 50))}</td>
      <td>${new Date(f.created_at).toLocaleDateString('ko-KR')}</td>
      <td>
        <form method="POST" action="/admin/flags/${f.id}/resolve" style="display:inline">
          <button name="action" value="resolved" class="btn-sm btn-approve">처리완료</button>
          <button name="action" value="dismissed" class="btn-sm btn-reject">무시</button>
        </form>
      </td>
    </tr>
  `).join('');

  const html = render('views/admin-flags.html', {
    nav: buildNav(req.user),
    rows: rows || '<tr><td colspan="6" class="empty-text">신고가 없습니다.</td></tr>',
    currentStatus: statusFilter,
    totalCount: String(flags.length),
  });
  res.send(html);
});

// 신고 처리
router.post('/flags/:id/resolve', isLoggedIn, isAdmin, (req, res) => {
  const { action } = req.body;
  const validActions = ['resolved', 'dismissed'];
  if (!validActions.includes(action)) return res.status(400).send('잘못된 처리 상태입니다.');
  db.prepare('UPDATE report_flags SET status = ? WHERE id = ?').run(action, req.params.id);
  res.redirect('/admin/flags');
});

// 스터디방 포인트 관리
router.get('/study-rooms', isLoggedIn, isAdmin, (req, res) => {
  const rooms = db.prepare(`
    SELECT sr.*, u.name as owner_name, u.nickname as owner_nickname,
      (SELECT COUNT(*) FROM study_members WHERE room_id = sr.id) as member_count
    FROM study_rooms sr
    JOIN users u ON sr.owner_id = u.id
    ORDER BY sr.created_at DESC
  `).all();

  const rows = rooms.map(r => `
    <tr>
      <td><a href="/admin/study-rooms/${r.id}" style="color:#a5b4fc;text-decoration:none;font-weight:700">${escapeHtml(r.name)}</a></td>
      <td>${escapeHtml(r.owner_nickname || r.owner_name)}</td>
      <td>${r.member_count}명</td>
      <td style="font-weight:700;color:${(r.points || 0) > 0 ? '#4ade80' : '#ef4444'}">${(r.points || 0).toLocaleString()}P</td>
      <td>${new Date(r.created_at).toLocaleDateString('ko-KR')}</td>
      <td>
        <form method="POST" action="/admin/study-rooms/${r.id}/adjust-points" style="display:flex;gap:6px;align-items:center">
          <input type="number" name="amount" placeholder="금액" style="width:100px;padding:6px 10px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:8px;color:#fff;font-size:0.8rem">
          <input type="text" name="reason" placeholder="사유" style="width:140px;padding:6px 10px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:8px;color:#fff;font-size:0.8rem">
          <button type="submit" class="btn-sm">조정</button>
        </form>
      </td>
    </tr>
  `).join('');

  const html = `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
    <title>스터디방 관리 - 관리자</title>
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
      .container{max-width:1100px;margin:0 auto;padding:40px 20px}
      .back-link{color:rgba(255,255,255,0.4);text-decoration:none;font-size:0.9rem;margin-bottom:20px;display:inline-block}
      h1{font-size:1.5rem;font-weight:900;margin-bottom:20px}
      h1 .highlight{background:linear-gradient(135deg,#4f46e5,#06b6d4);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
      table{width:100%;border-collapse:collapse}
      th{text-align:left;padding:12px 16px;font-size:0.8rem;color:rgba(255,255,255,0.4);border-bottom:1px solid rgba(255,255,255,0.06)}
      td{padding:12px 16px;font-size:0.9rem;border-bottom:1px solid rgba(255,255,255,0.06)}
      .btn-sm{padding:6px 14px;background:linear-gradient(135deg,#4f46e5,#6366f1);border:none;border-radius:8px;color:#fff;font-size:0.8rem;font-weight:700;cursor:pointer;font-family:inherit}
      .summary-cards{display:flex;gap:16px;margin-bottom:30px;flex-wrap:wrap}
      .summary-card{flex:1;min-width:180px;padding:20px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:14px}
      .summary-card .label{font-size:0.8rem;color:rgba(255,255,255,0.4)}
      .summary-card .value{font-size:1.5rem;font-weight:900;margin-top:4px}
    </style></head><body>
    <nav>${buildNav(req.user)}</nav>
    <div class="container">
      <a href="/admin" class="back-link">&larr; 관리자 대시보드</a>
      <h1><span class="highlight">스터디방</span> 포인트 관리</h1>
      <div class="summary-cards">
        <div class="summary-card">
          <div class="label">총 스터디방</div>
          <div class="value">${rooms.length}개</div>
        </div>
        <div class="summary-card">
          <div class="label">총 포인트 합계</div>
          <div class="value" style="color:#fbbf24">${rooms.reduce((s, r) => s + (r.points || 0), 0).toLocaleString()}P</div>
        </div>
      </div>
      <table>
        <thead><tr><th>스터디방</th><th>스터디장</th><th>인원</th><th>보유 포인트</th><th>생성일</th><th>포인트 조정</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="6" style="text-align:center;color:rgba(255,255,255,0.3);padding:30px">스터디방이 없습니다.</td></tr>'}</tbody>
      </table>
    </div></body></html>`;
  res.send(html);
});

// 스터디방 포인트 상세 (관리자)
router.get('/study-rooms/:id', isLoggedIn, isAdmin, (req, res) => {
  const room = db.prepare('SELECT sr.*, u.name as owner_name FROM study_rooms sr JOIN users u ON sr.owner_id = u.id WHERE sr.id = ?').get(req.params.id);
  if (!room) return res.status(404).send('스터디방을 찾을 수 없습니다.');

  const logs = db.prepare('SELECT * FROM study_point_logs WHERE room_id = ? ORDER BY created_at DESC LIMIT 200').all(room.id);
  const typeLabels = { sales_revenue: '판매 수익', monthly_fee: '월 운영비', admin_adjust: '관리자 조정', member_fee: '가입비 수입' };

  const logRows = logs.length > 0 ? logs.map(l => `
    <tr>
      <td>${new Date(l.created_at).toLocaleDateString('ko-KR')}</td>
      <td>${typeLabels[l.type] || l.type}</td>
      <td style="color:${l.amount >= 0 ? '#4ade80' : '#ef4444'};font-weight:700">${l.amount >= 0 ? '+' : ''}${l.amount.toLocaleString()}P</td>
      <td style="color:rgba(255,255,255,0.5);font-size:0.85rem">${escapeHtml(l.description || '')}</td>
    </tr>
  `).join('') : '<tr><td colspan="4" style="text-align:center;color:rgba(255,255,255,0.3);padding:30px">내역이 없습니다.</td></tr>';

  const html = `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
    <title>${escapeHtml(room.name)} 포인트 - 관리자</title>
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
      .balance-card{display:flex;align-items:center;justify-content:space-between;padding:24px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:16px;margin:20px 0 30px}
      .balance-amount{font-size:2rem;font-weight:900;color:#fbbf24}
      .balance-label{font-size:0.85rem;color:rgba(255,255,255,0.5)}
      .adjust-form{display:flex;gap:8px;align-items:center}
      .adjust-form input{padding:8px 12px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:8px;color:#fff;font-size:0.9rem;font-family:inherit}
      .btn-sm{padding:8px 18px;background:linear-gradient(135deg,#4f46e5,#6366f1);border:none;border-radius:8px;color:#fff;font-size:0.85rem;font-weight:700;cursor:pointer;font-family:inherit}
      table{width:100%;border-collapse:collapse;margin-top:10px}
      th{text-align:left;padding:12px 16px;font-size:0.8rem;color:rgba(255,255,255,0.4);border-bottom:1px solid rgba(255,255,255,0.06)}
      td{padding:12px 16px;font-size:0.9rem;border-bottom:1px solid rgba(255,255,255,0.06)}
    </style></head><body>
    <nav>${buildNav(req.user)}</nav>
    <div class="container">
      <a href="/admin/study-rooms" class="back-link">&larr; 스터디방 목록</a>
      <h1><span class="highlight">${escapeHtml(room.name)}</span> 포인트</h1>
      <p style="color:rgba(255,255,255,0.5);font-size:0.9rem;margin-bottom:10px">스터디장: ${escapeHtml(room.owner_name)}</p>
      <div class="balance-card">
        <div>
          <div class="balance-label">현재 잔액</div>
          <div class="balance-amount">${(room.points || 0).toLocaleString()}P</div>
        </div>
        <form method="POST" action="/admin/study-rooms/${room.id}/adjust-points" class="adjust-form">
          <input type="number" name="amount" placeholder="금액 (음수 가능)" required style="width:130px">
          <input type="text" name="reason" placeholder="사유" required style="width:180px">
          <button type="submit" class="btn-sm">포인트 조정</button>
        </form>
      </div>
      <h2 style="font-size:1.1rem;margin-bottom:10px">포인트 내역</h2>
      <table>
        <thead><tr><th>날짜</th><th>유형</th><th>금액</th><th>설명</th></tr></thead>
        <tbody>${logRows}</tbody>
      </table>
    </div></body></html>`;
  res.send(html);
});

// 스터디방 포인트 조정 (관리자)
router.post('/study-rooms/:id/adjust-points', isLoggedIn, isAdmin, (req, res) => {
  const room = db.prepare('SELECT * FROM study_rooms WHERE id = ?').get(req.params.id);
  if (!room) return res.status(404).send('스터디방을 찾을 수 없습니다.');

  const amount = parseInt(req.body.amount);
  const reason = (req.body.reason || '').trim();
  if (!amount || isNaN(amount)) return res.status(400).send('유효한 금액을 입력해주세요.');

  db.prepare('UPDATE study_rooms SET points = points + ? WHERE id = ?').run(amount, room.id);
  db.prepare('INSERT INTO study_point_logs (room_id, amount, type, description, admin_id) VALUES (?, ?, ?, ?, ?)').run(
    room.id, amount, 'admin_adjust', reason || `관리자 포인트 조정: ${amount > 0 ? '+' : ''}${amount.toLocaleString()}P`, req.user.id
  );

  // 스터디장에게 알림
  notify(db, room.owner_id, 'points', '스터디방 포인트 조정', `"${room.name}" 스터디방 포인트가 ${amount > 0 ? '+' : ''}${amount.toLocaleString()}P 조정되었습니다. ${reason ? '사유: ' + reason : ''}`, `/study/${room.id}/points`);

  // 이전 페이지로 돌아가기
  const referer = req.headers.referer || `/admin/study-rooms/${room.id}`;
  res.redirect(referer);
});

// === 광고 관리 ===
router.get('/ads', isLoggedIn, isAdmin, (req, res) => {
  const ads = db.prepare('SELECT * FROM ads ORDER BY created_at DESC').all();
  const inquiries = db.prepare('SELECT * FROM ad_inquiries ORDER BY created_at DESC').all();

  const adList = ads.length > 0 ? ads.map(a => `
    <div class="card">
      <div class="ad-item">
        ${a.image_url ? `<img src="${escapeHtml(a.image_url)}" class="ad-thumb">` : '<div class="ad-thumb" style="display:flex;align-items:center;justify-content:center;font-size:0.75rem;color:rgba(255,255,255,0.2)">이미지 없음</div>'}
        <div class="ad-info">
          <div class="ad-title">${escapeHtml(a.title)}</div>
          <div class="ad-link">${escapeHtml(a.link_url || '링크 없음')} · ${a.position}</div>
        </div>
        <span class="ad-status ${a.is_active ? 'active' : 'inactive'}">${a.is_active ? '활성' : '비활성'}</span>
        <div class="ad-actions">
          <button class="btn-sm btn-toggle" onclick="toggleAd(${a.id})">${a.is_active ? '비활성화' : '활성화'}</button>
          <button class="btn-sm btn-delete" onclick="deleteAd(${a.id})">삭제</button>
        </div>
      </div>
    </div>
  `).join('') : '<div class="empty-text">등록된 광고가 없습니다.</div>';

  const inquiryList = inquiries.length > 0 ? inquiries.map(i => `
    <div class="card inq-item">
      <div class="inq-header">
        <span class="inq-name">${escapeHtml(i.name)} ${i.company ? '(' + escapeHtml(i.company) + ')' : ''}</span>
        <span>
          <span class="inq-status ${i.status}">${{pending:'대기',replied:'답변완료',closed:'종료'}[i.status] || i.status}</span>
          <span class="inq-meta">${escapeHtml(i.email)} · ${new Date(i.created_at).toLocaleDateString('ko-KR')}</span>
        </span>
      </div>
      <div class="inq-message">${escapeHtml(i.message)}</div>
      <div style="display:flex;gap:6px">
        <button class="btn-sm btn-toggle" onclick="updateInquiry(${i.id},'replied')">답변완료</button>
        <button class="btn-sm btn-toggle" onclick="updateInquiry(${i.id},'closed')">종료</button>
      </div>
    </div>
  `).join('') : '<div class="empty-text">접수된 문의가 없습니다.</div>';

  const html = render('views/admin-ads.html', {
    nav: buildNav(req.user),
    adList,
    inquiryList,
    inquiryCount: String(inquiries.length),
  });
  res.send(html);
});

// 광고 등록
router.post('/ads', isLoggedIn, isAdmin, adUpload.single('image'), (req, res) => {
  const { title, link_url, position } = req.body;
  if (!title) return res.json({ ok: false, error: '제목을 입력해주세요.' });
  const imageUrl = req.file ? `/uploads/ads/${req.file.filename}` : null;
  db.prepare('INSERT INTO ads (title, image_url, link_url, position) VALUES (?, ?, ?, ?)').run(
    title, imageUrl, link_url || null, position || 'loading'
  );
  res.json({ ok: true });
});

// 광고 활성/비활성 토글
router.post('/ads/:id/toggle', isLoggedIn, isAdmin, (req, res) => {
  const ad = db.prepare('SELECT * FROM ads WHERE id = ?').get(req.params.id);
  if (!ad) return res.json({ ok: false });
  db.prepare('UPDATE ads SET is_active = ? WHERE id = ?').run(ad.is_active ? 0 : 1, ad.id);
  res.json({ ok: true });
});

// 광고 삭제
router.delete('/ads/:id', isLoggedIn, isAdmin, (req, res) => {
  const ad = db.prepare('SELECT * FROM ads WHERE id = ?').get(req.params.id);
  if (ad?.image_url) {
    try { fs.unlinkSync(path.join(__dirname, '..', ad.image_url)); } catch {}
  }
  db.prepare('DELETE FROM ads WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// 문의 상태 변경
router.post('/ads/inquiry/:id', isLoggedIn, isAdmin, (req, res) => {
  db.prepare('UPDATE ad_inquiries SET status = ? WHERE id = ?').run(req.body.status, req.params.id);
  res.json({ ok: true });
});

// 클럽 인증 심사 목록
router.get('/club-verifications', isLoggedIn, isAdmin, (req, res) => {
  const apps = db.prepare(`
    SELECT cv.*, u.name, u.nickname, u.email, u.photo
    FROM club_verifications cv
    JOIN users u ON cv.user_id = u.id
    ORDER BY cv.status = 'pending' DESC, cv.created_at DESC
  `).all();

  const clubNames = { '10b': '10억 클럽', '100b': '100억 클럽', '1000b': '1000억 클럽', '1t': '1조 클럽' };
  const rows = apps.map(a => `
    <tr>
      <td>${escapeHtml(a.nickname || a.name)}</td>
      <td>${escapeHtml(a.email || '')}</td>
      <td><strong>${clubNames[a.club] || a.club}</strong></td>
      <td style="font-size:0.82rem;color:rgba(255,255,255,0.5);max-width:200px;overflow:hidden;text-overflow:ellipsis">${escapeHtml(a.proof_text || '')}</td>
      <td><span style="font-size:0.72rem;padding:2px 8px;border-radius:8px;background:${a.status === 'pending' ? 'rgba(251,191,36,0.15);color:#fbbf24' : a.status === 'approved' ? 'rgba(74,222,128,0.15);color:#4ade80' : 'rgba(239,68,68,0.15);color:#ef4444'}">${a.status === 'pending' ? '대기' : a.status === 'approved' ? '승인' : '반려'}</span></td>
      <td>${a.status === 'pending' ? `
        <form style="display:inline" onsubmit="event.preventDefault();reviewClub(${a.id},'approve',this)">
          <button class="btn-sm" style="background:rgba(74,222,128,0.15);color:#4ade80;border:1px solid rgba(74,222,128,0.3)">승인</button>
        </form>
        <form style="display:inline" onsubmit="event.preventDefault();reviewClub(${a.id},'reject',this)">
          <input type="text" name="memo" placeholder="반려 사유" style="width:100px;padding:4px 8px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:6px;color:#fff;font-size:0.75rem">
          <button class="btn-sm" style="background:rgba(239,68,68,0.15);color:#ef4444;border:1px solid rgba(239,68,68,0.3)">반려</button>
        </form>` : new Date(a.reviewed_at || a.created_at).toLocaleDateString('ko-KR')}</td>
    </tr>
  `).join('');

  const html = `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
    <title>클럽 인증 심사 - 관리자</title>
    <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;700;900&display=swap" rel="stylesheet">
    <style>
      *{margin:0;padding:0;box-sizing:border-box}
      body{font-family:'Noto Sans KR',sans-serif;background:linear-gradient(135deg,#0f0c29,#302b63,#24243e);color:#fff;min-height:100vh}
      nav{position:sticky;top:0;z-index:100;display:flex;justify-content:space-between;align-items:center;padding:16px 40px;background:rgba(15,12,41,0.95);backdrop-filter:blur(20px);border-bottom:1px solid rgba(255,255,255,0.05)}
      .logo{font-size:1.4rem;font-weight:900;background:linear-gradient(135deg,#4f46e5,#06b6d4);-webkit-background-clip:text;-webkit-text-fill-color:transparent;text-decoration:none}
      .nav-links{display:flex;align-items:center;gap:24px;flex-wrap:wrap}
      .nav-item{padding:8px 16px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:50px;color:rgba(255,255,255,0.75);text-decoration:none;font-size:0.82rem;font-weight:600;transition:all 0.3s}
      .nav-item:hover{background:rgba(79,70,229,0.2);border-color:rgba(79,70,229,0.4);color:#fff}
      .user-area{display:flex;align-items:center;gap:16px}
      .user-area img{width:36px;height:36px;border-radius:50%;border:2px solid rgba(79,70,229,0.5)}
      .logout-btn{padding:8px 20px;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.15);border-radius:50px;color:#fff;text-decoration:none;font-size:0.85rem}
      .container{max-width:1000px;margin:0 auto;padding:40px 20px}
      .back-link{color:rgba(255,255,255,0.4);text-decoration:none;font-size:0.9rem;margin-bottom:20px;display:inline-block}
      h1{font-size:1.5rem;font-weight:900;margin-bottom:20px}
      h1 .highlight{background:linear-gradient(135deg,#4f46e5,#06b6d4);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
      table{width:100%;border-collapse:collapse}
      th{text-align:left;padding:12px 16px;font-size:0.8rem;color:rgba(255,255,255,0.4);border-bottom:1px solid rgba(255,255,255,0.08)}
      td{padding:12px 16px;font-size:0.88rem;border-bottom:1px solid rgba(255,255,255,0.04)}
      .btn-sm{padding:5px 12px;border-radius:8px;font-size:0.75rem;font-weight:700;cursor:pointer;font-family:inherit;border:none}
    </style></head><body>
    <nav>${buildNav(req.user)}</nav>
    <div class="container">
      <a href="/admin" class="back-link">&larr; 관리자 대시보드</a>
      <h1><span class="highlight">클럽 인증</span> 심사</h1>
      <table>
        <thead><tr><th>닉네임</th><th>이메일</th><th>클럽</th><th>인증 설명</th><th>상태</th><th>액션</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="6" style="text-align:center;color:rgba(255,255,255,0.3);padding:30px">인증 신청이 없습니다.</td></tr>'}</tbody>
      </table>
    </div>
    <script>
      function reviewClub(id, action, form) {
        var memo = form.querySelector('input[name="memo"]');
        fetch('/admin/club-verifications/' + id + '/review', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
          body: JSON.stringify({ action: action, memo: memo ? memo.value : '' })
        }).then(function(r) { return r.json(); }).then(function(d) { if (d.ok) window.location.reload(); else alert(d.error); });
      }
    </script></body></html>`;
  res.send(html);
});

// 클럽 인증 심사 처리
router.post('/club-verifications/:id/review', isLoggedIn, isAdmin, (req, res) => {
  const { action, memo } = req.body;
  const app = db.prepare('SELECT * FROM club_verifications WHERE id = ?').get(req.params.id);
  if (!app) return res.json({ ok: false, error: '신청을 찾을 수 없습니다.' });

  if (action === 'approve') {
    db.prepare("UPDATE club_verifications SET status = 'approved', admin_memo = ?, reviewed_at = datetime('now') WHERE id = ?").run(memo || '', app.id);
    const clubNames = { '10b': '10억 클럽', '100b': '100억 클럽', '1000b': '1000억 클럽', '1t': '1조 클럽' };
    notify(db, app.user_id, 'study_approved', '클럽 인증 승인', `${clubNames[app.club] || app.club} 인증이 승인되었습니다!`, '/community?board=' + app.club);
  } else {
    db.prepare("UPDATE club_verifications SET status = 'rejected', admin_memo = ?, reviewed_at = datetime('now') WHERE id = ?").run(memo || '', app.id);
    notify(db, app.user_id, 'study_rejected', '클럽 인증 반려', `클럽 인증이 반려되었습니다.${memo ? ' 사유: ' + memo : ''}`, '/community/club-apply?club=' + app.club);
  }
  res.json({ ok: true });
});

module.exports = router;
