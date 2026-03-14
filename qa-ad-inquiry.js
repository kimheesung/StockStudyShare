const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto('http://localhost:3000/ad-inquiry', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: '/tmp/ad-inquiry.png', fullPage: true });
  console.log('screenshot saved');
  await browser.close();
})();
