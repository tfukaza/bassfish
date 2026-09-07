const { chromium } = require(process.env.BASSFISH_PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const base = process.env.BASSFISH_SITE_TEST_URL || 'http://127.0.0.1:8081/bassfish/';
  const output = path.resolve(__dirname, '../qa');
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  const checks = [], errors = [];
  const check = (name, value) => { assert.ok(value, name); checks.push(name); };
  const ready = target => target.waitForFunction(() => document.querySelector('#pond').dataset.ready === 'true', null, { timeout: 30000 });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
  try {
    await page.goto(base);
    await ready(page);
    check('Pond loads from the GitHub Pages project path', await page.locator('#pond canvas').count() === 1);
    await page.getByRole('button', { name: 'Pause motion', exact: true }).click();
    await page.waitForTimeout(250);
    const frozen = await page.locator('#pond canvas').screenshot();
    await page.waitForTimeout(220);
    check('Pause stops the scene', frozen.equals(await page.locator('#pond canvas').screenshot()));
    const box = await page.locator('#pond').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 75, box.y + box.height / 2, { steps: 6 }); await page.mouse.up();
    check('Dragging rotates the scene', !frozen.equals(await page.locator('#pond canvas').screenshot()));
    await page.getByRole('button', { name: 'Reset view' }).click();
    check('Reset restores the camera', frozen.equals(await page.locator('#pond canvas').screenshot()));
    await page.screenshot({ path: path.join(output, 'desktop.png'), fullPage: true });

    await page.getByRole('tab', { name: 'Claude Code' }).click();
    check('Claude Code instructions selected', await page.locator('#host-claude').isVisible() && !await page.locator('#host-codex').isVisible());
    await page.locator('#host-claude [data-copy]').click();
    check('Copy host commands', (await page.evaluate(() => navigator.clipboard.readText())).startsWith('claude mcp add --scope user bassfish -- bassfish mcp'));
    await page.getByRole('tab', { name: 'Claude Code' }).focus();
    await page.keyboard.press('ArrowRight');
    check('Keyboard switches host tabs', await page.getByRole('tab', { name: 'Other MCP hosts' }).getAttribute('aria-selected') === 'true');
    await page.keyboard.press('Home');
    check('Home key returns to first host', await page.getByRole('tab', { name: 'Codex', exact: true }).getAttribute('aria-selected') === 'true');
    await page.locator('[data-copy-url]').click();
    check('Copy setup link preserves project path', await page.evaluate(() => navigator.clipboard.readText()) === new URL('setup.md', base).href);
    await page.locator('[data-copy="install-code"]').click();
    check('Copy install commands has no prompt characters', await page.evaluate(() => navigator.clipboard.readText()) === 'npm install -g @bassfish/cli\nbassfish setup\nbassfish --version');
    await page.locator('[data-copy="first-prompt"]').click();
    check('Copy first conversation prompt', (await page.evaluate(() => navigator.clipboard.readText())).includes('API pagination'));

    await page.waitForFunction(() => !document.querySelector('#copy-status').textContent);
    for (const width of [320, 390, 768, 1024, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
      await page.waitForTimeout(180);
      check(`No page overflow at ${width}px`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (width === 390 || width === 768) await page.screenshot({ path: path.join(output, `${width}.png`), fullPage: true });
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.reload(); await ready(page);
    check('Reduced motion starts paused', await page.getByRole('button', { name: 'Play motion', exact: true }).isVisible());
    for (const name of ['setup.md', 'llms.txt', 'index.md']) {
      const response = await page.request.get(new URL(name, base).href);
      check(`${name} is served as readable text`, response.ok() && /text\//.test(response.headers()['content-type']) && !(await response.text()).includes('<!doctype'));
    }
    const fallback = await context.newPage();
    await fallback.addInitScript(() => { const original = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (type, ...args) { return type === 'webgl2' ? null : original.call(this, type, ...args); }; });
    await fallback.goto(base);
    await fallback.waitForFunction(() => document.querySelector('#pond').dataset.ready === 'fallback');
    check('WebGL failure keeps a poster and usable installation', await fallback.locator('.pond-poster').isVisible() && await fallback.locator('#install-code').isVisible() && !await fallback.locator('.pond-controls').isVisible());
    await fallback.close();
    const missing = await context.newPage();
    await missing.route('**/foliage/cattails-v2.webp', route => route.abort());
    await missing.goto(base);
    await missing.waitForFunction(() => document.querySelector('#pond').dataset.ready === 'fallback');
    check('Missing texture falls back cleanly', await missing.locator('#pond canvas').count() === 0 && await missing.locator('.pond-poster').isVisible());
    await missing.close();
    const noJS = await browser.newPage({ javaScriptEnabled: false });
    await noJS.goto(base);
    check('Without JavaScript all host commands and setup link remain available', await noJS.locator('#host-codex').isVisible() && await noJS.locator('#host-claude').isVisible() && await noJS.locator('.guide-url').isVisible());
    check('Without JavaScript there are no dead copy buttons', await noJS.locator('[data-copy-url]').isHidden());
    await noJS.close();
    check('No JavaScript, shader, or missing-resource errors', errors.length === 0);
    await fs.writeFile(path.join(output, 'checks.json'), JSON.stringify({ base, checks, errors }, null, 2));
    console.log(JSON.stringify({ base, checks, errors }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
