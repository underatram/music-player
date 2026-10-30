// Text too long for its space scrolls back and forth while you hover over its
// row, or while the row has keyboard focus.
(() => {
  const CONTAINERS = '.row, .filter, .playlist, .display';
  const TEXT = '.row > span, .filter-title, .playlist-label, .now-title, .now-detail';
  const PIXELS_PER_SECOND = 45;
  const MIN_SECONDS = 2;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  let activeContainer = null;
  let scrolling = [];

  function start(container) {
    if (reducedMotion.matches) return;
    for (const node of container.querySelectorAll(TEXT)) {
      const distance = node.scrollWidth - node.clientWidth;
      if (distance <= 1) continue;

      const inner = document.createElement('span');
      inner.className = 'marquee-text';
      inner.textContent = node.textContent;
      inner.style.setProperty('--marquee-distance', `${-distance}px`);
      inner.style.setProperty('--marquee-seconds', `${Math.max(MIN_SECONDS, distance / PIXELS_PER_SECOND)}s`);
      node.replaceChildren(inner);
      node.classList.add('marquee');
      scrolling.push(node);
    }
  }

  function stop() {
    for (const node of scrolling) {
      node.classList.remove('marquee');
      // The text may have been replaced in the meantime, such as a new song title.
      const inner = node.querySelector(':scope > .marquee-text');
      if (inner) node.replaceChildren(inner.textContent);
    }
    scrolling = [];
  }

  function moveTo(container) {
    if (container === activeContainer) return;
    stop();
    activeContainer = container;
    if (container) start(container);
  }

  document.addEventListener('mouseover', (event) => moveTo(event.target.closest(CONTAINERS)));
  document.addEventListener('focusin', (event) => moveTo(event.target.closest(CONTAINERS)));
  document.documentElement.addEventListener('mouseleave', () => moveTo(null));
})();
