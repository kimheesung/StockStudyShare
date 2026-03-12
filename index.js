const express = require('express');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// Google OAuth 설정 - .env 또는 환경변수로 설정 필요
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'YOUR_CLIENT_ID';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'YOUR_CLIENT_SECRET';

app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
}));
app.use(passport.initialize());
app.use(passport.session());

// Passport 직렬화
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

// Google Strategy
passport.use(new GoogleStrategy({
  clientID: GOOGLE_CLIENT_ID,
  clientSecret: GOOGLE_CLIENT_SECRET,
  callbackURL: process.env.CALLBACK_URL || `http://localhost:${port}/auth/google/callback`,
}, (accessToken, refreshToken, profile, done) => {
  const user = {
    id: profile.id,
    name: profile.displayName,
    email: profile.emails?.[0]?.value,
    photo: profile.photos?.[0]?.value,
  };
  return done(null, user);
}));

// 로그인 확인 미들웨어
function isLoggedIn(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.redirect('/');
}

// 홈페이지
app.get('/', (req, res) => {
  if (req.isAuthenticated()) {
    let html = fs.readFileSync(path.join(__dirname, 'views/dashboard.html'), 'utf8');
    html = html.replaceAll('{{name}}', req.user.name);
    html = html.replaceAll('{{photo}}', req.user.photo);
    html = html.replaceAll('{{email}}', req.user.email);
    res.send(html);
  } else {
    res.sendFile(path.join(__dirname, 'views/home.html'));
  }
});

// Google 로그인 시작
app.get('/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

// Google 콜백
app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/' }),
  (req, res) => res.redirect('/')
);

// 로그아웃
app.get('/logout', (req, res) => {
  req.logout(() => res.redirect('/'));
});

// 보호된 API 예시
app.get('/api/me', isLoggedIn, (req, res) => {
  res.json(req.user);
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
