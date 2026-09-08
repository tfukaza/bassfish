const DURATION = 12000;

export function mountFeatureDemos(root = document) {
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const demos = [...root.querySelectorAll('.workflow-demo')].map(element => ({
    element, elapsed:0, visible:0, userPaused:false,
    toggle:element.querySelector('[data-demo-toggle]'),
    steps:[...element.querySelectorAll('.demo-steps li')],
    fragments:[...element.querySelectorAll('[data-show-from]')],
    progress:element.querySelector('.demo-progress span'),
  }));
  let raf = 0, last = 0, disposed = false;
  const listeners = [];
  function render(demo) {
    const phase = demo.elapsed / 3000, complete = demo.elapsed >= DURATION;
    for (const e of demo.fragments) e.hidden = phase < Number(e.dataset.showFrom) || (e.dataset.showUntil !== undefined && phase >= Number(e.dataset.showUntil));
    demo.steps.forEach((step, i) => {
      step.classList.toggle('current', !complete && i === Math.min(3, Math.floor(phase)));
      step.classList.toggle('done', complete || i < Math.floor(phase));
    });
    demo.progress.style.transform = `scaleX(${demo.elapsed / DURATION})`;
    demo.toggle.textContent = demo.userPaused ? 'Resume' : 'Pause';
    demo.toggle.setAttribute('aria-label', `${demo.userPaused ? 'Resume' : 'Pause'} ${demo.element.dataset.demo} demo`);
    demo.toggle.disabled = complete;
    demo.element.dataset.phase = String(Math.min(4, Math.floor(phase)));
    demo.element.dataset.elapsed = String(Math.round(demo.elapsed));
    demo.element.dataset.complete = String(complete);
  }
  function candidate() {
    if (motion.matches || document.hidden) return undefined;
    return demos.filter(d => d.visible >= .35 && !d.userPaused && d.elapsed < DURATION).sort((a,b) => b.visible-a.visible)[0];
  }
  function tick(now) {
    raf = 0;
    if (disposed) return;
    const active = candidate();
    if (!active) { last = 0; return; }
    active.elapsed = Math.min(DURATION, active.elapsed + (last ? Math.min(100, now-last) : 0));
    last = now;
    render(active);
    if (candidate()) raf = requestAnimationFrame(tick); else last = 0;
  }
  function schedule() { if (!disposed && !raf && candidate()) { last = 0; raf = requestAnimationFrame(tick); } }
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) demos.find(d => d.element === entry.target).visible = entry.intersectionRatio;
    schedule();
  }, {threshold:[0,.2,.35,.5,.75,1]});
  function preference() {
    for (const demo of demos) {
      demo.element.querySelector('.demo-controls').hidden = motion.matches;
      if (motion.matches) demo.elapsed = DURATION;
      render(demo);
    }
    schedule();
  }
  for (const demo of demos) {
    const onToggle = () => { demo.userPaused = !demo.userPaused; render(demo); schedule(); };
    const onReplay = () => { demo.elapsed = 0; demo.userPaused = false; render(demo); schedule(); };
    demo.toggle.addEventListener('click', onToggle);
    const replay = demo.element.querySelector('[data-demo-replay]');
    replay.addEventListener('click', onReplay);
    listeners.push(() => {demo.toggle.removeEventListener('click', onToggle);replay.removeEventListener('click', onReplay);});
    observer.observe(demo.element);
  }
  preference();
  const onVisibility = () => {last = 0;schedule();};
  document.addEventListener('visibilitychange', onVisibility);
  motion.addEventListener('change', preference);
  const dispose = () => {
    disposed = true;cancelAnimationFrame(raf);observer.disconnect();listeners.forEach(fn => fn());
    document.removeEventListener('visibilitychange', onVisibility);motion.removeEventListener('change', preference);
    removeEventListener('pagehide', onPageHide);
  };
  const onPageHide = event => { if (!event.persisted) dispose(); };
  addEventListener('pagehide', onPageHide);
  return {dispose};
}
