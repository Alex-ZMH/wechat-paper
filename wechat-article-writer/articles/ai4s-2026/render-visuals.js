const { chromium } = require('playwright');
const path = require('path');

const targets = [
  ['#cover', 'ai4s-cover-final.png'],
  ['#ladder', 'ai4s-evidence-ladder.png'],
  ['#matrix', 'ai4s-company-matrix.png'],
  ['#quadrant', 'ai4s-capital-vs-proof.png'],
  ['#redflags', 'ai4s-red-flags.png'],
  ['#stack', 'ai4s-industry-stack.png'],
  ['#loop', 'ai4s-commercial-loop.png'],
];

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  });
  const page = await browser.newPage({ viewport: { width: 2400, height: 1600 }, deviceScaleFactor: 1 });
  const htmlPath = path.join(__dirname, 'visuals.html');
  await page.goto('file:///' + htmlPath.replace(/\\/g, '/'), { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  for (const [selector, filename] of targets) {
    const el = page.locator(selector);
    await el.screenshot({ path: path.join(__dirname, 'images', filename) });
  }
  await browser.close();
})();
