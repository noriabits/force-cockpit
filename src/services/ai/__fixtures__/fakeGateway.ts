// Shared test doubles for the AI layer, used by AiExecutor.test.ts (yaml-scripts)
// and AskAiService.test.ts (Overview tab) so both consumers of AiConversation
// exercise it against the same scriptable fakes instead of duplicating them.
import { vi } from 'vitest';
import type { SkillInfo, SkillsRepository } from '../../skills/SkillsRepository';
import type { ChatEvent, ChatRequest, LmGateway, WorkspaceSearch } from '../types';

/** A scriptable LmGateway: each entry in `scripted` is the events for one send() call. */
export class FakeGateway implements LmGateway {
  public readonly sends: ChatRequest[] = [];
  constructor(private readonly scripted: ChatEvent[][]) {}
  async listModels() {
    return [];
  }
  async *send(req: ChatRequest): AsyncIterable<ChatEvent> {
    // Snapshot the messages — AiConversation mutates the same array across rounds.
    this.sends.push({
      modelId: req.modelId,
      tools: req.tools,
      messages: req.messages.map((m) => ({ ...m })),
    });
    for (const e of this.scripted[this.sends.length - 1] ?? []) yield e;
  }
}

/**
 * A WorkspaceSearch stub. `files` maps a relative path → content; searchFiles
 * regex-matches the file name, readFile looks one up.
 */
export function fakeWorkspaceSearch(files: Record<string, string> = {}): WorkspaceSearch {
  const baseName = (p: string) => p.split('/').pop() ?? p;
  return {
    searchFiles: async (pattern: string) => {
      const re = new RegExp(pattern, 'i');
      const paths = Object.keys(files).filter((p) => re.test(baseName(p)));
      return { paths, truncated: false };
    },
    readFile: async (relPath: string) =>
      relPath in files
        ? { path: relPath, content: files[relPath] }
        : { error: `"${relPath}" not found` },
  };
}

/** A SkillsRepository stub: a catalogue + a body lookup, no filesystem. */
export function fakeSkills(
  list: SkillInfo[] = [],
  bodies: Record<string, string> = {},
): SkillsRepository {
  return {
    listSkills: () => list,
    readSkill: (id: string) => bodies[id] ?? null,
  } as unknown as SkillsRepository;
}

/** A minimal ConnectionManager stub covering the calls the AI layer makes. */
export function fakeConnectionManager(overrides: Record<string, unknown> = {}) {
  return {
    query: vi.fn(async () => ({
      records: [{ Id: '001', Name: 'Acme' }],
      totalSize: 1,
      done: true,
    })),
    toolingQuery: vi.fn(async () => ({
      records: [{ QualifiedApiName: 'My_Field__c', Label: 'My Field', DataType: 'Text(255)' }],
      totalSize: 1,
      done: true,
    })),
    executeAnonymousWithDebugLog: vi.fn(async () => ({
      compiled: true,
      success: true,
      compileProblem: null,
      exceptionMessage: null,
      exceptionStackTrace: null,
      debugLog: '12:00:00.0 (1)|USER_DEBUG|[1]|DEBUG|payload-from-apex',
    })),
    describeSObject: vi.fn(async (name: string) => ({
      name,
      label: name,
      fields: [
        { name: 'Id', label: 'Record ID', type: 'id', referenceTo: [] },
        { name: 'Name', label: `${name} Name`, type: 'string', referenceTo: [] },
      ],
    })),
    getCurrentOrg: () => ({ username: 'u@example.com' }),
    ...overrides,
  };
}
