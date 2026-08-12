// @ts-check
// Webview-side describe cache + request coalescing for SOQL autocomplete. Posts
// describeGlobal / describeSObject to the host and resolves the returned promise
// when the matching result message arrives. Caches resolved projections so a
// relationship walk (Account → Owner → User) only hits the host once per object.

/**
 * @typedef {Object} DescribeCacheCtx
 * @property {{ postMessage: (msg: any) => void }} vscode
 */

/** @param {DescribeCacheCtx} ctx */
export function createDescribeCache(ctx) {
  const { vscode } = ctx;

  /** @type {any} */
  let globalValue = null;
  /** @type {Promise<any> | null} */
  let globalPromise = null;
  /** @type {((v: any) => void) | null} */
  let globalResolve = null;

  /** @type {Map<string, any>} */
  const sobjectValues = new Map();
  /** @type {Map<string, { promise: Promise<any>, resolve: (v: any) => void }>} */
  const sobjectPending = new Map();

  function getGlobal() {
    if (globalValue) return Promise.resolve(globalValue);
    if (globalPromise) return globalPromise;
    globalPromise = new Promise((resolve) => {
      globalResolve = resolve;
    });
    vscode.postMessage({ type: 'describeGlobal' });
    return globalPromise;
  }

  /** @param {string} name */
  function getSObject(name) {
    const key = name.toLowerCase();
    if (sobjectValues.has(key)) return Promise.resolve(sobjectValues.get(key));
    const pending = sobjectPending.get(key);
    if (pending) return pending.promise;
    /** @type {(v: any) => void} */
    let resolveFn = () => {};
    const promise = new Promise((resolve) => {
      resolveFn = resolve;
    });
    sobjectPending.set(key, { promise, resolve: resolveFn });
    vscode.postMessage({ type: 'describeSObject', name });
    return promise;
  }

  // ── Message intake (called from index.js handlers) ───────────────────────────
  /** @param {any} data */
  function onGlobalResult(data) {
    globalValue = data;
    if (globalResolve) {
      globalResolve(data);
      globalResolve = null;
    }
  }

  /** @param {string} name @param {any} data */
  function onSObjectResult(name, data) {
    const key = name.toLowerCase();
    sobjectValues.set(key, data);
    const pending = sobjectPending.get(key);
    if (pending) {
      pending.resolve(data);
      sobjectPending.delete(key);
    }
  }

  /** Unblock any pending request on error so the UI doesn't hang. @param {any} data */
  function onError(data) {
    if (data && data.name) {
      const key = String(data.name).toLowerCase();
      const pending = sobjectPending.get(key);
      if (pending) {
        pending.resolve(null);
        sobjectPending.delete(key);
      }
    } else if (globalResolve) {
      globalResolve(null);
      globalResolve = null;
      globalPromise = null;
    }
  }

  function clear() {
    globalValue = null;
    globalPromise = null;
    globalResolve = null;
    sobjectValues.clear();
    sobjectPending.clear();
  }

  return { getGlobal, getSObject, onGlobalResult, onSObjectResult, onError, clear };
}
