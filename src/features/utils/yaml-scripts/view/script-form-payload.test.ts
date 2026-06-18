import { describe, it, expect } from 'vitest';
import {
  cleanInputs,
  validateInputs,
  buildScriptPayload,
  type RawFormInput,
} from './script-form-payload';

function rawInput(overrides: Partial<RawFormInput> = {}): RawFormInput {
  return {
    name: '',
    label: '',
    type: 'string',
    required: false,
    options: '',
    checkboxDefault: false,
    ...overrides,
  };
}

describe('cleanInputs', () => {
  it('drops rows with a blank name', () => {
    expect(cleanInputs([rawInput({ name: '  ' }), rawInput({ name: 'foo' })])).toEqual([
      { name: 'foo' },
    ]);
  });

  it('trims name and label, omits empty label', () => {
    expect(cleanInputs([rawInput({ name: ' foo ', label: '  ' })])).toEqual([{ name: 'foo' }]);
    expect(cleanInputs([rawInput({ name: 'foo', label: ' Bar ' })])).toEqual([
      { name: 'foo', label: 'Bar' },
    ]);
  });

  it('splits and trims picklist options, dropping blanks', () => {
    expect(
      cleanInputs([rawInput({ name: 'foo', type: 'picklist', options: 'A, B ,, C' })]),
    ).toEqual([{ name: 'foo', type: 'picklist', options: ['A', 'B', 'C'] }]);
  });

  it('includes checkbox default only when true', () => {
    expect(cleanInputs([rawInput({ name: 'foo', type: 'checkbox' })])).toEqual([
      { name: 'foo', type: 'checkbox' },
    ]);
    expect(
      cleanInputs([rawInput({ name: 'foo', type: 'checkbox', checkboxDefault: true })]),
    ).toEqual([{ name: 'foo', type: 'checkbox', default: true }]);
  });

  it('marks textarea type and required flag', () => {
    expect(cleanInputs([rawInput({ name: 'foo', type: 'textarea', required: true })])).toEqual([
      { name: 'foo', type: 'textarea', required: true },
    ]);
  });

  it('omits type for plain string inputs', () => {
    expect(cleanInputs([rawInput({ name: 'foo', type: 'string' })])).toEqual([{ name: 'foo' }]);
  });
});

describe('validateInputs', () => {
  it('returns null for a valid set', () => {
    expect(validateInputs([{ name: 'foo' }, { name: '_bar1' }])).toBeNull();
  });

  it('rejects an invalid identifier', () => {
    expect(validateInputs([{ name: '1foo' }])).toBe('errorInputNameInvalid');
    expect(validateInputs([{ name: 'foo-bar' }])).toBe('errorInputNameInvalid');
  });

  it('rejects duplicate names', () => {
    expect(validateInputs([{ name: 'foo' }, { name: 'foo' }])).toBe('errorInputNameDuplicate');
  });

  it('requires options for a picklist input', () => {
    expect(validateInputs([{ name: 'foo', type: 'picklist', options: [] }])).toBe(
      'errorPicklistOptionsRequired',
    );
    expect(validateInputs([{ name: 'foo', type: 'picklist', options: ['A'] }])).toBeNull();
  });
});

describe('buildScriptPayload', () => {
  const base = {
    name: 'My Script',
    description: 'desc',
    type: 'apex' as const,
    folder: 'utils',
    isFile: false,
    filePath: '',
    content: 'System.debug(1);',
    inputs: [],
    filterUserDebug: false,
    formatJson: false,
  };

  it('uses inline content when not file-based', () => {
    const payload = buildScriptPayload(base);
    expect(payload.script).toBe('System.debug(1);');
    expect(payload).not.toHaveProperty('scriptFile');
  });

  it('uses scriptFile and blanks script when file-based', () => {
    const payload = buildScriptPayload({
      ...base,
      isFile: true,
      filePath: 'force-cockpit/scripts/a.cls',
      content: 'ignored',
    });
    expect(payload.script).toBe('');
    expect(payload.scriptFile).toBe('force-cockpit/scripts/a.cls');
  });

  it('includes apex defaults only for apex type when checked', () => {
    const payload = buildScriptPayload({ ...base, filterUserDebug: true, formatJson: true });
    expect(payload).toMatchObject({ filterUserDebug: true, formatJson: true });

    const nonApex = buildScriptPayload({
      ...base,
      type: 'command',
      filterUserDebug: true,
      formatJson: true,
    });
    expect(nonApex).not.toHaveProperty('filterUserDebug');
    expect(nonApex).not.toHaveProperty('formatJson');
  });

  it('spreads ai fields only for ai type', () => {
    const aiFields = { model: 'auto', allowFollowupQueries: true as const };
    const payload = buildScriptPayload({ ...base, type: 'ai', aiFields });
    expect(payload).toMatchObject(aiFields);

    const nonAi = buildScriptPayload({ ...base, type: 'apex', aiFields });
    expect(nonAi).not.toHaveProperty('model');
  });

  it('omits ai fields when not provided even for ai type', () => {
    const payload = buildScriptPayload({ ...base, type: 'ai' });
    expect(payload).not.toHaveProperty('model');
  });
});
