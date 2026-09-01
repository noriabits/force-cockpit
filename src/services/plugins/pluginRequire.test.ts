import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginHost } from './PluginHost';
import { PluginRegistry } from './PluginRegistry';
import { createSensitiveGate } from './sensitiveGate';
import type { ConnectionManager } from '../../salesforce/connection';

/**
 * `require` is only reachable from inside a running handler, so these drive it
 * the way an author would: through PluginHost, with real files on disk.
 */
describe('plugin require', () => {
  let tmp: string;
  let userDir: string;
  let pluginDir: string;
  let query: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-require-'));
    userDir = path.join(tmp, 'plugins');
    pluginDir = path.join(userDir, 'demo');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'plugin.yaml'), 'name: Demo\n', 'utf8');
    fs.writeFileSync(path.join(pluginDir, 'view.html'), '<p>x</p>', 'utf8');
    query = vi.fn().mockResolvedValue({ totalSize: 1, records: [{ Id: '001' }] });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function write(relPath: string, body: string): void {
    const full = path.join(pluginDir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, 'utf8');
  }

  function makeHost() {
    return new PluginHost({
      connectionManager: {
        getConnection: () => null,
        getCurrentOrg: () => null,
        query,
      } as unknown as ConnectionManager,
      workspaceRoot: tmp,
      registry: new PluginRegistry(userDir, path.join(tmp, 'private', 'plugins')),
      gate: createSensitiveGate({
        resolveOrgType: async () => 'sandbox',
        confirm: async () => true,
      }),
    });
  }

  const run = (handler = 'go', args: unknown = {}) => makeHost().invoke('demo', handler, args);

  it('requires a sibling file and calls into it', async () => {
    write('lib/jobs.js', `exports.double = (n) => n * 2;`);
    write(
      'handlers.js',
      `
      const { double } = require('./lib/jobs.js');
      exports.go = async ({ n }) => double(n);
    `,
    );

    await expect(run('go', { n: 21 })).resolves.toBe(42);
  });

  // The whole point: a helper file needs the org without anything being
  // threaded down to it.
  it('gives a required file the same sandbox globals', async () => {
    write(
      'lib/jobs.js',
      `
      exports.count = async () => (await query('SELECT Id FROM Account')).totalSize;
    `,
    );
    write(
      'handlers.js',
      `
      const { count } = require('./lib/jobs.js');
      exports.go = async () => count();
    `,
    );

    await expect(run()).resolves.toBe(1);
    expect(query).toHaveBeenCalledWith('SELECT Id FROM Account');
  });

  it('does not let a required file clobber the handler file exports', async () => {
    write('lib/jobs.js', `exports.go = () => 'from the helper';`);
    write(
      'handlers.js',
      `
      require('./lib/jobs.js');
      exports.go = async () => 'from handlers';
    `,
    );

    await expect(run()).resolves.toBe('from handlers');
  });

  it('resolves a nested require relative to the requiring file, not the plugin root', async () => {
    write(
      'lib/a.js',
      `
      const b = require('./b.js');
      exports.value = 'a+' + b.value;
    `,
    );
    write('lib/b.js', `exports.value = 'b';`);
    write(
      'handlers.js',
      `
      const a = require('./lib/a.js');
      exports.go = async () => a.value;
    `,
    );

    await expect(run()).resolves.toBe('a+b');
  });

  it('supports module.exports assigned wholesale', async () => {
    write('lib/fn.js', `module.exports = (n) => n + 1;`);
    write(
      'handlers.js',
      `
      const inc = require('./lib/fn.js');
      exports.go = async ({ n }) => inc(n);
    `,
    );

    await expect(run('go', { n: 1 })).resolves.toBe(2);
  });

  it('exposes __filename and __dirname to a required file', async () => {
    write('lib/where.js', `exports.dir = __dirname; exports.file = __filename;`);
    write(
      'handlers.js',
      `
      const w = require('./lib/where.js');
      exports.go = async () => w;
    `,
    );

    await expect(run()).resolves.toEqual({
      dir: path.join(pluginDir, 'lib'),
      file: path.join(pluginDir, 'lib', 'where.js'),
    });
  });

  describe('resolution', () => {
    it('appends .js when the exact path is not a file', async () => {
      write('lib/jobs.js', `exports.v = 'found';`);
      write('handlers.js', `exports.go = async () => require('./lib/jobs').v;`);

      await expect(run()).resolves.toBe('found');
    });

    it('falls back to index.js in a folder', async () => {
      write('lib/index.js', `exports.v = 'index';`);
      write('handlers.js', `exports.go = async () => require('./lib').v;`);

      await expect(run()).resolves.toBe('index');
    });
  });

  describe('caching', () => {
    it('runs a shared file once per invoke, however many times it is required', async () => {
      write(
        'lib/counter.js',
        `
        globalThis.__loads = (globalThis.__loads ?? 0) + 1;
        exports.loads = () => globalThis.__loads;
      `,
      );
      write(
        'handlers.js',
        `
        const one = require('./lib/counter.js');
        const two = require('./lib/counter.js');
        exports.go = async () => ({ same: one === two, loads: one.loads() });
      `,
      );

      await expect(run()).resolves.toEqual({ same: true, loads: 1 });
    });

    // Same rule handlers.js follows: edit, click, see the change.
    it('re-reads a required file on the next invoke', async () => {
      write('lib/v.js', `exports.v = 1;`);
      write('handlers.js', `exports.go = async () => require('./lib/v.js').v;`);
      const host = makeHost();

      await expect(host.invoke('demo', 'go', {})).resolves.toBe(1);
      write('lib/v.js', `exports.v = 2;`);
      await expect(host.invoke('demo', 'go', {})).resolves.toBe(2);
    });

    it('survives a circular require instead of recursing forever', async () => {
      write(
        'lib/a.js',
        `
        exports.name = 'a';
        exports.peer = () => require('./b.js').name;
      `,
      );
      write(
        'lib/b.js',
        `
        const a = require('./a.js');
        exports.name = 'b';
        exports.sawA = a.name;
      `,
      );
      write(
        'handlers.js',
        `
        const a = require('./lib/a.js');
        exports.go = async () => ({ peer: a.peer(), sawA: require('./lib/b.js').sawA });
      `,
      );

      await expect(run()).resolves.toEqual({ peer: 'b', sawA: 'a' });
    });

    it('does not cache a file that threw while loading', async () => {
      write('lib/boom.js', `throw new Error('bad helper');`);
      write(
        'handlers.js',
        `
        exports.go = async () => {
          const seen = [];
          for (let i = 0; i < 2; i++) {
            try { require('./lib/boom.js'); } catch (e) { seen.push(e.message); }
          }
          return seen;
        };
      `,
      );

      await expect(run()).resolves.toEqual(['bad helper', 'bad helper']);
    });
  });

  describe('built-ins', () => {
    it.each(['fs', 'path', 'os', 'js-yaml'])(
      'resolves require("%s") to the sandbox global',
      async (spec) => {
        write('handlers.js', `exports.go = async () => typeof require('${spec}');`);
        await expect(run()).resolves.toBe('object');
      },
    );

    it('hands back the very same object as the bare global', async () => {
      write('handlers.js', `exports.go = async () => require('path') === path;`);
      await expect(run()).resolves.toBe(true);
    });
  });

  describe('refusals', () => {
    it('explains that npm packages are not available', async () => {
      write('handlers.js', `exports.go = async () => require('lodash');`);
      await expect(run()).rejects.toThrow(/npm packages are not available/);
    });

    it('names the relative-path form in that message', async () => {
      write('handlers.js', `exports.go = async () => require('lodash');`);
      await expect(run()).rejects.toThrow(/\.\/lib\/jobs\.js/);
    });

    it('refuses to escape the plugin folder', async () => {
      fs.writeFileSync(path.join(tmp, 'secret.js'), `exports.v = 'leaked';`, 'utf8');
      write('handlers.js', `exports.go = async () => require('../../secret.js').v;`);

      await expect(run()).rejects.toThrow(/inside its own folder/);
    });

    it('refuses a sibling plugin whose name merely starts the same', async () => {
      fs.mkdirSync(path.join(userDir, 'demo-evil'), { recursive: true });
      fs.writeFileSync(path.join(userDir, 'demo-evil', 'x.js'), `exports.v = 1;`, 'utf8');
      write('handlers.js', `exports.go = async () => require('../demo-evil/x.js').v;`);

      await expect(run()).rejects.toThrow(/inside its own folder/);
    });

    it('reports a missing file clearly', async () => {
      write('handlers.js', `exports.go = async () => require('./nope.js');`);
      await expect(run()).rejects.toThrow(/no such file in the plugin folder/);
    });

    it('reports a syntax error in a required file', async () => {
      write('lib/bad.js', `exports.v = (;`);
      write('handlers.js', `exports.go = async () => require('./lib/bad.js');`);
      await expect(run()).rejects.toThrow(/require\("\.\/lib\/bad\.js"\)/);
    });
  });
});
