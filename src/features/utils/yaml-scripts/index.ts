import * as path from 'path';
import * as vscode from 'vscode';
import type { ConnectionManager } from '../../../salesforce/connection';
import type { DescribeService } from '../../../services/DescribeService';
import type { FeatureModule, FeatureModuleFactory } from '../../FeatureModule';
import { YamlScriptsService, type SaveScriptInput } from './YamlScriptsService';
import { VsCodeLmGateway } from './execution/ai/LmGateway';
import { VsCodeWorkspaceSearch } from './execution/ai/WorkspaceSearch';
import { SkillsRepository } from './skills/SkillsRepository';

export function createYamlScriptsFeature(paths: {
  builtInPath: string;
  userPath: string;
  privatePath: string;
  workspaceRoot: string;
  workspaceState: vscode.Memento;
  skillsPaths: string[];
  describeService: DescribeService;
  /** Push an out-of-band message to the webview (e.g. editor-save → form sync). */
  postToWebview: (message: unknown) => void;
}): FeatureModuleFactory {
  return (connectionManager: ConnectionManager): FeatureModule => {
    const gateway = new VsCodeLmGateway();
    const skillsRepo = new SkillsRepository(paths.workspaceRoot, paths.skillsPaths);
    const workspaceSearch = new VsCodeWorkspaceSearch();
    const service = new YamlScriptsService(
      connectionManager,
      paths,
      gateway,
      skillsRepo,
      paths.describeService,
      workspaceSearch,
    );
    // Back the "Open as markdown" preview with a read-only virtual document so no
    // raw-source editor is opened. A *fresh* URI is minted per click (the version
    // lives in the query, keeping the tab title clean): a never-seen URI bypasses
    // VSCode's content-provider cache (firing onDidChange does not reliably
    // re-fetch), guaranteeing the latest result is rendered. The unlocked Markdown
    // preview matches on column only, so the same preview tab is reused and simply
    // switched to the new URI — no tab piles up.
    const RESULT_SCHEME = 'force-cockpit-ai-result';
    const resultContents = new Map<string, string>();
    // path → previous uri.toString(), so we can evict the prior version per script
    // and keep the map to one entry each.
    const lastUriByPath = new Map<string, string>();
    let resultVersion = 0;
    vscode.workspace.registerTextDocumentContentProvider(RESULT_SCHEME, {
      provideTextDocumentContent: (uri) => resultContents.get(uri.toString()) ?? '',
    });

    // ── "Open in editor": editable virtual buffer for the script code body ──
    // An in-memory FileSystemProvider gives a real Ctrl+S → writeFile hook with no
    // "Save As" dialog and no temp files on disk. The editor edits only the code
    // string; on save we push `scriptCodeUpdated` back to the form (YAML persistence
    // stays on the form's Save button). A fresh URI is minted per click (version in
    // the query) so seed content always lands in a clean buffer, and the prior buffer
    // for the same title is evicted (one entry per script title) — mirrors the
    // markdown-preview provider above.
    const EDIT_SCHEME = 'force-cockpit-script-edit';
    const editBuffers = new Map<string, { content: Uint8Array; mtime: number }>();
    const lastEditUriByPath = new Map<string, string>();
    let editVersion = 0;
    const editEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    vscode.workspace.registerFileSystemProvider(
      EDIT_SCHEME,
      {
        onDidChangeFile: editEmitter.event,
        watch: () => new vscode.Disposable(() => {}),
        stat: (uri) => {
          const buf = editBuffers.get(uri.toString());
          if (!buf) throw vscode.FileSystemError.FileNotFound(uri);
          return {
            type: vscode.FileType.File,
            ctime: 0,
            mtime: buf.mtime,
            size: buf.content.byteLength,
          };
        },
        readFile: (uri) => {
          const buf = editBuffers.get(uri.toString());
          if (!buf) throw vscode.FileSystemError.FileNotFound(uri);
          return buf.content;
        },
        writeFile: (uri, content) => {
          editBuffers.set(uri.toString(), { content, mtime: Date.now() });
          editEmitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
          paths.postToWebview({
            type: 'scriptCodeUpdated',
            data: { code: Buffer.from(content).toString('utf8') },
          });
        },
        readDirectory: () => {
          throw vscode.FileSystemError.NoPermissions();
        },
        createDirectory: () => {
          throw vscode.FileSystemError.NoPermissions();
        },
        delete: () => {
          throw vscode.FileSystemError.NoPermissions();
        },
        rename: () => {
          throw vscode.FileSystemError.NoPermissions();
        },
      },
      { isCaseSensitive: true },
    );

    const base = path.join('dist', 'features', 'utils', 'yaml-scripts');
    return {
      id: 'yaml-scripts',
      tab: 'utils-scripts',
      htmlPath: path.join(base, 'view.html'),
      jsPath: path.join(base, 'view.js'),
      cssPath: path.join(base, 'view.css'),
      labelsPath: path.join(base, 'labels.js'),
      routes: {
        loadYamlScripts: {
          handler: async () => ({ scripts: await service.loadScripts() }),
          successType: 'loadYamlScriptsResult',
          errorType: 'loadYamlScriptsError',
        },
        listChatModels: {
          handler: async () => ({ models: await gateway.listModels() }),
          successType: 'listChatModelsResult',
          errorType: 'listChatModelsError',
        },
        listSkills: {
          handler: async () => ({ skills: skillsRepo.listSkills() }),
          successType: 'listSkillsResult',
          errorType: 'listSkillsError',
        },
        executeYamlScript: {
          handler: async (msg, signal, onChunk) => {
            const scriptId = msg.scriptId as string;
            const inputValues = (msg.inputs ?? {}) as Record<string, string>;
            const scripts = await service.loadScripts();
            // Warn as soon as the fallback is detected (before the analysis
            // runs) so the user can cancel and pick a different model.
            const onModelFallback = ({
              requestedId,
              usedModelName,
            }: {
              requestedId: string;
              usedModelName: string;
            }) => {
              const scriptName = scripts.find((s) => s.id === scriptId)?.name ?? scriptId;
              void vscode.window.showWarningMessage(
                `The model "${requestedId}" chosen for "${scriptName}" is no longer available. ` +
                  `Using "${usedModelName}" instead.`,
              );
            };
            return await service.executeScript(
              scriptId,
              scripts,
              inputValues,
              signal,
              onChunk,
              onModelFallback,
            );
          },
          successType: 'executeYamlScriptResult',
          errorType: 'executeYamlScriptError',
        },
        saveYamlScript: {
          handler: async (msg) => {
            const saved = service.saveScript(
              msg.input as SaveScriptInput,
              msg.isPrivate as boolean,
            );
            return { script: saved };
          },
          successType: 'saveYamlScriptResult',
          errorType: 'saveYamlScriptError',
        },
        updateYamlScript: {
          handler: async (msg) => {
            const updated = service.updateScript(
              msg.oldScriptId as string,
              msg.input as SaveScriptInput,
              msg.isPrivate as boolean,
              msg.wasPrivate as boolean,
            );
            return { script: updated };
          },
          successType: 'updateYamlScriptResult',
          errorType: 'updateYamlScriptError',
        },
        browseForScriptFile: {
          handler: async () => {
            const workspaceRoot = paths.workspaceRoot;
            const defaultUri = workspaceRoot ? vscode.Uri.file(workspaceRoot) : undefined;
            const result = await vscode.window.showOpenDialog({
              defaultUri,
              canSelectMany: false,
              openLabel: 'Select Script File',
            });
            if (!result || result.length === 0) return { cancelled: true };
            const selected = result[0].fsPath;
            const rel = path.relative(workspaceRoot, selected).replace(/\\/g, '/');
            return { cancelled: false, filePath: rel };
          },
          successType: 'browseForScriptFileResult',
          errorType: 'browseForScriptFileError',
        },
        openScriptFile: {
          handler: async (msg) => {
            const filePath = msg.filePath as string;
            const absPath = path.resolve(paths.workspaceRoot, filePath);
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(absPath));
            await vscode.window.showTextDocument(doc);
            return {};
          },
          successType: 'openScriptFileResult',
          errorType: 'openScriptFileError',
        },
        editScriptCode: {
          handler: async (msg) => {
            const code = (msg.code as string) ?? '';
            const scriptType = (msg.scriptType as string) ?? 'apex';
            const extByType: Record<string, string> = {
              apex: 'cls',
              js: 'js',
              command: 'sh',
              ai: 'md',
            };
            const ext = extByType[scriptType] ?? 'txt';
            const title = ((msg.name as string) || '').replace(/[\\/]/g, '_').trim() || 'script';
            const uri = vscode.Uri.from({
              scheme: EDIT_SCHEME,
              path: `/${title}.${ext}`,
              query: `v=${++editVersion}`,
            });
            const prev = lastEditUriByPath.get(uri.path);
            if (prev) editBuffers.delete(prev);
            editBuffers.set(uri.toString(), {
              content: Buffer.from(code, 'utf8'),
              mtime: Date.now(),
            });
            lastEditUriByPath.set(uri.path, uri.toString());
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc, { preview: false });
            return {};
          },
          successType: 'editScriptCodeDone',
          errorType: 'editScriptCodeError',
        },
        openScriptResult: {
          handler: async (msg) => {
            const content = msg.content as string;
            const doc = await vscode.workspace.openTextDocument({ content, language: 'plaintext' });
            await vscode.window.showTextDocument(doc);
            return {};
          },
          successType: 'openScriptResultDone',
          errorType: 'openScriptResultError',
        },
        openScriptResultMarkdown: {
          handler: async (msg) => {
            const content = msg.content as string;
            // `path` carries the script title (drives the tab name); `query` carries
            // the version so each run gets a unique, never-cached URI. The `.md`
            // suffix makes VSCode treat it as markdown.
            const title = (
              (msg.title as string) ||
              (msg.scriptId as string) ||
              'AI result'
            ).replace(/[\\/]/g, '_');
            const uri = vscode.Uri.from({
              scheme: RESULT_SCHEME,
              path: `/${title}.md`,
              query: `v=${++resultVersion}`,
            });
            const prev = lastUriByPath.get(uri.path);
            if (prev) resultContents.delete(prev);
            resultContents.set(uri.toString(), content);
            lastUriByPath.set(uri.path, uri.toString());
            await vscode.workspace.openTextDocument(uri);
            await vscode.commands.executeCommand('markdown.showPreview', uri);
            return {};
          },
          successType: 'openScriptResultMarkdownDone',
          errorType: 'openScriptResultMarkdownError',
        },
        loadFavorites: {
          handler: async () => {
            const favorites: string[] = paths.workspaceState.get('yamlScripts.favorites', []);
            return { favorites };
          },
          successType: 'loadFavoritesResult',
          errorType: 'loadFavoritesError',
        },
        toggleFavorite: {
          handler: async (msg) => {
            const scriptId = msg.scriptId as string;
            const favorites: string[] = paths.workspaceState.get('yamlScripts.favorites', []);
            const index = favorites.indexOf(scriptId);
            if (index >= 0) {
              favorites.splice(index, 1);
            } else {
              favorites.push(scriptId);
            }
            await paths.workspaceState.update('yamlScripts.favorites', favorites);
            return { favorites };
          },
          successType: 'toggleFavoriteResult',
          errorType: 'toggleFavoriteError',
        },
        deleteYamlScript: {
          handler: async (msg) => {
            const confirmed = await vscode.window.showWarningMessage(
              `Delete "${msg.scriptName as string}"? This cannot be undone.`,
              { modal: true },
              'Delete',
            );
            if (confirmed !== 'Delete') return { deleted: false };
            service.deleteScript(msg.scriptId as string, msg.isPrivate as boolean);
            return { deleted: true };
          },
          successType: 'deleteYamlScriptResult',
          errorType: 'deleteYamlScriptError',
        },
      },
    };
  };
}
