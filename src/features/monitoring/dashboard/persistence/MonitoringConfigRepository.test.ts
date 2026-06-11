import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MonitoringConfigRepository } from './MonitoringConfigRepository';
import type { MonitoringConfig } from '../types';

function writeConfig(baseDir: string, folder: string, filename: string, content: string): void {
  const dir = path.join(baseDir, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), content, 'utf8');
}

const VALID_YAML = `
name: Test Chart
soql: SELECT Status, COUNT(Id) Cnt FROM Order GROUP BY Status
labelField: Status
valueFields:
  - field: Cnt
    label: Count
chartType: bar
`;

const baseConfig = (overrides: Partial<MonitoringConfig> = {}): MonitoringConfig => ({
  id: '',
  folder: 'orders',
  name: 'My Chart',
  description: '',
  soql: 'SELECT Id FROM Account',
  labelField: 'Id',
  valueFields: [{ field: 'Id', label: 'ID' }],
  chartType: 'bar',
  refreshInterval: 0,
  ...overrides,
});

describe('MonitoringConfigRepository', () => {
  let tmpDir: string;
  let userPath: string;
  let privatePath: string;
  let repo: MonitoringConfigRepository;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mon-repo-test-'));
    userPath = path.join(tmpDir, 'user');
    privatePath = path.join(tmpDir, 'private');
    fs.mkdirSync(userPath, { recursive: true });
    fs.mkdirSync(privatePath, { recursive: true });
    repo = new MonitoringConfigRepository({ userPath, privatePath });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('saveConfig', () => {
    it('writes a new config to userPath/{folder}/{slug}.yaml', () => {
      const saved = repo.saveConfig(baseConfig());
      expect(saved.source).toBe('user');
      expect(saved.id).toBe('orders/my-chart');
      expect(fs.existsSync(path.join(userPath, 'orders', 'my-chart.yaml'))).toBe(true);
    });

    it('writes to privatePath when isPrivate=true', () => {
      const saved = repo.saveConfig(baseConfig({ folder: 'test', name: 'Private Chart' }), true);
      expect(saved.source).toBe('private');
      expect(fs.existsSync(path.join(privatePath, 'test', 'private-chart.yaml'))).toBe(true);
    });

    it('floors non-zero refreshInterval below 10 to 10', () => {
      repo.saveConfig(baseConfig({ folder: 'test', name: 'Fast', refreshInterval: 3 }));
      const written = fs.readFileSync(path.join(userPath, 'test', 'fast.yaml'), 'utf8');
      expect(written).toMatch(/refreshInterval: 10/);
    });

    it('preserves refreshInterval 0', () => {
      repo.saveConfig(baseConfig({ folder: 'test', name: 'Off', refreshInterval: 0 }));
      const written = fs.readFileSync(path.join(userPath, 'test', 'off.yaml'), 'utf8');
      expect(written).toMatch(/refreshInterval: 0/);
    });

    it('writes notifyOnIncrease only when truthy', () => {
      repo.saveConfig(baseConfig({ folder: 'a', name: 'On', notifyOnIncrease: true }));
      repo.saveConfig(baseConfig({ folder: 'a', name: 'Off' }));
      expect(fs.readFileSync(path.join(userPath, 'a', 'on.yaml'), 'utf8')).toMatch(
        /notifyOnIncrease: true/,
      );
      expect(fs.readFileSync(path.join(userPath, 'a', 'off.yaml'), 'utf8')).not.toMatch(
        /notifyOnIncrease/,
      );
    });

    it('creates nested sub-category folders', () => {
      const saved = repo.saveConfig(baseConfig({ folder: 'orders/quarterly', name: 'Nested' }));
      expect(saved.id).toBe('orders/quarterly/nested');
      expect(fs.existsSync(path.join(userPath, 'orders', 'quarterly', 'nested.yaml'))).toBe(true);
    });

    it('moves the file when the category changes (rename = move)', () => {
      const saved = repo.saveConfig(baseConfig());
      const moved = repo.saveConfig({ ...saved, folder: 'sales' });
      expect(moved.id).toBe('sales/my-chart');
      expect(fs.existsSync(path.join(userPath, 'sales', 'my-chart.yaml'))).toBe(true);
      expect(fs.existsSync(path.join(userPath, 'orders', 'my-chart.yaml'))).toBe(false);
    });

    it('moves the file when the config is renamed', () => {
      const saved = repo.saveConfig(baseConfig({ name: 'Old Name' }));
      const renamed = repo.saveConfig({ ...saved, name: 'New Name' });
      expect(renamed.id).toBe('orders/new-name');
      expect(fs.existsSync(path.join(userPath, 'orders', 'new-name.yaml'))).toBe(true);
      expect(fs.existsSync(path.join(userPath, 'orders', 'old-name.yaml'))).toBe(false);
    });

    it('sequential renames never pile up files (feeds back the returned id each time)', () => {
      let cur = repo.saveConfig(baseConfig({ name: 'Name A' }));
      cur = repo.saveConfig({ ...cur, name: 'Name B' });
      cur = repo.saveConfig({ ...cur, name: 'Name C' });
      cur = repo.saveConfig({ ...cur, name: 'Name D' });
      expect(cur.id).toBe('orders/name-d');
      // Only the final file survives — the webview now feeds back the saved id
      // (id + source) on each rename, so cleanup always targets the real old file.
      expect(fs.readdirSync(path.join(userPath, 'orders'))).toEqual(['name-d.yaml']);
    });

    it('a stale old id (the pre-fix webview bug) is what caused the pile-up', () => {
      // Reproduces the root cause: saving repeatedly with a STALE id (the very
      // first id) leaves the renamed files orphaned because cleanup can't find
      // the already-moved old file. Documents why the webview must feed back ids.
      const first = repo.saveConfig(baseConfig({ name: 'Name A' }));
      repo.saveConfig({ ...first, name: 'Name B' }); // id still A -> writes B, deletes A
      repo.saveConfig({ ...first, name: 'Name C' }); // stale id A (gone) -> can't clean B
      expect(fs.readdirSync(path.join(userPath, 'orders')).sort()).toEqual([
        'name-b.yaml',
        'name-c.yaml',
      ]);
    });

    it('moves a shared config to private when toggled on', () => {
      const saved = repo.saveConfig(baseConfig());
      const moved = repo.saveConfig(saved, true);
      expect(moved.source).toBe('private');
      expect(fs.existsSync(path.join(privatePath, 'orders', 'my-chart.yaml'))).toBe(true);
      expect(fs.existsSync(path.join(userPath, 'orders', 'my-chart.yaml'))).toBe(false);
    });

    it('moves a private config back to shared when toggled off', () => {
      const saved = repo.saveConfig(baseConfig(), true);
      const moved = repo.saveConfig(saved, false);
      expect(moved.source).toBe('user');
      expect(fs.existsSync(path.join(userPath, 'orders', 'my-chart.yaml'))).toBe(true);
      expect(fs.existsSync(path.join(privatePath, 'orders', 'my-chart.yaml'))).toBe(false);
    });

    it('throws when same id exists in the other location', () => {
      writeConfig(privatePath, 'orders', 'chart.yaml', VALID_YAML);
      expect(() =>
        repo.saveConfig(baseConfig({ id: 'orders/chart', name: 'Chart' }), false),
      ).toThrow(/already exists in the private folder/);
    });

    it('exempts the config own old file during a privacy move (own-old-file)', () => {
      const saved = repo.saveConfig(baseConfig());
      // Toggling private with the same id must not be blocked by the duplicate check
      expect(() => repo.saveConfig(saved, true)).not.toThrow();
    });

    it('never deletes builtin files when editing a builtin config', () => {
      const builtInPath = path.join(tmpDir, 'builtin');
      writeConfig(builtInPath, 'orders', 'chart.yaml', VALID_YAML);
      const saved = repo.saveConfig(
        baseConfig({ id: 'orders/chart', source: 'builtin', folder: 'sales', name: 'Chart' }),
      );
      expect(saved.id).toBe('sales/chart');
      expect(fs.existsSync(path.join(userPath, 'sales', 'chart.yaml'))).toBe(true);
      expect(fs.existsSync(path.join(builtInPath, 'orders', 'chart.yaml'))).toBe(true);
    });
  });

  describe('deleteConfig', () => {
    it('removes a .yaml file from userPath', () => {
      writeConfig(userPath, 'orders', 'by-status.yaml', VALID_YAML);
      repo.deleteConfig('orders/by-status', false);
      expect(fs.existsSync(path.join(userPath, 'orders', 'by-status.yaml'))).toBe(false);
    });

    it('removes a .yaml file from privatePath when isPrivate=true', () => {
      writeConfig(privatePath, 'orders', 'chart.yaml', VALID_YAML);
      repo.deleteConfig('orders/chart', true);
      expect(fs.existsSync(path.join(privatePath, 'orders', 'chart.yaml'))).toBe(false);
    });

    it('also handles the .yml extension', () => {
      writeConfig(userPath, 'orders', 'legacy.yml', VALID_YAML);
      repo.deleteConfig('orders/legacy', false);
      expect(fs.existsSync(path.join(userPath, 'orders', 'legacy.yml'))).toBe(false);
    });

    it('throws when the file does not exist', () => {
      expect(() => repo.deleteConfig('orders/missing', false)).toThrow(
        /Cannot delete: config not found/,
      );
    });
  });

  describe('savePositions', () => {
    it('writes position into the matching yaml file', async () => {
      writeConfig(userPath, 'orders', 'chart.yaml', VALID_YAML);
      await repo.savePositions([{ id: 'orders/chart', position: 5, source: 'user' }]);
      const doc = yaml.load(
        fs.readFileSync(path.join(userPath, 'orders', 'chart.yaml'), 'utf8'),
      ) as Record<string, unknown>;
      expect(doc.position).toBe(5);
    });

    it('updates a private file when source=private', async () => {
      writeConfig(privatePath, 'orders', 'chart.yaml', VALID_YAML);
      await repo.savePositions([{ id: 'orders/chart', position: 2, source: 'private' }]);
      const doc = yaml.load(
        fs.readFileSync(path.join(privatePath, 'orders', 'chart.yaml'), 'utf8'),
      ) as Record<string, unknown>;
      expect(doc.position).toBe(2);
    });

    it('skips entries whose file does not exist', async () => {
      await expect(
        repo.savePositions([{ id: 'orders/missing', position: 1, source: 'user' }]),
      ).resolves.toBeUndefined();
    });

    it('resolves nested-folder ids', async () => {
      writeConfig(userPath, path.join('orders', 'emea'), 'regional.yaml', VALID_YAML);
      await repo.savePositions([{ id: 'orders/emea/regional', position: 7, source: 'user' }]);
      const doc = yaml.load(
        fs.readFileSync(path.join(userPath, 'orders', 'emea', 'regional.yaml'), 'utf8'),
      ) as Record<string, unknown>;
      expect(doc.position).toBe(7);
    });
  });
});
