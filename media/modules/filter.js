// @ts-check
// Generic feature filter: each .feature-filter-input filters accordions and cards
// in the nearest .utils-sub-tab-panel or .tab-content ancestor by substring match.
// Inputs with data-no-generic-filter are owned by a dedicated filter module (e.g.
// utils-subtab.js) and skipped here.

(function () {
  document.querySelectorAll('.feature-filter-input').forEach((input) => {
    if (input.hasAttribute('data-no-generic-filter')) return;

    const tabContent = /** @type {HTMLElement | null} */ (
      input.closest('.utils-sub-tab-panel') || input.closest('.tab-content')
    );
    if (!tabContent) return;

    const noResults = document.createElement('div');
    noResults.className = 'feature-no-results';
    noResults.textContent = 'No matching features found.';
    tabContent.appendChild(noResults);

    input.addEventListener('input', () => {
      const query = /** @type {HTMLInputElement} */ (input).value.toLowerCase().trim();
      const sections = tabContent.querySelectorAll('.accordion, .card:not(:first-of-type)');
      let visibleCount = 0;

      sections.forEach((section) => {
        if (section.closest('.feature-filter')) return;
        const text = (section.textContent || '').toLowerCase();
        const matches = !query || text.includes(query);
        /** @type {HTMLElement} */ (section).style.display = matches ? '' : 'none';
        if (matches) visibleCount++;
      });

      noResults.style.display = visibleCount === 0 && query ? 'block' : 'none';
    });
  });
})();
