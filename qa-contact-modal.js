const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto('http://localhost:3000/dashboard', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  // 관리자 문의 버튼 클릭
  await page.click('.btn-contact');
  await page.waitForTimeout(500);
  await page.screenshot({ path: '/tmp/contact-modal.png', fullPage: false });
  console.log('screenshot saved');
  await browser.close();
})();
