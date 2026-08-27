import { describe, expect, it } from 'vitest';
import { defaultFormatJson } from './log-defaults';

describe('defaultFormatJson', () => {
  it('is on for ai and rest, whose output is JSON-shaped', () => {
    expect(defaultFormatJson({ type: 'ai' })).toBe(true);
    expect(defaultFormatJson({ type: 'rest' })).toBe(true);
  });

  it("honours the script's own format-json for other kinds", () => {
    expect(defaultFormatJson({ type: 'apex', formatJson: true })).toBe(true);
    expect(defaultFormatJson({ type: 'apex', formatJson: false })).toBe(false);
    expect(defaultFormatJson({ type: 'command' })).toBe(false);
    expect(defaultFormatJson({ type: 'js' })).toBe(false);
  });

  // The ai/rest default must not be overridable by an absent formatJson: the
  // execute-handler used to reset the checkbox to `formatJson ?? false` on every
  // run, so the default-on survived only until the first execution.
  it('stays on for ai/rest regardless of formatJson', () => {
    expect(defaultFormatJson({ type: 'ai', formatJson: false })).toBe(true);
    expect(defaultFormatJson({ type: 'rest', formatJson: false })).toBe(true);
  });
});
