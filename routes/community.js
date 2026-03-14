const express = require('express');
const db = require('../lib/db');
const { render, isLoggedIn, isAdmin, buildNav, escapeHtml, notify } = require('../lib/helpers');
const router = express.Router();

const BOARDS = {
  all: { name: '모두', icon: '💬', needVerify: false },
  '10b': { name: '10억 클럽', icon: '💰', needVerify: true },
  '100b': { name: '100억 클럽', icon: '💎', needVerify: true },
  '1000b': { name: '1000억 클럽', icon: '👑', needVerify: true },
  '1t': { name: '1조 클럽', icon: '🏆', needVerify: true },
};

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

  // 클럽 접근 권한 체크
  if (boardInfo.needVerify) {
    const verified = getUserVerifiedClubs(req.user.id);
    if (!verified.has(board) && req.user.role !== 'admin') {
      return res.redirect('/community/club-apply?club=' + board);
    }
  }

  const page = parseInt(req.query.page) || 1;
  const limit = 20;
  const offset = (page - 1) * limit;

  const totalCount = db.prepare('SELECT COUNT(*) as c FROM board_posts WHERE board = ? AND is_deleted = 0').get(board).c;
  const posts = db.prepare(`
    SELECT bp.*, u.photo
    FROM board_posts bp
    JOIN users u ON bp.user_id = u.id
    WHERE bp.board = ? AND bp.is_deleted = 0
    ORDER BY bp.created_at DESC
    LIMIT ? OFFSET ?
  `).all(board, limit, offset);

  const boardNickname = getUserBoardNickname(req.user.id);
  const verifiedClubs = getUserVerifiedClubs(req.user.id);

  // 탭
  const boardTabs = Object.entries(BOARDS).map(([key, info]) => {
    const isActive = key === board;
    const isLocked = info.needVerify && !verifiedClubs.has(key) && req.user.role !== 'admin';
    return `<a href="/community?board=${key}" class="board-tab ${isActive ? 'active' : ''} ${isLocked ? 'locked' : ''}">${info.icon} ${info.name}${isLocked ? ' 🔒' : ''}</a>`;
  }).join('');

  // 글 목록
  const postRows = posts.length > 0 ? posts.map(p => {
    const commentCount = db.prepare('SELECT COUNT(*) as c FROM board_comments WHERE post_id = ?').get(p.id).c;
    const timeAgo = getTimeAgo(p.created_at);
    const displayName = p.board_nickname || '익명';
    return `
      <a href="/community/post/${p.id}" class="post-row">
        <div class="post-main">
          <div class="post-title">${escapeHtml(p.title)}</div>
          <div class="post-meta">${escapeHtml(displayName)} · ${timeAgo}${commentCount > 0 ? ` · 댓글 ${commentCount}` : ''}</div>
        </div>
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

  if (boardInfo.needVerify) {
    const verified = getUserVerifiedClubs(req.user.id);
    if (!verified.has(board) && req.user.role !== 'admin') {
      return res.json({ ok: false, error: '인증된 회원만 글을 작성할 수 있습니다.' });
    }
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

  const boardInfo = BOARDS[post.board];
  if (boardInfo && boardInfo.needVerify) {
    const verified = getUserVerifiedClubs(req.user.id);
    if (!verified.has(post.board) && req.user.role !== 'admin') {
      return res.redirect('/community/club-apply?club=' + post.board);
    }
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

  // 5개 이상 신고 시 자동 삭제
  if (newCount >= 5) {
    db.prepare('UPDATE board_posts SET is_deleted = 1 WHERE id = ?').run(post.id);
  }

  res.json({ ok: true, count: newCount, deleted: newCount >= 5 });
});

// 글 삭제 (본인만)
router.post('/post/:id/delete', isLoggedIn, (req, res) => {
  const post = db.prepare('SELECT * FROM board_posts WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!post) return res.json({ ok: false, error: '삭제할 수 없습니다.' });
  db.prepare('UPDATE board_posts SET is_deleted = 1 WHERE id = ?').run(post.id);
  res.json({ ok: true });
});

// 클럽 인증 신청 페이지
router.get('/club-apply', isLoggedIn, (req, res) => {
  const club = req.query.club;
  const clubInfo = BOARDS[club];
  if (!clubInfo || !clubInfo.needVerify) return res.redirect('/community');

  const existing = db.prepare("SELECT * FROM club_verifications WHERE user_id = ? AND club = ? ORDER BY created_at DESC LIMIT 1").get(req.user.id, club);

  const html = render('views/community-club-apply.html', {
    nav: buildNav(req.user),
    clubKey: club,
    clubName: clubInfo.name,
    clubIcon: clubInfo.icon,
    existingStatus: existing ? existing.status : '',
    adminMemo: existing ? escapeHtml(existing.admin_memo || '') : '',
  });
  res.send(html);
});

// 클럽 인증 신청 제출
router.post('/club-apply', isLoggedIn, (req, res) => {
  const { club, proof_text } = req.body;
  const clubInfo = BOARDS[club];
  if (!clubInfo || !clubInfo.needVerify) return res.json({ ok: false, error: '유효하지 않은 클럽입니다.' });

  const existing = db.prepare("SELECT id FROM club_verifications WHERE user_id = ? AND club = ? AND status = 'pending'").get(req.user.id, club);
  if (existing) return res.json({ ok: false, error: '이미 심사 중인 신청이 있습니다.' });

  db.prepare('INSERT INTO club_verifications (user_id, club, proof_text) VALUES (?, ?, ?)').run(req.user.id, club, proof_text || '');

  // 관리자에게 알림
  const admins = db.prepare("SELECT id FROM users WHERE role = 'admin'").all();
  const userName = req.user.nickname || req.user.name;
  for (const admin of admins) {
    notify(db, admin.id, 'report_pending_admin', '클럽 인증 신청', `${userName}님이 ${clubInfo.name} 인증을 신청했습니다.`, '/admin/club-verifications');
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
