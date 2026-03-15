const fs = require('fs');
const path = require('path');

// 역할: user(일반유저), study_member(스터디원), study_leader(스터디장), admin(관리자)

function render(filePath, replacements = {}) {
  let html = fs.readFileSync(path.join(__dirname, '..', filePath), 'utf8');
  for (const [key, value] of Object.entries(replacements)) {
    html = html.replaceAll(`{{${key}}}`, value ?? '');
  }
  return html;
}

function needsSetup(req) {
  return req.isAuthenticated() && !req.user.nickname;
}

function isLoggedIn(req, res, next) {
  if (!req.isAuthenticated()) return res.redirect('/');
  if (needsSetup(req) && req.path !== '/setup') return res.redirect('/setup');
  return next();
}

function isAuthor(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.redirect('/');
}

function isStudyLeader(req, res, next) {
  if (req.isAuthenticated() && (req.user.role === 'study_leader' || req.user.role === 'admin')) return next();
  res.status(403).send('스터디장만 접근할 수 있습니다.');
}

function isAdmin(req, res, next) {
  const allowedIds = (process.env.ADMIN_GOOGLE_ID || '').split(',').map(s => s.trim()).filter(Boolean);
  if (req.isAuthenticated() && req.user.role === 'admin' && allowedIds.includes(req.user.id)) return next();
  res.status(403).send('관리자만 접근할 수 있습니다.');
}

const ROLE_LABELS = {
  user: '일반유저',
  study_member: '스터디원',
  study_leader: '스터디장',
  admin: '관리자',
};

function buildNav(user) {
  if (!user) return '';

  return `
    <style>
      nav{position:sticky;top:0;z-index:100;display:flex;justify-content:space-between;align-items:center;padding:12px 40px;background:rgba(15,12,41,0.95);backdrop-filter:blur(20px);border-bottom:1px solid rgba(255,255,255,0.05)}
      .logo{font-size:1.4rem;font-weight:900;background:linear-gradient(135deg,#4f46e5,#06b6d4);-webkit-background-clip:text;-webkit-text-fill-color:transparent;text-decoration:none}
      .nav-links{display:flex;align-items:center;gap:6px}
      .nav-item{padding:8px 16px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:50px;color:rgba(255,255,255,0.75);text-decoration:none;font-size:0.82rem;font-weight:600;transition:all 0.2s;white-space:nowrap}
      .nav-item:hover{background:rgba(79,70,229,0.15);border-color:rgba(79,70,229,0.3);color:#fff;transform:translateY(-1px)}
      .nav-dropdown{position:relative}
      .nav-dropdown .nav-item{cursor:pointer;user-select:none}
      .nav-dropdown-menu{display:none;position:absolute;top:100%;left:0;margin-top:8px;min-width:180px;background:rgba(20,20,50,0.98);border:1px solid rgba(255,255,255,0.1);border-radius:14px;padding:6px;box-shadow:0 12px 40px rgba(0,0,0,0.5);z-index:200}
      .nav-dropdown:hover .nav-dropdown-menu{display:block}
      .nav-dropdown-menu a{display:block;padding:10px 16px;color:rgba(255,255,255,0.7);text-decoration:none;font-size:0.82rem;font-weight:600;border-radius:10px;transition:all 0.15s}
      .nav-dropdown-menu a:hover{background:rgba(79,70,229,0.15);color:#fff}
      .user-area{display:flex;align-items:center;gap:12px;flex-shrink:0}
      .user-area img{width:34px;height:34px;border-radius:50%;border:2px solid rgba(79,70,229,0.5)}
      .logout-btn{padding:7px 16px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.12);border-radius:50px;color:rgba(255,255,255,0.6);text-decoration:none;font-size:0.78rem}
      .btn-contact{padding:6px 14px;background:rgba(251,191,36,0.12);border:1px solid rgba(251,191,36,0.25);border-radius:50px;color:#fbbf24;font-size:0.72rem;font-weight:700;cursor:pointer;font-family:inherit;transition:all 0.2s;margin-left:10px;white-space:nowrap}
      .btn-contact:hover{background:rgba(251,191,36,0.22);transform:translateY(-1px)}
      .contact-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.8);z-index:1000;align-items:center;justify-content:center}
      .contact-overlay.show{display:flex}
      .contact-modal{background:linear-gradient(135deg,#1a1a3e,#2a2a5e);border:1px solid rgba(255,255,255,0.1);border-radius:24px;padding:32px;max-width:440px;width:92%;animation:contactIn 0.2s ease-out}
      @keyframes contactIn{from{opacity:0;transform:scale(0.95)}to{opacity:1;transform:scale(1)}}
      .contact-modal h3{font-size:1.1rem;font-weight:900;margin-bottom:6px}
      .contact-modal .cm-desc{font-size:0.82rem;color:rgba(255,255,255,0.4);line-height:1.6;margin-bottom:18px}
      .contact-modal .cm-beta{display:inline-block;padding:3px 10px;background:rgba(239,68,68,0.15);color:#f87171;border-radius:8px;font-size:0.7rem;font-weight:700;margin-bottom:12px}
      .contact-modal select,.contact-modal textarea{width:100%;padding:12px 16px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:12px;color:#fff;font-size:0.9rem;font-family:inherit;margin-bottom:14px}
      .contact-modal select option{background:#1a1a2e}
      .contact-modal textarea{min-height:100px;resize:vertical;line-height:1.6}
      .contact-modal textarea:focus,.contact-modal select:focus{outline:none;border-color:rgba(79,70,229,0.5)}
      .contact-modal .cm-actions{display:flex;gap:10px}
      .contact-modal .cm-actions button{flex:1;padding:13px;border-radius:14px;font-size:0.95rem;font-weight:700;cursor:pointer;font-family:inherit;border:none}
      .cm-btn-send{background:linear-gradient(135deg,#4f46e5,#6366f1);color:#fff}
      .cm-btn-cancel{background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15)!important;color:#fff}
      .cm-msg{padding:10px 14px;border-radius:10px;font-size:0.82rem;margin-bottom:12px;display:none}
      .cm-msg.ok{display:block;background:rgba(74,222,128,0.1);border:1px solid rgba(74,222,128,0.2);color:#4ade80}
      .cm-msg.err{display:block;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.2);color:#ef4444}
    </style>
    <a href="/" class="logo">StockStudyShare</a>
    <button class="btn-contact" onclick="document.getElementById('contact-modal').classList.add('show')">💬 관리자 문의</button>
    <div class="nav-links">
      <a href="/dashboard" class="nav-item">🏠 대시보드</a>
      <a href="/study" class="nav-item">📚 스터디방</a>
      <div class="nav-dropdown">
        <span class="nav-item">📄 리포트 ▾</span>
        <div class="nav-dropdown-menu">
          <a href="/reports">🔍 리포트 검색</a>
          <a href="/author/reports/new">✏️ 리포트 작성하기</a>
          <a href="/visit-notes">🗒️ 탐방노트</a>
          <a href="/dart">📢 주요공시</a>
        </div>
      </div>
      <div class="nav-dropdown">
        <span class="nav-item">💬 커뮤니티 ▾</span>
        <div class="nav-dropdown-menu">
          <a href="/community">💬 생각나누기</a>
          <a href="/contest">🏆 치킨배</a>
        </div>
      </div>
      <div class="nav-dropdown">
        <span class="nav-item">👤 내 활동 ▾</span>
        <div class="nav-dropdown-menu">
          <a href="/author/dashboard">📊 내 리포트</a>
          <a href="/my/purchases">📦 내 구매내역</a>
          <a href="/my/shop">🛒 상점</a>
        </div>
      </div>
    </div>
    <div class="user-area">
      <div class="notif-wrap" id="notif-wrap" style="position:relative">
        <button id="notif-bell" onclick="toggleNotifPanel()" style="background:none;border:none;cursor:pointer;font-size:1.2rem;position:relative;padding:4px 8px;color:#334155">
          🔔<span id="notif-badge" style="display:none;position:absolute;top:-2px;right:0;background:#ef4444;color:#fff;font-size:0.6rem;font-weight:700;min-width:16px;height:16px;line-height:16px;text-align:center;border-radius:50%;padding:0 4px">0</span>
        </button>
        <div id="notif-panel" style="display:none;position:absolute;right:0;top:100%;margin-top:8px;width:360px;max-height:440px;overflow-y:auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,0.12);z-index:999">
          <div style="display:flex;justify-content:space-between;align-items:center;padding:14px 16px;border-bottom:1px solid #f1f5f9">
            <span style="font-weight:700;font-size:0.9rem">알림</span>
            <button onclick="markAllRead()" style="background:none;border:none;color:#4f46e5;font-size:0.75rem;cursor:pointer;font-family:inherit">모두 읽음</button>
          </div>
          <div id="notif-list" style="padding:4px 0"></div>
          <div id="notif-empty" style="display:none;padding:30px;text-align:center;color:#94a3b8;font-size:0.85rem">알림이 없습니다</div>
        </div>
      </div>
      <a href="/my/profile" style="display:flex;align-items:center;gap:8px;text-decoration:none;color:#fff">
        <img src="${escapeHtml(user.custom_photo || user.photo || '')}" alt="profile">
        <span>${escapeHtml(user.nickname || user.name)}</span>
      </a>
      <a href="/my/points" style="font-size:0.7rem;color:#d97706;font-weight:700;text-decoration:none;background:rgba(251,191,36,0.1);padding:3px 10px;border-radius:10px;border:1px solid rgba(251,191,36,0.2)">${(user.points || 0).toLocaleString()}P</a>
      ${user.role === 'admin'
        ? `<a href="/admin" style="font-size:0.68rem;padding:3px 10px;border-radius:10px;font-weight:700;background:rgba(168,85,247,0.1);color:#7c3aed;text-decoration:none;transition:all 0.2s" onmouseover="this.style.background='rgba(168,85,247,0.25)'" onmouseout="this.style.background='rgba(168,85,247,0.1)'">${ROLE_LABELS[user.role]}</a>`
        : `<span style="font-size:0.68rem;padding:3px 10px;border-radius:10px;font-weight:700;${
          user.role === 'study_leader' ? 'background:rgba(34,197,94,0.1);color:#16a34a' :
          user.role === 'study_member' ? 'background:rgba(6,182,212,0.1);color:#0891b2' :
          'background:#f1f5f9;color:#64748b'
        }">${ROLE_LABELS[user.role] || user.role}</span>`
      }
      <a href="/logout" class="logout-btn">로그아웃</a>
    </div>
    <script>
    (function(){
      var panel=document.getElementById('notif-panel'),badge=document.getElementById('notif-badge'),list=document.getElementById('notif-list'),empty=document.getElementById('notif-empty');
      function esc(s){if(!s)return '';var d=document.createElement('div');d.textContent=s;return d.innerHTML;}
      window.toggleNotifPanel=function(){
        if(panel.style.display==='none'){panel.style.display='block';loadNotifs();}else{panel.style.display='none';}
      };
      document.addEventListener('click',function(e){if(!e.target.closest('#notif-wrap'))panel.style.display='none';});
      function loadNotifs(){
        fetch('/api/notifications').then(function(r){return r.json();}).then(function(data){
          if(!data.items||data.items.length===0){list.innerHTML='';empty.style.display='block';return;}
          empty.style.display='none';
          list.innerHTML=data.items.map(function(n){
            var bg=n.is_read?'transparent':'rgba(79,70,229,0.08)';
            var dot=n.is_read?'':'<span style="width:8px;height:8px;border-radius:50%;background:#4f46e5;flex-shrink:0"></span>';
            var timeAgo=getTimeAgo(n.created_at);
            var typeIcon={'report_approved':'✅','report_rejected':'❌','report_pending_admin':'📋','study_approved':'🎉','study_rejected':'😢','purchase':'💰','points':'🪙'}[n.type]||'📢';
            return '<a href="javascript:void(0)" onclick="clickNotif('+n.id+',\\''+encodeURIComponent(n.link||'')+'\\')\" style=\"display:flex;gap:10px;align-items:flex-start;padding:12px 16px;text-decoration:none;color:#1e293b;background:'+bg+';border-bottom:1px solid #f1f5f9;transition:background 0.15s\">'
              +'<span style=\"font-size:1.1rem;flex-shrink:0;margin-top:2px\">'+typeIcon+'</span>'
              +'<div style=\"flex:1;min-width:0\">'
              +'<div style=\"font-size:0.85rem;font-weight:'+(n.is_read?'400':'600')+';line-height:1.4\">'+esc(n.title)+'</div>'
              +(n.message?'<div style=\"font-size:0.78rem;color:#64748b;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap\">'+esc(n.message)+'</div>':'')
              +'<div style=\"font-size:0.7rem;color:#94a3b8;margin-top:4px\">'+timeAgo+'</div>'
              +'</div>'+dot+'</a>';
          }).join('');
        }).catch(function(){});
      }
      window.clickNotif=function(id,link){
        fetch('/api/notifications/'+id+'/read',{method:'POST'}).then(function(){
          checkUnread();
          if(link){window.location.href=decodeURIComponent(link);}else{loadNotifs();}
        });
      };
      window.markAllRead=function(){
        fetch('/api/notifications/read-all',{method:'POST'}).then(function(){badge.style.display='none';loadNotifs();});
      };
      function checkUnread(){
        fetch('/api/notifications/unread-count').then(function(r){return r.json();}).then(function(d){
          if(d.count>0){badge.textContent=d.count>99?'99+':d.count;badge.style.display='block';}
          else{badge.style.display='none';}
        }).catch(function(){});
      }
      function getTimeAgo(dateStr){
        var diff=Math.floor((Date.now()-new Date(dateStr+'Z').getTime())/1000);
        if(diff<60)return '방금 전';if(diff<3600)return Math.floor(diff/60)+'분 전';
        if(diff<86400)return Math.floor(diff/3600)+'시간 전';if(diff<604800)return Math.floor(diff/86400)+'일 전';
        return new Date(dateStr).toLocaleDateString('ko-KR');
      }
      checkUnread();
      setInterval(checkUnread,30000);
    })();
    </script>`;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 포인트 지급 + 추천인 5% 분배
function addPoints(db, userId, amount, type, description, relatedReportId) {
  if (amount <= 0) return;
  // 본인 포인트 지급
  db.prepare('UPDATE users SET points = points + ? WHERE id = ?').run(amount, userId);
  db.prepare('INSERT INTO point_logs (user_id, amount, type, description, related_user_id, related_report_id) VALUES (?, ?, ?, ?, NULL, ?)').run(userId, amount, type, description, relatedReportId || null);

  // 추천인 5% 분배
  const user = db.prepare('SELECT referrer_id FROM users WHERE id = ?').get(userId);
  let referrerId = user?.referrer_id;
  // 추천인 없으면 admin에게
  if (!referrerId) {
    const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
    referrerId = admin?.id;
  }
  if (referrerId && referrerId !== userId) {
    const bonus = Math.floor(amount * 0.05);
    if (bonus > 0) {
      db.prepare('UPDATE users SET points = points + ? WHERE id = ?').run(bonus, referrerId);
      db.prepare('INSERT INTO point_logs (user_id, amount, type, description, related_user_id, related_report_id) VALUES (?, ?, ?, ?, ?, ?)').run(referrerId, bonus, 'referral_bonus', `추천인 보너스 (${type})`, userId, relatedReportId || null);
    }
  }
}

// 알림 생성 헬퍼
function notify(db, userId, type, title, message, link) {
  if (!userId) return;
  db.prepare('INSERT INTO notifications (user_id, type, title, message, link) VALUES (?, ?, ?, ?, ?)').run(userId, type, title, message || '', link || '');
}

function adBannerHtml(style) {
  const s = style || 'horizontal'; // horizontal or vertical
  if (s === 'vertical') {
    return `<div class="sss-ad-slot" data-style="vertical">
      <a href="/ad-inquiry" class="sss-ad-vert" id="sss-ad" target="_blank">
        <div class="sss-ad-default"><div style="font-size:1.5rem;margin-bottom:6px">📢</div><div style="font-size:0.82rem;font-weight:700;color:rgba(255,255,255,0.5)">광고 문의</div><div style="font-size:0.7rem;color:rgba(255,255,255,0.2);margin-top:2px">여기에 광고를 게재하세요</div></div>
        <div class="sss-ad-loaded" style="display:none"></div>
        <span style="font-size:0.6rem;color:rgba(255,255,255,0.12);margin-top:6px">AD</span>
      </a>
    </div>
    <style>.sss-ad-vert{display:flex;flex-direction:column;align-items:center;gap:8px;padding:18px 14px;background:linear-gradient(180deg,rgba(79,70,229,0.05),rgba(6,182,212,0.03));border:1px solid rgba(79,70,229,0.12);border-radius:14px;text-decoration:none;color:#fff;text-align:center;transition:all 0.2s}.sss-ad-vert:hover{border-color:rgba(79,70,229,0.3);transform:translateY(-1px)}.sss-ad-vert img{width:100%;border-radius:8px}</style>
    <script>(function(){fetch('/api/ads?position=dashboard').then(function(r){return r.json()}).then(function(ads){if(ads.length>0){var a=ads[0],el=document.getElementById('sss-ad'),d=el.querySelector('.sss-ad-default'),c=el.querySelector('.sss-ad-loaded');if(a.image_url){c.innerHTML='<img src="'+a.image_url+'" style="width:100%;border-radius:8px" alt="">';if(a.link_url)el.href=a.link_url;d.style.display='none';c.style.display='block';}}}).catch(function(){});})()</script>`;
  }
  return `<div class="sss-ad-slot" data-style="horizontal">
    <a href="/ad-inquiry" class="sss-ad-horiz" id="sss-ad" target="_blank">
      <div class="sss-ad-default" style="display:flex;align-items:center;gap:14px">
        <span style="font-size:1.3rem">📢</span>
        <div><div style="font-size:0.82rem;font-weight:700;color:rgba(255,255,255,0.5)">이 자리에 광고를 게재하세요</div><div style="font-size:0.7rem;color:rgba(255,255,255,0.2)">클릭하여 광고 문의하기</div></div>
        <span style="margin-left:auto;font-size:0.6rem;color:rgba(255,255,255,0.12)">AD</span>
      </div>
      <div class="sss-ad-loaded" style="display:none"></div>
    </a>
  </div>
  <style>.sss-ad-horiz{display:block;padding:14px 20px;background:linear-gradient(135deg,rgba(79,70,229,0.04),rgba(6,182,212,0.02));border:1px solid rgba(79,70,229,0.1);border-radius:14px;text-decoration:none;color:#fff;transition:all 0.2s;margin:20px 0}.sss-ad-horiz:hover{border-color:rgba(79,70,229,0.25)}.sss-ad-horiz img{width:100%;border-radius:8px}</style>
  <script>(function(){fetch('/api/ads?position=dashboard').then(function(r){return r.json()}).then(function(ads){if(ads.length>0){var a=ads[0],el=document.getElementById('sss-ad'),d=el.querySelector('.sss-ad-default'),c=el.querySelector('.sss-ad-loaded');if(a.image_url){c.innerHTML='<img src="'+a.image_url+'" style="width:100%;border-radius:8px" alt="">';if(a.link_url)el.href=a.link_url;d.style.display='none';c.style.display='block';}}}).catch(function(){});})()</script>`;
}

module.exports = { render, isLoggedIn, isAuthor, isStudyLeader, isAdmin, needsSetup, buildNav, escapeHtml, addPoints, notify, adBannerHtml, ROLE_LABELS };
