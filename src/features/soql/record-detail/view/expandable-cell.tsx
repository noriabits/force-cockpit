// A `<td>` clamped to one ellipsized line, which a click unwraps to show the
// full value in place — the SOQL results' and Monitoring tables' behaviour,
// through the same shared classes and rules (shared/view/table-cell-expand.js,
// styled in media/main.css). Expansion is component state, not a class toggled
// onto the node, because Preact owns this cell and would drop a class it did
// not render the next time this row's class prop changed.
import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import {
  CLAMPED_CLASS,
  EXPANDED_CLASS,
  isLongCellValue,
  isSelectingText,
} from '../../../shared/view/table-cell-expand';

export function ExpandableCell({
  text,
  maxChars,
  class: className,
  children,
}: {
  /** The full value, measured against `maxChars` to decide whether to clamp. */
  text: string;
  /** Characters that fit on one line at this column's own max-width (view.css). */
  maxChars: number;
  class?: string;
  /** What to render; defaults to `text`. */
  children?: ComponentChildren;
}) {
  const [expanded, setExpanded] = useState(false);
  const long = isLongCellValue(text, maxChars);
  const classes = [className, long && CLAMPED_CLASS, long && expanded && EXPANDED_CLASS]
    .filter(Boolean)
    .join(' ');
  return (
    <td
      class={classes || undefined}
      onClick={long ? () => !isSelectingText() && setExpanded(!expanded) : undefined}
    >
      {children ?? text}
    </td>
  );
}
