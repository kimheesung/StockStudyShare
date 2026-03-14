const express = require('express');
const db = require('../lib/db');
const { render, isLoggedIn, buildNav, escapeHtml, notify } = require('../lib/helpers');
const router = express.Router();

const HOST_FEE = 100000;
const CHICKEN_PRICE = 20000;
const CHICKEN_COUNT = 5;
const MIN_PARTICIPANTS = 5;
const MAX_PARTICIPANTS = 10;
const PRIZE_DISTRIBUTION = [
  { rank: 1, chickens: 1, label: '치킨 1개' },
  { rank: 2, chickens: 1, label: '치킨 1개' },
  { rank: 3, chickens: 1, label: '치킨 1개' },
  { rank: 4, chickens: 1, label: '치킨 1개' },
  { rank: 5, chickens: 1, label: '치킨 1개' },
];

// 리포트 치킨배 목록
router.get('/', isLoggedIn, (req, res) => {
  const contests = db.prepare(`
    SELECT c.*,
           u.nickname as creator_name, u.photo as creator_photo,
           (SELECT COUNT(*) FROM competition_entries WHERE competition_id = c.id AND entry_status = 'selected') as participant_count,
           (SELECT COUNT(*) FROM competition_entries WHERE competition_id = c.id AND entry_status = 'pending') as applicant_count
    FROM competitions c
    JOIN users u ON c.creator_id = u.id
    ORDER BY
      CASE c.status WHEN 'recruiting' THEN 0 WHEN 'active' THEN 1 ELSE 2 END,
      c.created_at DESC
  `).all();

  const myEntries = new Set();
  db.prepare('SELECT competition_id FROM competition_entries WHERE user_id = ?').all(req.user.id)
    .forEach(e => myEntries.add(e.competition_id));

  const contestCards = contests.length > 0 ? contests.map(c => {
    const isMine = myEntries.has(c.id);
    const isFull = c.participant_count >= c.max_participants;
    const totalApplicants = c.participant_count + c.applicant_count;

    let statusBadge, statusStyle;
    if (c.status === 'recruiting') {
      statusBadge = '모집중'; statusStyle = 'background:rgba(74,222,128,0.15);color:#4ade80;border:1px solid rgba(74,222,128,0.3)';
    } else if (c.status === 'active') {
      statusBadge = '진행중'; statusStyle = 'background:rgba(59,130,246,0.15);color:#60a5fa;border:1px solid rgba(59,130,246,0.3)';
    } else if (c.status === 'ended') {
      statusBadge = '종료'; statusStyle = 'background:rgba(255,255,255,0.06);color:rgba(255,255,255,0.4);border:1px solid rgba(255,255,255,0.1)';
    } else {
      statusBadge = '취소됨'; statusStyle = 'background:rgba(239,68,68,0.1);color:#f87171;border:1px solid rgba(239,68,68,0.2)';
    }

    let actionBtn = '';
    if (c.status === 'recruiting') {
      if (isMine) {
        actionBtn = '<span style="padding:8px 16px;border-radius:10px;font-size:0.82rem;font-weight:700;background:rgba(79,70,229,0.15);color:#a5b4fc">지원 완료</span>';
      } else {
        actionBtn = `<a href="/contest/${c.id}" style="padding:8px 20px;border-radius:10px;font-size:0.82rem;font-weight:700;background:linear-gradient(135deg,#ef4444,#f97316);color:#fff;text-decoration:none;border:none">지원하기</a>`;
      }
    } else {
      actionBtn = `<a href="/contest/${c.id}" style="padding:8px 20px;border-radius:10px;font-size:0.82rem;font-weight:700;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);color:rgba(255,255,255,0.6);text-decoration:none">상세보기</a>`;
    }

    const endInfo = c.end_date ? new Date(c.end_date).toLocaleDateString('ko-KR') + ' 마감' : `${c.duration_days}일간 진행`;

    return `<div class="contest-card">
      <div class="contest-header">
        <div class="contest-title-row">
          <h3>${escapeHtml(c.name)}</h3>
          <span class="contest-status" style="${statusStyle}">${statusBadge}</span>
        </div>
        <div class="contest-creator">
          <img src="${c.creator_photo || ''}" alt="">
          <span>${escapeHtml(c.creator_name)} 주최</span>
        </div>
      </div>
      <div class="contest-info">
        <div class="contest-stat">
          <span class="stat-label">참가비</span>
          <span class="stat-value" style="color:#4ade80;font-weight:900">무료</span>
        </div>
        <div class="contest-stat">
          <span class="stat-label">선정/지원</span>
          <span class="stat-value">${c.participant_count}/${totalApplicants}명</span>
        </div>
        <div class="contest-stat">
          <span class="stat-label">상금</span>
          <span class="stat-value" style="color:#f87171;font-weight:900">치킨 ${CHICKEN_COUNT}개</span>
        </div>
        <div class="contest-stat">
          <span class="stat-label">기간</span>
          <span class="stat-value">${endInfo}</span>
        </div>
      </div>
      <div class="contest-prize-bar">
        <span>&#127831; 1~5등 치킨 기프트콘 각 1개씩</span>
      </div>
      <div class="contest-action">${actionBtn}</div>
    </div>`;
  }).join('') : '<div class="empty-state"><p>아직 개설된 대회가 없습니다.</p><small>새 대회를 만들어 보세요!</small></div>';

  const html = render('views/contest-list.html', {
    nav: buildNav(req.user),
    contestCards,
    userPoints: String(req.user.points || 0),
  });
  res.send(html);
});

// 대회 생성 (주최비 10만P → admin 귀속)
router.post('/create', isLoggedIn, (req, res) => {
  const durationDays = parseInt(req.body.duration_days) || 30;
  const nickname = req.user.nickname || req.user.name;
  const name = `${nickname} 리포트 치킨배`;

  if (![7, 14, 30, 60, 90].includes(durationDays)) return res.status(400).send('유효하지 않은 기간입니다.');

  const user = db.prepare('SELECT points FROM users WHERE id = ?').get(req.user.id);
  if (!user || user.points < HOST_FEE) {
    return res.status(400).send(`주최비 ${HOST_FEE.toLocaleString()}P가 필요합니다. (보유: ${(user?.points || 0).toLocaleString()}P)`);
  }

  const createTx = db.transaction(() => {
    db.prepare('UPDATE users SET points = points - ? WHERE id = ?').run(HOST_FEE, req.user.id);
    db.prepare("INSERT INTO point_logs (user_id, amount, type, description) VALUES (?, ?, 'contest_host', ?)").run(
      req.user.id, -HOST_FEE, `리포트 치킨배 주최: ${name}`
    );
    const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
    if (admin) {
      db.prepare('UPDATE users SET points = points + ? WHERE id = ?').run(HOST_FEE, admin.id);
      db.prepare("INSERT INTO point_logs (user_id, amount, type, description) VALUES (?, ?, 'contest_host_fee', ?)").run(
        admin.id, HOST_FEE, `리포트 치킨배 주최비 수입: ${name}`
      );
    }
    return db.prepare(`INSERT INTO competitions (creator_id, name, entry_fee, max_participants, min_participants, duration_days)
      VALUES (?, ?, 0, ?, ?, ?)`).run(req.user.id, name, MAX_PARTICIPANTS, MIN_PARTICIPANTS, durationDays);
  });

  const result = createTx();
  res.redirect(`/contest/${result.lastInsertRowid}`);
});

// 대회 상세
router.get('/:id', isLoggedIn, (req, res) => {
  const contest = db.prepare(`
    SELECT c.*, u.nickname as creator_name, u.photo as creator_photo
    FROM competitions c JOIN users u ON c.creator_id = u.id
    WHERE c.id = ?
  `).get(req.params.id);
  if (!contest) return res.status(404).send('대회를 찾을 수 없습니다.');

  // 선정된 참가자
  const selectedEntries = db.prepare(`
    SELECT ce.*, u.nickname, u.photo, r.title as report_title, r.stock_name, r.stock_code
    FROM competition_entries ce
    JOIN users u ON ce.user_id = u.id JOIN reports r ON ce.report_id = r.id
    WHERE ce.competition_id = ? AND ce.entry_status = 'selected'
    ORDER BY CASE WHEN ce.return_rate IS NOT NULL THEN 0 ELSE 1 END, ce.return_rate DESC
  `).all(contest.id);

  // 대기중 지원자
  const pendingEntries = db.prepare(`
    SELECT ce.*, u.nickname, u.photo, r.title as report_title, r.stock_name, r.stock_code
    FROM competition_entries ce
    JOIN users u ON ce.user_id = u.id JOIN reports r ON ce.report_id = r.id
    WHERE ce.competition_id = ? AND ce.entry_status = 'pending'
    ORDER BY ce.created_at ASC
  `).all(contest.id);

  const allEntries = [...selectedEntries, ...pendingEntries];
  const myEntry = allEntries.find(e => e.user_id === req.user.id);
  const isCreator = contest.creator_id === req.user.id;

  // 이미 선정된 종목 (중복 방지 - 선정+대기 모두)
  const takenStocks = new Set(allEntries.map(e => e.stock_code).filter(Boolean));

  // 참가 가능 리포트
  let myReportOptions = '';
  if (!myEntry && contest.status === 'recruiting') {
    const myReports = db.prepare(`
      SELECT id, title, stock_name, stock_code, market_type FROM reports
      WHERE author_id = ? AND status IN ('on_sale', 'study_published')
        AND stock_code IS NOT NULL AND stock_code != ''
      ORDER BY created_at DESC
    `).all(req.user.id);
    myReportOptions = myReports.map(r => {
      const isTaken = takenStocks.has(r.stock_code);
      return `<option value="${r.id}" data-code="${escapeHtml(r.stock_code)}" ${isTaken ? 'disabled' : ''}>${escapeHtml(r.stock_name)} (${escapeHtml(r.stock_code)}) - ${escapeHtml(r.title)}${isTaken ? ' ❌ 이미 등록된 종목' : ''}</option>`;
    }).join('');
  }

  // 선정된 참가자 테이블
  const rankIcons = ['', '&#129351;', '&#129352;', '&#129353;', '4&#65039;&#8419;', '5&#65039;&#8419;'];
  const entryRows = selectedEntries.length > 0 ? selectedEntries.map((e, i) => {
    const rank = e.rank || (contest.status === 'ended' ? i + 1 : '-');
    const rankIcon = (contest.status === 'ended' && rank <= 5) ? (rankIcons[rank] || rank) + ' ' : '';
    const returnStr = e.return_rate !== null
      ? `<span style="color:${e.return_rate >= 0 ? '#ef4444' : '#3b82f6'};font-weight:700">${e.return_rate >= 0 ? '+' : ''}${e.return_rate.toFixed(2)}%</span>`
      : '<span style="color:rgba(255,255,255,0.3)">대기중</span>';
    const prizeStr = e.prize_amount > 0 ? `<span style="color:#fbbf24;font-weight:700">&#127831;</span>` : '';
    const isSelf = e.user_id === req.user.id;
    return `<tr style="${isSelf ? 'background:rgba(79,70,229,0.08)' : ''}">
      <td style="font-weight:700;font-size:1.1rem">${rankIcon}${rank}</td>
      <td><div style="display:flex;align-items:center;gap:8px"><img src="${e.photo || ''}" style="width:28px;height:28px;border-radius:50%"><span${isSelf ? ' style="color:#a5b4fc;font-weight:700"' : ''}>${escapeHtml(e.nickname)}</span></div></td>
      <td>${escapeHtml(e.stock_name)} <span style="color:rgba(255,255,255,0.3);font-size:0.8rem">${escapeHtml(e.stock_code || '')}</span></td>
      <td>${e.entry_price ? Math.round(e.entry_price).toLocaleString() + '원' : '-'}</td>
      <td>${e.final_price ? Math.round(e.final_price).toLocaleString() + '원' : '-'}</td>
      <td>${returnStr}</td>
      <td>${prizeStr}</td>
    </tr>`;
  }).join('') : '<tr><td colspan="7" style="text-align:center;color:rgba(255,255,255,0.3);padding:30px">아직 선정된 참가자가 없습니다.</td></tr>';

  // 대기중 지원자 목록 (주최자에게만 선정/거절 버튼 표시)
  const pendingRows = pendingEntries.map(e => {
    const isSelf = e.user_id === req.user.id;
    const selectBtn = isCreator && contest.status === 'recruiting'
      ? `<form method="POST" action="/contest/${contest.id}/select/${e.id}" style="display:inline"><button style="padding:4px 12px;background:rgba(74,222,128,0.15);border:1px solid rgba(74,222,128,0.3);border-radius:8px;color:#4ade80;font-size:0.78rem;font-weight:700;cursor:pointer;font-family:inherit">선정</button></form>
         <form method="POST" action="/contest/${contest.id}/reject/${e.id}" style="display:inline;margin-left:4px"><button style="padding:4px 12px;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.2);border-radius:8px;color:#ef4444;font-size:0.78rem;cursor:pointer;font-family:inherit">거절</button></form>`
      : '<span style="color:#fbbf24;font-size:0.82rem">심사중</span>';
    return `<tr style="${isSelf ? 'background:rgba(251,191,36,0.05)' : ''}">
      <td><div style="display:flex;align-items:center;gap:8px"><img src="${e.photo || ''}" style="width:28px;height:28px;border-radius:50%"><span${isSelf ? ' style="color:#fbbf24;font-weight:700"' : ''}>${escapeHtml(e.nickname)}</span></div></td>
      <td>${escapeHtml(e.stock_name)} <span style="color:rgba(255,255,255,0.3);font-size:0.8rem">(${escapeHtml(e.stock_code || '')})</span></td>
      <td style="font-size:0.82rem;color:rgba(255,255,255,0.4)">${escapeHtml(e.report_title)}</td>
      <td>${selectBtn}</td>
    </tr>`;
  }).join('');

  const canStart = isCreator && contest.status === 'recruiting' && selectedEntries.length >= MIN_PARTICIPANTS;
  const canJoin = !myEntry && contest.status === 'recruiting';

  const html = render('views/contest-detail.html', {
    nav: buildNav(req.user),
    contestId: String(contest.id),
    name: escapeHtml(contest.name),
    creatorName: escapeHtml(contest.creator_name),
    creatorPhoto: contest.creator_photo || '',
    isCreator: isCreator ? 'true' : '',
    status: contest.status,
    entryFee: '무료',
    participantCount: String(selectedEntries.length),
    applicantCount: String(pendingEntries.length),
    maxParticipants: String(MAX_PARTICIPANTS),
    minParticipants: String(MIN_PARTICIPANTS),
    totalPrize: `치킨 ${CHICKEN_COUNT}개 (${(CHICKEN_COUNT * CHICKEN_PRICE).toLocaleString()}P)`,
    durationDays: String(contest.duration_days),
    startDate: contest.start_date ? new Date(contest.start_date).toLocaleDateString('ko-KR') : '',
    endDate: contest.end_date ? new Date(contest.end_date).toLocaleDateString('ko-KR') : '',
    entryRows,
    pendingRows: pendingRows || '',
    hasPending: pendingEntries.length > 0 ? 'true' : '',
    canStart: canStart ? 'true' : '',
    canJoin: canJoin ? 'true' : '',
    myReportOptions,
    hasEntry: myEntry ? 'true' : '',
    myEntryStatus: myEntry ? myEntry.entry_status : '',
    userPoints: String(req.user.points || 0),
  });
  res.send(html);
});

// 대회 지원 (pending 상태로 등록)
router.post('/:id/join', isLoggedIn, (req, res) => {
  const contest = db.prepare("SELECT * FROM competitions WHERE id = ? AND status = 'recruiting'").get(req.params.id);
  if (!contest) return res.status(400).send('모집중인 대회가 아닙니다.');

  const existing = db.prepare('SELECT id FROM competition_entries WHERE competition_id = ? AND user_id = ?').get(contest.id, req.user.id);
  if (existing) return res.redirect(`/contest/${contest.id}`);

  const reportId = parseInt(req.body.report_id);
  const report = db.prepare(`
    SELECT * FROM reports
    WHERE id = ? AND author_id = ? AND status IN ('on_sale', 'study_published')
      AND stock_code IS NOT NULL AND stock_code != ''
  `).get(reportId, req.user.id);
  if (!report) return res.status(400).send('유효한 리포트를 선택해주세요. (본인이 발행한 리포트만 가능)');

  // 종목 중복 체크
  const duplicateStock = db.prepare('SELECT id FROM competition_entries WHERE competition_id = ? AND stock_code = ?').get(contest.id, report.stock_code);
  if (duplicateStock) return res.status(400).send(`이미 등록된 종목입니다: ${report.stock_name} (${report.stock_code})`);

  db.prepare(`INSERT INTO competition_entries (competition_id, user_id, report_id, stock_code, stock_name, market_type, entry_status)
    VALUES (?, ?, ?, ?, ?, ?, 'pending')`).run(
    contest.id, req.user.id, reportId, report.stock_code, report.stock_name, report.market_type
  );

  notify(db, contest.creator_id, 'purchase', '치킨배 지원', `${req.user.nickname || req.user.name}님이 "${contest.name}"에 지원했습니다. (${report.stock_name}) 선정해주세요!`, `/contest/${contest.id}`);

  res.redirect(`/contest/${contest.id}`);
});

// 주최자: 지원자 선정
router.post('/:id/select/:entryId', isLoggedIn, (req, res) => {
  const contest = db.prepare("SELECT * FROM competitions WHERE id = ? AND creator_id = ? AND status = 'recruiting'").get(req.params.id, req.user.id);
  if (!contest) return res.status(403).send('권한이 없습니다.');

  const selectedCount = db.prepare("SELECT COUNT(*) as c FROM competition_entries WHERE competition_id = ? AND entry_status = 'selected'").get(contest.id).c;
  if (selectedCount >= MAX_PARTICIPANTS) return res.status(400).send('최대 참가 인원에 도달했습니다.');

  const entry = db.prepare("SELECT * FROM competition_entries WHERE id = ? AND competition_id = ? AND entry_status = 'pending'").get(req.params.entryId, contest.id);
  if (!entry) return res.status(404).send('지원자를 찾을 수 없습니다.');

  db.prepare("UPDATE competition_entries SET entry_status = 'selected' WHERE id = ?").run(entry.id);
  notify(db, entry.user_id, 'study_approved', '치킨배 선정!', `"${contest.name}" 대회에 선정되었습니다!`, `/contest/${contest.id}`);

  res.redirect(`/contest/${contest.id}`);
});

// 주최자: 지원자 거절
router.post('/:id/reject/:entryId', isLoggedIn, (req, res) => {
  const contest = db.prepare("SELECT * FROM competitions WHERE id = ? AND creator_id = ? AND status = 'recruiting'").get(req.params.id, req.user.id);
  if (!contest) return res.status(403).send('권한이 없습니다.');

  const entry = db.prepare("SELECT * FROM competition_entries WHERE id = ? AND competition_id = ? AND entry_status = 'pending'").get(req.params.entryId, contest.id);
  if (!entry) return res.status(404).send('지원자를 찾을 수 없습니다.');

  db.prepare("UPDATE competition_entries SET entry_status = 'rejected' WHERE id = ?").run(entry.id);
  notify(db, entry.user_id, 'study_rejected', '치킨배 미선정', `"${contest.name}" 대회에 선정되지 않았습니다.`, `/contest`);

  res.redirect(`/contest/${contest.id}`);
});

// 대회 시작 (주최자: 선정 안 한 지원자는 자동 선정, 초과 시 선착순)
router.post('/:id/start', isLoggedIn, async (req, res) => {
  const contest = db.prepare("SELECT * FROM competitions WHERE id = ? AND creator_id = ? AND status = 'recruiting'").get(req.params.id, req.user.id);
  if (!contest) return res.status(400).send('대회를 시작할 수 없습니다.');

  // 선정된 참가자 수
  let selectedCount = db.prepare("SELECT COUNT(*) as c FROM competition_entries WHERE competition_id = ? AND entry_status = 'selected'").get(contest.id).c;

  // 부족하면 pending 지원자를 선착순으로 자동 선정
  if (selectedCount < MAX_PARTICIPANTS) {
    const pendingEntries = db.prepare("SELECT id FROM competition_entries WHERE competition_id = ? AND entry_status = 'pending' ORDER BY created_at ASC").all(contest.id);
    for (const pe of pendingEntries) {
      if (selectedCount >= MAX_PARTICIPANTS) break;
      db.prepare("UPDATE competition_entries SET entry_status = 'selected' WHERE id = ?").run(pe.id);
      selectedCount++;
    }
  }

  // 남은 pending은 거절 처리
  db.prepare("UPDATE competition_entries SET entry_status = 'rejected' WHERE competition_id = ? AND entry_status = 'pending'").run(contest.id);

  const entries = db.prepare("SELECT * FROM competition_entries WHERE competition_id = ? AND entry_status = 'selected'").all(contest.id);
  if (entries.length < MIN_PARTICIPANTS) return res.status(400).send(`최소 ${MIN_PARTICIPANTS}명이 선정되어야 시작할 수 있습니다. (현재 ${entries.length}명)`);

  const startDate = new Date().toISOString();
  const endDate = new Date(Date.now() + contest.duration_days * 86400000).toISOString();

  for (const entry of entries) {
    try {
      const code = (entry.stock_code || '').replace(/[^0-9A-Za-z]/g, '');
      const symbol = /^\d{6}$/.test(code) ? (entry.market_type === 'KOSDAQ' ? `${code}.KQ` : `${code}.KS`) : code;
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
      const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const json = await resp.json();
      const price = json.chart?.result?.[0]?.meta?.regularMarketPrice || 0;
      if (price > 0) db.prepare('UPDATE competition_entries SET entry_price = ? WHERE id = ?').run(price, entry.id);
    } catch {}
  }

  db.prepare("UPDATE competitions SET status = 'active', start_date = ?, end_date = ? WHERE id = ?").run(startDate, endDate, contest.id);

  for (const entry of entries) {
    notify(db, entry.user_id, 'purchase', '리포트 치킨배 시작!', `"${contest.name}" 대회가 시작되었습니다! ${contest.duration_days}일간 수익률을 겨루세요.`, `/contest/${contest.id}`);
  }

  res.redirect(`/contest/${contest.id}`);
});

// 대회 결과 정산
router.post('/:id/settle', isLoggedIn, async (req, res) => {
  const contest = db.prepare("SELECT * FROM competitions WHERE id = ? AND status = 'active'").get(req.params.id);
  if (!contest) return res.status(400).send('정산할 수 없는 대회입니다.');
  if (contest.creator_id !== req.user.id && req.user.role !== 'admin') return res.status(403).send('권한이 없습니다.');
  if (new Date(contest.end_date) > new Date()) return res.status(400).send('아직 대회 기간이 종료되지 않았습니다.');

  const entries = db.prepare("SELECT * FROM competition_entries WHERE competition_id = ? AND entry_status = 'selected'").all(contest.id);

  for (const entry of entries) {
    try {
      const code = (entry.stock_code || '').replace(/[^0-9A-Za-z]/g, '');
      const symbol = /^\d{6}$/.test(code) ? (entry.market_type === 'KOSDAQ' ? `${code}.KQ` : `${code}.KS`) : code;
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
      const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const json = await resp.json();
      const price = json.chart?.result?.[0]?.meta?.regularMarketPrice || 0;
      if (price > 0 && entry.entry_price > 0) {
        const returnRate = ((price - entry.entry_price) / entry.entry_price) * 100;
        db.prepare('UPDATE competition_entries SET final_price = ?, return_rate = ? WHERE id = ?').run(price, returnRate, entry.id);
        entry.return_rate = returnRate;
      }
    } catch {}
  }

  entries.sort((a, b) => (b.return_rate || -9999) - (a.return_rate || -9999));

  const settleTx = db.transaction(() => {
    entries.forEach((entry, i) => {
      const rank = i + 1;
      const prizeInfo = PRIZE_DISTRIBUTION.find(p => p.rank === rank);
      const prizeValue = prizeInfo ? Math.floor(prizeInfo.chickens * CHICKEN_PRICE) : 0;
      db.prepare('UPDATE competition_entries SET rank = ?, prize_amount = ? WHERE id = ?').run(rank, prizeValue, entry.id);

      if (prizeInfo && rank <= 5) {
        notify(db, entry.user_id, 'points', `🍗 치킨배 ${rank}등!`, `"${contest.name}" ${rank}등! 치킨 기프트콘이 지급됩니다. (수익률: ${(entry.return_rate || 0).toFixed(2)}%)`, `/contest/${contest.id}`);
      } else {
        notify(db, entry.user_id, 'purchase', '리포트 치킨배 종료', `"${contest.name}" 종료. ${rank}등 (수익률: ${(entry.return_rate || 0).toFixed(2)}%)`, `/contest/${contest.id}`);
      }
    });

    const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
    if (admin) {
      const winners = entries.slice(0, 5).map((e, i) => {
        const u = db.prepare('SELECT nickname, name FROM users WHERE id = ?').get(e.user_id);
        return `${i + 1}등: ${u?.nickname || u?.name}`;
      }).join(', ');
      notify(db, admin.id, 'report_pending_admin', '치킨배 기프트콘 발송 필요', `"${contest.name}" 종료. 수상자: ${winners}`, `/contest/${contest.id}`);
    }

    db.prepare("UPDATE competitions SET status = 'ended' WHERE id = ?").run(contest.id);
  });
  settleTx();

  res.redirect(`/contest/${contest.id}`);
});

module.exports = router;
