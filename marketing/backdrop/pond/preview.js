import { mountPond } from './scene.js';

if (new URLSearchParams(location.search).has('embed')) document.body.classList.add('embed');
let pond;
try {
  pond = mountPond(document.querySelector('#pond'));
  await pond.ready;
  window.bassfishPond = pond;
  const pause = document.querySelector('#pause');
  function sync() {
    pause.setAttribute('aria-pressed', String(pond.paused));
    pause.setAttribute('aria-label', pond.paused ? 'Play animation' : 'Pause animation');
    document
      .querySelector('#pause-icon')
      .setAttribute('d', pond.paused ? 'M2 1l9 5-9 5Z' : 'M3 1v10M9 1v10');
  }
  pause.addEventListener('click', () => {
    pond.setPaused(!pond.paused);
    sync();
  });
  document.querySelector('#signal').addEventListener('click', () => pond.signal());
  document.querySelector('#reset').addEventListener('click', () => pond.resetView());
  document.querySelector('#pond').addEventListener('pond:motionchange', sync);
  sync();
  if (pond.reducedMotion)
    document.querySelector('#hint').textContent = 'Motion paused. Drag to look around.';
  addEventListener('pagehide', () => pond.dispose(), { once: true });
} catch (error) {
  pond?.dispose();
  console.error('Pond preview:', error);
  document.querySelector('#fallback').hidden = false;
  document.querySelectorAll('button').forEach(button => (button.disabled = true));
}
