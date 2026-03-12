const express = require('express');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'YOUR_CLIENT_ID';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'YOUR_CLIENT_SECRET';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
}));
app.use(passport.initialize());
app.use(passport.session());

// ── 인메모리 데이터 저장소 ──
const users = new Map();   // id -> user
const studies = [];         // study 배열

// 샘플 스터디 데이터
studies.push(
  {
    id: '1',
    title: '미국 성장주 Deep Dive',
    description: '매주 미국 성장주 1종목을 선정해 재무제표, 비즈니스 모델, 밸류에이션을 심층 분석합니다. NVDA, TSLA, AMZN 등 빅테크부터 유망 중소형주까지 다룹니다.',
    category: '해외주식',
    maxMembers: 8,
    schedule: '매주 토요일 오후 2시',
    creatorId: 'system',
    creatorName: 'StockStudyShare',
    creatorPhoto: '',
    members: [],
    createdAt: new Date().toISOString(),
  },
  {
    id: '2',
    title: '차트 패턴 마스터 클래스',
    description: '캔들 패턴, 이동평균선, 볼린저밴드 등 기술적 분석의 핵심을 매주 실전 차트로 학습합니다. 초보자도 환영합니다.',
    category: '기술적분석',
    maxMembers: 12,
    schedule: '매주 수요일 저녁 8시',
    creatorId: 'system',
    creatorName: 'StockStudyShare',
    creatorPhoto: '',
    members: [],
    createdAt: new Date().toISOString(),
  },
  {
    id: '3',
    title: '배당주로 월급 만들기',
    description: '국내외 배당주를 분석하고 배당 포트폴리오를 함께 설계합니다. 매달 배당금 수령을 목표로 장기 투자 전략을 세워봅니다.',
    category: '배당투자',
    maxMembers: 10,
    schedule: '격주 일요일 오전 11시',
    creatorId: 'system',
    creatorName: 'StockStudyShare',
    creatorPhoto: '',
    members: [],
    createdAt: new Date().toISOString(),
  }
);

// ── Passport 설정 ──
passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => {
  const user = users.get(id);
  done(null, user || null);
});

passport.use(new GoogleStrategy({
  clientID: GOOGLE_CLIENT_ID,
  clientSecret: GOOGLE_CLIENT_SECRET,
  callbackURL: process.env.CALLBACK_URL || `http://localhost:${port}/auth/google/callback`,
}, (accessToken, refreshToken, profile, done) => {
  let user = users.get(profile.id);
  if (!user) {
    user = {
      id: profile.id,
      name: profile.displayName,
      email: profile.emails?.[0]?.value,
      photo: profile.photos?.[0]?.value,
      joinedAt: new Date().toISOString(),
    };
    users.set(user.id, user);
  }
  return done(null, user);
}));

function isLoggedIn(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.redirect('/');
}

// ── 헬퍼: HTML 템플릿 렌더링 ──
function render(filePath, replacements) {
  let html = fs.readFileSync(path.join(__dirname, filePath), 'utf8');
  for (const [key, value] of Object.entries(replacements)) {
    html = html.replaceAll(`{{${key}}}`, value || '');
  }
  return html;
}

// ── 라우트 ──

// 홈 / 대시보드
app.get('/', (req, res) => {
  if (req.isAuthenticated()) {
    res.redirect('/dashboard');
  } else {
    res.sendFile(path.join(__dirname, 'views/home.html'));
  }
});

// 대시보드 - 스터디 목록
app.get('/dashboard', isLoggedIn, (req, res) => {
  const studyCards = studies.map(s => {
    const memberCount = s.members.length;
    const isMember = s.members.includes(req.user.id);
    const isCreator = s.creatorId === req.user.id;
    let badge = '';
    if (isCreator) badge = '<span class="badge-creator">내가 만든</span>';
    else if (isMember) badge = '<span class="badge-member">참여중</span>';

    return `
      <a href="/study/${s.id}" class="study-card">
        <div class="card-category">${s.category}</div>
        <h3>${s.title}</h3>
        <p class="card-desc">${s.description.slice(0, 60)}...</p>
        <div class="card-meta">
          <span>👥 ${memberCount}/${s.maxMembers}명</span>
          <span>📅 ${s.schedule}</span>
        </div>
        ${badge}
      </a>`;
  }).join('');

  const html = render('views/dashboard.html', {
    name: req.user.name,
    photo: req.user.photo,
    email: req.user.email,
    studyCards: studyCards,
  });
  res.send(html);
});

// 스터디 상세
app.get('/study/:id', isLoggedIn, (req, res) => {
  const study = studies.find(s => s.id === req.params.id);
  if (!study) return res.status(404).send('스터디를 찾을 수 없습니다.');

  const isMember = study.members.includes(req.user.id);
  const isCreator = study.creatorId === req.user.id;
  const isFull = study.members.length >= study.maxMembers;

  let actionButton = '';
  if (isCreator) {
    actionButton = '<button class="btn-action btn-disabled" disabled>내가 만든 스터디입니다</button>';
  } else if (isMember) {
    actionButton = `<form method="POST" action="/study/${study.id}/leave"><button class="btn-action btn-leave">탈퇴하기</button></form>`;
  } else if (isFull) {
    actionButton = '<button class="btn-action btn-disabled" disabled>정원이 다 찼습니다</button>';
  } else {
    actionButton = `<form method="POST" action="/study/${study.id}/join"><button class="btn-action btn-join">신청하기</button></form>`;
  }

  let memberList = study.members.map(mid => {
    const u = users.get(mid);
    if (!u) return '';
    return `<div class="member-item"><img src="${u.photo}" alt=""><span>${u.name}</span></div>`;
  }).join('');
  if (!memberList) {
    memberList = '<p class="empty-members">아직 참여 멤버가 없습니다. 첫 번째 멤버가 되어보세요!</p>';
  }

  const html = render('views/study-detail.html', {
    name: req.user.name,
    photo: req.user.photo,
    title: study.title,
    description: study.description,
    category: study.category,
    schedule: study.schedule,
    maxMembers: String(study.maxMembers),
    memberCount: String(study.members.length),
    creatorName: study.creatorName,
    actionButton: actionButton,
    memberList: memberList,
  });
  res.send(html);
});

// 스터디 신청
app.post('/study/:id/join', isLoggedIn, (req, res) => {
  const study = studies.find(s => s.id === req.params.id);
  if (!study) return res.status(404).send('스터디를 찾을 수 없습니다.');
  if (!study.members.includes(req.user.id) && study.members.length < study.maxMembers) {
    study.members.push(req.user.id);
  }
  res.redirect(`/study/${study.id}`);
});

// 스터디 탈퇴
app.post('/study/:id/leave', isLoggedIn, (req, res) => {
  const study = studies.find(s => s.id === req.params.id);
  if (!study) return res.status(404).send('스터디를 찾을 수 없습니다.');
  study.members = study.members.filter(id => id !== req.user.id);
  res.redirect(`/study/${study.id}`);
});

// 스터디 만들기 폼
app.get('/study-new', isLoggedIn, (req, res) => {
  const html = render('views/study-new.html', {
    name: req.user.name,
    photo: req.user.photo,
  });
  res.send(html);
});

// 스터디 생성
app.post('/study-new', isLoggedIn, (req, res) => {
  const { title, description, category, maxMembers, schedule } = req.body;
  const study = {
    id: String(Date.now()),
    title,
    description,
    category: category || '기타',
    maxMembers: parseInt(maxMembers) || 10,
    schedule: schedule || '미정',
    creatorId: req.user.id,
    creatorName: req.user.name,
    creatorPhoto: req.user.photo,
    members: [],
    createdAt: new Date().toISOString(),
  };
  studies.unshift(study);
  res.redirect('/dashboard');
});

// Google 로그인
app.get('/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/' }),
  (req, res) => res.redirect('/dashboard')
);

app.get('/logout', (req, res) => {
  req.logout(() => res.redirect('/'));
});

app.get('/api/me', isLoggedIn, (req, res) => {
  res.json(req.user);
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
