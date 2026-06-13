import { describe, expect, it, vi } from 'vitest';
import type { ConnectionManager } from '../../../../../salesforce/connection';
import { DescribeService } from '../../../../../services/DescribeService';
import type { SkillInfo, SkillsRepository } from '../../skills/SkillsRepository';
import type { YamlScript } from '../../types';
import { AiExecutor } from './AiExecutor';
import type { ChatEvent, ChatRequest, LmGateway, WorkspaceSearch } from './types';

/** Build an AiExecutor whose describe path goes through a real (memory-only) DescribeService over the same cm. */
function makeExecutor(
  cm: ConnectionManager,
  gw: LmGateway,
  skills: SkillsRepository,
  workspaceSearch?: WorkspaceSearch,
): AiExecutor {
  return new AiExecutor(cm, gw, skills, new DescribeService(cm), workspaceSearch);
}

/**
 * A WorkspaceSearch stub. `files` maps a relative path → content; searchFiles
 * regex-matches the file name, readFile looks one up.
 */
function fakeWorkspaceSearch(files: Record<string, string> = {}): WorkspaceSearch {
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
function fakeSkills(list: SkillInfo[] = [], bodies: Record<string, string> = {}): SkillsRepository {
  return {
    listSkills: () => list,
    readSkill: (id: string) => bodies[id] ?? null,
  } as unknown as SkillsRepository;
}

/** A scriptable LmGateway: each entry in `scripted` is the events for one send() call. */
class FakeGateway implements LmGateway {
  public readonly sends: ChatRequest[] = [];
  constructor(private readonly scripted: ChatEvent[][]) {}
  async listModels() {
    return [];
  }
  async *send(req: ChatRequest): AsyncIterable<ChatEvent> {
    // Snapshot the messages — AiExecutor mutates the same array across rounds.
    this.sends.push({
      modelId: req.modelId,
      tools: req.tools,
      messages: req.messages.map((m) => ({ ...m })),
    });
    for (const e of this.scripted[this.sends.length - 1] ?? []) yield e;
  }
}

function makeCM(overrides: Partial<ConnectionManager> = {}): ConnectionManager {
  return {
    query: vi.fn(async () => ({
      records: [{ Id: '001', Name: 'Acme' }],
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
  } as unknown as ConnectionManager;
}

function aiScript(over: Partial<YamlScript> = {}): YamlScript {
  return {
    id: 'ai/x',
    folder: 'ai',
    name: 'X',
    description: '',
    type: 'ai',
    script: 'Analyse it.',
    source: 'user',
    gather: { kind: 'soql', value: 'SELECT Id FROM Account' },
    ...over,
  };
}

describe('AiExecutor', () => {
  it('runs a soql gather, embeds the data, and streams the analysis', async () => {
    const cm = makeCM();
    const gw = new FakeGateway([
      [
        { kind: 'text', text: 'Hello ' },
        { kind: 'text', text: 'world' },
      ],
    ]);
    const chunks: string[] = [];
    const result = await makeExecutor(cm, gw, fakeSkills()).execute(aiScript(), undefined, (c) =>
      chunks.push(c),
    );

    expect(cm.query).toHaveBeenCalledWith('SELECT Id FROM Account');
    expect(result.success).toBe(true);
    expect(result.debugLog).toContain('Hello world');
    expect(chunks.join('')).toContain('Hello world');
    expect(gw.sends[0].messages[0].text).toContain('Acme'); // gather data in the prompt
    expect(gw.sends[0].tools).toHaveLength(1); // describe_object only, no follow-up
    expect(gw.sends[0].tools[0].name).toBe('describe_object');
  });

  it('runs an apex gather and surfaces its debug output', async () => {
    const cm = makeCM();
    const gw = new FakeGateway([[{ kind: 'text', text: 'ok' }]]);
    const result = await makeExecutor(cm, gw, fakeSkills()).execute(
      aiScript({ gather: { kind: 'apex', value: 'System.debug(1);' } }),
    );
    expect(cm.executeAnonymousWithDebugLog).toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(gw.sends[0].messages[0].text).toContain('payload-from-apex');
  });

  it('fences the gathered data dump in the transcript (```json for soql)', async () => {
    const cm = makeCM();
    const gw = new FakeGateway([[{ kind: 'text', text: 'ok' }]]);
    const result = await makeExecutor(cm, gw, fakeSkills()).execute(aiScript());
    expect(result.debugLog).toMatch(/```json\n[\s\S]*Acme[\s\S]*\n```/);
  });

  it('fences the apex gather data dump with a plain ``` block', async () => {
    const cm = makeCM();
    const gw = new FakeGateway([[{ kind: 'text', text: 'ok' }]]);
    const result = await makeExecutor(cm, gw, fakeSkills()).execute(
      aiScript({ gather: { kind: 'apex', value: 'System.debug(1);' } }),
    );
    expect(result.debugLog).toMatch(/```\n[\s\S]*payload-from-apex[\s\S]*\n```/);
    expect(result.debugLog).not.toContain('```json');
  });

  it('runs an input/prompt-only script with no gather step', async () => {
    const cm = makeCM();
    const gw = new FakeGateway([[{ kind: 'text', text: 'answer' }]]);
    const chunks: string[] = [];
    const result = await makeExecutor(cm, gw, fakeSkills()).execute(
      aiScript({ gather: undefined, script: 'Generate the SELECT Id FROM Account query.' }),
      undefined,
      (c) => chunks.push(c),
    );

    expect(cm.query).not.toHaveBeenCalled(); // no gather ran
    expect(cm.executeAnonymousWithDebugLog).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(chunks.join('')).not.toContain('# Gathering data');
    const prompt = gw.sends[0].messages[0].text;
    expect(prompt).not.toContain('## Gathered data');
    expect(prompt).toContain('Generate the SELECT Id FROM Account query.');
    expect(gw.sends[0].tools.map((t) => t.name)).toContain('describe_object');
  });

  it('fails cleanly when the apex gather does not compile', async () => {
    const cm = makeCM({
      executeAnonymousWithDebugLog: vi.fn(async () => ({
        compiled: false,
        success: false,
        compileProblem: 'bad apex',
        exceptionMessage: null,
        exceptionStackTrace: null,
        debugLog: '',
      })),
    } as unknown as Partial<ConnectionManager>);
    const result = await makeExecutor(cm, new FakeGateway([[]]), fakeSkills()).execute(
      aiScript({ gather: { kind: 'apex', value: 'x' } }),
    );
    expect(result.success).toBe(false);
    expect(result.message).toContain('bad apex');
  });

  it('offers and runs the run_soql tool when follow-up is allowed', async () => {
    const cm = makeCM();
    const gw = new FakeGateway([
      [
        {
          kind: 'toolCall',
          call: { callId: 'c1', name: 'run_soql', input: { soql: 'SELECT Id FROM Contact' } },
        },
      ],
      [{ kind: 'text', text: 'done' }],
    ]);
    const result = await makeExecutor(cm, gw, fakeSkills()).execute(
      aiScript({ allowFollowupQueries: true }),
    );

    expect(cm.query).toHaveBeenCalledTimes(2); // gather + follow-up
    expect(cm.query).toHaveBeenLastCalledWith('SELECT Id FROM Contact');
    expect(gw.sends[0].tools).toHaveLength(2);
    expect(gw.sends[0].tools.map((t) => t.name)).toContain('describe_object');
    expect(gw.sends[0].tools.map((t) => t.name)).toContain('run_soql');
    const round2 = gw.sends[1].messages;
    expect(round2.some((m) => m.role === 'assistant' && 'toolCalls' in m && m.toolCalls)).toBe(
      true,
    );
    expect(round2.some((m) => m.role === 'toolResult' && m.callId === 'c1')).toBe(true);
    expect(result.success).toBe(true);
  });

  it('offers only describe_object when follow-up is disabled', async () => {
    const gw = new FakeGateway([[{ kind: 'text', text: 'x' }]]);
    await makeExecutor(makeCM(), gw, fakeSkills()).execute(aiScript());
    expect(gw.sends[0].tools).toHaveLength(1);
    expect(gw.sends[0].tools[0].name).toBe('describe_object');
  });

  it('calls describeSObject and returns a compact field list', async () => {
    const cm = makeCM();
    const gw = new FakeGateway([
      [
        {
          kind: 'toolCall',
          call: { callId: 'd1', name: 'describe_object', input: { objectName: 'Account' } },
        },
      ],
      [{ kind: 'text', text: 'done' }],
    ]);
    const result = await makeExecutor(cm, gw, fakeSkills()).execute(aiScript());

    expect(cm.describeSObject).toHaveBeenCalledWith('Account');
    expect(result.success).toBe(true);
    const toolResult = gw.sends[1].messages.find((m) => m.role === 'toolResult');
    const content = toolResult && 'content' in toolResult ? toolResult.content : '';
    expect(content).toContain('"objectName": "Account"');
    expect(content).toContain('"name": "Id"');
  });

  it('blocks a non-SELECT follow-up query and feeds the rejection back', async () => {
    const cm = makeCM();
    const gw = new FakeGateway([
      [
        {
          kind: 'toolCall',
          call: { callId: 'c1', name: 'run_soql', input: { soql: 'DELETE FROM Account' } },
        },
      ],
      [{ kind: 'text', text: 'understood' }],
    ]);
    await makeExecutor(cm, gw, fakeSkills()).execute(aiScript({ allowFollowupQueries: true }));

    expect(cm.query).toHaveBeenCalledTimes(1); // gather only — the DELETE never ran
    const toolResult = gw.sends[1].messages.find((m) => m.role === 'toolResult');
    expect(toolResult && 'content' in toolResult ? toolResult.content : '').toMatch(
      /only SELECT\/SOQL queries are allowed/i,
    );
  });

  it('injects the skills catalogue + read_skill tool only when skills are selected', async () => {
    const skills = fakeSkills(
      [
        { id: 'data-quality', name: 'Data Quality', description: 'check completeness' },
        { id: 'naming', name: 'Naming', description: 'naming rules' },
      ],
      { 'data-quality': 'DQ body', naming: 'NAMING body' },
    );
    const gw = new FakeGateway([[{ kind: 'text', text: 'x' }]]);
    await makeExecutor(makeCM(), gw, skills).execute(aiScript({ skills: ['data-quality'] }));

    // Only the selected skill appears in the catalogue, with its description.
    expect(gw.sends[0].messages[0].text).toContain('## Available skills');
    expect(gw.sends[0].messages[0].text).toContain('data-quality: check completeness');
    expect(gw.sends[0].messages[0].text).not.toContain('naming: naming rules');
    expect(gw.sends[0].tools.map((t) => t.name)).toContain('read_skill');
  });

  it('does not offer read_skill when no skills are selected', async () => {
    const gw = new FakeGateway([[{ kind: 'text', text: 'x' }]]);
    await makeExecutor(makeCM(), gw, fakeSkills()).execute(aiScript());
    expect(gw.sends[0].messages[0].text).not.toContain('## Available skills');
    expect(gw.sends[0].tools.map((t) => t.name)).not.toContain('read_skill');
  });

  it('reads a skill body and feeds it back as a tool result', async () => {
    const skills = fakeSkills([{ id: 'dq', name: 'DQ', description: 'd' }], {
      dq: 'THE SKILL BODY',
    });
    const gw = new FakeGateway([
      [{ kind: 'toolCall', call: { callId: 's1', name: 'read_skill', input: { skillId: 'dq' } } }],
      [{ kind: 'text', text: 'done' }],
    ]);
    await makeExecutor(makeCM(), gw, skills).execute(aiScript({ skills: ['dq'] }));

    const toolResult = gw.sends[1].messages.find((m) => m.role === 'toolResult');
    expect(toolResult && 'content' in toolResult ? toolResult.content : '').toBe('THE SKILL BODY');
  });

  it('feeds back an error for an unknown skill id', async () => {
    const skills = fakeSkills([{ id: 'dq', name: 'DQ', description: 'd' }], { dq: 'body' });
    const gw = new FakeGateway([
      [
        {
          kind: 'toolCall',
          call: { callId: 's1', name: 'read_skill', input: { skillId: 'nope' } },
        },
      ],
      [{ kind: 'text', text: 'done' }],
    ]);
    await makeExecutor(makeCM(), gw, skills).execute(aiScript({ skills: ['dq'] }));

    const toolResult = gw.sends[1].messages.find((m) => m.role === 'toolResult');
    expect(toolResult && 'content' in toolResult ? toolResult.content : '').toMatch(
      /unknown skill/i,
    );
  });

  it('does not offer the workspace-file tools unless the flag and a workspace search are present', async () => {
    // Flag off, search present → absent.
    const gw1 = new FakeGateway([[{ kind: 'text', text: 'x' }]]);
    await makeExecutor(makeCM(), gw1, fakeSkills(), fakeWorkspaceSearch()).execute(aiScript());
    const names1 = gw1.sends[0].tools.map((t) => t.name);
    expect(names1).not.toContain('search_workspace_files');
    expect(names1).not.toContain('read_workspace_file');

    // Flag on, no search wired → still absent (cannot run without it).
    const gw2 = new FakeGateway([[{ kind: 'text', text: 'x' }]]);
    await makeExecutor(makeCM(), gw2, fakeSkills()).execute(
      aiScript({ allowReadWorkspaceFiles: true }),
    );
    const names2 = gw2.sends[0].tools.map((t) => t.name);
    expect(names2).not.toContain('search_workspace_files');
    expect(names2).not.toContain('read_workspace_file');
  });

  it('offers the workspace-file tools and feeds search results + file source back', async () => {
    const search = fakeWorkspaceSearch({
      'force-app/main/default/classes/OrderSelector.cls': 'public class OrderSelector {}',
      'force-app/main/default/classes/AccountSelector.cls': 'public class AccountSelector {}',
    });
    const gw = new FakeGateway([
      [
        {
          kind: 'toolCall',
          call: { callId: 's1', name: 'search_workspace_files', input: { pattern: 'Selector' } },
        },
      ],
      [
        {
          kind: 'toolCall',
          call: {
            callId: 'r1',
            name: 'read_workspace_file',
            input: { path: 'force-app/main/default/classes/OrderSelector.cls' },
          },
        },
      ],
      [{ kind: 'text', text: 'done' }],
    ]);
    const result = await makeExecutor(makeCM(), gw, fakeSkills(), search).execute(
      aiScript({ allowReadWorkspaceFiles: true }),
    );

    const names = gw.sends[0].tools.map((t) => t.name);
    expect(names).toContain('search_workspace_files');
    expect(names).toContain('read_workspace_file');

    // Round 2: the search result lists both matching paths.
    const searchResult = gw.sends[1].messages.find((m) => m.role === 'toolResult');
    const searchContent = searchResult && 'content' in searchResult ? searchResult.content : '';
    expect(searchContent).toContain('OrderSelector.cls');
    expect(searchContent).toContain('AccountSelector.cls');

    // Round 3: the read result carries the file content.
    const readResult = gw.sends[2].messages.find(
      (m) => m.role === 'toolResult' && m.callId === 'r1',
    );
    const readContent = readResult && 'content' in readResult ? readResult.content : '';
    expect(readContent).toContain('public class OrderSelector {}');
    expect(result.success).toBe(true);
  });

  it('matches workspace files by regex against the file name', async () => {
    const search = fakeWorkspaceSearch({
      'classes/OrderSelector.cls': 'a',
      'classes/OrderService.cls': 'b',
    });
    const gw = new FakeGateway([
      [
        {
          kind: 'toolCall',
          call: {
            callId: 's1',
            name: 'search_workspace_files',
            input: { pattern: 'Selector\\.cls$' },
          },
        },
      ],
      [{ kind: 'text', text: 'done' }],
    ]);
    await makeExecutor(makeCM(), gw, fakeSkills(), search).execute(
      aiScript({ allowReadWorkspaceFiles: true }),
    );

    const searchResult = gw.sends[1].messages.find((m) => m.role === 'toolResult');
    const content = searchResult && 'content' in searchResult ? searchResult.content : '';
    expect(content).toContain('OrderSelector.cls');
    expect(content).not.toContain('OrderService.cls');
  });

  it('feeds back an error when the requested file is not found', async () => {
    const gw = new FakeGateway([
      [
        {
          kind: 'toolCall',
          call: { callId: 'r1', name: 'read_workspace_file', input: { path: 'Nope.cls' } },
        },
      ],
      [{ kind: 'text', text: 'done' }],
    ]);
    await makeExecutor(makeCM(), gw, fakeSkills(), fakeWorkspaceSearch()).execute(
      aiScript({ allowReadWorkspaceFiles: true }),
    );

    const toolResult = gw.sends[1].messages.find((m) => m.role === 'toolResult');
    expect(toolResult && 'content' in toolResult ? toolResult.content : '').toMatch(/not found/i);
  });

  it('returns cancelled when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const result = await makeExecutor(makeCM(), new FakeGateway([[]]), fakeSkills()).execute(
      aiScript(),
      ac.signal,
    );
    expect(result.cancelled).toBe(true);
  });
});
