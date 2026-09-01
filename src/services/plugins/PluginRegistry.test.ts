import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PluginRegistry } from './PluginRegistry';

describe('PluginRegistry', () => {
  let tmp: string;
  let userDir: string;
  let privateDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugins-test-'));
    userDir = path.join(tmp, 'plugins');
    privateDir = path.join(tmp, 'private', 'plugins');
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function writePlugin(
    root: string,
    id: string,
    manifest: string | null,
    files: Record<string, string> = { 'view.html': '<p>hi</p>' },
  ): void {
    const dir = path.join(root, id);
    fs.mkdirSync(dir, { recursive: true });
    if (manifest !== null) fs.writeFileSync(path.join(dir, 'plugin.yaml'), manifest, 'utf8');
    for (const [name, body] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), body, 'utf8');
    }
  }

  const registry = () => new PluginRegistry(userDir, privateDir);
  const names = (list: { name: string }[]) => list.map((p) => p.name);

  it('discovers plugins with the folder name as the id, sorted by display name', () => {
    writePlugin(userDir, 'zeta', 'name: Zeta\ndescription: last\nicon: "🅩"');
    writePlugin(userDir, 'alpha', 'name: Alpha\ndescription: first');

    expect(registry().list()).toEqual([
      {
        id: 'alpha',
        name: 'Alpha',
        description: 'first',
        icon: '',
        dir: path.join(userDir, 'alpha'),
        source: 'user',
      },
      {
        id: 'zeta',
        name: 'Zeta',
        description: 'last',
        icon: '🅩',
        dir: path.join(userDir, 'zeta'),
        source: 'user',
      },
    ]);
  });

  it('sorts a symbol-prefixed name by its word, not by the leading symbol', () => {
    // The whole reason this goes through the shared `compareByName` rather than
    // a plain localeCompare: default collation puts symbols and emoji AHEAD of
    // every letter, so "⚙️ Zebra" sorts before "Apex" — an order that reads as
    // random once a few plugins carry an icon in their name. Comparison starts
    // at the first alphanumeric character instead.
    writePlugin(userDir, 'zebra', 'name: "⚙️ Zebra"');
    writePlugin(userDir, 'apex', 'name: Apex Jobs');
    writePlugin(userDir, 'monitor', 'name: "🔥 Monitor"');

    expect(names(registry().list())).toEqual(['Apex Jobs', '🔥 Monitor', '⚙️ Zebra']);
  });

  it('lets a "0 " prefix pin a plugin to the top even against an emoji-prefixed one', () => {
    // The other half of the same defect: under plain collation every emoji still
    // sorts ahead of the digit, so the prefix a user reaches for to pin
    // something to the top does nothing at all.
    writePlugin(userDir, 'pinned', 'name: "0 Pinned"');
    writePlugin(userDir, 'apex', 'name: "⚙️ Apex"');

    expect(names(registry().list())).toEqual(['0 Pinned', '⚙️ Apex']);
  });

  it('exposes its scan roots, private first, so the panel need not re-derive them', () => {
    expect(registry().roots).toEqual([privateDir, userDir]);
  });

  it('skips a folder with no plugin.yaml — it is not a plugin, not a broken one', () => {
    writePlugin(userDir, 'not-a-plugin', null);
    expect(registry().list()).toEqual([]);
  });

  it('returns no plugins when the directories do not exist', () => {
    expect(registry().list()).toEqual([]);
  });

  it('lets a private plugin shadow a shared one of the same id', () => {
    writePlugin(userDir, 'orders', 'name: Shared Orders');
    writePlugin(privateDir, 'orders', 'name: Private Orders');

    const list = registry().list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'orders', name: 'Private Orders', source: 'private' });
  });

  // The invalid-card contract: a broken plugin must be VISIBLE and
  // self-diagnosing, never silently absent.
  it('flags a manifest that is not valid YAML', () => {
    writePlugin(userDir, 'broken', 'name: [unclosed');
    const [info] = registry().list();
    expect(info.invalid).toBe(true);
    expect(info.error).toMatch(/not valid YAML/);
  });

  it('flags a manifest that is not a mapping', () => {
    writePlugin(userDir, 'broken', '- just\n- a list');
    expect(registry().list()[0].error).toMatch(/must be a YAML mapping/);
  });

  it('flags a manifest with no name, and still names the card after the folder', () => {
    writePlugin(userDir, 'nameless', 'description: no name here');
    const [info] = registry().list();
    expect(info).toMatchObject({ id: 'nameless', name: 'nameless', invalid: true });
    expect(info.error).toMatch(/missing a "name"/);
  });

  it('flags a plugin with no view.html but keeps its declared name', () => {
    writePlugin(userDir, 'headless', 'name: Headless', {});
    const [info] = registry().list();
    expect(info).toMatchObject({ name: 'Headless', invalid: true, error: 'Missing view.html.' });
  });

  describe('resolve', () => {
    it('resolves a discovered id to its folder', () => {
      writePlugin(userDir, 'orders', 'name: Orders');
      expect(registry().resolve('orders')?.dir).toBe(path.join(userDir, 'orders'));
    });

    it('refuses an id it never discovered', () => {
      writePlugin(userDir, 'orders', 'name: Orders');
      expect(registry().resolve('ghost')).toBeNull();
    });

    // The id arrives from the webview, so it must never be joined into a path.
    it('refuses a traversal id rather than escaping the plugins folder', () => {
      writePlugin(userDir, 'orders', 'name: Orders');
      expect(registry().resolve('../../etc')).toBeNull();
      expect(registry().resolve('..')).toBeNull();
    });

    it('refuses an invalid plugin — there is nothing safe to run', () => {
      writePlugin(userDir, 'broken', 'name: Broken', {});
      expect(registry().resolve('broken')).toBeNull();
    });
  });
});
