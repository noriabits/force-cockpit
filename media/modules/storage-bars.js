// @ts-check
// Renders the Data Storage + File Storage usage bars on the Overview tab from
// the `storageLimits` message posted by MainPanel._sendStorageLimits.

(function () {
  const win = /** @type {any} */ (window);

  const storageCard = /** @type {HTMLElement} */ (document.getElementById('storage-card'));
  const storageDataValue = /** @type {HTMLElement} */ (
    document.getElementById('storage-data-value')
  );
  const storageDataBar = /** @type {HTMLElement} */ (document.getElementById('storage-data-bar'));
  const storageFileValue = /** @type {HTMLElement} */ (
    document.getElementById('storage-file-value')
  );
  const storageFileBar = /** @type {HTMLElement} */ (document.getElementById('storage-file-bar'));

  /**
   * Format a MB value: show as KB when under 1 MB, otherwise MB.
   * @param {number} mb
   */
  function formatStorageMB(mb) {
    if (mb < 1 && mb > 0) return Math.round(mb * 1024) + ' KB';
    return mb + ' MB';
  }

  /**
   * @param {{
   *   DataStorageMB: { Max: number, Remaining: number },
   *   FileStorageMB: { Max: number, Remaining: number },
   * }} limits
   */
  function renderStorage(limits) {
    const data = limits.DataStorageMB;
    const file = limits.FileStorageMB;
    const dataUsed = data.Max - data.Remaining;
    const fileUsed = file.Max - file.Remaining;
    const dataPct = data.Max > 0 ? Math.round((dataUsed / data.Max) * 100) : 0;
    const filePct = file.Max > 0 ? Math.round((fileUsed / file.Max) * 100) : 0;

    storageDataValue.textContent =
      formatStorageMB(dataUsed) + ' / ' + formatStorageMB(data.Max) + ' (' + dataPct + '%)';
    storageDataBar.style.width = (dataUsed > 0 ? Math.max(dataPct, 1) : 0) + '%';
    storageDataBar.classList.toggle('storage-bar-warn', dataPct >= 75 && dataPct < 90);
    storageDataBar.classList.toggle('storage-bar-critical', dataPct >= 90);

    storageFileValue.textContent =
      formatStorageMB(fileUsed) + ' / ' + formatStorageMB(file.Max) + ' (' + filePct + '%)';
    storageFileBar.style.width = (fileUsed > 0 ? Math.max(filePct, 1) : 0) + '%';
    storageFileBar.classList.toggle('storage-bar-warn', filePct >= 75 && filePct < 90);
    storageFileBar.classList.toggle('storage-bar-critical', filePct >= 90);

    storageCard.style.display = '';
  }

  win.__onMessage('storageLimits', (/** @type {any} */ msg) => renderStorage(msg.data));
})();
