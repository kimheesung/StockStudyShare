const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'data', 'database.sqlite');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT,
    photo TEXT,
    nickname TEXT UNIQUE,
    referrer_id TEXT,
    points INTEGER NOT NULL DEFAULT 0,
    role TEXT NOT NULL DEFAULT 'user',
    joined_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS point_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id),
    amount INTEGER NOT NULL,
    type TEXT NOT NULL,
    description TEXT,
    related_user_id TEXT,
    related_report_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS author_applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id),
    intro TEXT NOT NULL,
    career TEXT NOT NULL,
    external_links TEXT,
    sample_report TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    admin_memo TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    reviewed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS author_profiles (
    user_id TEXT PRIMARY KEY REFERENCES users(id),
    display_name TEXT NOT NULL,
    bio TEXT,
    sectors TEXT
  );

  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    author_id TEXT NOT NULL REFERENCES users(id),
    title TEXT NOT NULL,
    stock_name TEXT NOT NULL,
    stock_code TEXT,
    market_type TEXT,
    sector TEXT,
    summary TEXT NOT NULL,
    thesis TEXT,
    investment_points TEXT,
    valuation_basis TEXT,
    risks TEXT,
    bear_case TEXT,
    references_text TEXT,
    holding_disclosure TEXT,
    conflict_disclosure TEXT,
    base_price INTEGER,
    sale_price INTEGER NOT NULL DEFAULT 0,
    visibility TEXT NOT NULL DEFAULT 'study_only',
    max_buyers INTEGER NOT NULL DEFAULT 0,
    study_room_id INTEGER,
    status TEXT NOT NULL DEFAULT 'draft',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    published_at TEXT
  );

  CREATE TABLE IF NOT EXISTS report_review_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id INTEGER NOT NULL REFERENCES reports(id),
    reviewer_id TEXT NOT NULL REFERENCES users(id),
    action TEXT NOT NULL,
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id),
    report_id INTEGER NOT NULL REFERENCES reports(id),
    amount INTEGER NOT NULL DEFAULT 0,
    payment_status TEXT NOT NULL DEFAULT 'completed',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, report_id)
  );

  CREATE TABLE IF NOT EXISTS view_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id),
    report_id INTEGER NOT NULL REFERENCES reports(id),
    ip TEXT,
    user_agent TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS study_rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    owner_id TEXT NOT NULL REFERENCES users(id),
    points INTEGER NOT NULL DEFAULT 1000000,
    last_charged_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS study_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL REFERENCES study_rooms(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    joined_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(room_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS leader_applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id),
    study_name TEXT NOT NULL,
    study_plan TEXT NOT NULL,
    agreement TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    admin_memo TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    reviewed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS study_applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL REFERENCES study_rooms(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    message TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS follows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    follower_id TEXT NOT NULL REFERENCES users(id),
    author_id TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(follower_id, author_id)
  );

  CREATE TABLE IF NOT EXISTS report_flags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reporter_id TEXT NOT NULL REFERENCES users(id),
    report_id INTEGER NOT NULL REFERENCES reports(id),
    reason TEXT NOT NULL,
    detail TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// 마이그레이션: users 테이블에 nickname, referrer_id, points 추가
try {
  const cols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  if (!cols.includes('nickname')) {
    db.exec("ALTER TABLE users ADD COLUMN nickname TEXT");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_nickname ON users(nickname) WHERE nickname IS NOT NULL");
  }
  if (!cols.includes('referrer_id')) db.exec("ALTER TABLE users ADD COLUMN referrer_id TEXT");
  if (!cols.includes('points')) db.exec("ALTER TABLE users ADD COLUMN points INTEGER NOT NULL DEFAULT 0");
} catch(e) { console.error('users migration error:', e.message); }

// 마이그레이션: reports 테이블에 visibility, max_buyers, study_room_id 추가
try {
  const rCols = db.prepare("PRAGMA table_info(reports)").all().map(c => c.name);
  if (!rCols.includes('visibility')) db.exec("ALTER TABLE reports ADD COLUMN visibility TEXT DEFAULT 'study_only'");
  if (!rCols.includes('max_buyers')) db.exec("ALTER TABLE reports ADD COLUMN max_buyers INTEGER DEFAULT 0");
  if (!rCols.includes('study_room_id')) db.exec("ALTER TABLE reports ADD COLUMN study_room_id INTEGER");
} catch(e) { console.error('reports migration error:', e.message); }

// 마이그레이션: study_rooms에 max_members, report_cycle_months 추가
try {
  const srCols2 = db.prepare("PRAGMA table_info(study_rooms)").all().map(c => c.name);
  if (!srCols2.includes('max_members')) db.exec("ALTER TABLE study_rooms ADD COLUMN max_members INTEGER DEFAULT 20");
  if (!srCols2.includes('report_cycle_months')) db.exec("ALTER TABLE study_rooms ADD COLUMN report_cycle_months INTEGER DEFAULT 1");
} catch(e) { console.error('study_rooms max/cycle migration error:', e.message); }

// 마이그레이션: study_applications에 intro, file_path 추가
try {
  const saCols = db.prepare("PRAGMA table_info(study_applications)").all().map(c => c.name);
  if (!saCols.includes('intro')) db.exec("ALTER TABLE study_applications ADD COLUMN intro TEXT");
  if (!saCols.includes('file_path')) db.exec("ALTER TABLE study_applications ADD COLUMN file_path TEXT");
} catch(e) { console.error('study_applications migration error:', e.message); }

// 스터디방 포인트 로그 테이블
db.exec(`
  CREATE TABLE IF NOT EXISTS study_point_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL REFERENCES study_rooms(id),
    amount INTEGER NOT NULL,
    type TEXT NOT NULL,
    description TEXT,
    admin_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// 알림 테이블
db.exec(`
  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id),
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT,
    link TEXT,
    is_read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read, created_at DESC);
`);

// 리포트 평가 테이블
db.exec(`
  CREATE TABLE IF NOT EXISTS report_ratings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id),
    report_id INTEGER NOT NULL REFERENCES reports(id),
    rating INTEGER NOT NULL CHECK(rating >= 1 AND rating <= 5),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, report_id)
  );
`);

// 마이그레이션: reports에 entry_price (발행 다음날 시초가) 추가
try {
  const rpCols = db.prepare("PRAGMA table_info(reports)").all().map(c => c.name);
  if (!rpCols.includes('entry_price')) db.exec("ALTER TABLE reports ADD COLUMN entry_price REAL");
} catch(e) { console.error('reports entry_price migration error:', e.message); }

// 마이그레이션: study_rooms에 points, last_charged_at 추가
try {
  const srCols = db.prepare("PRAGMA table_info(study_rooms)").all().map(c => c.name);
  if (!srCols.includes('points')) db.exec("ALTER TABLE study_rooms ADD COLUMN points INTEGER DEFAULT 1000000");
  if (!srCols.includes('last_charged_at')) {
    db.exec("ALTER TABLE study_rooms ADD COLUMN last_charged_at TEXT");
    db.exec("UPDATE study_rooms SET last_charged_at = datetime('now') WHERE last_charged_at IS NULL");
  }
} catch(e) { console.error('study_rooms migration error:', e.message); }

// 월간 스터디방 포인트 차감 + 멤버 월회비 차감 (서버 시작 시 체크)
try {
  const rooms = db.prepare("SELECT id, name, points, last_charged_at, owner_id FROM study_rooms").all();
  const now = new Date();
  for (const room of rooms) {
    const lastCharged = new Date(room.last_charged_at);
    let monthsPassed = (now.getFullYear() - lastCharged.getFullYear()) * 12 + (now.getMonth() - lastCharged.getMonth());
    if (monthsPassed > 0) {
      // 스터디방 운영비 차감
      const deduction = monthsPassed * 100000;
      const newPoints = Math.max(0, room.points - deduction);
      db.prepare("UPDATE study_rooms SET points = ?, last_charged_at = datetime('now') WHERE id = ?").run(newPoints, room.id);
      db.prepare("INSERT INTO study_point_logs (room_id, amount, type, description) VALUES (?, ?, 'monthly_fee', ?)").run(
        room.id, -deduction, `월 운영비 차감 (${monthsPassed}개월)`
      );

      // 멤버 월회비 차감 (10,000P x 경과 월수, 스터디장 제외)
      const members = db.prepare("SELECT user_id FROM study_members WHERE room_id = ? AND user_id != ?").all(room.id, room.owner_id);
      for (const m of members) {
        const fee = monthsPassed * 10000;
        const user = db.prepare("SELECT points FROM users WHERE id = ?").get(m.user_id);
        if (user) {
          const actualFee = Math.min(fee, Math.max(0, user.points));
          if (actualFee > 0) {
            db.prepare("UPDATE users SET points = points - ? WHERE id = ?").run(actualFee, m.user_id);
            db.prepare("INSERT INTO point_logs (user_id, amount, type, description) VALUES (?, ?, 'study_monthly', ?)").run(
              m.user_id, -actualFee, `스터디방 월회비 (${monthsPassed}개월): ${room.name}`
            );
          }
        }
      }
    }
  }
} catch(e) { console.error('monthly deduction error:', e.message); }

// 마이그레이션: study_rooms에서 invite_code 제거
try {
  const hasInviteCode = db.prepare("SELECT COUNT(*) as c FROM pragma_table_info('study_rooms') WHERE name = 'invite_code'").get().c;
  if (hasInviteCode) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS study_rooms_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        owner_id TEXT NOT NULL REFERENCES users(id),
        points INTEGER DEFAULT 1000000,
        last_charged_at TEXT NOT NULL DEFAULT (datetime('now')),
        max_members INTEGER DEFAULT 20,
        report_cycle_months INTEGER DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT OR IGNORE INTO study_rooms_new (id, name, description, owner_id, points, last_charged_at, max_members, report_cycle_months, created_at)
        SELECT id, name, description, owner_id,
               COALESCE(points, 1000000), COALESCE(last_charged_at, datetime('now')),
               COALESCE(max_members, 20), COALESCE(report_cycle_months, 1), created_at
        FROM study_rooms;
      DROP TABLE study_rooms;
      ALTER TABLE study_rooms_new RENAME TO study_rooms;
    `);
  }
} catch(e) {}

// 생각나누기 게시판
db.exec(`
  CREATE TABLE IF NOT EXISTS board_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id),
    board TEXT NOT NULL DEFAULT 'all',
    board_nickname TEXT,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    report_count INTEGER NOT NULL DEFAULT 0,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS board_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL REFERENCES board_posts(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(post_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS board_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL REFERENCES board_posts(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    board_nickname TEXT,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS club_verifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id),
    club TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    proof_text TEXT,
    admin_memo TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    reviewed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS user_board_profiles (
    user_id TEXT PRIMARY KEY REFERENCES users(id),
    board_nickname TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// 리포트 경진대회
db.exec(`
  CREATE TABLE IF NOT EXISTS competitions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    creator_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    entry_fee INTEGER NOT NULL DEFAULT 20000,
    max_participants INTEGER NOT NULL DEFAULT 10,
    min_participants INTEGER NOT NULL DEFAULT 3,
    status TEXT NOT NULL DEFAULT 'recruiting',
    start_date TEXT,
    end_date TEXT,
    duration_days INTEGER NOT NULL DEFAULT 30,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS competition_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    competition_id INTEGER NOT NULL REFERENCES competitions(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    report_id INTEGER NOT NULL REFERENCES reports(id),
    stock_code TEXT,
    stock_name TEXT,
    market_type TEXT,
    entry_price REAL,
    final_price REAL,
    return_rate REAL,
    rank INTEGER,
    prize_amount INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(competition_id, user_id)
  );
`);

module.exports = db;
