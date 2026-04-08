import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadConfig } from './config';

describe('loadConfig', () => {
  let tmpDir: string;
  let extensionDir: string;
  let userDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
    extensionDir = path.join(tmpDir, 'extension');
    userDir = path.join(tmpDir, 'user');
    fs.mkdirSync(extensionDir);
    fs.mkdirSync(userDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns defaults when no files exist', () => {
    const config = loadConfig(extensionDir, userDir);
    expect(config).toEqual({
      apiVersion: '65.0',
      protectedSandboxes: [],
    });
  });

  it('reads bundled config.yaml', () => {
    fs.writeFileSync(path.join(extensionDir, 'config.yaml'), 'apiVersion: "60.0"');
    const config = loadConfig(extensionDir, userDir);
    expect(config.apiVersion).toBe('60.0');
    expect(config.protectedSandboxes).toEqual([]);
  });

  it('user config overrides bundled config', () => {
    fs.writeFileSync(path.join(extensionDir, 'config.yaml'), 'apiVersion: "60.0"');
    fs.writeFileSync(path.join(userDir, 'config.yaml'), 'apiVersion: "62.0"');
    const config = loadConfig(extensionDir, userDir);
    expect(config.apiVersion).toBe('62.0');
  });

  it('partial user config only overrides specified keys', () => {
    fs.writeFileSync(path.join(extensionDir, 'config.yaml'), 'apiVersion: "60.0"');
    fs.writeFileSync(path.join(userDir, 'config.yaml'), 'protectedSandboxes:\n  - staging');
    const config = loadConfig(extensionDir, userDir);
    expect(config.apiVersion).toBe('60.0');
    expect(config.protectedSandboxes).toEqual(['staging']);
  });

  it('returns defaults for malformed YAML', () => {
    fs.writeFileSync(path.join(userDir, 'config.yaml'), ': : invalid yaml {{[');
    const config = loadConfig(extensionDir, userDir);
    expect(config.apiVersion).toBe('65.0');
  });

  it('ignores invalid field types', () => {
    fs.writeFileSync(
      path.join(userDir, 'config.yaml'),
      'apiVersion: 123\nprotectedSandboxes: "not-array"',
    );
    const config = loadConfig(extensionDir, userDir);
    expect(config.apiVersion).toBe('65.0');
    expect(config.protectedSandboxes).toEqual([]);
  });

  it('filters non-string entries from protectedSandboxes', () => {
    fs.writeFileSync(
      path.join(userDir, 'config.yaml'),
      'protectedSandboxes:\n  - staging\n  - 42\n  - qa',
    );
    const config = loadConfig(extensionDir, userDir);
    expect(config.protectedSandboxes).toEqual(['staging', 'qa']);
  });

  it('ignores empty or whitespace-only apiVersion', () => {
    fs.writeFileSync(path.join(userDir, 'config.yaml'), 'apiVersion: "  "');
    const config = loadConfig(extensionDir, userDir);
    expect(config.apiVersion).toBe('65.0');
  });

  it('handles empty config file gracefully', () => {
    fs.writeFileSync(path.join(userDir, 'config.yaml'), '');
    const config = loadConfig(extensionDir, userDir);
    expect(config.apiVersion).toBe('65.0');
  });
});
