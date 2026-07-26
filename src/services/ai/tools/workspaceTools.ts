// Workspace-file tools offered to the model: discover files by name, then read
// one. Both delegate to an injected WorkspaceSearch (traversal- and
// gitignore-guarded), so this module stays vscode-free.
import type { WorkspaceSearch } from '../types';
import { stringArg, type ToolHandler } from './ToolHandler';

export function createSearchWorkspaceFilesTool(workspaceSearch: WorkspaceSearch): ToolHandler {
  return {
    spec: {
      name: 'search_workspace_files',
      description:
        'Search the workspace for files by name. `pattern` is a case-insensitive ' +
        'JavaScript regular expression matched against the file name — a plain word ' +
        'works as a substring match (e.g. "Selector" finds OrderSelector.cls, ' +
        'AccountSelector.cls), or use regex syntax for more control (e.g. ' +
        '"^Account.*\\.cls$"). Returns a capped list of matching file paths (Apex ' +
        'classes/triggers, objects, fields, flows, LWC, permission sets — any ' +
        'Salesforce metadata or source file, excluding anything in .gitignore). Use ' +
        'this to discover files before reading them with read_workspace_file.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description:
              'A case-insensitive regular expression matched against the file name, e.g. "Selector" or "^Account.*\\.cls$".',
          },
        },
        required: ['pattern'],
      },
    },
    async run(input, append) {
      const pattern = stringArg(input, 'pattern');
      if (!pattern) return 'Error: no search pattern provided.';
      append(`\n\n[search_workspace_files] /${pattern}/\n`);
      const result = await workspaceSearch.searchFiles(pattern);
      if ('error' in result) {
        append(`→ error: ${result.error}\n\n`);
        return `Error searching workspace files: ${result.error}`;
      }
      append(`→ ${result.paths.length} match(es)${result.truncated ? ' (truncated)' : ''}\n\n`);
      return JSON.stringify({ pattern, paths: result.paths, truncated: result.truncated });
    },
  };
}

export function createReadWorkspaceFileTool(workspaceSearch: WorkspaceSearch): ToolHandler {
  return {
    spec: {
      name: 'read_workspace_file',
      description:
        'Read the full content of a single workspace file by its workspace-relative ' +
        'path (typically one returned by search_workspace_files). Use this to inspect ' +
        'code referenced in stack traces or any Salesforce metadata file you need. ' +
        'Files excluded by .gitignore cannot be read.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'The workspace-relative path to the file, e.g. "force-app/main/default/classes/OrderSelector.cls".',
          },
        },
        required: ['path'],
      },
    },
    async run(input, append) {
      const rel = stringArg(input, 'path');
      if (!rel) return 'Error: no file path provided.';
      append(`\n\n[read_workspace_file] ${rel}\n`);
      const result = await workspaceSearch.readFile(rel);
      if ('error' in result) {
        append(`→ error: ${result.error}\n\n`);
        return `Error reading workspace file: ${result.error}`;
      }
      append(`→ ${result.content.length} char(s) from ${result.path}\n\n`);
      return JSON.stringify({ path: result.path, content: result.content });
    },
  };
}
