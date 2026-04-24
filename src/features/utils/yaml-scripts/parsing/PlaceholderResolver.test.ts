import { describe, expect, it } from 'vitest';
import {
  escapeForType,
  substituteInputs,
  substituteSystemPlaceholders,
  validateRequiredInputs,
} from './PlaceholderResolver';
import type { YamlScript } from '../types';

function script(partial: Partial<YamlScript>): YamlScript {
  return {
    id: 'cat/s',
    folder: 'cat',
    name: 'S',
    description: '',
    type: 'apex',
    script: '',
    source: 'user',
    ...partial,
  };
}

describe('escapeForType', () => {
  it('apex: doubles single quotes', () => {
    expect(escapeForType("it's a test", 'apex')).toBe("it''s a test");
  });

  it('apex: escapes backslashes', () => {
    expect(escapeForType('C:\\path', 'apex')).toBe('C:\\\\path');
  });

  it('js: produces JSON-safe escaping (escapes double quotes)', () => {
    expect(escapeForType('"quoted"', 'js')).toBe('\\"quoted\\"');
  });

  it('command: returns the raw value unchanged', () => {
    expect(escapeForType("raw'value", 'command')).toBe("raw'value");
  });

  it('apex: escapes LF newlines as \\n', () => {
    expect(escapeForType('line1\nline2', 'apex')).toBe('line1\\nline2');
  });

  it('apex: escapes CRLF newlines as \\n', () => {
    expect(escapeForType('line1\r\nline2', 'apex')).toBe('line1\\nline2');
  });

  it('apex: escapes CR newlines as \\n', () => {
    expect(escapeForType('line1\rline2', 'apex')).toBe('line1\\nline2');
  });

  it('js: escapes newlines via JSON (\\n → \\\\n in output)', () => {
    expect(escapeForType('a\nb', 'js')).toBe('a\\nb');
  });
});

describe('substituteInputs', () => {
  it('replaces ${varName} with the escaped value', () => {
    const s = script({
      inputs: [{ name: 'orderId' }],
      type: 'apex',
      script: "Id x = '${orderId}';",
    });
    expect(substituteInputs(s, { orderId: 'ord001' })).toBe("Id x = 'ord001';");
  });

  it('replaces an unset optional input with an empty string', () => {
    const s = script({ inputs: [{ name: 'ext' }], type: 'apex', script: "'${ext}'" });
    expect(substituteInputs(s, {})).toBe("''");
  });

  it('returns the script unchanged when there are no inputs', () => {
    const s = script({ inputs: [], type: 'apex', script: 'SELECT Id FROM Account' });
    expect(substituteInputs(s, {})).toBe('SELECT Id FROM Account');
  });

  it('substitutes a textarea value with newlines into an Apex string (newlines escaped)', () => {
    const s = script({
      inputs: [{ name: 'items', type: 'textarea' }],
      type: 'apex',
      script: "String s = '${items}';",
    });
    expect(substituteInputs(s, { items: 'a\nb\nc' })).toBe("String s = 'a\\nb\\nc';");
  });

  it('handles regex-special characters in input names', () => {
    const s = script({ inputs: [{ name: 'a.b' }], type: 'command', script: 'echo ${a.b}' });
    expect(substituteInputs(s, { 'a.b': 'hello' })).toBe('echo hello');
  });
});

describe('substituteSystemPlaceholders', () => {
  it('replaces ${orgUsername} with the provided value', () => {
    const result = substituteSystemPlaceholders("String u = '${orgUsername}';", 'apex', {
      orgUsername: 'admin@myorg.com',
    });
    expect(result).toBe("String u = 'admin@myorg.com';");
  });

  it('applies Apex escaping to the value', () => {
    const result = substituteSystemPlaceholders("'${orgUsername}'", 'apex', {
      orgUsername: "it's@org.com",
    });
    expect(result).toBe("'it''s@org.com'");
  });

  it('applies JS escaping to the value', () => {
    const result = substituteSystemPlaceholders('"${orgUsername}"', 'js', {
      orgUsername: 'user"name@org.com',
    });
    expect(result).toBe('"user\\"name@org.com"');
  });

  it('resolves to empty string when the system value is empty', () => {
    const result = substituteSystemPlaceholders('echo ${orgUsername}', 'command', {
      orgUsername: '',
    });
    expect(result).toBe('echo ');
  });

  it('replaces multiple occurrences', () => {
    const result = substituteSystemPlaceholders('${orgUsername} and ${orgUsername}', 'command', {
      orgUsername: 'admin@myorg.com',
    });
    expect(result).toBe('admin@myorg.com and admin@myorg.com');
  });

  it('leaves content unchanged when no system placeholders are present', () => {
    const result = substituteSystemPlaceholders("System.debug('hello');", 'apex', {
      orgUsername: 'admin@myorg.com',
    });
    expect(result).toBe("System.debug('hello');");
  });
});

describe('validateRequiredInputs', () => {
  it('returns null when no inputs are defined', () => {
    const s = script({ inputs: [] });
    expect(validateRequiredInputs(s, {})).toBeNull();
  });

  it('returns null when all required inputs are filled', () => {
    const s = script({ inputs: [{ name: 'x', required: true }] });
    expect(validateRequiredInputs(s, { x: 'value' })).toBeNull();
  });

  it('returns a descriptive error when a required input is missing', () => {
    const s = script({ inputs: [{ name: 'orderId', required: true, label: 'Order ID' }] });
    expect(validateRequiredInputs(s, {})).toBe('Required input "Order ID" is missing.');
  });

  it('falls back to name when label is not set', () => {
    const s = script({ inputs: [{ name: 'orderId', required: true }] });
    expect(validateRequiredInputs(s, {})).toBe('Required input "orderId" is missing.');
  });

  it('treats whitespace-only as missing', () => {
    const s = script({ inputs: [{ name: 'orderId', required: true }] });
    expect(validateRequiredInputs(s, { orderId: '   ' })).toMatch(/missing/i);
  });

  it('ignores non-required inputs that are empty', () => {
    const s = script({ inputs: [{ name: 'x' }] });
    expect(validateRequiredInputs(s, {})).toBeNull();
  });
});
