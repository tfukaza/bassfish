const status = document.querySelector('#copy-status');
let statusTimer;
function announce(message) {
  clearTimeout(statusTimer);
  status.textContent = message;
  statusTimer = setTimeout(() => { status.textContent = ''; }, 4500);
}

for (const button of document.querySelectorAll('[data-copy], [data-copy-url]')) {
  button.hidden = false;
  button.addEventListener('click', async () => {
    const value = button.dataset.copyUrl
      ? new URL(button.dataset.copyUrl, new URL('./', location.href)).href
      : document.getElementById(button.dataset.copy).textContent.trim();
    try {
      await navigator.clipboard.writeText(value);
      announce(button.dataset.copyUrl ? 'Setup link copied. Paste it into your agent’s chat.' : 'Copied to clipboard.');
    } catch {
      // Keep the link or commands visible and selectable when clipboard access is unavailable.
      const target = button.dataset.copyUrl ? document.querySelector('.guide-url') : document.getElementById(button.dataset.copy);
      if (button.dataset.copyUrl) { target.textContent = value; target.href = value; }
      const selection = getSelection(), range = document.createRange();
      range.selectNodeContents(target); selection.removeAllRanges(); selection.addRange(range);
      announce('Copy is unavailable here. Select and copy the highlighted text.');
    }
  });
}

const picker = document.querySelector('.host-picker');
const tabs = [...picker.querySelectorAll('a')];
picker.setAttribute('role', 'tablist');
function selectTab(tab, focus = false) {
  for (const item of tabs) {
    const selected = item === tab;
    item.setAttribute('aria-selected', String(selected));
    item.tabIndex = selected ? 0 : -1;
    document.querySelector(item.getAttribute('href')).hidden = !selected;
  }
  if (focus) tab.focus();
}
for (const [index, tab] of tabs.entries()) {
  const panel = document.querySelector(tab.getAttribute('href'));
  tab.setAttribute('role', 'tab');
  tab.setAttribute('aria-controls', panel.id);
  panel.setAttribute('role', 'tabpanel');
  panel.setAttribute('aria-labelledby', tab.id);
  panel.tabIndex = 0;
  tab.addEventListener('click', event => { event.preventDefault(); selectTab(tab); });
  tab.addEventListener('keydown', event => {
    const next = { ArrowRight: (index + 1) % tabs.length, ArrowLeft: (index + tabs.length - 1) % tabs.length, Home: 0, End: tabs.length - 1 }[event.key];
    if (next !== undefined) { event.preventDefault(); selectTab(tabs[next], true); }
  });
}
document.body.classList.add('tabs-ready');
selectTab(tabs.find(tab => tab.hash === location.hash) ?? tabs[0]);
addEventListener('hashchange', () => {
  const tab = tabs.find(item => item.hash === location.hash);
  if (tab) selectTab(tab);
});

const container = document.querySelector('#pond');
const controls = document.querySelector('.pond-controls');
const hint = document.querySelector('#pond-hint');
const pause = document.querySelector('#pause-pond');
let pond, disposed = false, offscreen = false, userPaused = matchMedia('(prefers-reduced-motion: reduce)').matches;
function syncMotion() {
  pause.textContent = userPaused ? 'Play motion' : 'Pause motion';
  pause.setAttribute('aria-pressed', String(userPaused));
}
const observer = new IntersectionObserver(entries => {
  offscreen = !entries[0].isIntersecting;
  pond?.setPaused(userPaused || offscreen);
}, { threshold: 0 });
observer.observe(container);
pause.addEventListener('click', () => {
  userPaused = !userPaused;
  pond?.setPaused(userPaused || offscreen);
  syncMotion();
});
document.querySelector('#reset-pond').addEventListener('click', () => pond?.resetView());
container.addEventListener('pond:motionchange', () => {
  userPaused = true;
  syncMotion();
});
addEventListener('pagehide', event => {
  if (event.persisted) return;
  disposed = true; observer.disconnect(); pond?.dispose();
}, { once: true });

// Let the text and poster paint before fetching the optional interactive scene.
async function loadPond() {
  try {
    const { mountPond } = await import('./backdrop/pond/scene.js');
    if (disposed) return;
    pond = mountPond(container, { paused: userPaused || offscreen, pixelRatio: 1.5 });
    await pond.ready;
    if (disposed) return;
    controls.hidden = false;
    hint.textContent = 'Drag to turn the pond.';
    syncMotion();
    container.dataset.ready = 'true';
  } catch {
    pond?.dispose(); pond = undefined;
    controls.hidden = true;
    hint.textContent = 'A little common ground. Showing the still pond.';
    container.dataset.ready = 'fallback';
  }
}
if ('requestIdleCallback' in window) requestIdleCallback(loadPond, { timeout: 1500 });
else setTimeout(loadPond, 100);
