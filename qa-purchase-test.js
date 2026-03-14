const { chromium } = require('playwright');
const db = require('./lib/db');

(async () => {
  console.log('=== 리포트 구매 흐름 테스트 ===\n');

  // 1. DB에서 판매 중인 리포트 확인
  const reports = db.prepare("SELECT id, title, sale_price, author_id FROM reports WHERE status = 'on_sale' LIMIT 10").all();
  console.log('판매 중인 리포트:', reports.length, '건');
  reports.forEach(r => console.log(`  - [${r.id}] ${r.title} | 가격: ${r.sale_price}P | 작성자ID: ${r.author_id}`));

  // 2. 유저 목록 확인 (구매 테스트용)
  const users = db.prepare("SELECT id, name, email, points, role FROM users LIMIT 10").all();
  console.log('\n유저 목록:');
  users.forEach(u => console.log(`  - [${u.id}] ${u.name} (${u.email}) | 포인트: ${u.points}P | 역할: ${u.role}`));

  // 3. 기존 주문 확인
  const orders = db.prepare("SELECT o.*, r.title FROM orders o JOIN reports r ON o.report_id = r.id ORDER BY o.created_at DESC LIMIT 10").all();
  console.log('\n최근 주문:');
  orders.forEach(o => console.log(`  - 유저${o.user_id} → "${o.title}" | 금액: ${o.amount}P | 상태: ${o.payment_status}`));

  // 4. 구매 가능한 조합 찾기 (작성자가 아닌 유저 + 미구매 + 유료 리포트)
  console.log('\n--- 구매 가능한 조합 찾기 ---');
  for (const report of reports) {
    if (report.sale_price === 0) continue;
    for (const user of users) {
      if (user.id === report.author_id) continue;
      const existingOrder = db.prepare('SELECT id FROM orders WHERE user_id = ? AND report_id = ?').get(user.id, report.id);
      if (!existingOrder) {
        console.log(`\n구매 가능: 유저 [${user.id}] ${user.name} (${user.points}P) → 리포트 [${report.id}] "${report.title}" (${report.sale_price}P)`);
        if (user.points >= report.sale_price) {
          console.log('  → 포인트 충분함!');
        } else {
          console.log('  → 포인트 부족');
        }
      }
    }
  }

  // 5. 세션/쿠키 확인을 위해 실제 브라우저 테스트
  console.log('\n=== 브라우저 테스트 시작 ===');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  // 홈페이지 접속
  await page.goto('http://localhost:3000/', { waitUntil: 'domcontentloaded' });
  await page.screenshot({ path: '/tmp/qa-home.png' });
  console.log('\n홈페이지 접속 완료');

  // 리포트 목록 페이지
  await page.goto('http://localhost:3000/reports', { waitUntil: 'domcontentloaded' });
  await page.screenshot({ path: '/tmp/qa-reports.png' });
  const reportLinks = await page.$$eval('.report-card-full', els => els.map(e => ({ href: e.href, text: e.textContent.trim().slice(0, 80) })));
  console.log('\n리포트 목록에서 보이는 카드:', reportLinks.length);
  reportLinks.forEach(r => console.log(`  - ${r.text}...`));

  // 첫 번째 유료 리포트 상세 페이지로 이동
  if (reports.length > 0) {
    const testReport = reports.find(r => r.sale_price > 0) || reports[0];
    await page.goto(`http://localhost:3000/reports/${testReport.id}`, { waitUntil: 'domcontentloaded' });
    await page.screenshot({ path: '/tmp/qa-report-detail.png' });
    console.log(`\n리포트 상세 페이지 (ID: ${testReport.id}) 스크린샷 저장`);

    // 버튼 텍스트 확인
    const btnText = await page.$eval('.btn-primary', el => el.textContent).catch(() => 'btn-primary 없음');
    console.log('액션 버튼 텍스트:', btnText);
  }

  // 포인트 로그 확인
  console.log('\n=== 포인트 로그 (최근 10건) ===');
  const pointLogs = db.prepare("SELECT pl.*, u.name FROM point_logs pl JOIN users u ON pl.user_id = u.id ORDER BY pl.created_at DESC LIMIT 10").all();
  pointLogs.forEach(l => console.log(`  [${l.created_at}] ${l.name}: ${l.amount > 0 ? '+' : ''}${l.amount}P (${l.type}) ${l.description}`));

  await browser.close();
  console.log('\n=== 테스트 완료 ===');
})();
