// @ts-check
// Clone User — feature webview script
// Runs inside the VSCode webview. Uses window.__vscode (set by main.js) for postMessage.
// Registers with the feature message bus via window.__registerFeature().
// All user-facing strings are sourced from window.CloneUserLabels (set by labels.js).

(function () {
  // Cast window to any to access extension-defined globals (__vscode, __registerFeature,
  // CloneUserLabels) that TypeScript does not know about on Window.
  const win = /** @type {any} */ (window);
  const L = win.CloneUserLabels;

  // ── DOM refs ──────────────────────────────────────────────────────────────
  const cloneSearchInput = /** @type {HTMLInputElement} */ (
    document.getElementById('clone-user-search')
  );
  const btnCloneSearch = /** @type {HTMLButtonElement} */ (
    document.getElementById('btn-clone-search')
  );
  const cloneSearchResults = /** @type {HTMLElement} */ (
    document.getElementById('clone-search-results')
  );
  const cloneSearchTbody = /** @type {HTMLElement} */ (
    document.getElementById('clone-search-tbody')
  );
  const cloneSelectedUser = /** @type {HTMLElement} */ (
    document.getElementById('clone-selected-user')
  );
  const cloneSelectedLabel = /** @type {HTMLElement} */ (
    document.getElementById('clone-selected-label')
  );
  const btnCloneClearSource = /** @type {HTMLButtonElement} */ (
    document.getElementById('btn-clone-clear-source')
  );
  const cloneSearchError = /** @type {HTMLElement} */ (
    document.getElementById('clone-search-error')
  );
  const cloneFirstName = /** @type {HTMLInputElement} */ (
    document.getElementById('clone-first-name')
  );
  const cloneLastName = /** @type {HTMLInputElement} */ (
    document.getElementById('clone-last-name')
  );
  const cloneEmail = /** @type {HTMLInputElement} */ (document.getElementById('clone-email'));
  const cloneGenUsername = /** @type {HTMLElement} */ (
    document.getElementById('clone-generated-username')
  );
  const btnCloneExecute = /** @type {HTMLButtonElement} */ (
    document.getElementById('btn-clone-execute')
  );
  const cloneStatus = /** @type {HTMLElement} */ (document.getElementById('clone-status'));
  const cloneResult = /** @type {HTMLElement} */ (document.getElementById('clone-result'));
  const cloneError = /** @type {HTMLElement} */ (document.getElementById('clone-error'));

  // Apply labels to static elements
  btnCloneSearch.textContent = L.btnSearch;
  btnCloneClearSource.textContent = L.btnChange;
  btnCloneExecute.textContent = L.btnCloneUser;
  cloneSearchInput.placeholder = L.placeholderSearch;
  cloneFirstName.placeholder = L.placeholderFirstName;
  cloneLastName.placeholder = L.placeholderLastName;
  cloneEmail.placeholder = L.placeholderEmail;
  cloneGenUsername.textContent = L.placeholderUsername;

  // ── State ─────────────────────────────────────────────────────────────────
  let connected = false;
  /** @type {{ sandboxName?: string, isProtectedOrg?: boolean, [key: string]: any } | null} */
  let currentOrg = null;
  /** @type {string | null} */
  let selectedSourceUserId = null;

  // ── Helpers ───────────────────────────────────────────────────────────────
  /** @param {unknown} str @returns {string} */
  function escapeHtml(str) {
    if (str == null) return '<em style="opacity:0.5">null</em>';
    return win.__escapeHtml(str);
  }

  function updateGeneratedUsername() {
    const email = cloneEmail.value.trim();
    if (!email) {
      cloneGenUsername.textContent = L.placeholderUsername;
      return;
    }
    if (currentOrg && currentOrg.sandboxName) {
      cloneGenUsername.textContent = email + '.b2b.' + currentOrg.sandboxName;
    } else {
      cloneGenUsername.textContent = email + '.b2b';
    }
    updateCloneButton();
  }

  function updateCloneButton() {
    const hasSource = !!selectedSourceUserId;
    const hasFirst = !!cloneFirstName.value.trim();
    const hasLast = !!cloneLastName.value.trim();
    const hasEmail = !!cloneEmail.value.trim();
    btnCloneExecute.disabled = !(connected && hasSource && hasFirst && hasLast && hasEmail);
  }

  /**
   * @param {string} userId
   * @param {string} name
   * @param {string} email
   */
  function selectSourceUser(userId, name, email) {
    selectedSourceUserId = userId;
    cloneSelectedLabel.textContent = name + ' (' + email + ')';
    cloneSelectedUser.style.display = '';
    cloneSearchResults.style.display = 'none';
    cloneSearchError.textContent = '';
    cloneSearchError.style.display = 'none';
    updateCloneButton();
  }

  function clearSourceUser() {
    selectedSourceUserId = null;
    cloneSelectedUser.style.display = 'none';
    cloneSearchResults.style.display = 'none';
    updateCloneButton();
  }

  // ── Event listeners ───────────────────────────────────────────────────────
  btnCloneSearch.addEventListener('click', () => {
    const term = cloneSearchInput.value.trim();
    if (!term) return;
    if (!connected) {
      cloneSearchError.textContent = L.errorNotConnected;
      cloneSearchError.style.display = '';
      return;
    }
    btnCloneSearch.disabled = true;
    cloneSearchError.textContent = '';
    cloneSearchError.style.display = 'none';
    cloneSearchResults.style.display = 'none';
    win.__vscode.postMessage({ type: 'cloneUserSearch', searchTerm: term });
  });

  cloneSearchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      btnCloneSearch.click();
    }
  });

  btnCloneClearSource.addEventListener('click', () => {
    clearSourceUser();
  });

  cloneEmail.addEventListener('input', updateGeneratedUsername);
  cloneFirstName.addEventListener('input', updateCloneButton);
  cloneLastName.addEventListener('input', updateCloneButton);

  /** @type {string | null} */
  let _cloneOpId = null;

  btnCloneExecute.addEventListener('click', () => {
    if (!connected || !selectedSourceUserId) return;
    const firstName = cloneFirstName.value.trim();
    const lastName = cloneLastName.value.trim();
    const email = cloneEmail.value.trim();
    if (!firstName || !lastName || !email) return;

    win.__confirmIfSensitive(
      currentOrg,
      'Execute this action?',
      () => {
        cloneStatus.textContent = L.statusCloning;
        cloneResult.textContent = '';
        cloneResult.style.display = 'none';
        cloneError.textContent = '';
        cloneError.style.display = 'none';
        _cloneOpId = win.__startAction(btnCloneExecute, () => {
          cloneStatus.textContent = '';
        });
        win.__vscode.postMessage({
          type: 'cloneUser',
          sourceUserId: selectedSourceUserId,
          firstName: firstName,
          lastName: lastName,
          email: email,
          opId: _cloneOpId,
        });
      },
      () => {
        updateCloneButton();
      },
    );
  });

  // ── Feature registration ──────────────────────────────────────────────────
  win.__registerFeature('clone-user', {
    /** @param {{ sandboxName?: string, isProtectedOrg?: boolean, [key: string]: any }} org */
    onOrgConnected: function (org) {
      connected = true;
      currentOrg = org;
      updateGeneratedUsername();
      updateCloneButton();
    },
    onOrgDisconnected: function () {
      connected = false;
      currentOrg = null;
      selectedSourceUserId = null;
      updateCloneButton();
    },
    /** @param {{ type: string, data: any }} message */
    onMessage: function (message) {
      switch (message.type) {
        case 'cloneUserSearchResult': {
          btnCloneSearch.disabled = false;
          cloneSearchError.textContent = '';
          cloneSearchError.style.display = 'none';
          const users = message.data.records || [];
          cloneSearchTbody.innerHTML = '';
          if (users.length === 0) {
            cloneSearchError.textContent = L.errorNoUsersFound;
            cloneSearchError.style.display = '';
            cloneSearchResults.style.display = 'none';
            return;
          }
          for (const u of users) {
            const row = document.createElement('tr');
            row.innerHTML =
              '<td>' +
              escapeHtml(u.Name) +
              '</td>' +
              '<td>' +
              escapeHtml(u.Email) +
              '</td>' +
              '<td>' +
              escapeHtml(u.ProfileName || '\u2014') +
              '</td>' +
              '<td></td>';
            const selectBtn = document.createElement('button');
            selectBtn.className = 'btn btn-ghost btn-select';
            selectBtn.textContent = L.btnSelect;
            selectBtn.addEventListener('click', () => selectSourceUser(u.Id, u.Name, u.Email));
            const lastCell = /** @type {HTMLElement} */ (row.lastElementChild);
            lastCell.appendChild(selectBtn);
            cloneSearchTbody.appendChild(row);
          }
          cloneSearchResults.style.display = '';
          break;
        }
        case 'cloneUserSearchError':
          btnCloneSearch.disabled = false;
          cloneSearchResults.style.display = 'none';
          cloneSearchError.textContent = message.data.message;
          cloneSearchError.style.display = '';
          break;

        case 'cloneUserResult':
          win.__endAction(_cloneOpId);
          _cloneOpId = null;
          cloneStatus.textContent = '';
          cloneError.textContent = '';
          cloneError.style.display = 'none';
          cloneResult.textContent = message.data.message;
          cloneResult.style.display = '';
          break;

        case 'cloneUserError':
          win.__endAction(_cloneOpId);
          _cloneOpId = null;
          cloneStatus.textContent = '';
          cloneResult.textContent = '';
          cloneResult.style.display = 'none';
          cloneError.textContent = message.data.message;
          cloneError.style.display = '';
          break;
      }
    },
  });
})();
