// @ts-check
// Utils tab — sub-tab switching (Scripts / Built-in / Logs) and the combined
// text + category filter for the Built-in sub-tab.

(function () {
  // ── Sub-tab switching ───────────────────────────────────────────────────
  const utilsSubTabBar = document.querySelector('.utils-sub-tab-bar');
  if (utilsSubTabBar) {
    utilsSubTabBar.addEventListener('click', (e) => {
      const btn = /** @type {HTMLElement} */ (e.target);
      if (!btn.classList.contains('utils-sub-tab') || btn.classList.contains('active')) return;
      const subTabId = btn.getAttribute('data-utils-tab');
      if (!subTabId) return;
      utilsSubTabBar
        .querySelectorAll('.utils-sub-tab')
        .forEach((t) => t.classList.remove('active'));
      btn.classList.add('active');
      document
        .querySelectorAll('.utils-sub-tab-panel')
        .forEach((p) => p.classList.remove('active'));
      const panel = document.getElementById('utils-sub-tab-' + subTabId);
      if (panel) panel.classList.add('active');
    });
  }

  // ── Built-in sub-tab: combined text + category filter ──────────────────
  const panel = /** @type {HTMLElement | null} */ (
    document.getElementById('utils-sub-tab-built-in')
  );
  const searchInput = /** @type {HTMLInputElement | null} */ (
    document.getElementById('utils-builtin-search')
  );
  const pillsContainer = /** @type {HTMLElement | null} */ (
    document.getElementById('utils-builtin-pills')
  );
  if (!panel || !searchInput || !pillsContainer) return;

  let activeCategory = 'all';

  const noResults = document.createElement('div');
  noResults.className = 'feature-no-results';
  noResults.textContent = 'No matching features found.';
  panel.appendChild(noResults);

  function applyFilters() {
    const query = searchInput.value.toLowerCase().trim();
    const sections = panel.querySelectorAll('.accordion');
    let visible = 0;

    sections.forEach((el) => {
      const section = /** @type {HTMLElement} */ (el);
      const category = section.getAttribute('data-category') ?? '';
      const categoryMatch = activeCategory === 'all' || category === activeCategory;
      const textMatch = !query || (section.textContent || '').toLowerCase().includes(query);
      const show = categoryMatch && textMatch;
      section.style.display = show ? '' : 'none';
      if (show) visible++;
    });

    noResults.style.display = visible === 0 ? 'block' : 'none';
  }

  /**
   * @param {string} category
   * @param {HTMLButtonElement} activePill
   */
  function setActiveCategory(category, activePill) {
    activeCategory = category;
    pillsContainer.querySelectorAll('.category-pill').forEach((p) => {
      p.classList.toggle('active', p === activePill);
    });
    applyFilters();
  }

  const accordions = panel.querySelectorAll('.accordion[data-category]');
  const categories = /** @type {string[]} */ ([
    ...new Set([...accordions].map((a) => a.getAttribute('data-category'))),
  ]).sort();

  if (categories.length > 0) {
    const allPill = /** @type {HTMLButtonElement} */ (document.createElement('button'));
    allPill.className = 'category-pill active';
    allPill.textContent = 'All';
    allPill.addEventListener('click', () => setActiveCategory('all', allPill));
    pillsContainer.appendChild(allPill);

    for (const cat of categories) {
      const pill = /** @type {HTMLButtonElement} */ (document.createElement('button'));
      pill.className = 'category-pill';
      pill.textContent = cat;
      pill.addEventListener('click', () => setActiveCategory(cat, pill));
      pillsContainer.appendChild(pill);
    }
  }

  searchInput.addEventListener('input', applyFilters);
})();
