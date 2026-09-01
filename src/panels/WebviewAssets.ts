// Builds the webview HTML: reads the main.html template, collects feature
// HTML/CSS/JS fragments, and injects the core webview module scripts.
// No webview lifecycle concerns — MainPanel keeps those.

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import type { FeatureModule } from '../features/FeatureModule';
import {
  VIEW_CSS_FILE,
  VIEW_HTML_FILE,
  VIEW_JS_FILE,
  type PluginInfo,
} from '../services/plugins/PluginRegistry';

interface FeatureAssetResult {
  tabFragments: Record<string, string>;
  linkTags: string[];
  scriptTags: string[];
}

interface PluginAssetResult {
  /** Sub-tab buttons for the Plugins tab bar. */
  subTabs: string;
  /** The matching sub-tab panels. */
  panels: string;
  linkTags: string[];
  scriptTags: string[];
}

/**
 * `String.prototype.replace` reads `$&`, `` $` ``, `$'` and `$$` in the
 * REPLACEMENT as patterns, so injecting author-written HTML as a plain string
 * silently splices the surrounding document into it. A replacer function is
 * passed the match instead and returns the text verbatim. Same class of bug
 * `PlaceholderResolver.substituteVars` already fixes for script placeholders —
 * and it applied to the feature fragments here long before plugins existed.
 */
function literal(text: string): () => string {
  return () => text;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export class WebviewAssets {
  // Webview core modules loaded synchronously before main.js. Order matters:
  // ipc.js sets up the dispatch registry everything else registers with, so it
  // must come first. main.js (the bootstrap that posts `ready`) runs last.
  // Paths are extension-root-relative so esbuild-bundled modules (under dist/)
  // can sit alongside the plain media/modules/ scripts.
  static readonly WEBVIEW_MODULES: readonly string[] = [
    'media/modules/ipc.js',
    'media/modules/tooltip.js',
    'media/modules/action-tracker.js',
    'media/modules/confirmation.js',
    'media/modules/org-lifecycle.js',
    'media/modules/storage-bars.js',
    'dist/webview/rest-call.js',
    'media/modules/tabs.js',
    'media/modules/utils-subtab.js',
    'media/modules/accordion.js',
    'media/modules/filter.js',
    'media/modules/paste-buttons.js',
    'media/modules/plugin-api.js',
  ];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly webview: vscode.Webview,
    private readonly features: FeatureModule[],
    private readonly plugins: PluginInfo[] = [],
  ) {}

  async getHtml(): Promise<string> {
    const nonce = this._nonce();
    const uris = this._buildUris();

    const [mainHtml, featureAssets, pluginAssets] = await Promise.all([
      fs.promises.readFile(uris.htmlPath, 'utf8'),
      this._collectFeatureAssets(nonce),
      this._collectPluginAssets(nonce),
    ]);

    const webviewModuleTags = this._buildWebviewModuleTags(nonce);

    let html = mainHtml
      .replace(/\$\{nonce\}/g, nonce)
      .replace(/\$\{cssUri\}/g, uris.css)
      .replace(/\$\{jsUri\}/g, uris.js)
      .replace(/\$\{chartJsUri\}/g, uris.chartJs)
      .replace(/\$\{webviewModules\}/g, webviewModuleTags)
      .replace(/\$\{cspSource\}/g, this.webview.cspSource)
      .replace(/\$\{logoUri\}/g, uris.logo)
      .replace(/\$\{panelTitle\}/g, 'Force Cockpit')
      // Author-written markup — see `literal` on why these two cannot be
      // replacement strings.
      .replace(/\$\{pluginSubTabs\}/g, literal(pluginAssets.subTabs))
      .replace(/\$\{pluginPanels\}/g, literal(pluginAssets.panels));

    for (const tab of Object.keys(featureAssets.tabFragments)) {
      html = html.replace(`<!-- features:${tab} -->`, literal(featureAssets.tabFragments[tab]));
    }

    const linkTags = [...featureAssets.linkTags, ...pluginAssets.linkTags];
    const scriptTags = [...featureAssets.scriptTags, ...pluginAssets.scriptTags];
    html = html.replace('</head>', literal(linkTags.join('\n') + '\n</head>'));
    html = html.replace('</body>', literal(scriptTags.join('\n') + '\n</body>'));

    return html;
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  private _nonce(): string {
    return crypto.randomBytes(16).toString('hex');
  }

  private _fileUri(...parts: string[]): string {
    return this._absFileUri(path.join(this.context.extensionPath, ...parts));
  }

  /**
   * A plugin's assets live in the user's workspace, not the extension install
   * dir, so they cannot go through `_fileUri`. `MainPanel` adds the two plugin
   * dirs to `localResourceRoots`; without that this returns a URI the webview
   * refuses to load.
   */
  private _absFileUri(absPath: string): string {
    return this.webview.asWebviewUri(vscode.Uri.file(absPath)).toString();
  }

  private _buildUris() {
    return {
      htmlPath: path.join(this.context.extensionPath, 'webviews', 'main.html'),
      css: this._fileUri('media', 'main.css'),
      js: this._fileUri('media', 'main.js'),
      chartJs: this._fileUri('dist', 'vendor', 'chart.umd.js'),
      logo: this._fileUri('media', 'fc-logo.png'),
    };
  }

  private _buildWebviewModuleTags(nonce: string): string {
    return WebviewAssets.WEBVIEW_MODULES.map(
      (relPath) => `<script nonce="${nonce}" src="${this._fileUri(relPath)}"></script>`,
    ).join('\n    ');
  }

  /**
   * Build the Plugins tab's sub-tabs and panels from user-authored folders.
   *
   * Every read is individually guarded. Unlike a feature, whose assets ship
   * inside the VSIX, a plugin's files are the user's and can be malformed,
   * unreadable, or deleted mid-session — and `_update()` only logs a rejected
   * `getHtml()`, leaving `webview.html` unset and the WHOLE panel blank. A
   * broken plugin must cost exactly one broken sub-tab.
   */
  private async _collectPluginAssets(nonce: string): Promise<PluginAssetResult> {
    const subTabs: string[] = [];
    const panels: string[] = [];
    const linkTags: string[] = [];
    const scriptTags: string[] = [];

    for (const plugin of this.plugins) {
      const label = `${plugin.icon ? escapeHtml(plugin.icon) + ' ' : ''}${escapeHtml(plugin.name)}`;
      const tooltip = escapeHtml(plugin.description || plugin.name);
      subTabs.push(
        `<button class="plugin-sub-tab" data-plugin-tab="${escapeHtml(plugin.id)}" ` +
          `data-tooltip="${tooltip}" aria-label="${tooltip}">${label}</button>`,
      );

      const body = plugin.invalid
        ? `<div class="error-box" style="display: block">${escapeHtml(plugin.error ?? 'This plugin could not be loaded.')}</div>`
        : await this._readPluginHtml(plugin);

      panels.push(
        `<div class="plugin-sub-tab-panel" id="plugin-sub-tab-${escapeHtml(plugin.id)}">${body}</div>`,
      );

      if (plugin.invalid) continue;

      if (fs.existsSync(path.join(plugin.dir, VIEW_CSS_FILE))) {
        linkTags.push(
          `<link rel="stylesheet" href="${this._absFileUri(path.join(plugin.dir, VIEW_CSS_FILE))}">`,
        );
      }
      if (fs.existsSync(path.join(plugin.dir, VIEW_JS_FILE))) {
        // A module, so a plugin can split its own code across relative imports —
        // they resolve under the plugin dir, which is already a resource root.
        scriptTags.push(
          `<script type="module" nonce="${nonce}" ` +
            `src="${this._absFileUri(path.join(plugin.dir, VIEW_JS_FILE))}"></script>`,
        );
      }
    }

    return { subTabs: subTabs.join('\n'), panels: panels.join('\n'), linkTags, scriptTags };
  }

  private async _readPluginHtml(plugin: PluginInfo): Promise<string> {
    try {
      return await fs.promises.readFile(path.join(plugin.dir, VIEW_HTML_FILE), 'utf8');
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return `<div class="error-box" style="display: block">Could not read ${VIEW_HTML_FILE}: ${escapeHtml(detail)}</div>`;
    }
  }

  private async _collectFeatureAssets(nonce: string): Promise<FeatureAssetResult> {
    const tabFragments: Record<string, string> = {};
    const linkTags: string[] = [];
    const scriptTags: string[] = [];

    const htmlContents = await Promise.all(
      this.features.map((f) =>
        fs.promises.readFile(path.join(this.context.extensionPath, f.htmlPath), 'utf8'),
      ),
    );

    for (let i = 0; i < this.features.length; i++) {
      const feature = this.features[i];
      tabFragments[feature.tab] = (tabFragments[feature.tab] ?? '') + htmlContents[i];

      linkTags.push(`<link rel="stylesheet" href="${this._fileUri(feature.cssPath)}">`);

      if (feature.labelsPath) {
        scriptTags.push(
          `<script nonce="${nonce}" src="${this._fileUri(feature.labelsPath)}" defer></script>`,
        );
      }
      scriptTags.push(
        `<script nonce="${nonce}" src="${this._fileUri(feature.jsPath)}" defer></script>`,
      );
    }

    return { tabFragments, linkTags, scriptTags };
  }
}
