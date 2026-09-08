const status = document.querySelector('#copy-status');
let statusTimer;

for (const button of document.querySelectorAll('[data-copy]')) {
  button.hidden = false;
  button.addEventListener('click', async () => {
    const target = document.getElementById(button.dataset.copy);
    if (!target) return;
    const original = button.textContent;
    try {
      await navigator.clipboard.writeText(target.textContent);
      button.textContent = 'Copied';
      status.textContent = 'Copied to clipboard';
      status.classList.add('visible');
      clearTimeout(statusTimer);
      statusTimer = setTimeout(() => status.classList.remove('visible'), 1800);
      setTimeout(() => {
        button.textContent = original;
      }, 1800);
    } catch {
      status.textContent = 'Copy failed. Select the text manually';
      status.classList.add('visible');
      clearTimeout(statusTimer);
      statusTimer = setTimeout(() => status.classList.remove('visible'), 2400);
    }
  });
}

const navLinks = [...document.querySelectorAll('.docs-sidebar a[href^="#"]')];
const sections = navLinks.map(link => document.querySelector(link.hash)).filter(Boolean);
const markActive = id => {
  for (const link of navLinks) {
    if (link.hash === `#${id}`) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  }
};

if ('IntersectionObserver' in window) {
  const visible = new Map();
  const observer = new IntersectionObserver(
    entries => {
      for (const entry of entries) visible.set(entry.target.id, entry);
      const current = [...visible.values()]
        .filter(entry => entry.isIntersecting)
        .sort(
          (a, b) =>
            Math.abs(a.boundingClientRect.top - 125) - Math.abs(b.boundingClientRect.top - 125),
        )[0];
      if (current) markActive(current.target.id);
    },
    { rootMargin: '-110px 0px -68% 0px', threshold: [0, 0.1] },
  );
  for (const section of sections) observer.observe(section);
}

markActive(location.hash.slice(1) || 'overview');
addEventListener('hashchange', () => markActive(location.hash.slice(1) || 'overview'));
