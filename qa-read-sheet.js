const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });

  // Use the HTML view which loads faster
  const sheetUrl = 'https://docs.google.com/spreadsheets/d/18SqGDTJuV-tyi4Yj5KKuFFp_MTki9AMNmC7vkG9xqBY/htmlview?gid=0';

  await page.goto(sheetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);

  await page.screenshot({ path: '/tmp/sheet-initial.png', fullPage: false });

  const title = await page.title();
  console.log('Page title:', title);

  // Get all table data
  const tableData = await page.evaluate(() => {
    const tables = document.querySelectorAll('table');
    const results = [];
    tables.forEach((table, ti) => {
      const rows = table.querySelectorAll('tr');
      rows.forEach((row, ri) => {
        const cells = row.querySelectorAll('td, th');
        const rowData = [];
        cells.forEach(cell => rowData.push(cell.textContent.trim()));
        if (rowData.some(c => c)) results.push(rowData.join('\t'));
      });
    });
    return results.join('\n');
  });

  console.log(tableData);

  await browser.close();
})();
