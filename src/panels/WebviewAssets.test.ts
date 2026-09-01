import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as realFs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('vscode', () => ({
  Uri: { file: (p: string) => ({ fsPath: p, _file: p }) },
}));

import { WebviewAssets } from './WebviewAssets';
import { PluginRegistry, type PluginInfo } from '../services/plugins/PluginRegistry';
import type { FeatureModule } from '../features/FeatureModule';

const TEMPLATE = [
  '<html><head></head><body>',
  '<nav id="tab-bar">${pluginSubTabs}</nav>',
  '<div id="tab-utils"><!-- features:utils --></div>',
  '<div id="tab-plugins">${pluginPanels}</div>',
  '</body></html>',
].join('\n');

describe('WebviewAssets', () => {
  let tmp: string;
  let extensionPath: string;

  beforeEach(() => {
    tmp = realFs.mkdtempSync(path.join(os.tmpdir(), 'webview-assets-'));
    extensionPath = path.join(tmp, 'ext');
    realFs.mkdirSync(path.join(extensionPath, 'webviews'), { recursive: true });
    realFs.writeFileSync(path.join(extensionPath, 'webviews', 'main.html'), TEMPLATE, 'utf8');
  });

  afterEach(() => {
    realFs.rmSync(tmp, { recursive: true, force: true });
  });

  const context = () => ({ extensionPath }) as unknown as import('vscode').ExtensionContext;
  const webview = () =>
    ({
      cspSource: 'vscode-webview://x',
      asWebviewUri: (u: { fsPath: string }) => ({ toString: () => `wv:${u.fsPath}` }),
    }) as unknown as import('vscode').Webview;

  function makePlugin(id: string, files: Record<string, string>, over: Partial<PluginInfo> = {}) {
    const dir = path.join(tmp, 'plugins', id);
    realFs.mkdirSync(dir, { recursive: true });
    for (const [name, body] of Object.entries(files)) {
      realFs.writeFileSync(path.join(dir, name), body, 'utf8');
    }
    const info: PluginInfo = {
      id,
      name: id,
      description: '',
      icon: '',
      dir,
      source: 'user',
      ...over,
    };
    return info;
  }

  const html = (plugins: PluginInfo[], features: FeatureModule[] = []) =>
    new WebviewAssets(context(), webview(), features, plugins).getHtml();

  it('renders one sub-tab and one panel per plugin', async () => {
    const p = makePlugin(
      'orders',
      { 'view.html': '<p>Orders UI</p>' },
      {
        name: 'Order Explorer',
        icon: '📦',
        description: 'Browse orders',
      },
    );

    const out = await html([p]);

    expect(out).toContain('data-plugin-tab="orders"');
    expect(out).toContain('📦 Order Explorer');
    expect(out).toContain('data-tooltip="Browse orders"');
    expect(out).toContain('<div class="plugin-sub-tab-panel" id="plugin-sub-tab-orders">');
    expect(out).toContain('<p>Orders UI</p>');
  });

  it('serves view.js as a module and view.css as a stylesheet, from the plugin dir', async () => {
    const p = makePlugin('orders', {
      'view.html': '<p>x</p>',
      'view.js': 'export {};',
      'view.css': 'p{}',
    });

    const out = await html([p]);

    expect(out).toContain(`<script type="module" nonce=`);
    expect(out).toContain(`src="wv:${path.join(p.dir, 'view.js')}"`);
    expect(out).toContain(`href="wv:${path.join(p.dir, 'view.css')}"`);
  });

  it('emits no script or link tag for a plugin that ships neither', async () => {
    const p = makePlugin('bare', { 'view.html': '<p>x</p>' });
    const out = await html([p]);
    expect(out).not.toContain('type="module"');
    expect(out).not.toContain('rel="stylesheet"');
  });

  // The invalid-card contract: visible and self-diagnosing, never silent.
  it('renders an invalid plugin as a sub-tab whose panel carries the error', async () => {
    const p = makePlugin('broken', {}, { invalid: true, error: 'Missing view.html.' });
    const out = await html([p]);
    expect(out).toContain('data-plugin-tab="broken"');
    expect(out).toContain('Missing view.html.');
  });

  it('loads no assets for an invalid plugin even if the files are there', async () => {
    const p = makePlugin(
      'broken',
      { 'view.html': '<p>x</p>', 'view.js': 'export {};' },
      { invalid: true, error: 'bad manifest' },
    );
    const out = await html([p]);
    expect(out).not.toContain('type="module"');
  });

  // A plugin's files are the USER's — deleted mid-session, this must cost one
  // broken sub-tab, not a rejected getHtml() and a blank panel.
  it('degrades a plugin whose view.html cannot be read, and still renders the others', async () => {
    const gone = makePlugin('gone', {});
    const fine = makePlugin('fine', { 'view.html': '<p>still here</p>' });

    const out = await html([gone, fine]);

    expect(out).toContain('Could not read view.html');
    expect(out).toContain('<p>still here</p>');
  });

  it('escapes the author-supplied name, icon and description', async () => {
    const p = makePlugin(
      'x',
      { 'view.html': '<p>x</p>' },
      {
        name: '<img src=x onerror=alert(1)>',
        description: '"quoted"',
      },
    );
    const out = await html([p]);
    expect(out).not.toContain('<img src=x');
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(out).toContain('&quot;quoted&quot;');
  });

  // String.prototype.replace reads $&, $`, $' and $$ in the REPLACEMENT as
  // patterns, so author markup containing them used to splice the surrounding
  // document into itself. This applied to feature fragments long before
  // plugins existed.
  describe('replacement-pattern safety', () => {
    it('keeps $& and friends verbatim in a plugin fragment', async () => {
      const p = makePlugin('x', { 'view.html': `<p>a $& b $\` c $' d $$ e</p>` });
      const out = await html([p]);
      expect(out).toContain(`<p>a $& b $\` c $' d $$ e</p>`);
    });

    it('keeps $& verbatim in a feature fragment', async () => {
      const featureDir = path.join(extensionPath, 'f');
      realFs.mkdirSync(featureDir, { recursive: true });
      realFs.writeFileSync(path.join(featureDir, 'view.html'), '<p>cost: $&amp; $$</p>', 'utf8');
      const feature = {
        id: 'f',
        tab: 'utils',
        htmlPath: path.join('f', 'view.html'),
        jsPath: path.join('f', 'view.js'),
        cssPath: path.join('f', 'view.css'),
        routes: {},
      } as unknown as FeatureModule;

      const out = await html([], [feature]);

      expect(out).toContain('<p>cost: $&amp; $$</p>');
    });
  });

  it('leaves the placeholders empty when there are no plugins', async () => {
    const out = await html([]);
    expect(out).not.toContain('${pluginSubTabs}');
    expect(out).not.toContain('${pluginPanels}');
    expect(out).not.toContain('plugin-sub-tab');
  });

  // The unit tests above drive a synthetic template. This one uses the REAL
  // webviews/main.html and the REAL example plugin, so it fails if either
  // placeholder is dropped from the template, if the plugin module is removed
  // from WEBVIEW_MODULES, or if the example plugin stops parsing.
  describe('against the real template and example plugin', () => {
    const ROOT = path.resolve(__dirname, '../..');

    it('renders a Plugins tab wired to the example plugin', async () => {
      const plugins = new PluginRegistry(
        path.join(ROOT, 'force-cockpit', 'plugins'),
        path.join(ROOT, 'force-cockpit', 'private', 'plugins'),
      ).list();

      const out = await new WebviewAssets(
        { extensionPath: ROOT } as unknown as import('vscode').ExtensionContext,
        webview(),
        [],
        plugins,
      ).getHtml();

      // No placeholder survives substitution.
      expect(out).not.toMatch(/\$\{[a-zA-Z]+\}/);
      expect(out).toContain('data-tab="plugins"');
      expect(out).toContain('data-plugin-tab="apex-jobs"');
      expect(out).toContain('id="plugin-sub-tab-apex-jobs"');
      expect(out).toContain('id="apex-jobs-refresh"');
      expect(out).toContain('media/modules/plugin-api.js');

      // The plugin's module tag carries the same nonce as the core modules —
      // without it the panel CSP (`script-src 'nonce-...'`) drops it silently.
      const nonce = /nonce="([a-f0-9]{32})"/.exec(out)?.[1];
      expect(nonce).toBeTruthy();
      expect(out).toContain(`<script type="module" nonce="${nonce}"`);
    });
  });
});
