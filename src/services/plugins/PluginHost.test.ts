import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginHost } from './PluginHost';
import { PluginRegistry } from './PluginRegistry';
import { createSensitiveGate } from './sensitiveGate';
import type { ConnectionManager } from '../../salesforce/connection';

function fakeConnectionManager(overrides: Partial<ConnectionManager> = {}): ConnectionManager {
  return {
    getConnection: () => null,
    getCurrentOrg: () => null,
    query: vi.fn().mockResolvedValue({ records: [{ Id: '001' }], totalSize: 1 }),
    executeAnonymousWithDebugLog: vi.fn().mockResolvedValue({ success: true }),
    ...overrides,
  } as unknown as ConnectionManager;
}

describe('PluginHost', () => {
  let tmp: string;
  let userDir: string;
  let privateDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-host-test-'));
    userDir = path.join(tmp, 'plugins');
    privateDir = path.join(tmp, 'private', 'plugins');
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function writePlugin(id: string, handlers: string | null, name = id): string {
    const dir = path.join(userDir, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'plugin.yaml'), `name: ${name}\n`, 'utf8');
    fs.writeFileSync(path.join(dir, 'view.html'), '<p>hi</p>', 'utf8');
    if (handlers !== null) fs.writeFileSync(path.join(dir, 'handlers.js'), handlers, 'utf8');
    return dir;
  }

  function makeHost(cm = fakeConnectionManager()) {
    const confirm = vi.fn().mockResolvedValue(true);
    const host = new PluginHost({
      connectionManager: cm,
      workspaceRoot: tmp,
      registry: new PluginRegistry(userDir, privateDir),
      gate: createSensitiveGate({ resolveOrgType: async () => 'sandbox', confirm }),
    });
    return { host, confirm };
  }

  it('dispatches to the named handler and returns its value', async () => {
    writePlugin('orders', `exports.ping = async () => ({ pong: true });`);
    const { host } = makeHost();
    await expect(host.invoke('orders', 'ping', {})).resolves.toEqual({ pong: true });
  });

  it('passes args through to the handler', async () => {
    writePlugin('orders', `exports.echo = async ({ a, b }) => a + b;`);
    const { host } = makeHost();
    await expect(host.invoke('orders', 'echo', { a: 2, b: 3 })).resolves.toBe(5);
  });

  it('supports module.exports as well as exports', async () => {
    writePlugin('orders', `module.exports.ping = async () => 'ok';`);
    const { host } = makeHost();
    await expect(host.invoke('orders', 'ping', {})).resolves.toBe('ok');
  });

  it('gives the handler the SF sandbox globals', async () => {
    const cm = fakeConnectionManager();
    writePlugin(
      'orders',
      `exports.run = async () => (await query('SELECT Id FROM Account')).totalSize;`,
    );
    const { host } = makeHost(cm);
    await expect(host.invoke('orders', 'run', {})).resolves.toBe(1);
    expect(cm.query).toHaveBeenCalledWith('SELECT Id FROM Account');
  });

  it('exposes pluginDir and pluginId', async () => {
    const dir = writePlugin('orders', `exports.where = async () => ({ pluginId, pluginDir });`);
    const { host } = makeHost();
    await expect(host.invoke('orders', 'where', {})).resolves.toEqual({
      pluginId: 'orders',
      pluginDir: dir,
    });
  });

  it('streams log() output through onChunk', async () => {
    writePlugin('orders', `exports.talk = async () => { log('one'); error('two'); return 1; };`);
    const { host } = makeHost();
    const chunks: string[] = [];
    await host.invoke('orders', 'talk', {}, { onChunk: (c) => chunks.push(c) });
    expect(chunks).toEqual(['one\n', '[ERROR] two\n']);
  });

  it('rejects an unknown plugin id', async () => {
    const { host } = makeHost();
    await expect(host.invoke('ghost', 'ping', {})).rejects.toThrow('Unknown plugin "ghost"');
  });

  it('rejects a handler name that is not a bare identifier', async () => {
    writePlugin('orders', `exports.ping = async () => 1;`);
    const { host } = makeHost();
    await expect(host.invoke('orders', 'ping; process.exit()', {})).rejects.toThrow(
      'Invalid handler name',
    );
  });

  it('reports a handler that is not defined', async () => {
    writePlugin('orders', `exports.ping = async () => 1;`);
    const { host } = makeHost();
    await expect(host.invoke('orders', 'nope', {})).rejects.toThrow(
      'Plugin handler "nope" is not defined.',
    );
  });

  // `exports` is a plain object, so `toString`, `constructor` and `valueOf` are
  // all inherited FUNCTIONS. A bare `exports[name]` lookup passes the typeof
  // guard and calls a method the plugin never wrote. These are ordinary
  // identifiers, so HANDLER_NAME_RE cannot reject them — the lookup has to.
  it.each(['toString', 'constructor', 'valueOf', 'hasOwnProperty'])(
    'refuses the inherited %s rather than calling it',
    async (handler) => {
      writePlugin('orders', `exports.ping = async () => 1;`);
      const { host } = makeHost();
      await expect(host.invoke('orders', handler, {})).rejects.toThrow(
        `Plugin handler "${handler}" is not defined.`,
      );
    },
  );

  it('still finds a handler the plugin deliberately named toString', async () => {
    writePlugin('orders', `exports.toString = async () => 'mine';`);
    const { host } = makeHost();
    await expect(host.invoke('orders', 'toString', {})).resolves.toBe('mine');
  });

  it('reports a plugin with no handlers.js', async () => {
    writePlugin('orders', null);
    const { host } = makeHost();
    await expect(host.invoke('orders', 'ping', {})).rejects.toThrow('has no handlers.js');
  });

  it('propagates the shared cancellation sentinel verbatim', async () => {
    writePlugin('orders', `exports.slow = () => new Promise(() => {});`);
    const { host } = makeHost();
    const ac = new AbortController();
    const pending = host.invoke('orders', 'slow', {}, { signal: ac.signal });
    ac.abort();
    await expect(pending).rejects.toThrow('Operation cancelled');
  });

  // The per-invoke re-read is what makes editing handlers.js take effect on the
  // next click with no reload — and what keeps `connection`/`org` from going
  // stale across an org switch.
  it('re-reads handlers.js on every invoke', async () => {
    writePlugin('orders', `exports.v = async () => 1;`);
    const { host } = makeHost();
    await expect(host.invoke('orders', 'v', {})).resolves.toBe(1);

    fs.writeFileSync(path.join(userDir, 'orders', 'handlers.js'), `exports.v = async () => 2;`);
    await expect(host.invoke('orders', 'v', {})).resolves.toBe(2);
  });

  it('applies the sensitive-org gate to a plugin mutation', async () => {
    writePlugin(
      'orders',
      `exports.mutate = async () => { await executeApex('update x;'); return 'done'; };`,
      'Order Explorer',
    );
    const cm = fakeConnectionManager();
    const confirm = vi.fn().mockResolvedValue(false);
    const host = new PluginHost({
      connectionManager: cm,
      workspaceRoot: tmp,
      registry: new PluginRegistry(userDir, privateDir),
      gate: createSensitiveGate({ resolveOrgType: async () => 'production', confirm }),
    });

    await expect(host.invoke('orders', 'mutate', {})).rejects.toThrow('Operation cancelled');
    expect(confirm.mock.calls[0][0]).toContain('Order Explorer');
    expect(cm.executeAnonymousWithDebugLog).not.toHaveBeenCalled();
  });
});
