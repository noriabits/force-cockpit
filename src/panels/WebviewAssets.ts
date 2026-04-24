// Builds the webview HTML: reads the main.html template, collects feature
// HTML/CSS/JS fragments, and injects the core webview module scripts.
// No webview lifecycle concerns — MainPanel keeps those.

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import type { FeatureModule } from '../features/FeatureModule';

interface FeatureAssetResult {
  tabFragments: Record<string, string>;
  linkTags: string[];
  scriptTags: string[];
}

export class WebviewAssets {
  // Webview core modules loaded synchronously before main.js. Order matters:
  // ipc.js sets up the dispatch registry everything else registers with, so it
  // must come first. main.js (the bootstrap that posts `ready`) runs last.
  static readonly WEBVIEW_MODULES: readonly string[] = [
    'ipc.js',
    'action-tracker.js',
    'confirmation.js',
    'org-lifecycle.js',
    'storage-bars.js',
    'query-editor.js',
    'tabs.js',
    'utils-subtab.js',
    'accordion.js',
    'filter.js',
    'paste-buttons.js',
  ];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly webview: vscode.Webview,
    private readonly features: FeatureModule[],
  ) {}

  async getHtml(): Promise<string> {
    const nonce = this._nonce();
    const uris = this._buildUris();

    const [mainHtml, featureAssets] = await Promise.all([
      fs.promises.readFile(uris.htmlPath, 'utf8'),
      this._collectFeatureAssets(nonce),
    ]);

    const webviewModuleTags = this._buildWebviewModuleTags(nonce);

    let html = mainHtml
      .replace(/\$\{nonce\}/g, nonce)
      .replace(/\$\{cssUri\}/g, uris.css)
      .replace(/\$\{jsUri\}/g, uris.js)
      .replace(/\$\{chartJsUri\}/g, uris.chartJs)
      .replace(/\$\{highlightJsUri\}/g, uris.highlightJs)
      .replace(/\$\{webviewModules\}/g, webviewModuleTags)
      .replace(/\$\{cspSource\}/g, this.webview.cspSource)
      .replace(/\$\{logoUri\}/g, uris.logo)
      .replace(/\$\{panelTitle\}/g, 'Force Cockpit');

    for (const [tab, fragments] of Object.entries(featureAssets.tabFragments)) {
      html = html.replace(`<!-- features:${tab} -->`, fragments);
    }

    html = html.replace('</head>', featureAssets.linkTags.join('\n') + '\n</head>');
    html = html.replace('</body>', featureAssets.scriptTags.join('\n') + '\n</body>');

    return html;
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  private _nonce(): string {
    return crypto.randomBytes(16).toString('hex');
  }

  private _fileUri(...parts: string[]): string {
    return this.webview
      .asWebviewUri(vscode.Uri.file(path.join(this.context.extensionPath, ...parts)))
      .toString();
  }

  private _buildUris() {
    return {
      htmlPath: path.join(this.context.extensionPath, 'webviews', 'main.html'),
      css: this._fileUri('media', 'main.css'),
      js: this._fileUri('media', 'main.js'),
      chartJs: this._fileUri('dist', 'vendor', 'chart.umd.js'),
      highlightJs: this._fileUri('dist', 'vendor', 'highlightjs.bundle.js'),
      logo: this._fileUri('media', 'fc-logo.png'),
    };
  }

  private _buildWebviewModuleTags(nonce: string): string {
    return WebviewAssets.WEBVIEW_MODULES.map(
      (name) =>
        `<script nonce="${nonce}" src="${this._fileUri('media', 'modules', name)}"></script>`,
    ).join('\n    ');
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
