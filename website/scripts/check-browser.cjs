const { chromium } = require(process.env.BASSFISH_PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const base = process.env.BASSFISH_SITE_TEST_URL || 'http://127.0.0.1:8081/bassfish/';
  const output = path.resolve(__dirname, '../qa/story');
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await context.newPage(),
    checks = [],
    errors = [];
  const check = (name, value) => {
    assert.ok(value, name);
    checks.push(name);
  };
  const ready = p =>
    p.waitForFunction(() => document.querySelector('#pond').dataset.ready === 'true', null, {
      timeout: 30000,
    });
  const stats = () => page.evaluate(() => window.bassfishStory.getStats());
  const progress = async p => {
    await page.evaluate(p => {
      const story = document.querySelector('#story');
      scrollTo({
        top: story.offsetTop + ((story.offsetHeight - innerHeight) * p) / Number(story.dataset.end),
        behavior: 'instant',
      });
    }, p);
    await page.waitForFunction(
      p => Math.abs(window.bassfishStory.getStats().progress - p) < 0.006,
      p,
    );
    await page.waitForTimeout(260);
  };
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('response', r => {
    if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`);
  });
  try {
    await page.goto(base);
    await ready(page);
    check(
      'Landing shows one pond and one agent',
      (await stats()).ponds === 1 && (await stats()).hiddenAgents === 0 && !(await stats()).carrier,
    );
    check(
      'Title is visible HTML above the pond',
      (await page.locator('.landing-title').isVisible()) &&
        (await page.locator('#site-title').textContent()) === 'bassfish',
    );
    check(
      'Landing starts lower with a visible installation link',
      (await stats()).sceneDrop > 0.1 &&
        (await page.locator('.hero-install').isVisible()) &&
        (await page.locator('.hero-install').getAttribute('href')) === './docs.html#install',
    );
    check(
      'Geist fonts are loaded locally',
      await page.evaluate(
        () =>
          document.fonts.check('16px Geist') &&
          document.fonts.check('16px "Geist Mono"') &&
          getComputedStyle(document.body).fontFamily.startsWith('Geist'),
      ),
    );
    check(
      'Hero typography is substantially larger',
      await page
        .locator('#site-title')
        .evaluate(e => parseFloat(getComputedStyle(e).fontSize) >= 120),
    );
    check(
      'Transparent canvas lets HTML scroll behind the pond',
      await page
        .locator('#pond canvas')
        .evaluate(e => e.getContext('webgl2').getContextAttributes().alpha),
    );
    check(
      'Full story is available to assistive technology',
      (await page.locator('.story-chapters h2').count()) === 6 &&
        (await page.locator('.skip-link').getAttribute('href')) === '#install',
    );
    await page.evaluate(() => window.bassfishStory.setPaused(true));
    const frozen = (await stats()).time;
    await page.waitForTimeout(200);
    check('Pause stops ambient animation', (await stats()).time === frozen);
    await progress(0.66);
    const entering = await stats();
    await page.screenshot({ path: path.join(output, '1440-text-entering.png') });
    await progress(1.1);
    check(
      'The hero link leaves the tab order after the landing',
      await page.locator('.hero-install').isHidden(),
    );
    check('Headings rise from behind the pond', entering.textY > 200 && (await stats()).textY < 1);
    check('The pond settles lower after the hero', (await stats()).sceneDrop > 0.1);
    check('The single fish surfaces', (await stats()).leadFishY > 0);
    check(
      'Agent status appears beside the fish',
      (await page.locator('.fish-bubble.visible').count()) === 1 &&
        (await page.locator('.fish-bubble.visible').textContent()).includes('question'),
    );
    check(
      'Chapter heading is flat HTML',
      (await page.locator('#chapter-title').textContent()).includes('One agent') &&
        (await page.locator('.chapter-heading').isVisible()),
    );
    await progress(2.12);
    check(
      'Three hidden agents join beneath the visible agent',
      (await stats()).hiddenAgents === 3 && (await stats()).ponds === 1,
    );
    check(
      'Each submerged agent has a doing something bubble',
      (await page.locator('.fish-bubble.visible').allInnerTexts()).length === 3 &&
        (await page.locator('.fish-bubble.visible').allInnerTexts()).every(
          text => text === 'doing something',
        ),
    );
    check(
      'The small third line of story text is removed',
      (await page.locator('#repo-context').count()) === 0,
    );
    await progress(2.9);
    const turning = (await stats()).pondPoses.map(p => p.rotation);
    await progress(3.35);
    const separated = await stats();
    check(
      'Three other ponds rotate into existence',
      separated.ponds === 4 && Math.abs(turning[1] - separated.pondPoses[1].rotation) > 0.05,
    );
    check(
      'Ponds face outward at quarter turns',
      separated.pondPoses.every(
        (pose, i) => Math.abs(pose.rotation - [0, -Math.PI / 2, Math.PI, Math.PI / 2][i]) < 0.001,
      ),
    );
    check(
      'The original pond is at the bottom',
      separated.pondPoses.slice(1).every(p => p.y < separated.pondPoses[0].y),
    );
    check(
      'Separate ponds have no connecting rig yet',
      !separated.carrier && separated.microphones === 0,
    );
    const flight = [];
    for (const p of [3.63, 3.8, 3.99]) {
      await progress(p);
      flight.push(await stats());
      await page.screenshot({ path: path.join(output, `flight-${p}.png`) });
    }
    check(
      'The arriving bass follows a curved swimming path',
      flight[1].carrierPosition[2] > flight[0].carrierPosition[2] + 2 &&
        flight[1].carrierPosition[2] > flight[2].carrierPosition[2] + 2,
    );
    check(
      'The bass turns to follow each bend',
      Math.abs(flight[0].carrierForward[2] - flight[1].carrierForward[2]) > 0.2,
    );
    await progress(4.35);
    check(
      'The larger bass flies in above the ponds',
      (await stats()).carrier && !(await stats()).connected,
    );
    check(
      'The large bass faces down and right toward the camera',
      (await stats()).carrierNose.x > (await stats()).carrierTail.x &&
        (await stats()).carrierNose.y > (await stats()).carrierTail.y,
    );
    await progress(5.15);
    check(
      'Four microphones connect the agents',
      (await stats()).microphones === 4 && (await stats()).connected,
    );
    check(
      'The API and client exchange messages',
      (await page.locator('.fish-bubble.visible').count()) === 2 &&
        (await page.locator('.fish-bubble.visible').allTextContents()).some(text =>
          text.includes('Got it'),
        ),
    );
    check(
      'Geometry and texture sharing keep the scene bounded',
      (await stats()).drawCalls < 450 && (await stats()).triangles < 200000,
    );
    await progress(5.4);
    check(
      'The conversation continues with tests and review',
      (await page.locator('.fish-bubble.visible').allTextContents()).some(text =>
        text.includes('tests pass'),
      ),
    );
    const orbit = (await stats()).orbit;
    await page.evaluate(() => window.bassfishStory.setPaused(false));
    const swim = (await stats()).leadFishPosition;
    await page.waitForFunction(before => {
      const now = window.bassfishStory.getStats().leadFishPosition;
      return Math.hypot(now[0] - before[0], now[2] - before[2]) > 0.04;
    }, swim);
    const animated = await stats();
    check(
      'Surface fish swim around a circular path',
      Math.hypot(animated.leadFishPosition[0] - swim[0], animated.leadFishPosition[2] - swim[2]) >
        0.04 &&
        Math.abs(
          Math.hypot(animated.leadFishPosition[0] - 1.4, animated.leadFishPosition[2] - 2) - 0.85,
        ) < 0.001,
    );
    check('The connected scene keeps rotating', animated.orbit > orbit + 0.01);
    await page.evaluate(() => window.bassfishStory.setPaused(true));
    await progress(6.5);
    const overhead = await stats();
    check(
      'The final camera is exactly top-down',
      Math.abs(overhead.cameraDirection[1] + 1) < 1e-10 &&
        Math.abs(overhead.cameraDirection[0]) + Math.abs(overhead.cameraDirection[2]) < 1e-10,
    );
    check('The rig clears the overhead view', !overhead.carrier && overhead.microphones === 0);
    check(
      'Four square ponds form an aligned grid',
      overhead.pondRects.every(r => Math.abs(r.width - r.height) < 0.001) &&
        Math.abs(overhead.pondRects[0].y - overhead.pondRects[1].y) < 0.001 &&
        Math.abs(overhead.pondRects[2].x - overhead.pondRects[1].x) < 0.001,
    );
    await page.evaluate(() => window.bassfishStory.setPaused(false));
    await page.waitForTimeout(400);
    check(
      'The overhead camera stays locked while fish swim',
      JSON.stringify((await stats()).cameraQuaternion) ===
        JSON.stringify(overhead.cameraQuaternion),
    );
    await page.evaluate(() => window.bassfishStory.setPaused(true));
    await progress(6.73);
    check(
      'Terminal surfaces begin at the pond footprints',
      await page.evaluate(() => {
        const rectangles = window.bassfishStory.getStats().pondRects;
        return [...document.querySelectorAll('.story-terminal')].every((e, i) => {
          const r = e.getBoundingClientRect(),
            p = rectangles[i];
          return (
            Math.abs(r.x - p.x) < 4 && Math.abs(r.y - p.y) < 4 && Math.abs(r.width - p.width) < 4
          );
        });
      }),
    );
    await progress(7.4);
    const earlyEvents = await page.locator('.terminal-layer').getAttribute('data-events');
    await progress(8.35);
    check(
      'Four terminal windows show a shared conversation',
      (await page.locator('.story-terminal').count()) === 4 &&
        (await page.locator('.terminal-line.receive:not([hidden])').count()) > 10 &&
        (await page
          .locator('.terminal-line.file:not([hidden]),.terminal-line.ticket:not([hidden])')
          .count()) >= 4,
    );
    check(
      'Output advances and scrolls inside each terminal',
      Number(await page.locator('.terminal-layer').getAttribute('data-events')) >
        Number(earlyEvents) &&
        (await page
          .locator('.story-terminal')
          .evaluateAll(panes => panes.every(e => Number(e.dataset.scroll) > 0))),
    );
    check(
      'The terminal grid replaces the pond canvas',
      await page.locator('#pond').evaluate(e => getComputedStyle(e).opacity === '0'),
    );
    await progress(6.5);
    check(
      'Reverse scrolling restores the locked ponds',
      (await page.locator('.terminal-layer').isHidden()) &&
        (await page.locator('#pond').evaluate(e => getComputedStyle(e).opacity === '1')),
    );
    await progress(0);
    check(
      'Reverse scrolling restores the single-pond landing',
      (await stats()).ponds === 1 && (await stats()).hiddenAgents === 0 && !(await stats()).carrier,
    );
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
      for (const [name, p] of [
        ['landing', 0],
        ['single', 1.1],
        ['hidden', 2.12],
        ['separate', 3.35],
        ['arrival', 4.35],
        ['connected', 5.15],
        ['overhead', 6.5],
        ['morph', 7.12],
        ['terminals', 8.35],
      ]) {
        await progress(p);
        await page.screenshot({ path: path.join(output, `${width}-${name}.png`) });
        check(
          `${name} fits at ${width}px`,
          await page.evaluate(
            () =>
              document.documentElement.scrollWidth <= innerWidth &&
              [...document.querySelectorAll('.fish-bubble.visible')].every(e => {
                const r = e.getBoundingClientRect();
                return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom < innerHeight;
              }),
          ),
        );
      }
    }
    for (const width of [320, 768, 1024, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      await progress(8.35);
      check(
        `Terminal grid fits at ${width}px`,
        await page.locator('.story-terminal').evaluateAll(panes =>
          panes.every(e => {
            const r = e.getBoundingClientRect();
            return (
              r.left >= 0 && r.right <= innerWidth && r.top > 100 && r.bottom < innerHeight - 40
            );
          }),
        ),
      );
      check(
        `No page overflow at ${width}px`,
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      );
    }
    for (const [width, height] of [
      [1440, 1000],
      [390, 844],
      [320, 568],
      [1280, 600],
    ]) {
      await page.setViewportSize({ width, height });
      await progress(8.4);
      check(
        `Four terminals remain separate at ${width}×${height}`,
        await page.locator('.story-terminal').evaluateAll(panes => {
          const r = panes.map(e => e.getBoundingClientRect());
          return (
            r[1].right < r[0].left &&
            r[2].right < r[3].left &&
            r[2].bottom < r[1].top &&
            r.every(a => a.top > 95 && a.bottom < innerHeight - 40)
          );
        }),
      );
      await page.evaluate(() => scrollBy({ top: innerHeight * 0.7, behavior: 'instant' }));
      await page.waitForTimeout(250);
      check(
        `The terminal stage releases into normal flow at ${width}px`,
        await page.locator('.story-stage').evaluate(e => e.getBoundingClientRect().top < -100),
      );
      await page
        .locator('.feature-sections')
        .screenshot({ path: path.join(output, `${width}-benefits.png`) });
      check(
        `Three readable feature sections at ${width}px`,
        (await page.locator('.feature-section').count()) === 3 &&
          (await page
            .locator('.feature-section')
            .evaluateAll(cards =>
              cards.every(e => e.clientWidth >= innerWidth / 5 && e.scrollWidth <= e.clientWidth),
            )),
      );
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await progress(8.35);
    await page.locator('.skip-link').focus();
    await page.locator('.skip-link').click();
    check(
      'Skip to install moves focus to the installation section',
      await page.evaluate(
        () =>
          document.activeElement.id === 'install' &&
          Math.abs(document.querySelector('#install').getBoundingClientRect().top) < 45,
      ),
    );
    check(
      'Installation is ordered install, connect, update',
      (await page.locator('#install-title').textContent()) === 'Installation' &&
        JSON.stringify(await page.locator('.step-heading h2').allTextContents()) ===
          JSON.stringify([
            'Install the latest Bassfish',
            'Install MCP and Skills',
            'Keep it current',
          ]),
    );
    check(
      'Terminal commands keep literal double dashes and have room below',
      await page.locator('#install-code').evaluate(code => {
        const block = code.closest('.code-block');
        const next = block.nextElementSibling;
        return (
          code.textContent.includes('bassfish --version') &&
          getComputedStyle(code).fontVariantLigatures === 'none' &&
          parseFloat(getComputedStyle(block).marginBottom) >= 20 &&
          (!next || next.getBoundingClientRect().top - block.getBoundingClientRect().bottom >= 20)
        );
      }),
    );
    check(
      'Installation has three direct steps and four host choices',
      (await page.locator('.install-steps > li').count()) === 3 &&
        (await page.locator('.host-picker a').count()) === 4,
    );
    check(
      'The retired setup guide is not linked',
      (await page.locator('a[href*="setup.md"]').count()) === 0,
    );
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
      await page.locator('#install').scrollIntoViewIfNeeded();
      await page
        .locator('#install')
        .screenshot({ path: path.join(output, `${width}-install.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('#host-codex [data-copy]').click();
    const codexCommand = await page.evaluate(() => navigator.clipboard.readText());
    check(
      'Codex commands include the plugin and targeted skills',
      codexCommand.startsWith('codex mcp remove bassfish') &&
        codexCommand.includes('codex plugin marketplace add tfukaza/bassfish') &&
        codexCommand.includes('codex plugin add bassfish@bassfish') &&
        codexCommand.includes('--skill use-bassfish --skill manage-bassfish') &&
        codexCommand.includes('--agent codex --global --yes'),
    );
    await page.locator('[data-copy="install-code"]').click();
    check(
      'Copy installation commands',
      (await page.evaluate(() => navigator.clipboard.readText())) ===
        'npm install -g @bassfish/cli@latest\nbassfish setup\nbassfish --version\nbassfish doctor',
    );
    await page.getByRole('tab', { name: 'Claude Code' }).click();
    await page.locator('#host-claude [data-copy]').click();
    check(
      'Claude commands include the plugin and targeted skills',
      (await page.evaluate(() => navigator.clipboard.readText())).startsWith(
        'claude plugin marketplace add https://github.com/tfukaza/bassfish.git',
      ) &&
        (await page.evaluate(() => navigator.clipboard.readText())).includes(
          '--agent claude-code --global --yes',
        ),
    );
    await page.getByRole('tab', { name: 'Claude Code' }).focus();
    await page.keyboard.press('ArrowRight');
    check(
      'Host picker supports keyboard navigation',
      (await page.getByRole('tab', { name: 'OpenCode' }).getAttribute('aria-selected')) === 'true',
    );
    await page.keyboard.press('Home');
    check(
      'The retired setup guide is not published',
      !(await page.request.get(new URL('setup.md', base).href)).ok(),
    );
    for (const name of ['llms.txt', 'index.md']) {
      const response = await page.request.get(new URL(name, base).href);
      check(
        `${name} is readable and includes skills`,
        response.ok() &&
          /text\//.test(response.headers()['content-type']) &&
          (await response.text()).includes('use-bassfish'),
      );
    }
    const docsPage = await context.newPage();
    docsPage.on('pageerror', e => errors.push(`docs: ${e.message}`));
    docsPage.on('console', m => {
      if (m.type() === 'error') errors.push(`docs: ${m.text()}`);
    });
    docsPage.on('response', r => {
      if (r.status() >= 400) errors.push(`docs: ${r.status()} ${r.url()}`);
    });
    await docsPage.goto(new URL('docs.html', base).href);
    await docsPage.evaluate(() => document.fonts.ready);
    for (const width of [320, 390, 768, 1440]) {
      await docsPage.setViewportSize({ width, height: width < 600 ? 844 : 1000 });
      check(
        `Docs have no page overflow at ${width}px`,
        await docsPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      );
    }
    check(
      'Docs cover capabilities and every supported host',
      (await docsPage.locator('.capability-grid article').count()) === 6 &&
        (await docsPage.locator('.host-section').count()) === 4,
    );
    const docsText = await docsPage.locator('body').innerText();
    const documentedTools = await docsPage
      .locator('[data-tool]')
      .evaluateAll(items => items.map(item => item.dataset.tool));
    check(
      'Docs list the exact compact MCP surface',
      JSON.stringify(documentedTools) ===
        JSON.stringify([
          'bindHostSession',
          'deliverHostNotifications',
          'getContext',
          'setAgentName',
          'notifications',
          'waitForWork',
          'findResources',
          'createResource',
          'acquireTurn',
          'cancelTurn',
          'readTurn',
          'commitTurn',
          'releaseTurn',
        ]),
    );
    check(
      'Docs explain ticket, file, and upgrade workflows',
      (await docsPage.locator('.workflow-panels article').count()) === 2 &&
        (await docsPage.locator('#upgrade').count()) === 1 &&
        docsText.includes('pending turns'),
    );
    check(
      'Docs reject retired public contracts',
      docsText.includes('v0.4.0') &&
        !docsText.includes('13 Bassfish tools') &&
        !docsText.includes('shared note'),
    );
    check(
      'Docs include current setup commands',
      [
        'npm install -g @bassfish/cli@latest',
        'codex plugin marketplace add tfukaza/bassfish',
        'codex plugin add bassfish@bassfish',
        'claude plugin install bassfish@bassfish --scope user',
        'opencode plugin @bassfish/cli --global',
        '--agent codex --global --yes',
        '--agent claude-code --global --yes',
        '--agent opencode --global --yes',
        'skills@latest update',
        'use-bassfish manage-bassfish --global --yes',
      ].every(command => docsText.includes(command)),
    );
    await docsPage.locator('[data-copy="codex-code"]').click();
    await docsPage.waitForFunction(
      () => document.querySelector('[data-copy="codex-code"]').textContent === 'Copied',
    );
    check(
      'Docs copy controls work',
      (await docsPage.evaluate(() => navigator.clipboard.readText())).includes(
        'codex plugin add bassfish@bassfish',
      ),
    );
    await docsPage.locator('.troubleshooting details').first().locator('summary').click();
    check(
      'Docs troubleshooting disclosures work',
      (await docsPage.locator('.troubleshooting details').first().getAttribute('open')) !== null,
    );
    await docsPage.locator('.docs-sidebar a[href="#codex"]').click();
    await docsPage.waitForFunction(
      () =>
        location.hash === '#codex' &&
        document.querySelector('.docs-sidebar a[href="#codex"]').getAttribute('aria-current') ===
          'location',
    );
    check('Docs section navigation tracks the current location', true);
    await docsPage.close();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(base);
    await ready(page);
    check('Reduced-motion preference starts paused', (await stats()).paused);
    await page.evaluate(() => {
      const story = document.querySelector('#story');
      scrollTo({
        top: ((story.offsetHeight - innerHeight) * 3.3) / Number(story.dataset.end),
        behavior: 'instant',
      });
    });
    await page.waitForFunction(() => window.bassfishStory.getStats().chapter === 3);
    check(
      'Reduced motion uses still chapter poses',
      Math.abs((await stats()).progress - 3.25) < 0.001,
    );
    const still = (await stats()).time;
    await page.waitForTimeout(180);
    check('Reduced-motion scene stays still', (await stats()).time === still);
    await page.evaluate(() => {
      const story = document.querySelector('#story');
      scrollTo({
        top: ((story.offsetHeight - innerHeight) * 6.5) / Number(story.dataset.end),
        behavior: 'instant',
      });
    });
    await page.waitForFunction(() => window.bassfishStory.getStats().overhead === 1);
    check('Reduced motion includes a still overhead grid', (await stats()).morph === 0);
    await page.evaluate(() => {
      const story = document.querySelector('#story');
      scrollTo({
        top: ((story.offsetHeight - innerHeight) * 7.3) / Number(story.dataset.end),
        behavior: 'instant',
      });
    });
    await page.waitForFunction(() => window.bassfishStory.getStats().morph === 1);
    check(
      'Reduced motion shows complete static terminals',
      (await page.locator('.terminal-line:not([hidden])').count()) === 54 &&
        (await page
          .locator('.terminal-feed')
          .first()
          .evaluate(e => getComputedStyle(e).transitionDuration === '0s')),
    );
    for (const [name, setup] of [
      [
        'WebGL unavailable',
        async p =>
          p.addInitScript(() => {
            const original = HTMLCanvasElement.prototype.getContext;
            HTMLCanvasElement.prototype.getContext = function (type, ...args) {
              return type === 'webgl2' ? null : original.call(this, type, ...args);
            };
          }),
      ],
      [
        'Missing texture',
        async p => p.route('**/foliage/cattails-v2.webp', route => route.abort()),
      ],
    ]) {
      const fallback = await context.newPage();
      await setup(fallback);
      await fallback.goto(base);
      await fallback.waitForFunction(
        () => document.querySelector('#pond').dataset.ready === 'fallback',
      );
      check(
        `${name} retains a visible text story and installation`,
        (await fallback.locator('.story-chapters').isVisible()) &&
          (await fallback.locator('#install-code').isVisible()) &&
          (await fallback.locator('#pond canvas').count()) === 0 &&
          (await fallback.locator('.feature-section').count()) === 3 &&
          (await fallback.locator('.terminal-layer').isHidden()),
      );
      await fallback.close();
    }
    const noJS = await browser.newPage({ javaScriptEnabled: false });
    await noJS.goto(base);
    check(
      'No-JavaScript view includes the complete story and host instructions',
      (await noJS.locator('.story-chapters').isVisible()) &&
        (await noJS.locator('#host-claude').isVisible()) &&
        (await noJS.locator('#host-codex').isVisible()) &&
        (await noJS.locator('#host-opencode').isVisible()) &&
        (await noJS.locator('.feature-section').count()) === 3,
    );
    check(
      'No-JavaScript view has no inactive copy controls',
      await noJS
        .locator('[data-copy]')
        .evaluateAll(buttons => buttons.every(button => button.hidden)),
    );
    await noJS.close();
    const preview = await context.newPage();
    await preview.goto(new URL('backdrop/pond/', base).href);
    await preview.waitForFunction(() => !!window.bassfishPond);
    check(
      'The standalone pond remains available',
      await preview.evaluate(() => window.bassfishPond.getStats().texturedBass === 2),
    );
    await preview.getByRole('button', { name: 'Pause animation', exact: true }).click();
    await preview.getByRole('button', { name: 'Reset view', exact: true }).click();
    check(
      'Standalone pond controls still work',
      await preview.evaluate(
        () => window.bassfishPond.paused && window.bassfishPond.getStats().yaw === 0.72,
      ),
    );
    await preview.close();
    await page.evaluate(() => window.bassfishStory.dispose());
    const frames = (await stats()).frames;
    await page.waitForTimeout(100);
    check(
      'Disposal removes the canvas and stops drawing',
      (await page.locator('#pond canvas').count()) === 0 && (await stats()).frames === frames,
    );
    check('No JavaScript, shader, or resource errors', errors.length === 0);
    await fs.writeFile(
      path.join(output, 'checks.json'),
      JSON.stringify({ base, checks, errors }, null, 2),
    );
    console.log(JSON.stringify({ base, checks, errors }, null, 2));
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
