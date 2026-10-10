// A span carrying a Cockpit tooltip. Its own module (not private to
// record-detail.tsx) so the compare pane can use it without an import cycle.
import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';

const setTooltip = (el: Element, text: string) =>
  (window as unknown as { __setTooltip: (el: Element, text: string) => void }).__setTooltip(
    el,
    text,
  );

export function Tooltip({
  text,
  wrap,
  class: className,
  children,
}: {
  text: string;
  /** Long text: let the tooltip wrap (`.fc-tooltip--wrap`) instead of running off-screen. */
  wrap?: boolean;
  class?: string;
  children: ComponentChildren;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (!ref.current) return;
    setTooltip(ref.current, text);
    if (wrap) ref.current.setAttribute('data-tooltip-wrap', '');
  }, [text, wrap]);
  return (
    <span ref={ref} class={className}>
      {children}
    </span>
  );
}
