const { chromium } = require(process.env.BASSFISH_PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const errors = [], checks = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
  const base = process.env.BASSFISH_PREVIEW_URL || 'http://127.0.0.1:8080/backdrop/';
  const stats = () => page.evaluate(() => window.bassfishBackdrop.getStats());
  const check = (label, condition) => { assert.ok(condition, label); checks.push(label); };
  try {
    await page.goto(base);
    await page.waitForFunction(() => window.bassfishBackdrop?.getStats().frames > 5);
    const first = await stats();
    check('Three.js r180 mounted and rendering', first.threeRevision === '180' && first.triangles > 50000);
    await page.getByRole('button', { name: 'Pause animation', exact: true }).click();
    const frozen = await stats();
    await page.waitForTimeout(250);
    check('Pause stops scene time', (await stats()).elapsed === frozen.elapsed);
    await page.getByRole('button', { name: 'Send signal' }).click();
    check('Signal appears while paused', (await stats()).pulseAge === .6);
    await page.getByRole('button', { name: 'Moonlight', exact: true }).click();
    check('Moonlight palette updates', (await stats()).palette === 1);
    await page.screenshot({ path: path.join(__dirname, 'moonlight.png') });
    await page.getByRole('button', { name: 'Deep water', exact: true }).click();
    await page.getByRole('button', { name: 'Preview with type', exact: true }).click();
    check('Copy preview and hero composition update together', await page.locator('#sample-copy').isVisible() && (await stats()).composition === 1);
    await page.screenshot({ path: path.join(__dirname, 'desktop-with-type.png') });
    await page.getByRole('button', { name: 'Scene only', exact: true }).click();
    check('Scene-only toggle hides example copy', !(await page.locator('#sample-copy').isVisible()));
    await page.getByRole('button', { name: 'Play animation', exact: true }).click();
    await page.waitForFunction(t => window.bassfishBackdrop.getStats().elapsed > t, frozen.elapsed);
    check('Playback resumes', !(await stats()).paused);
    await page.mouse.move(1240, 220);
    await page.waitForTimeout(500);
    await page.mouse.move(720, 500);
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(__dirname, 'desktop.png') });
    for (const width of [390, 760, 1920]) {
      await page.setViewportSize({ width, height: width === 1920 ? 1080 : 844 });
      await page.waitForFunction(w => window.bassfishBackdrop.getStats().width === w, width);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      check(`No horizontal overflow at ${width}px`, !overflow);
      if (width === 390) {
        await page.screenshot({ path: path.join(__dirname, 'mobile.png') });
        await page.getByRole('button', { name: 'Preview with type' }).click();
        await page.waitForTimeout(800);
        await page.screenshot({ path: path.join(__dirname, 'mobile-with-type.png') });
        await page.getByRole('button', { name: 'Scene only' }).click();
      }
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.reload();
    await page.waitForFunction(() => !!window.bassfishBackdrop);
    check('Reduced motion starts paused', (await stats()).paused);
    check('Reduced-motion control offers Play', await page.getByRole('button', { name: 'Play animation', exact: true }).isVisible());
    await page.goto(base + '?embed');
    await page.waitForFunction(() => !!window.bassfishBackdrop);
    check('Embed hides all preview chrome', !(await page.locator('.chrome').isVisible()));
    await page.screenshot({ path: path.join(__dirname, '..', 'poster.jpg'), type: 'jpeg', quality: 90 });
    const rendererStats = await stats();
    await page.evaluate(() => window.bassfishBackdrop.dispose());
    check('Dispose removes the canvas', await page.locator('canvas').count() === 0);
    const frames = (await stats()).frames;
    await page.waitForTimeout(180);
    check('Dispose cancels animation', (await stats()).frames === frames);
    check('No JavaScript, shader, or network errors', errors.length === 0);
    await fs.writeFile(path.join(__dirname, 'checks.json'), JSON.stringify({ checks, errors, rendererStats }, null, 2));
    console.log(JSON.stringify({ checks, errors, rendererStats }, null, 2));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
