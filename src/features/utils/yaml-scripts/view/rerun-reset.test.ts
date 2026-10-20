// @vitest-environment jsdom
// A script's accordion shows one run at a time. These pin the two ways an
// earlier run's failure used to land on top of a later one: the Execute button
// re-enabling mid-run, and a superseded run's late result still rendering.
import * as fs from 'fs';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let posts: any[];
let feature: any;
const inbound = new Map<string, (msg: any) => void>();

const SCRIPT = {
  id: 'sf-cli/x',
  folder: 'sf-cli',
  name: 'X',
  description: '',
  type: 'js',
  script: 'log(1)',
  source: 'user',
  inputs: [{ name: 'flag', type: 'checkbox' }],
};

beforeEach(async () => {
  posts = [];
  document.body.innerHTML = fs.readFileSync(path.join(__dirname, '..', 'view.html'), 'utf8');
  const w = window as any;
  w.__vscode = { postMessage: (m: any) => posts.push(m) };
  w.__escapeHtml = (s: string) => s;
  w.__setTooltip = () => {};
  w.__onMessage = (type: string, h: (msg: any) => void) => inbound.set(type, h);
  w.__registerFeature = (_id: string, h: any) => (feature = h);
  w.__confirmIfSensitive = (_o: any, _l: string, ok: () => void) => ok();
  (globalThis as any).CSS ??= { escape: (s: string) => s };
  vi.resetModules();
  await import('../../../../../media/modules/action-tracker.js');
  await import('../labels.js');
  await import('./index.js');
  feature.onOrgConnected({ username: 'me', sandboxName: 'dev' });
  deliver('loadYamlScriptsResult', { scripts: [SCRIPT] });
});

const deliver = (type: string, data: any) => feature.onMessage({ type, data });
const executeBtn = () => document.querySelector<HTMLButtonElement>('.yaml-execute-btn')!;
const output = () => document.querySelector<HTMLElement>('.yaml-log-output')!;
const errorBox = () => document.querySelector<HTMLElement>('.accordion .error-box')!;
const lastOpId = () => posts.filter((p) => p.type === 'executeYamlScript').at(-1).opId;
const fail = (opId: string) =>
  deliver('executeYamlScriptResult', {
    scriptId: SCRIPT.id,
    opId,
    success: false,
    message: 'Test run failed',
    debugLog: 'boom',
  });

describe('re-running a script', () => {
  it('clears the previous failure as soon as Execute is clicked', () => {
    executeBtn().click();
    fail(lastOpId());
    expect(output().classList.contains('yaml-log-output--error')).toBe(true);
    expect(errorBox().textContent).toBe('Test run failed');

    executeBtn().click();
    expect(output().classList.contains('yaml-log-output--error')).toBe(false);
    expect(errorBox().textContent).toBe('');
  });

  it('keeps Execute disabled when an input changes mid-run', () => {
    executeBtn().click();
    const flag = document.querySelector<HTMLInputElement>(
      '.yaml-inputs-form input[type="checkbox"]',
    )!;
    flag.click();
    expect(executeBtn().disabled).toBe(true);
  });

  it('ignores the late output of a run that was cancelled and re-run', async () => {
    executeBtn().click();
    const first = lastOpId();
    document.querySelector<HTMLButtonElement>('.action-cancel-btn')!.click();
    executeBtn().click();
    const second = lastOpId();

    deliver('scriptLogChunk', { opId: first, chunk: 'old run\n' });
    deliver('scriptLogChunk', { opId: second, chunk: 'new run\n' });
    fail(first);
    // Log chunks are painted once per animation frame.
    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(output().textContent).toBe('new run\n');
    expect(output().classList.contains('yaml-log-output--error')).toBe(false);
    expect(errorBox().textContent).toBe('');
    expect(executeBtn().disabled).toBe(true);
  });
});
