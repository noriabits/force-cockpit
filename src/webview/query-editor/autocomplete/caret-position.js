// @ts-check
// Computes the pixel position of a caret offset within a <textarea>, using the
// standard "mirror div" technique: an offscreen div is styled identically to
// the textarea (font, padding, border, whitespace handling) so its text wraps
// exactly the same way, then a marker span placed at the caret offset reveals
// its offsetTop/offsetLeft. Native textareas expose no caret-coordinate API,
// so there is no lighter way to find where line N of a wrapped, multi-line
// query actually sits.

/** Properties that affect text layout/wrapping and must match the textarea exactly. */
const MIRRORED_PROPERTIES = [
  'boxSizing',
  'width',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'letterSpacing',
  'lineHeight',
  'tabSize',
  'whiteSpace',
  'overflowWrap',
  'wordBreak',
];

/**
 * @param {HTMLTextAreaElement} textarea
 * @param {number} position
 * @returns {{ top: number, left: number, lineHeight: number }}
 */
export function getCaretCoordinates(textarea, position) {
  const mirror = document.createElement('div');
  const computed = getComputedStyle(textarea);
  const mirrorStyle = /** @type {any} */ (mirror.style);
  for (const prop of MIRRORED_PROPERTIES) {
    mirrorStyle[prop] = computed[/** @type {any} */ (prop)];
  }
  mirror.style.position = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.top = '0';
  mirror.style.left = '-9999px';
  mirror.style.height = 'auto';
  mirror.style.overflow = 'hidden';

  mirror.textContent = textarea.value.slice(0, position);
  const marker = document.createElement('span');
  // A trailing placeholder keeps a caret at the very end of a line/text from
  // collapsing the marker to zero width (offsetTop/Left would then read from
  // the wrong, following line in some wrapping edge cases).
  marker.textContent = textarea.value.slice(position) || '.';
  mirror.appendChild(marker);

  document.body.appendChild(mirror);
  const top = marker.offsetTop;
  const left = marker.offsetLeft;
  document.body.removeChild(mirror);

  const lineHeight = parseFloat(computed.lineHeight) || parseFloat(computed.fontSize) * 1.2;
  return { top, left, lineHeight };
}
