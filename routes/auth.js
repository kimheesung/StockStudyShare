const express = require('express');
const passport = require('passport');
const router = express.Router();

router.get('/google', (req, res, next) => {
  const ua = (req.headers['user-agent'] || '').toLowerCase();
  // 카카오톡, 라인, 인스타그램, 페이스북 등 인앱 브라우저 감지
  const isInApp = /kakaotalk|kakao|naver|line|instagram|fbav|fban|twitter|snapchat|wv\)/.test(ua);

  if (isInApp) {
    const currentUrl = `${req.protocol}://${req.get('host')}/auth/google`;
    return res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
      <title>외부 브라우저로 열기</title>
      <style>
        *{margin:0;padding:0;box-sizing:border-box}
        body{font-family:-apple-system,sans-serif;background:#0f0c29;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
        .card{text-align:center;max-width:360px;width:100%;padding:40px 28px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:24px}
        .icon{font-size:3rem;margin-bottom:16px}
        h2{font-size:1.2rem;margin-bottom:8px}
        p{font-size:0.88rem;color:rgba(255,255,255,0.5);line-height:1.6;margin-bottom:24px}
        .btn{display:block;padding:14px;background:linear-gradient(135deg,#4f46e5,#6366f1);border-radius:14px;color:#fff;text-decoration:none;font-size:1rem;font-weight:700;margin-bottom:12px}
        .btn-copy{display:block;padding:12px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);border-radius:14px;color:#fff;font-size:0.88rem;cursor:pointer;font-family:inherit;width:100%}
        .url-box{padding:10px 14px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:10px;font-size:0.75rem;color:rgba(255,255,255,0.4);word-break:break-all;margin-bottom:16px}
        .hint{font-size:0.75rem;color:rgba(255,255,255,0.25);margin-top:12px}
      </style>
      <script>
        // 안드로이드 intent로 외부 브라우저 열기 시도
        function openExternal() {
          var url = '${currentUrl}';
          if (/android/i.test(navigator.userAgent)) {
            location.href = 'intent://' + url.replace(/^https?:\\/\\//, '') + '#Intent;scheme=https;package=com.android.chrome;end';
          } else {
            // iOS: Safari로 열기
            location.href = url;
          }
        }
        function copyUrl() {
          navigator.clipboard.writeText('${req.protocol}://${req.get('host')}').then(function() {
            document.getElementById('copy-btn').textContent = '복사 완료!';
            setTimeout(function() { document.getElementById('copy-btn').textContent = '주소 복사하기'; }, 2000);
          });
        }
      </script>
    </head><body>
      <div class="card">
        <div class="icon">🔒</div>
        <h2>외부 브라우저에서 열어주세요</h2>
        <p>Google 로그인은 카카오톡 등 인앱 브라우저에서 지원되지 않습니다.<br>Chrome 또는 Safari에서 접속해주세요.</p>
        <a href="#" class="btn" onclick="openExternal();return false">외부 브라우저로 열기</a>
        <div class="url-box">${req.protocol}://${req.get('host')}</div>
        <button class="btn-copy" id="copy-btn" onclick="copyUrl()">주소 복사하기</button>
        <div class="hint">위 주소를 복사하여 Chrome/Safari에 붙여넣기 해주세요</div>
      </div>
    </body></html>`);
  }

  passport.authenticate('google', { scope: ['profile', 'email'] })(req, res, next);
});

router.get('/google/callback', (req, res, next) => {
  passport.authenticate('google', (err, user, info) => {
    if (err) {
      console.error('[auth] Google OAuth error:', err);
      return res.redirect('/');
    }
    if (!user) {
      console.error('[auth] No user returned, info:', info);
      return res.redirect('/');
    }
    req.logIn(user, (loginErr) => {
      if (loginErr) {
        console.error('[auth] Login error:', loginErr);
        return res.redirect('/');
      }
      console.log('[auth] Login success:', user.id, user.email, 'nickname:', user.nickname);
      if (!user.nickname) return res.redirect('/setup');
      res.redirect('/dashboard');
    });
  })(req, res, next);
});

module.exports = router;
