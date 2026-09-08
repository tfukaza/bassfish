const DURATION = 12000;

export function mountFeatureDemos(root = document) {
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const demos = [...root.querySelectorAll('.workflow-demo')].map(element => ({
    element,
    elapsed: 0,
    visible: 0,
    fragments: [...element.querySelectorAll('[data-show-from]')],
  }));
  let raf = 0,
    last = 0,
    disposed = false;
  async function loadFish(demo) {
    if (demo.fishLoading) return;
    demo.fishLoading = true;
    try {
      const { createFeatureFish } = await import('./feature-fish.js');
      const fish = await createFeatureFish(demo.element);
      if (disposed) {
        fish.dispose();
        return;
      }
      demo.fish = fish;
      fish.draw(demo.elapsed / 1000);
    } catch {
      demo.element.dataset.fishReady = 'fallback';
    }
  }
  function render(demo) {
    const phase = demo.elapsed / 3000,
      complete = demo.elapsed >= DURATION;
    for (const e of demo.fragments)
      e.hidden =
        phase < Number(e.dataset.showFrom) ||
        (e.dataset.showUntil !== undefined && phase >= Number(e.dataset.showUntil));
    if (complete || motion.matches) demo.element.dataset.playing = 'false';
    demo.fish?.draw(demo.elapsed / 1000);
    demo.element.dataset.phase = String(Math.min(4, Math.floor(phase)));
    demo.element.dataset.elapsed = String(Math.round(demo.elapsed));
    demo.element.dataset.complete = String(complete);
  }
  function candidate() {
    if (motion.matches || document.hidden) return undefined;
    return demos
      .filter(d => d.visible >= 0.35 && d.elapsed < DURATION)
      .sort((a, b) => b.visible - a.visible)[0];
  }
  function tick(now) {
    raf = 0;
    if (disposed) return;
    const active = candidate();
    demos.forEach(d => {
      d.element.dataset.playing = String(d === active);
    });
    if (!active) {
      last = 0;
      return;
    }
    active.elapsed = Math.min(DURATION, active.elapsed + (last ? Math.min(100, now - last) : 0));
    last = now;
    render(active);
    if (candidate()) raf = requestAnimationFrame(tick);
    else last = 0;
  }
  function schedule() {
    if (!disposed && !raf && candidate()) {
      last = 0;
      raf = requestAnimationFrame(tick);
    }
  }
  const observer = new IntersectionObserver(
    entries => {
      for (const entry of entries) {
        const demo = demos.find(d => d.element === entry.target);
        demo.visible = entry.intersectionRatio;
        if (entry.isIntersecting) loadFish(demo);
      }
      schedule();
    },
    { threshold: [0, 0.2, 0.35, 0.5, 0.75, 1] },
  );
  function preference() {
    for (const demo of demos) {
      if (motion.matches) demo.elapsed = DURATION;
      render(demo);
    }
    schedule();
  }
  for (const demo of demos) {
    observer.observe(demo.element);
  }
  preference();
  const onVisibility = () => {
    last = 0;
    schedule();
  };
  document.addEventListener('visibilitychange', onVisibility);
  motion.addEventListener('change', preference);
  const dispose = () => {
    disposed = true;
    cancelAnimationFrame(raf);
    observer.disconnect();
    demos.forEach(d => d.fish?.dispose());
    document.removeEventListener('visibilitychange', onVisibility);
    motion.removeEventListener('change', preference);
    removeEventListener('pagehide', onPageHide);
  };
  const onPageHide = event => {
    if (!event.persisted) dispose();
  };
  addEventListener('pagehide', onPageHide);
  return { dispose };
}
