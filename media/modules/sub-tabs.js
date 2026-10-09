// @ts-check
// The ONE sub-tab switcher, shared by every sub-tab bar in the panel (Scripts,
// SOQL, Plugins).
//
//   - win.__createSubTabs(opts)       → { activate(id) } — wires one bar
//   - win.__activateSubTab(barId, id) → switch a bar from outside it (e.g. the
//                                       SOQL results' 🔍 jumping to the Record
//                                       Detail)
//
// Extracted when the SOQL tab became the third bar: utils-subtab.js and
// plugin-api.js each carried a ~15-line copy, and plugin-api.js's own comment
// named the third consumer as the point to stop copying.
//
// Each bar keeps its own class names (the paired selectors in media/main.css
// style them identically), so a panel is only ever looked up through its own
// bar's classes — one bar can never deactivate another bar's panels.
//
// Load order: before utils-subtab.js and plugin-api.js, which call it at load.

(function () {
  const win = /** @type {any} */ (window);

  /** @type {Map<string, (id: string) => void>} */
  const byBarId = new Map();

  /**
   * @param {{
   *   bar: HTMLElement,
   *   tabClass: string,
   *   tabAttr: string,
   *   panelClass: string,
   *   panelPrefix: string,
   * }} opts
   */
  function createSubTabs({ bar, tabClass, tabAttr, panelClass, panelPrefix }) {
    function activate(/** @type {string} */ id) {
      bar.querySelectorAll('.' + tabClass).forEach((t) => t.classList.remove('active'));
      bar
        .querySelector('.' + tabClass + '[' + tabAttr + '="' + CSS.escape(id) + '"]')
        ?.classList.add('active');
      document.querySelectorAll('.' + panelClass).forEach((p) => p.classList.remove('active'));
      document.getElementById(panelPrefix + id)?.classList.add('active');
    }

    bar.addEventListener('click', (e) => {
      const btn = /** @type {HTMLElement} */ (e.target);
      if (!btn.classList.contains(tabClass) || btn.classList.contains('active')) return;
      const id = btn.getAttribute(tabAttr);
      if (id) activate(id);
    });

    if (bar.id) byBarId.set(bar.id, activate);
    return { activate };
  }

  win.__createSubTabs = createSubTabs;
  win.__activateSubTab = (/** @type {string} */ barId, /** @type {string} */ id) =>
    byBarId.get(barId)?.(id);

  // ── The SOQL tab's bar (⚡ Query | 🔎 Record Detail) ──────────────────
  // Static markup in main.html with no module of its own, so it is wired here.
  const soqlBar = document.getElementById('soql-sub-tab-bar');
  if (soqlBar) {
    createSubTabs({
      bar: soqlBar,
      tabClass: 'soql-sub-tab',
      tabAttr: 'data-soql-tab',
      panelClass: 'soql-sub-tab-panel',
      panelPrefix: 'soql-sub-tab-',
    });
  }
})();
