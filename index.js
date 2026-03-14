require('dotenv').config();
const express = require('express');
const path = require('path');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const db = require('./lib/db');

const app = express();
const port = process.env.PORT || 3000;

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'YOUR_CLIENT_ID';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'YOUR_CLIENT_SECRET';
// 콤마 구분으로 여러 admin ID 지정 가능
const ADMIN_GOOGLE_IDS = (process.env.ADMIN_GOOGLE_ID || '').split(',').map(s => s.trim()).filter(Boolean);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000,
  },
}));
app.use(passport.initialize());
app.use(passport.session());

// ── Passport 설정 ──
passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  done(null, user || null);
});

passport.use(new GoogleStrategy({
  clientID: GOOGLE_CLIENT_ID,
  clientSecret: GOOGLE_CLIENT_SECRET,
  callbackURL: process.env.CALLBACK_URL || `http://localhost:${port}/auth/google/callback`,
}, (accessToken, refreshToken, profile, done) => {
  const id = profile.id;
  const name = profile.displayName;
  const email = profile.emails?.[0]?.value || '';
  const photo = profile.photos?.[0]?.value || '';

  let user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) {
    const isAdminUser = ADMIN_GOOGLE_IDS.includes(id);
    const role = isAdminUser ? 'admin' : 'user';
    const nickname = isAdminUser ? 'admin' : null;
    db.prepare('INSERT INTO users (id, name, email, photo, role, nickname, points) VALUES (?, ?, ?, ?, ?, ?, 100000)').run(id, name, email, photo, role, nickname);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    // 가입 환영 포인트 로그
    db.prepare("INSERT INTO point_logs (user_id, amount, type, description) VALUES (?, 100000, 'welcome', '가입 환영 포인트')").run(id);
  } else {
    // 기존 유저: 이름/사진 업데이트
    db.prepare('UPDATE users SET name = ?, photo = ? WHERE id = ?').run(name, photo, id);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  }
  return done(null, user);
}));

// ── 프로필 설정 (닉네임/추천인) ──
const { render, buildNav, escapeHtml, needsSetup } = require('./lib/helpers');

app.get('/setup', (req, res) => {
  if (!req.isAuthenticated()) return res.redirect('/');
  if (!needsSetup(req)) return res.redirect('/dashboard');
  const html = render('views/setup-profile.html', {
    name: escapeHtml(req.user.name),
    email: escapeHtml(req.user.email || ''),
    photo: req.user.photo || '',
  });
  res.send(html);
});

app.post('/setup', (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: '로그인이 필요합니다.' });
  if (!needsSetup(req)) return res.json({ ok: true });

  const nickname = (req.body.nickname || '').trim();
  const referrerNickname = (req.body.referrer_nickname || '').trim();

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

  let referrerId = null;
  if (referrerNickname) {
    const referrer = db.prepare('SELECT id FROM users WHERE nickname = ?').get(referrerNickname);
    if (!referrer) {
      return res.json({ ok: false, error: '존재하지 않는 추천인 닉네임입니다.' });
    }
    if (referrer.id === req.user.id) {
      return res.json({ ok: false, error: '본인을 추천인으로 지정할 수 없습니다.' });
    }
    referrerId = referrer.id;
  }

  db.prepare('UPDATE users SET nickname = ?, referrer_id = ? WHERE id = ?').run(nickname, referrerId, req.user.id);
  req.user.nickname = nickname;
  req.user.referrer_id = referrerId;

  res.json({ ok: true });
});

// ── 유저 포인트 API ──
app.get('/api/my-points', (req, res) => {
  if (!req.isAuthenticated()) return res.json({ points: 0 });
  const user = db.prepare('SELECT points FROM users WHERE id = ?').get(req.user.id);
  res.json({ points: user ? user.points : 0 });
});

// ── 알림 API ──
app.get('/api/notifications', (req, res) => {
  if (!req.isAuthenticated()) return res.json({ items: [] });
  const items = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').all(req.user.id);
  res.json({ items });
});

app.get('/api/notifications/unread-count', (req, res) => {
  if (!req.isAuthenticated()) return res.json({ count: 0 });
  const row = db.prepare('SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = 0').get(req.user.id);
  res.json({ count: row.count });
});

app.post('/api/notifications/:id/read', (req, res) => {
  if (!req.isAuthenticated()) return res.json({ ok: false });
  db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

app.post('/api/notifications/read-all', (req, res) => {
  if (!req.isAuthenticated()) return res.json({ ok: false });
  db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0').run(req.user.id);
  res.json({ ok: true });
});

// ── 라우트 마운트 ──
app.use('/', require('./routes/public'));
app.use('/auth', require('./routes/auth'));
app.use('/reports', require('./routes/reports'));
app.use('/my', require('./routes/user'));
app.use('/author', require('./routes/author'));
app.use('/study', require('./routes/study'));
app.use('/admin', require('./routes/admin'));
app.use('/visit-notes', require('./routes/visitnotes'));
app.use('/community', require('./routes/community'));

app.get('/author-profile/:id', (req, res) => {
  const profile = db.prepare(`
    SELECT ap.*, u.name, u.nickname, u.photo, u.joined_at
    FROM author_profiles ap
    JOIN users u ON ap.user_id = u.id
    WHERE ap.user_id = ?
  `).get(req.params.id);

  if (!profile) return res.status(404).send('작성자를 찾을 수 없습니다.');

  const reports = db.prepare(`
    SELECT id, title, stock_name, stock_code, sector, sale_price, summary, published_at,
           (SELECT COUNT(*) FROM orders WHERE report_id = reports.id) as sales_count,
           (SELECT AVG(rating) FROM report_ratings WHERE report_id = reports.id) as avg_rating
    FROM reports WHERE author_id = ? AND status IN ('on_sale', 'study_published')
    ORDER BY published_at DESC
  `).all(req.params.id);

  const followerCount = db.prepare('SELECT COUNT(*) as c FROM follows WHERE author_id = ?').get(req.params.id).c;
  const totalSales = db.prepare('SELECT COUNT(*) as c FROM orders o JOIN reports r ON o.report_id = r.id WHERE r.author_id = ?').get(req.params.id).c;
  const isFollowing = req.user ? !!db.prepare('SELECT id FROM follows WHERE follower_id = ? AND author_id = ?').get(req.user.id, req.params.id) : false;
  const isSelf = req.user && req.user.id === req.params.id;

  const reportCards = reports.length > 0 ? reports.map(r => {
    const ratingStr = r.avg_rating ? `<span style="color:#fbbf24">&#9733;</span> ${Number(r.avg_rating).toFixed(1)}` : '';
    return `
    <a href="/reports/${r.id}" style="display:block;padding:20px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:16px;text-decoration:none;color:#fff;transition:all 0.3s;margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px">
        <div style="flex:1">
          <div style="font-size:0.75rem;color:rgba(255,255,255,0.35);margin-bottom:4px">${escapeHtml(r.sector || '')} · ${escapeHtml(r.stock_name)}${r.stock_code ? ' (' + r.stock_code + ')' : ''}</div>
          <h3 style="font-size:1rem;font-weight:700;margin-bottom:6px">${escapeHtml(r.title)}</h3>
          <p style="font-size:0.82rem;color:rgba(255,255,255,0.4);line-height:1.5">${escapeHtml((r.summary || '').slice(0, 120))}${(r.summary || '').length > 120 ? '...' : ''}</p>
        </div>
        <div style="text-align:right;flex-shrink:0">
          <div style="font-weight:700;color:#fbbf24;font-size:0.9rem">${r.sale_price === 0 ? '무료' : r.sale_price.toLocaleString() + 'P'}</div>
          <div style="font-size:0.72rem;color:rgba(255,255,255,0.3);margin-top:4px">${r.published_at ? new Date(r.published_at).toLocaleDateString('ko-KR') : ''}</div>
          <div style="font-size:0.72rem;color:rgba(255,255,255,0.3);margin-top:2px">판매 ${r.sales_count}건 ${ratingStr}</div>
        </div>
      </div>
    </a>`;
  }).join('') : '<p style="color:rgba(255,255,255,0.3);text-align:center;padding:40px">아직 리포트가 없습니다.</p>';

  const followBtn = isSelf ? '' : (req.user
    ? `<button id="follow-btn" onclick="toggleFollow()" style="padding:10px 28px;border-radius:50px;font-size:0.88rem;font-weight:700;cursor:pointer;font-family:inherit;transition:all 0.2s;${
      isFollowing
        ? 'background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);color:rgba(255,255,255,0.6)'
        : 'background:linear-gradient(135deg,#4f46e5,#6366f1);border:none;color:#fff'
    }">${isFollowing ? '팔로잉' : '팔로우'}</button>`
    : `<a href="/auth/google" style="padding:10px 28px;border-radius:50px;font-size:0.88rem;font-weight:700;background:linear-gradient(135deg,#4f46e5,#6366f1);color:#fff;text-decoration:none">로그인하고 팔로우</a>`);

  const html = render('views/author-profile.html', {
    nav: buildNav(req.user),
    authorId: req.params.id,
    displayName: escapeHtml(profile.display_name || profile.nickname || profile.name),
    bio: escapeHtml(profile.bio || ''),
    sectors: escapeHtml(profile.sectors || ''),
    photo: profile.photo || '',
    joinedAt: new Date(profile.joined_at).toLocaleDateString('ko-KR'),
    reportCards,
    totalReports: String(reports.length),
    followerCount: String(followerCount),
    totalSales: String(totalSales),
    followBtn,
    isFollowing: isFollowing ? 'true' : '',
  });
  res.send(html);
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
