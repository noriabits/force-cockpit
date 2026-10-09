// @ts-check
// Top-level tab switching (Overview / Scripts / SOQL / Monitoring / REST / Debug Logs).
// Also resets any active feature filter in the tab being left so the user sees all
// content when they return.
//
//   - win.__activateTab(tabId) → switch tabs from code, exactly as a click would
//                                (the SOQL results' 🔍 uses it to reach the
//                                Record Detail from wherever it was clicked)

(function () {
  const win = /** @type {any} */ (window);
  const tabBar = /** @type {HTMLElement | null} */ (document.getElementById('tab-bar'));
  if (!tabBar) return;

  function activateTab(/** @type {string} */ tabId) {
    const btn = tabBar?.querySelector('.tab[data-tab="' + CSS.escape(tabId) + '"]');
    if (!tabBar || !btn || btn.classList.contains('active')) return;

    tabBar.querySelectorAll('.tab').forEach((t) => {
      t.classList.remove('active');
      t.setAttribute('aria-selected', 'false');
    });
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');

    // Clear any active filter in the tab we're leaving
    document.querySelectorAll('.tab-content.active .feature-filter-input').forEach((fi) => {
      /** @type {HTMLInputElement} */ (fi).value = '';
      fi.dispatchEvent(new Event('input'));
    });

    document.querySelectorAll('.tab-content').forEach((p) => p.classList.remove('active'));
    const panel = document.getElementById('tab-' + tabId);
    if (panel) panel.classList.add('active');
  }

  tabBar.addEventListener('click', (e) => {
    const btn = /** @type {HTMLElement} */ (e.target);
    if (!btn.classList.contains('tab')) return;
    const tabId = btn.getAttribute('data-tab');
    if (tabId) activateTab(tabId);
  });

  win.__activateTab = activateTab;
})();
