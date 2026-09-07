import { mountBassfishBackdrop } from './scene.js';

const params = new URLSearchParams(location.search);
if (params.has('embed')) document.body.classList.add('embed');
const fallback = document.querySelector('#fallback');
try {
  const ocean = mountBassfishBackdrop(document.querySelector('#ocean'));
  // Exposed for the preview's controls and integration smoke checks.
  window.bassfishBackdrop = ocean;
  const copy = document.querySelector('#copy');
  const pause = document.querySelector('#pause');
  const palette = document.querySelector('#palette');
  copy.addEventListener('click', () => {
    const visible = copy.getAttribute('aria-pressed') !== 'true';
    copy.setAttribute('aria-pressed', String(visible));
    document.querySelector('#sample-copy').hidden = !visible;
    document.querySelector('#scene-label').hidden = visible;
    copy.textContent = visible ? 'Scene only' : 'Preview with type';
    ocean.setComposition(visible ? 'hero' : 'scene');
  });
  function syncPause() {
    pause.setAttribute('aria-pressed', String(ocean.paused));
    pause.setAttribute('aria-label', ocean.paused ? 'Play animation' : 'Pause animation');
    document.querySelector('#pause-icon').setAttribute('d', ocean.paused ? 'M3 2l9 5-9 5Z' : 'M4 2v10M10 2v10');
  }
  pause.addEventListener('click', () => { ocean.setPaused(!ocean.paused); syncPause(); });
  syncPause();
  document.querySelector('#signal').addEventListener('click', () => ocean.signal());
  palette.addEventListener('click', () => {
    const moon = palette.getAttribute('aria-pressed') !== 'true';
    palette.setAttribute('aria-pressed', String(moon));
    palette.textContent = moon ? 'Deep water' : 'Moonlight';
    ocean.setPalette(moon ? 'moonlight' : 'deep');
  });
  if (ocean.reducedMotion) document.querySelector('#hint').textContent = 'Motion is paused for your reduced-motion preference.';
  addEventListener('pagehide', () => ocean.dispose(), { once: true });
} catch (error) {
  console.error('Bassfish backdrop:', error);
  fallback.hidden = false;
  document.querySelectorAll('button').forEach(button => { button.disabled = true; });
}
