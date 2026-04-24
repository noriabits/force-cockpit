// @ts-check
// Top-level tab switching (Overview / Utils / Monitoring). Also resets any active
// feature filter in the tab being left so the user sees all content when they return.

(function () {
  const tabBar = /** @type {HTMLElement | null} */ (document.getElementById('tab-bar'));
  if (!tabBar) return;

  tabBar.addEventListener('click', (e) => {
    const btn = /** @type {HTMLElement} */ (e.target);
    if (!btn.classList.contains('tab') || btn.classList.contains('active')) return;

    const tabId = btn.getAttribute('data-tab');
    if (!tabId) return;

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
  });
})();
