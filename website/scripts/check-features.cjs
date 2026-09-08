const { chromium } = require(process.env.BASSFISH_PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const base = process.env.BASSFISH_SITE_TEST_URL || 'http://127.0.0.1:8081/bassfish/';
  const output = require('node:path').resolve(__dirname, '../qa/features');
  await fs.mkdir(output, { recursive: true });
  const checks = [];
  const check = (name, value) => {
    assert(value, name);
    checks.push(name);
  };
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(base);
    await page.waitForSelector('.workflow-demo[data-phase]');
    const demo = page.locator('[data-demo="team"]');
    const elapsed = () =>
      page.locator('.workflow-demo').evaluateAll(es => es.map(e => Number(e.dataset.elapsed)));
    await page.waitForTimeout(250);
    check(
      'Offscreen demos do not start',
      (await elapsed()).every(t => t === 0),
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await demo.scrollIntoViewIfNeeded();
    await page.waitForTimeout(600);
    check(
      'One substantially visible demo advances',
      (await elapsed()).filter(t => t > 0).length === 1,
    );
    await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
    await page.waitForTimeout(200);
    const off = await elapsed();
    await page.waitForTimeout(250);
    check(
      'Leaving the viewport suspends playback',
      JSON.stringify(off) === JSON.stringify(await elapsed()),
    );
    await demo.scrollIntoViewIfNeeded();
    // Simulate the browser visibility event deterministically in headless Chromium.
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const hidden = await elapsed();
    await page.waitForTimeout(250);
    check(
      'Hidden tabs suspend all demos',
      JSON.stringify(hidden) === JSON.stringify(await elapsed()),
    );
    await page.evaluate(() => {
      delete document.hidden;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForFunction(
      () => document.querySelector('[data-demo="team"]').dataset.phase === '1',
    );
    check('Client joins from Claude Code', await demo.locator('.terminal-new').isVisible());
    await page.waitForFunction(
      () => Number(document.querySelector('[data-demo="team"]').dataset.elapsed) > 9500,
    );
    check(
      'The speaking client has an abstract bubble',
      (await demo.locator('.speech-dots:visible').count()) === 1,
    );
    check(
      'Greeting and welcome appear',
      (await demo.locator('.glass-reply:visible').count()) === 2,
    );
    await page.waitForFunction(
      () => document.querySelector('[data-demo="team"]').dataset.complete === 'true',
    );
    check(
      'New session retains its greeting',
      (await demo.innerText()).includes('Hi, I’ll take the client.') &&
        (await demo.locator('.glass-reply:visible').count()) === 2,
    );
    await page.waitForTimeout(250);
    check('Completed demo holds', (await elapsed())[0] === 12000);
    await page.setViewportSize({ width: 1440, height: 1000 });
    for (const name of ['mentions', 'files']) {
      const d = page.locator(`[data-demo="${name}"]`);
      await d.scrollIntoViewIfNeeded();
      await page.waitForFunction(
        name => document.querySelector(`[data-demo="${name}"]`).dataset.phase === '1',
        name,
      );
      check(
        `${name} shows its intermediate action`,
        (await d.innerText()).includes(
          name === 'files' ? 'Claude Code is waiting' : 'You were mentioned',
        ),
      );
      if (name === 'files')
        check(
          'The first editor holds the line',
          (await d.getAttribute('data-hook-owner')) === 'api-agent',
        );
      await d.screenshot({ path: `${output}/${name}-intermediate.png` });
      if (name === 'files') {
        await page.waitForFunction(
          () => Number(document.querySelector('[data-demo="files"]').dataset.fishTime) >= 8,
        );
        check(
          'The next editor receives the line',
          (await d.getAttribute('data-hook-owner')) === 'client-agent',
        );
      }
      await page.waitForFunction(
        name => document.querySelector(`[data-demo="${name}"]`).dataset.complete === 'true',
        name,
      );
      check(
        `${name} reaches its final state`,
        (await d.innerText()).includes(
          name === 'files' ? 'export const lastPageCursor = null;' : 'api-agent ✓',
        ),
      );
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.workflow-demo')].every(e => e.dataset.complete === 'true'),
    );
    check(
      'Reduced motion shows complete examples and no playback controls',
      await page
        .locator('.workflow-demo')
        .evaluateAll(es => es.every(e => e.dataset.complete === 'true')),
    );
    for (const width of [1440, 900, 800, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      check(
        `No horizontal overflow at ${width}`,
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      );
      check(
        `Readable transcripts at ${width}`,
        await page
          .locator('.demo-animation')
          .evaluateAll(es =>
            es.every(e =>
              [...e.querySelectorAll('p,span,small,strong,b')]
                .filter(x => x.getClientRects().length)
                .every(x => parseFloat(getComputedStyle(x).fontSize) >= 12),
            ),
          ),
      );
      check(
        `Demo content fits at ${width}`,
        await page.locator('.demo-animation').evaluateAll(es =>
          es.every(e => {
            const r = e.getBoundingClientRect();
            return [...e.querySelectorAll('.glass-window')].every(w => {
              const b = w.getBoundingClientRect();
              return b.top >= r.top && b.bottom <= r.bottom && w.scrollHeight <= w.clientHeight;
            });
          }),
        ),
      );
      check(
        `Correct section layout at ${width}`,
        await page.locator('.feature-section').evaluateAll(
          (es, w) =>
            es.every(e => {
              const c = e.querySelector('.feature-copy').getBoundingClientRect(),
                d = e.querySelector('.workflow-demo').getBoundingClientRect();
              return w < 900 ? c.bottom <= d.top : c.right <= d.left || d.right <= c.left;
            }),
          width,
        ),
      );
      await page.locator('#features').screenshot({ path: `${output}/${width}.png` });
    }
    const noJS = await browser.newPage({
      javaScriptEnabled: false,
      viewport: { width: 390, height: 844 },
    });
    await noJS.goto(base);
    check(
      'No-JavaScript has all three complete examples',
      (await noJS.locator('.feature-section').count()) === 3 &&
        (await noJS.locator('.terminal-new').isVisible()) &&
        (await noJS.locator('[data-demo="files"]').innerText()).includes(
          'export const lastPageCursor = null;',
        ),
    );
    check(
      'No-JavaScript exposes action sequences without inactive controls',
      (await noJS.locator('.demo-steps li').count()) === 12 &&
        (await noJS.locator('.demo-controls:visible').count()) === 0,
    );
    check(
      'Animated transcripts do not announce updates',
      (await page.locator('.demo-animation[aria-hidden="true"]').count()) === 3 &&
        (await page.locator('.workflow-demo [aria-live]').count()) === 0,
    );
    check(
      'No scene labels or controls',
      (await page
        .locator('.demo-toolbar,.demo-description,.story-navigation,.feature-disclosure')
        .count()) === 0,
    );
    check(
      'Windows are level and dots are larger',
      (await page
        .locator('.glass-window')
        .evaluateAll(es => es.every(e => getComputedStyle(e).transform === 'none'))) &&
        (await page
          .locator('.window-chrome i')
          .first()
          .evaluate(e => e.offsetWidth === 11)),
    );
    const missing = await browser.newPage({ reducedMotion: 'reduce' });
    await missing.route('**/feature-fish.js', r => r.abort());
    await missing.goto(base);
    await missing.waitForSelector('.workflow-demo[data-complete="true"]');
    check(
      'Missing fish leaves complete readable demos',
      (await missing.locator('.feature-fish-canvas').count()) === 0 &&
        (await missing.locator('.glass-window:visible').count()) === 4,
    );
    await missing.close();
    check('No page errors', errors.length === 0);
    await fs.writeFile(`${output}/checks.json`, JSON.stringify({ base, checks, errors }, null, 2));
    console.log(`Passed ${checks.length} feature checks.`);
  } finally {
    await browser.close();
  }
})().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
