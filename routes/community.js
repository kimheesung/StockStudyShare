const express = require('express');
const db = require('../lib/db');
const { render, isLoggedIn, isAdmin, buildNav, escapeHtml, notify } = require('../lib/helpers');
const router = express.Router();

const BOARDS = {
  all: { name: '모두', icon: '💬', needVerify: false, minPoints: 0 },
  '10b': { name: '100만P 클럽', icon: '💰', needVerify: true, minPoints: 1000000 },
  '100b': { name: '1000만P 클럽', icon: '💎', needVerify: true, minPoints: 10000000 },
  '1000b': { name: '1억P 클럽', icon: '👑', needVerify: true, minPoints: 100000000 },
};

function hasClubAccess(user, board) {
  const boardInfo = BOARDS[board];
  if (!boardInfo || !boardInfo.needVerify) return true;
  if (user.role === 'admin') return true;
  const userPoints = db.prepare('SELECT points FROM users WHERE id = ?').get(user.id);
  return userPoints && userPoints.points >= boardInfo.minPoints;
}

function getUserBoardNickname(userId) {
  const row = db.prepare('SELECT board_nickname FROM user_board_profiles WHERE user_id = ?').get(userId);
  return row ? row.board_nickname : null;
}

function getUserVerifiedClubs(userId) {
  const rows = db.prepare("SELECT club FROM club_verifications WHERE user_id = ? AND status = 'approved'").all(userId);
  return new Set(rows.map(r => r.club));
}

// 게시판 목록
router.get('/', isLoggedIn, (req, res) => {
  const board = req.query.board || 'all';
  const boardInfo = BOARDS[board];
  if (!boardInfo) return res.redirect('/community?board=all');

  // 클럽 접근 권한 체크 (포인트 기반)
  if (boardInfo.needVerify && !hasClubAccess(req.user, board)) {
    return res.redirect('/community/club-info?club=' + board);
  }

  const page = parseInt(req.query.page) || 1;
  const limit = 20;
  const offset = (page - 1) * limit;

  const totalCount = db.prepare('SELECT COUNT(*) as c FROM board_posts WHERE board = ? AND is_deleted = 0 AND is_hidden = 0').get(board).c;
  const posts = db.prepare(`
    SELECT bp.*, u.photo
    FROM board_posts bp
    JOIN users u ON bp.user_id = u.id
    WHERE bp.board = ? AND bp.is_deleted = 0 AND bp.is_hidden = 0
    ORDER BY bp.created_at DESC
    LIMIT ? OFFSET ?
  `).all(board, limit, offset);

  const boardNickname = getUserBoardNickname(req.user.id);

  // 탭
  const boardTabs = Object.entries(BOARDS).map(([key, info]) => {
    const isActive = key === board;
    const isLocked = info.needVerify && !hasClubAccess(req.user, key);
    const pointLabel = info.minPoints > 0 ? ` (${(info.minPoints / 10000).toLocaleString()}만P)` : '';
    return `<a href="/community?board=${key}" class="board-tab ${isActive ? 'active' : ''} ${isLocked ? 'locked' : ''}">${info.icon} ${info.name}${isLocked ? ' 🔒' + pointLabel : ''}</a>`;
  }).join('');

  // 글 목록
  const isAdminUser = req.user.role === 'admin';
  const postRows = posts.length > 0 ? posts.map(p => {
    const commentCount = db.prepare('SELECT COUNT(*) as c FROM board_comments WHERE post_id = ?').get(p.id).c;
    const timeAgo = getTimeAgo(p.created_at);
    const displayName = p.board_nickname || '익명';
    const adminDeleteBtn = isAdminUser ? `<button class="admin-del-btn" onclick="event.preventDefault();adminDelete(${p.id})" title="삭제">✕</button>` : '';
    return `
      <a href="/community/post/${p.id}" class="post-row">
        <div class="post-main">
          <div class="post-title">${escapeHtml(p.title)}</div>
          <div class="post-meta">${escapeHtml(displayName)} · ${timeAgo}${commentCount > 0 ? ` · 댓글 ${commentCount}` : ''}</div>
        </div>
        ${adminDeleteBtn}
      </a>`;
  }).join('') : '<div class="empty-text">아직 글이 없습니다. 첫 글을 작성해보세요!</div>';

  // 페이지네이션
  const totalPages = Math.ceil(totalCount / limit);
  let pagination = '';
  if (totalPages > 1) {
    pagination = '<div class="pagination">';
    for (let i = 1; i <= totalPages; i++) {
      pagination += `<a href="/community?board=${board}&page=${i}" class="page-btn ${i === page ? 'active' : ''}">${i}</a>`;
    }
    pagination += '</div>';
  }

  const html = render('views/community.html', {
    nav: buildNav(req.user),
    boardTabs,
    boardName: boardInfo.name,
    boardIcon: boardInfo.icon,
    boardKey: board,
    postRows,
    pagination,
    totalCount: String(totalCount),
    hasBoardNickname: boardNickname ? 'true' : '',
    boardNickname: escapeHtml(boardNickname || ''),
  });
  res.send(html);
});

// 게시판 닉네임 설정
router.post('/set-nickname', isLoggedIn, (req, res) => {
  const nickname = (req.body.nickname || '').trim();
  if (!nickname || nickname.length < 2 || nickname.length > 15) {
    return res.json({ ok: false, error: '닉네임은 2~15자여야 합니다.' });
  }
  const existing = db.prepare('SELECT user_id FROM user_board_profiles WHERE board_nickname = ? AND user_id != ?').get(nickname, req.user.id);
  if (existing) return res.json({ ok: false, error: '이미 사용 중인 게시판 닉네임입니다.' });

  db.prepare('INSERT INTO user_board_profiles (user_id, board_nickname) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET board_nickname = ?').run(req.user.id, nickname, nickname);
  res.json({ ok: true });
});

// 글 작성
router.post('/write', isLoggedIn, (req, res) => {
  const { board, title, content } = req.body;
  const boardInfo = BOARDS[board];
  if (!boardInfo) return res.json({ ok: false, error: '유효하지 않은 게시판입니다.' });

  if (boardInfo.needVerify && !hasClubAccess(req.user, board)) {
    return res.json({ ok: false, error: `${boardInfo.name}은 ${(boardInfo.minPoints / 10000).toLocaleString()}만P 이상 보유자만 글을 작성할 수 있습니다.` });
  }

  if (!title || !content) return res.json({ ok: false, error: '제목과 내용을 입력해주세요.' });

  const boardNickname = getUserBoardNickname(req.user.id);
  if (!boardNickname) return res.json({ ok: false, error: '게시판 닉네임을 먼저 설정해주세요.' });

  db.prepare('INSERT INTO board_posts (user_id, board, board_nickname, title, content) VALUES (?, ?, ?, ?, ?)').run(
    req.user.id, board, boardNickname, title, content
  );
  res.json({ ok: true });
});

// 글 상세
router.get('/post/:id', isLoggedIn, (req, res) => {
  const post = db.prepare(`
    SELECT bp.*, u.photo FROM board_posts bp
    JOIN users u ON bp.user_id = u.id
    WHERE bp.id = ? AND bp.is_deleted = 0
  `).get(req.params.id);
  if (!post) return res.status(404).send('글을 찾을 수 없습니다.');

  // 가려진 글은 작성자와 관리자만 볼 수 있음
  if (post.is_hidden && post.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).send('이 글은 신고 누적으로 가려진 상태입니다. 관리자 검토 중입니다.');
  }

  const boardInfo = BOARDS[post.board];
  if (boardInfo && boardInfo.needVerify && !hasClubAccess(req.user, post.board)) {
    return res.redirect('/community/club-info?club=' + post.board);
  }

  const comments = db.prepare(`
    SELECT bc.*, u.photo FROM board_comments bc
    JOIN users u ON bc.user_id = u.id
    WHERE bc.post_id = ?
    ORDER BY bc.created_at ASC
  `).all(post.id);

  const alreadyReported = !!db.prepare('SELECT id FROM board_reports WHERE post_id = ? AND user_id = ?').get(post.id, req.user.id);
  const isAuthor = post.user_id === req.user.id;
  const boardNickname = getUserBoardNickname(req.user.id) || '';

  const commentHtml = comments.length > 0 ? comments.map(c => `
    <div class="comment">
      <div class="comment-header">
        <span class="comment-author">${escapeHtml(c.board_nickname || '익명')}</span>
        <span class="comment-time">${getTimeAgo(c.created_at)}</span>
      </div>
      <div class="comment-content">${escapeHtml(c.content)}</div>
    </div>
  `).join('') : '';

  const html = render('views/community-post.html', {
    nav: buildNav(req.user),
    postId: String(post.id),
    boardKey: post.board,
    boardName: boardInfo ? boardInfo.name : post.board,
    boardIcon: boardInfo ? boardInfo.icon : '',
    title: escapeHtml(post.title),
    content: escapeHtml(post.content),
    authorNickname: escapeHtml(post.board_nickname || '익명'),
    timeAgo: getTimeAgo(post.created_at),
    reportCount: String(post.report_count),
    commentHtml,
    commentCount: String(comments.length),
    alreadyReported: alreadyReported ? 'true' : '',
    isAuthor: isAuthor ? 'true' : '',
    isAdmin: req.user.role === 'admin' ? 'true' : '',
    boardNickname: escapeHtml(boardNickname),
  });
  res.send(html);
});

// 댓글 작성
router.post('/post/:id/comment', isLoggedIn, (req, res) => {
  const post = db.prepare('SELECT * FROM board_posts WHERE id = ? AND is_deleted = 0').get(req.params.id);
  if (!post) return res.json({ ok: false, error: '글을 찾을 수 없습니다.' });

  const content = (req.body.content || '').trim();
  if (!content) return res.json({ ok: false, error: '댓글 내용을 입력해주세요.' });

  const boardNickname = getUserBoardNickname(req.user.id);
  if (!boardNickname) return res.json({ ok: false, error: '게시판 닉네임을 먼저 설정해주세요.' });

  db.prepare('INSERT INTO board_comments (post_id, user_id, board_nickname, content) VALUES (?, ?, ?, ?)').run(
    post.id, req.user.id, boardNickname, content
  );
  res.json({ ok: true });
});

// 신고
router.post('/post/:id/report', isLoggedIn, (req, res) => {
  const post = db.prepare('SELECT * FROM board_posts WHERE id = ? AND is_deleted = 0').get(req.params.id);
  if (!post) return res.json({ ok: false, error: '글을 찾을 수 없습니다.' });

  const existing = db.prepare('SELECT id FROM board_reports WHERE post_id = ? AND user_id = ?').get(post.id, req.user.id);
  if (existing) return res.json({ ok: false, error: '이미 신고한 글입니다.' });

  db.prepare('INSERT INTO board_reports (post_id, user_id, reason) VALUES (?, ?, ?)').run(post.id, req.user.id, req.body.reason || '');
  const newCount = db.prepare('SELECT COUNT(*) as c FROM board_reports WHERE post_id = ?').get(post.id).c;
  db.prepare('UPDATE board_posts SET report_count = ? WHERE id = ?').run(newCount, post.id);

  // 5개 이상 신고 시 가리기 (관리자 확인 대기)
  let hidden = false;
  if (newCount >= 5) {
    db.prepare('UPDATE board_posts SET is_hidden = 1 WHERE id = ?').run(post.id);
    hidden = true;
    // 관리자에게 알림
    const admins = db.prepare("SELECT id FROM users WHERE role = 'admin'").all();
    for (const admin of admins) {
      notify(db, admin.id, 'report_pending_admin', '게시글 신고 누적', `"${post.title}" 게시글이 신고 ${newCount}건으로 자동 가려졌습니다. 확인이 필요합니다.`, '/admin/board-reports');
    }
  }

  res.json({ ok: true, count: newCount, hidden });
});

// 글 삭제 (본인 또는 관리자)
router.post('/post/:id/delete', isLoggedIn, (req, res) => {
  const post = db.prepare('SELECT * FROM board_posts WHERE id = ? AND is_deleted = 0').get(req.params.id);
  if (!post) return res.json({ ok: false, error: '글을 찾을 수 없습니다.' });
  if (post.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.json({ ok: false, error: '삭제 권한이 없습니다.' });
  }
  db.prepare('UPDATE board_posts SET is_deleted = 1 WHERE id = ?').run(post.id);
  res.json({ ok: true });
});

// 클럽 접근 불가 안내 페이지
router.get('/club-info', isLoggedIn, (req, res) => {
  const club = req.query.club;
  const clubInfo = BOARDS[club];
  if (!clubInfo || !clubInfo.needVerify) return res.redirect('/community');

  const userPoints = db.prepare('SELECT points FROM users WHERE id = ?').get(req.user.id);
  const currentPoints = userPoints ? userPoints.points : 0;
  const needed = clubInfo.minPoints - currentPoints;
  const minPointsStr = clubInfo.minPoints >= 100000000
    ? (clubInfo.minPoints / 100000000).toLocaleString() + '억'
    : (clubInfo.minPoints / 10000).toLocaleString() + '만';

  const html = `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
    <title>${clubInfo.name} - StockStudyShare</title>
    <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;700;900&display=swap" rel="stylesheet">
    <style>
      *{margin:0;padding:0;box-sizing:border-box}
      body{font-family:'Noto Sans KR',sans-serif;background:linear-gradient(135deg,#0f0c29,#302b63,#24243e);color:#fff;min-height:100vh}
      nav{position:sticky;top:0;z-index:100;display:flex;justify-content:space-between;align-items:center;padding:16px 40px;background:rgba(15,12,41,0.95);backdrop-filter:blur(20px);border-bottom:1px solid rgba(255,255,255,0.05)}
      .logo{font-size:1.4rem;font-weight:900;background:linear-gradient(135deg,#4f46e5,#06b6d4);-webkit-background-clip:text;-webkit-text-fill-color:transparent;text-decoration:none}
      .nav-links{display:flex;align-items:center;gap:24px;flex-wrap:wrap}
      .nav-item{padding:8px 16px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:50px;color:rgba(255,255,255,0.75);text-decoration:none;font-size:0.82rem;font-weight:600}
      .user-area{display:flex;align-items:center;gap:16px}
      .user-area img{width:36px;height:36px;border-radius:50%;border:2px solid rgba(79,70,229,0.5)}
      .logout-btn{padding:8px 20px;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.15);border-radius:50px;color:#fff;text-decoration:none;font-size:0.85rem}
      .container{max-width:600px;margin:0 auto;padding:60px 20px;text-align:center}
      .club-icon{font-size:4rem;margin-bottom:16px}
      h1{font-size:1.8rem;font-weight:900;margin-bottom:12px}
      .desc{color:rgba(255,255,255,0.5);font-size:0.95rem;line-height:1.7;margin-bottom:32px}
      .info-box{padding:28px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:20px;margin-bottom:24px}
      .info-row{display:flex;justify-content:space-between;padding:12px 0;border-bottom:1px solid rgba(255,255,255,0.05);font-size:0.95rem}
      .info-row:last-child{border-bottom:none}
      .info-label{color:rgba(255,255,255,0.4)}
      .info-value{font-weight:700}
      .progress-bar{height:10px;background:rgba(255,255,255,0.08);border-radius:5px;margin:20px 0 8px;overflow:hidden}
      .progress-fill{height:100%;border-radius:5px;transition:width 0.5s}
      .btn-charge{display:inline-block;padding:14px 36px;background:linear-gradient(135deg,#4f46e5,#6366f1);border-radius:50px;color:#fff;text-decoration:none;font-weight:700;font-size:1rem;transition:all 0.3s}
      .btn-charge:hover{transform:translateY(-2px);box-shadow:0 8px 30px rgba(79,70,229,0.5)}
      .back-link{display:inline-block;margin-top:16px;color:rgba(255,255,255,0.4);text-decoration:none;font-size:0.9rem}
    </style></head><body>
    <nav>${buildNav(req.user)}</nav>
    <div class="container">
      <div class="club-icon">${clubInfo.icon}</div>
      <h1>${clubInfo.name}</h1>
      <p class="desc">${clubInfo.name}은 <strong>${minPointsStr}P 이상</strong> 보유한 회원만<br>글을 쓰고 읽을 수 있는 프리미엄 게시판입니다.</p>
      <div class="info-box">
        <div class="info-row">
          <span class="info-label">필요 포인트</span>
          <span class="info-value" style="color:#fbbf24">${clubInfo.minPoints.toLocaleString()}P</span>
        </div>
        <div class="info-row">
          <span class="info-label">내 보유 포인트</span>
          <span class="info-value">${currentPoints.toLocaleString()}P</span>
        </div>
        <div class="info-row">
          <span class="info-label">부족 포인트</span>
          <span class="info-value" style="color:#ef4444">${needed > 0 ? needed.toLocaleString() + 'P' : '충족!'}</span>
        </div>
        <div class="progress-bar">
          <div class="progress-fill" style="width:${Math.min(100, (currentPoints / clubInfo.minPoints) * 100)}%;background:linear-gradient(90deg,#4f46e5,#06b6d4)"></div>
        </div>
        <div style="font-size:0.78rem;color:rgba(255,255,255,0.3)">${Math.min(100, (currentPoints / clubInfo.minPoints * 100)).toFixed(1)}% 달성</div>
      </div>
      <a href="/my/points" class="btn-charge">포인트 충전하기</a>
      <br><a href="/community" class="back-link">&larr; 게시판으로 돌아가기</a>
    </div></body></html>`;
  res.send(html);
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
