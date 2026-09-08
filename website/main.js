import { STORY_END, stillProgress } from './story-timing.js';
import { createTerminalStory } from './terminal-story.js';
import { mountFeatureDemos } from './feature-demos.js';

mountFeatureDemos();

const status = document.querySelector('#copy-status');
let statusTimer;
function announce(message) {
  clearTimeout(statusTimer);
  status.textContent = message;
  statusTimer = setTimeout(() => {
    status.textContent = '';
  }, 4500);
}

for (const button of document.querySelectorAll('[data-copy], [data-copy-url]')) {
  button.hidden = false;
  button.addEventListener('click', async () => {
    const value = button.dataset.copyUrl
      ? new URL(button.dataset.copyUrl, new URL('./', location.href)).href
      : document.getElementById(button.dataset.copy).textContent.trim();
    try {
      await navigator.clipboard.writeText(value);
      announce(
        button.dataset.copyUrl
          ? 'Setup link copied. Paste it into your agent’s chat.'
          : 'Copied to clipboard.',
      );
    } catch {
      // Keep the link or commands visible and selectable when clipboard access is unavailable.
      const target = button.dataset.copyUrl
        ? document.querySelector('.guide-url')
        : document.getElementById(button.dataset.copy);
      if (button.dataset.copyUrl) {
        target.textContent = value;
        target.href = value;
      }
      const selection = getSelection(),
        range = document.createRange();
      range.selectNodeContents(target);
      selection.removeAllRanges();
      selection.addRange(range);
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
  tab.addEventListener('click', event => {
    event.preventDefault();
    selectTab(tab);
  });
  tab.addEventListener('keydown', event => {
    const next = {
      ArrowRight: (index + 1) % tabs.length,
      ArrowLeft: (index + tabs.length - 1) % tabs.length,
      Home: 0,
      End: tabs.length - 1,
    }[event.key];
    if (next !== undefined) {
      event.preventDefault();
      selectTab(tabs[next], true);
    }
  });
}
document.body.classList.add('tabs-ready');
selectTab(tabs.find(tab => tab.hash === location.hash) ?? tabs[0]);
addEventListener('hashchange', () => {
  const tab = tabs.find(item => item.hash === location.hash);
  if (tab) selectTab(tab);
});

const storySection = document.querySelector('#story'),
  container = document.querySelector('#pond');
const bodyCopy = document.querySelector('#chapter-body'),
  chapterTitle = document.querySelector('#chapter-title');
const heading = document.querySelector('.chapter-heading'),
  landing = document.querySelector('.landing-title');
const terminalLayer = document.querySelector('.terminal-layer'),
  updateTerminals = createTerminalStory(terminalLayer, container);
storySection.dataset.end = String(STORY_END);
const bubbles = [...document.querySelectorAll('.fish-bubble')];
const leaders = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
leaders.classList.add('bubble-leaders');
const leaderPaths = bubbles.map(() => {
  const path = document.createElementNS(leaders.namespaceURI, 'path');
  leaders.appendChild(path);
  return path;
});
document.querySelector('.bubble-layer').prepend(leaders);
const motion = matchMedia('(prefers-reduced-motion: reduce)');
let pond,
  disposed = false,
  userPaused = motion.matches,
  offscreen = false,
  scrollFrame = 0;
let currentProgress = 0,
  currentChapter = -1;
document.body.classList.add('story-enhanced');

function updateScroll() {
  scrollFrame = 0;
  const rect = storySection.getBoundingClientRect();
  currentProgress = Math.max(
    0,
    Math.min(STORY_END, (-rect.top / (storySection.offsetHeight - innerHeight)) * STORY_END),
  );
  pond?.setStoryProgress(motion.matches ? stillProgress(currentProgress) : currentProgress);
}
function scheduleScroll() {
  if (!scrollFrame) scrollFrame = requestAnimationFrame(updateScroll);
}
addEventListener('scroll', scheduleScroll, { passive: true });
addEventListener('resize', scheduleScroll);
container.addEventListener('pond:motionchange', () => {
  userPaused = true;
});
motion.addEventListener('change', () => {
  userPaused = motion.matches;
  pond?.setPaused(userPaused || offscreen);
  scheduleScroll();
});
for (const link of document.querySelectorAll('a[href="#install"]'))
  link.addEventListener('click', event => {
    event.preventDefault();
    const target = document.querySelector('#install');
    history.replaceState(null, '', '#install');
    target.tabIndex = -1;
    target.scrollIntoView({ behavior: 'instant' });
    target.focus({ preventScroll: true });
  });
const observer = new IntersectionObserver(
  entries => {
    offscreen = !entries[0].isIntersecting;
    pond?.setPaused(userPaused || offscreen);
  },
  { threshold: 0 },
);
observer.observe(container);
addEventListener(
  'pagehide',
  event => {
    if (event.persisted) return;
    disposed = true;
    cancelAnimationFrame(scrollFrame);
    observer.disconnect();
    pond?.dispose();
    removeEventListener('scroll', scheduleScroll);
    removeEventListener('resize', scheduleScroll);
    motion.removeEventListener('change', scheduleScroll);
  },
  { once: true },
);

async function loadStory() {
  try {
    const [{ mountPond }, { createPondStory, chapters }] = await Promise.all([
      import('./backdrop/pond/scene.js'),
      import('./story-scene.js'),
    ]);
    await document.fonts.ready;
    if (disposed) return;
    pond = mountPond(container, {
      paused: userPaused || offscreen,
      pixelRatio: 1.35,
      storyEnd: STORY_END,
      createStory: createPondStory(frame => {
        if (frame.chapter !== currentChapter) {
          currentChapter = frame.chapter;
          storySection.dataset.chapter = String(frame.chapter);
          chapterTitle.textContent = frame.chapter ? chapters[frame.chapter].title : '';
          bodyCopy.textContent = frame.chapter ? chapters[frame.chapter].body : '';
          bodyCopy.hidden = !bodyCopy.textContent;
        }
        heading.style.transform = `translateY(${motion.matches ? 0 : frame.textY}px)`;
        heading.style.opacity = motion.matches ? '1' : String(frame.textOpacity);
        landing.style.transform = `translateY(${motion.matches ? 0 : frame.heroY}px)`;
        landing.style.opacity = motion.matches ? '1' : String(frame.heroOpacity);
        updateTerminals(frame);
        const placed = [];
        for (let i = 0; i < bubbles.length; i++) {
          const bubble = bubbles[i],
            data = frame.bubbles[i];
          leaderPaths[i].setAttribute('d', '');
          bubble.classList.toggle('visible', data.visible);
          bubble.classList.toggle('subagent-bubble', Boolean(data.subagent));
          if (!data.visible) continue;
          const viewport = `${container.clientWidth}/${container.clientHeight}`;
          if (
            bubble.querySelector('p').textContent !== data.text ||
            bubble.dataset.viewport !== viewport
          ) {
            bubble.querySelector('p').textContent = data.text;
            bubble.querySelector('span').textContent = data.agent;
            bubble.dataset.viewport = viewport;
            bubble.dataset.width = String(bubble.offsetWidth);
            bubble.dataset.height = String(bubble.offsetHeight);
          }
          const width = Number(bubble.dataset.width),
            height = Number(bubble.dataset.height),
            anchor = data.x * container.clientWidth;
          const left = Math.max(width / 2 + 16, Math.min(innerWidth - width / 2 - 16, anchor));
          let top = data.y * container.clientHeight;
          // Keep short activity bubbles distinct while their fish overlap in projection.
          for (const other of placed)
            if (
              Math.abs(left - other.left) < (width + other.width) / 2 + 8 &&
              top - height < other.top + 8 &&
              top > other.top - other.height - 8
            )
              top = other.top - other.height - 10;
          top = Math.max(height + 35, Math.min(container.clientHeight - 45, top));
          placed.push({ left, top, width, height });
          bubble.style.left = `${left}px`;
          bubble.style.top = `${top}px`;
          bubble.style.setProperty(
            '--tail-x',
            `${Math.max(12, Math.min(width - 12, anchor - left + width / 2)) - 5}px`,
          );
          if (data.subagent && Math.abs(top - data.y * container.clientHeight) > 15) {
            const tip = left + Math.max(-width / 2 + 12, Math.min(width / 2 - 12, anchor - left));
            leaderPaths[i].setAttribute(
              'd',
              `M ${tip} ${top - 9} L ${anchor} ${data.y * container.clientHeight - 3}`,
            );
          }
        }
      }),
    });
    updateScroll();
    await pond.ready;
    if (disposed) return;
    window.bassfishStory = pond;
    document.body.classList.add('story-ready');
    container.dataset.ready = 'true';
    if (location.hash === '#install') document.querySelector('#install').scrollIntoView();
    updateScroll();
  } catch {
    pond?.dispose();
    pond = undefined;
    observer.disconnect();
    terminalLayer.hidden = true;
    container.style.opacity = '1';
    document.body.classList.remove('story-enhanced', 'story-ready');
    container.dataset.ready = 'fallback';
  }
}
if ('requestIdleCallback' in window) requestIdleCallback(loadStory, { timeout: 1000 });
else setTimeout(loadStory, 60);
