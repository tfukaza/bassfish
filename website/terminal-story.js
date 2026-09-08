import { ease, mix } from './story-timing.js';

// One illustrative conversation, shared across the four views. These are not live sessions.
const sessions = [
  { host: 'Codex', name: 'api-agent' },
  { host: 'Claude Code', name: 'client-agent' },
  { host: 'Codex', name: 'test-agent' },
  { host: 'Claude Code', name: 'review-agent' },
];
const events = [
  [0, 'task', '› Implement the endpoint'],
  [1, 'task', '› Build the pagination UI'],
  [2, 'task', '› Cover the edge cases'],
  [3, 'task', '› Review the changes'],
  [0, 'meta', 'Following · API pagination'],
  [1, 'meta', 'Following · API pagination'],
  [2, 'meta', 'Following · API pagination'],
  [3, 'meta', 'Following · API pagination'],
  [1, 'send', '→ @api-agent: What’s the response shape?'],
  [0, 'receive', '← @client-agent: What’s the response shape?'],
  [0, 'meta', 'Thread turn claimed'],
  [0, 'send', '→ @here: { items, nextCursor }. Null means the last page.'],
  [0, 'meta', 'Message saved · turn released'],
  [1, 'receive', '← @api-agent: { items, nextCursor }. Null means the last page.'],
  [2, 'receive', '← @api-agent: Null means the last page.'],
  [3, 'receive', '← @api-agent: Response shape agreed.'],
  [0, 'meta', 'File set acquired · docs/api-plan.md'],
  [0, 'file', 'Saved the response shape to docs/api-plan.md.'],
  [3, 'meta', 'Waiting for the docs/api-plan.md lock…'],
  [0, 'meta', 'File set released'],
  [3, 'meta', 'File set acquired · rereading latest plan'],
  [3, 'file', 'Added review checks to docs/api-plan.md.'],
  [3, 'meta', 'File set released'],
  [1, 'send', '→ @test-agent: I’ll hide Next on the last page.'],
  [2, 'receive', '← @client-agent: Next is hidden on the last page.'],
  [1, 'task', 'Editing Pagination.tsx…'],
  [0, 'task', 'Editing routes/items.ts…'],
  [2, 'task', 'Adding empty-page and last-page tests…'],
  [3, 'task', 'Reading the diff and shared plan…'],
  [0, 'send', '→ @here: Endpoint is ready for testing.'],
  [2, 'receive', '← @api-agent: Endpoint is ready.'],
  [1, 'receive', '← @api-agent: Endpoint is ready.'],
  [1, 'send', '→ @test-agent: UI is ready too.'],
  [2, 'receive', '← @client-agent: UI is ready too.'],
  [2, 'task', 'Running pagination tests…'],
  [3, 'send', '→ @client-agent: Can we label the loading state?'],
  [1, 'receive', '← @review-agent: Label the loading state?'],
  [1, 'task', 'Adding “Loading more items…”'],
  [1, 'send', '→ @review-agent: Done. Ready for another look.'],
  [3, 'receive', '← @client-agent: Loading state updated.'],
  [2, 'ticket', 'Marked the test ticket done.'],
  [2, 'send', '→ @here: All 12 pagination tests pass.'],
  [0, 'receive', '← @test-agent: All 12 pagination tests pass.'],
  [1, 'receive', '← @test-agent: All 12 pagination tests pass.'],
  [3, 'receive', '← @test-agent: All 12 pagination tests pass.'],
  [3, 'ticket', 'Marked the review ticket done.'],
  [3, 'send', '→ @here: Reviewed. Ready to merge.'],
  [0, 'receive', '← @review-agent: Ready to merge.'],
  [1, 'receive', '← @review-agent: Ready to merge.'],
  [2, 'receive', '← @review-agent: Ready to merge.'],
  [0, 'task', '✓ Endpoint complete'],
  [1, 'task', '✓ UI complete'],
  [2, 'task', '✓ Tests complete'],
  [3, 'task', '✓ Review complete'],
];

export function createTerminalStory(layer, pond) {
  const panes = sessions.map((session, index) => {
    const element = document.createElement('div');
    element.className = 'story-terminal';
    element.dataset.agent = session.name;
    element.innerHTML =
      '<div class="terminal-bar"><span class="terminal-host"></span><span class="terminal-agent"></span></div><div class="terminal-viewport"><div class="terminal-feed"></div></div><div class="terminal-status">bassfish <span>•</span> API pagination</div>';
    element.querySelector('.terminal-host').textContent = session.host;
    element.querySelector('.terminal-agent').textContent = session.name;
    const feed = element.querySelector('.terminal-feed');
    const rows = events.flatMap(([agent, kind, text], event) => {
      if (agent !== index) return [];
      const row = document.createElement('p');
      row.className = `terminal-line ${kind}`;
      row.textContent = text;
      row.hidden = true;
      feed.append(row);
      return { row, event };
    });
    layer.append(element);
    return { element, feed, rows, viewport: element.querySelector('.terminal-viewport') };
  });
  let lastLayout = '',
    lastEvent = -1;

  return frame => {
    const { morph, width, height, progress, pondRects } = frame;
    layer.hidden = morph === 0;
    pond.style.opacity = String(1 - ease(0.08, 0.78, morph));
    if (!morph) return;
    const gap = width < 760 ? 10 : 18;
    const gridWidth = Math.min(1080, width - (width < 760 ? 40 : 80));
    const gridHeight = Math.min(580, height * 0.65);
    const paneWidth = (gridWidth - gap) / 2,
      paneHeight = (gridHeight - gap) / 2;
    const left = (width - gridWidth) / 2,
      top = height * 0.56 - gridHeight / 2;
    const shown = Math.floor(mix(8, events.length, ease(6.92, 8.3, progress)));
    const layout = `${width}/${height}/${morph}`;
    layer.dataset.events = String(shown);
    layer.style.opacity = String(ease(0, 0.42, morph));
    for (const [index, pane] of panes.entries()) {
      if (layout !== lastLayout) {
        // Match world X/Z placement: tests + review above client + API.
        const column = index === 0 || index === 3 ? 1 : 0;
        const row = index < 2 ? 1 : 0;
        const source = pondRects[index];
        Object.assign(pane.element.style, {
          left: `${mix(source.x, left + column * (paneWidth + gap), morph)}px`,
          top: `${mix(source.y, top + row * (paneHeight + gap), morph)}px`,
          width: `${mix(source.width, paneWidth, morph)}px`,
          height: `${mix(source.height, paneHeight, morph)}px`,
          borderRadius: `${mix(2, 9, morph)}px`,
        });
      }
      if (shown !== lastEvent) for (const { row, event } of pane.rows) row.hidden = event >= shown;
      pane.element.style.setProperty('--terminal-ink', String(ease(0.24, 0.88, morph)));
    }
    if (layout !== lastLayout || shown !== lastEvent) {
      // Read after all four layouts are written; never scroll the document to follow output.
      for (const pane of panes) {
        const offset = Math.max(0, pane.feed.offsetHeight - pane.viewport.clientHeight);
        pane.feed.style.transform = `translateY(${-offset}px)`;
        pane.element.dataset.scroll = String(offset);
      }
    }
    lastLayout = layout;
    lastEvent = shown;
  };
}
