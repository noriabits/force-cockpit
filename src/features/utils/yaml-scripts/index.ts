import * as path from 'path';
import * as vscode from 'vscode';
import type { ConnectionManager } from '../../../salesforce/connection';
import type { FeatureModule, FeatureModuleFactory } from '../../FeatureModule';
import { YamlScriptsService, type SaveScriptInput } from './YamlScriptsService';

export function createYamlScriptsFeature(paths: {
  builtInPath: string;
  userPath: string;
  privatePath: string;
  workspaceRoot: string;
  workspaceState: vscode.Memento;
}): FeatureModuleFactory {
  return (connectionManager: ConnectionManager): FeatureModule => {
    const service = new YamlScriptsService(connectionManager, paths);
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
        executeYamlScript: {
          handler: async (msg, signal, onChunk) => {
            const scriptId = msg.scriptId as string;
            const inputValues = (msg.inputs ?? {}) as Record<string, string>;
            const scripts = await service.loadScripts();
            return service.executeScript(scriptId, scripts, inputValues, signal, onChunk);
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
