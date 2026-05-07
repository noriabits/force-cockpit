// @ts-check
// Pure log/JSON rendering helpers for the YAML scripts log viewer.
// All functions take strings/values and return HTML strings — no DOM mutation,
// no shared state. Safe to unit-test in isolation.

/**
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  return /** @type {any} */ (window).__escapeHtml(str);
}

/**
 * @param {string} text
 * @returns {string}
 */
export function renderLogWithLinks(text) {
  const URL_RE = /(https?:\/\/[^\s<>"')\]]+)/g;
  const parts = text.split(URL_RE);
  let html = '';
  for (let partIdx = 0; partIdx < parts.length; partIdx++) {
    if (partIdx % 2 === 1) {
      const escapedUrl = escapeHtml(parts[partIdx]);
      html += `<a class="yaml-log-link" href="#" data-url="${escapedUrl}">${escapedUrl}</a>`;
    } else {
      html += escapeHtml(parts[partIdx]);
    }
  }
  return html;
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function deepParseJson(value) {
  if (typeof value === 'string') {
    try {
      return deepParseJson(JSON.parse(value));
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) return value.map(deepParseJson);
  if (value !== null && typeof value === 'object') {
    const out = /** @type {Record<string, unknown>} */ ({});
    for (const [key, val] of Object.entries(/** @type {object} */ (value))) {
      out[key] = deepParseJson(val);
    }
    return out;
  }
  return value;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function renderJsonCell(value) {
  if (value === null) return '<span class="yaml-json-null">null</span>';
  if (value === undefined) return '';
  if (typeof value === 'object') return renderJsonAsTable(value);
  if (typeof value === 'boolean') return `<span class="yaml-json-bool">${value}</span>`;
  if (typeof value === 'number') return `<span class="yaml-json-num">${value}</span>`;
  return escapeHtml(String(value));
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function renderJsonAsTable(value) {
  if (value === null || value === undefined) return escapeHtml(String(value));
  if (typeof value !== 'object') return escapeHtml(String(value));

  // Array of objects → column-per-key table
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => item !== null && typeof item === 'object' && !Array.isArray(item))
  ) {
    const keys = [...new Set(value.flatMap((obj) => Object.keys(/** @type {object} */ (obj))))];
    let html = '<table class="yaml-json-table"><thead><tr>';
    html += '<th class="yaml-json-th">(index)</th>';
    for (const key of keys) html += `<th class="yaml-json-th">${escapeHtml(key)}</th>`;
    html += '</tr></thead><tbody>';
    value.forEach((row, rowIdx) => {
      const obj = /** @type {Record<string, unknown>} */ (row);
      html += `<tr><td class="yaml-json-td yaml-json-td--index">${rowIdx}</td>`;
      for (const key of keys) html += `<td class="yaml-json-td">${renderJsonCell(obj[key])}</td>`;
      html += '</tr>';
    });
    html += '</tbody></table>';
    return html;
  }

  // Array of primitives → (index) | Value
  if (Array.isArray(value)) {
    let html = '<table class="yaml-json-table"><thead><tr>';
    html += '<th class="yaml-json-th">(index)</th><th class="yaml-json-th">Value</th>';
    html += '</tr></thead><tbody>';
    value.forEach((item, itemIdx) => {
      html += `<tr><td class="yaml-json-td yaml-json-td--index">${itemIdx}</td>`;
      html += `<td class="yaml-json-td">${renderJsonCell(item)}</td></tr>`;
    });
    html += '</tbody></table>';
    return html;
  }

  // Plain object → Key | Value
  const entries = Object.entries(value);
  let html = '<table class="yaml-json-table"><thead><tr>';
  html += '<th class="yaml-json-th">Key</th><th class="yaml-json-th">Value</th>';
  html += '</tr></thead><tbody>';
  for (const [key, val] of entries) {
    html += `<tr><td class="yaml-json-td yaml-json-td--key">${escapeHtml(key)}</td>`;
    html += `<td class="yaml-json-td">${renderJsonCell(val)}</td></tr>`;
  }
  html += '</tbody></table>';
  return html;
}

/**
 * Scans the log text for embedded JSON objects/arrays, renders them as tables,
 * and falls back to {@link renderLogWithLinks} for the surrounding text.
 *
 * @param {string} text
 * @returns {string}
 */
export function renderLogWithJsonTables(text) {
  let html = '';
  let cursor = 0;
  let textStart = 0;

  while (cursor < text.length) {
    const openChar = text[cursor];
    if (openChar === '{' || openChar === '[') {
      const closeChar = openChar === '{' ? '}' : ']';
      let depth = 1;
      let endIdx = cursor + 1;
      let inString = false;
      let escaped = false;
      while (endIdx < text.length && depth > 0) {
        const char = text[endIdx];
        if (escaped) {
          escaped = false;
        } else if (char === '\\' && inString) {
          escaped = true;
        } else if (char === '"') {
          inString = !inString;
        } else if (!inString) {
          if (char === openChar) depth++;
          else if (char === closeChar) depth--;
        }
        endIdx++;
      }
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(cursor, endIdx));
          if (cursor > textStart) html += renderLogWithLinks(text.slice(textStart, cursor));
          html += renderJsonAsTable(deepParseJson(parsed));
          cursor = endIdx;
          textStart = cursor;
          continue;
        } catch {
          /* JSON parse failed — treat as plain text */
        }
      }
    }
    cursor++;
  }
  if (textStart < text.length) html += renderLogWithLinks(text.slice(textStart));
  return html;
}
