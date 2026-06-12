import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ScriptParser } from './ScriptParser';

describe('ScriptParser', () => {
  describe('parseInputs', () => {
    const parser = new ScriptParser('');

    it('returns an empty array for undefined input', () => {
      expect(parser.parseInputs(undefined)).toEqual([]);
    });

    it('filters out entries that have no name', () => {
      expect(parser.parseInputs([{ label: 'No name here' }])).toEqual([]);
    });

    it('parses a string input with a custom label', () => {
      expect(parser.parseInputs([{ name: 'orderId', label: 'Order ID' }])).toEqual([
        { name: 'orderId', label: 'Order ID' },
      ]);
    });

    it('parses a picklist input with options', () => {
      expect(
        parser.parseInputs([
          { name: 'status', type: 'picklist', options: ['New', 'Done'], required: true },
        ]),
      ).toEqual([{ name: 'status', type: 'picklist', options: ['New', 'Done'], required: true }]);
    });

    it('does not set required unless explicitly true', () => {
      const result = parser.parseInputs([{ name: 'x', required: false }]);
      expect(result[0].required).toBeUndefined();
    });

    it('filters out non-object entries', () => {
      expect(parser.parseInputs(['not-an-object', 42, null])).toEqual([]);
    });

    it('parses a textarea input', () => {
      expect(parser.parseInputs([{ name: 'itemList', type: 'textarea', required: true }])).toEqual([
        { name: 'itemList', type: 'textarea', required: true },
      ]);
    });
  });

  describe('makeInvalidScript', () => {
    const parser = new ScriptParser('');

    it('sets invalid:true and the given error', () => {
      const result = parser.makeInvalidScript(
        { id: 'cat/s', folder: 'cat', name: 'S', description: '', source: 'user' },
        'bad stuff',
      );
      expect(result.invalid).toBe(true);
      expect(result.error).toBe('bad stuff');
    });

    it('defaults type to apex when not supplied', () => {
      const result = parser.makeInvalidScript(
        { id: 'cat/s', folder: 'cat', name: 'S', description: '', source: 'user' },
        'err',
      );
      expect(result.type).toBe('apex');
    });

    it('uses the supplied type when provided', () => {
      const result = parser.makeInvalidScript(
        { id: 'cat/s', folder: 'cat', name: 'S', description: '', source: 'user', type: 'js' },
        'err',
      );
      expect(result.type).toBe('js');
    });

    it('omits inputs when the array is empty', () => {
      const result = parser.makeInvalidScript(
        { id: 'cat/s', folder: 'cat', name: 'S', description: '', source: 'user', inputs: [] },
        'err',
      );
      expect(result.inputs).toBeUndefined();
    });

    it('includes inputs when the array is non-empty', () => {
      const inputs = [{ name: 'x' }];
      const result = parser.makeInvalidScript(
        { id: 'cat/s', folder: 'cat', name: 'S', description: '', source: 'user', inputs },
        'err',
      );
      expect(result.inputs).toEqual(inputs);
    });

    it('omits scriptFile when falsy', () => {
      const result = parser.makeInvalidScript(
        {
          id: 'cat/s',
          folder: 'cat',
          name: 'S',
          description: '',
          source: 'user',
          scriptFile: undefined,
        },
        'err',
      );
      expect(result.scriptFile).toBeUndefined();
    });

    it('includes scriptFile when provided', () => {
      const result = parser.makeInvalidScript(
        {
          id: 'cat/s',
          folder: 'cat',
          name: 'S',
          description: '',
          source: 'user',
          scriptFile: 'my.cls',
        },
        'err',
      );
      expect(result.scriptFile).toBe('my.cls');
    });
  });

  // detectScriptKind, validateYamlDoc, and resolveScriptContent are private
  // implementation details exercised through parse(). The loadScripts integration
  // tests in YamlScriptsService.test.ts cover them end-to-end. We still keep a
  // handful of targeted probes below to make regressions easy to pinpoint.

  describe('parse (reads file and returns structured script)', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parser-test-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns an inline apex script', () => {
      const filePath = path.join(tmpDir, 'hello.yaml');
      fs.writeFileSync(filePath, `name: Hello\napex: System.debug('hi');`, 'utf8');
      const parser = new ScriptParser(tmpDir);
      const result = parser.parse(filePath, 'cat/hello', 'cat', 'user');
      expect(result).toMatchObject({ name: 'Hello', type: 'apex', source: 'user' });
      expect(result?.invalid).toBeUndefined();
    });

    it('returns an invalid entry for broken YAML', () => {
      const filePath = path.join(tmpDir, 'bad.yaml');
      fs.writeFileSync(filePath, `: invalid: yaml: [`, 'utf8');
      const parser = new ScriptParser(tmpDir);
      const result = parser.parse(filePath, 'cat/bad', 'cat', 'user');
      expect(result?.invalid).toBe(true);
      expect(result?.error).toMatch(/Invalid YAML/i);
    });

    it('returns an invalid entry when both apex and command are set', () => {
      const filePath = path.join(tmpDir, 'amb.yaml');
      fs.writeFileSync(filePath, `name: Amb\napex: '1'\ncommand: echo`, 'utf8');
      const parser = new ScriptParser(tmpDir);
      const result = parser.parse(filePath, 'cat/amb', 'cat', 'user');
      expect(result?.invalid).toBe(true);
      expect(result?.error).toContain('Ambiguous');
    });

    it('resolves a file-based script when the referenced file exists', () => {
      fs.writeFileSync(path.join(tmpDir, 'my.cls'), 'System.debug();', 'utf8');
      const filePath = path.join(tmpDir, 'file.yaml');
      fs.writeFileSync(filePath, `name: File\napex-file: my.cls`, 'utf8');
      const parser = new ScriptParser(tmpDir);
      const result = parser.parse(filePath, 'cat/file', 'cat', 'user');
      expect(result?.invalid).toBeUndefined();
      expect(result?.script).toContain('System.debug');
    });

    it('returns invalid when the referenced file is outside the workspace', () => {
      const filePath = path.join(tmpDir, 'esc.yaml');
      fs.writeFileSync(filePath, `name: Esc\napex-file: ../outside.cls`, 'utf8');
      const parser = new ScriptParser(tmpDir);
      const result = parser.parse(filePath, 'cat/esc', 'cat', 'user');
      expect(result?.invalid).toBe(true);
      expect(result?.error).toContain('inside the workspace');
    });
  });

  describe('parse (ai scripts)', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parser-ai-test-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function parseYaml(yaml: string, id = 'ai/x', folder = 'ai') {
      const filePath = path.join(tmpDir, 'x.yaml');
      fs.writeFileSync(filePath, yaml, 'utf8');
      return new ScriptParser(tmpDir).parse(filePath, id, folder, 'user');
    }

    it('parses an ai script with a soql gather step', () => {
      const result = parseYaml(
        `name: Analyse\nmodel: claude-3.5-sonnet\ngather:\n  soql: SELECT Id FROM Account\nai: |\n  Summarise the data.\nallow-followup-queries: true`,
      );
      expect(result?.invalid).toBeUndefined();
      expect(result?.type).toBe('ai');
      expect(result?.script).toContain('Summarise the data.');
      expect(result?.model).toBe('claude-3.5-sonnet');
      expect(result?.gather).toEqual({ kind: 'soql', value: 'SELECT Id FROM Account' });
      expect(result?.allowFollowupQueries).toBe(true);
    });

    it('defaults model/allowFollowupQueries to undefined when omitted', () => {
      const result = parseYaml(`name: A\ngather:\n  apex: System.debug(1);\nai: Do it.`);
      expect(result?.type).toBe('ai');
      expect(result?.gather).toEqual({ kind: 'apex', value: 'System.debug(1);' });
      expect(result?.model).toBeUndefined();
      expect(result?.allowFollowupQueries).toBeUndefined();
    });

    it('resolves an apex-file gather step and keeps the path', () => {
      fs.writeFileSync(path.join(tmpDir, 'g.cls'), 'System.debug(42);', 'utf8');
      const result = parseYaml(`name: A\ngather:\n  apex-file: g.cls\nai: Do it.`);
      expect(result?.invalid).toBeUndefined();
      expect(result?.gather).toEqual({
        kind: 'apex-file',
        value: 'System.debug(42);',
        file: 'g.cls',
      });
    });

    it('supports an ai-file prompt', () => {
      fs.writeFileSync(path.join(tmpDir, 'p.md'), 'Analyse everything.', 'utf8');
      const result = parseYaml(`name: A\ngather:\n  soql: SELECT Id FROM Account\nai-file: p.md`);
      expect(result?.invalid).toBeUndefined();
      expect(result?.type).toBe('ai');
      expect(result?.script).toContain('Analyse everything.');
    });

    it('is invalid when gather is missing', () => {
      const result = parseYaml(`name: A\nai: Do it.`);
      expect(result?.invalid).toBe(true);
      expect(result?.error).toContain('gather');
    });

    it('is invalid when gather sets more than one source', () => {
      const result = parseYaml(
        `name: A\ngather:\n  soql: SELECT Id FROM Account\n  apex: System.debug(1);\nai: Do it.`,
      );
      expect(result?.invalid).toBe(true);
      expect(result?.error).toContain('ambiguous');
    });

    it('is invalid when the gather apex-file is missing on disk', () => {
      const result = parseYaml(`name: A\ngather:\n  apex-file: nope.cls\nai: Do it.`);
      expect(result?.invalid).toBe(true);
      expect(result?.error).toContain('not found');
    });

    it('picks the truthy gather field, ignoring an empty-string sibling', () => {
      const result = parseYaml(
        `name: A\ngather:\n  soql: ''\n  apex: System.debug(1);\nai: Do it.`,
      );
      expect(result?.invalid).toBeUndefined();
      expect(result?.gather).toEqual({ kind: 'apex', value: 'System.debug(1);' });
    });

    it('is ambiguous when both ai and apex are set at the top level', () => {
      const result = parseYaml(`name: A\napex: System.debug(1);\nai: Do it.`);
      expect(result?.invalid).toBe(true);
      expect(result?.error).toContain('Ambiguous');
    });
  });
});
