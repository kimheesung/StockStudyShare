const express = require('express');
const passport = require('passport');
const router = express.Router();

router.get('/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

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
