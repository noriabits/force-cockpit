import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MonitoringDashboardService } from './MonitoringDashboardService';
import type { ConnectionManager } from '../../../salesforce/connection';

function makeMock(overrides: { query?: ReturnType<typeof vi.fn> } = {}): ConnectionManager {
  return {
    query: overrides.query ?? vi.fn(),
  } as unknown as ConnectionManager;
}

function makeService(
  paths: Partial<{ builtInPath: string; userPath: string; privatePath: string }> = {},
  mock?: ConnectionManager,
): MonitoringDashboardService {
  return new MonitoringDashboardService(mock ?? makeMock(), {
    builtInPath: paths.builtInPath ?? '',
    userPath: paths.userPath ?? '',
    privatePath: paths.privatePath ?? '',
  });
}

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

describe('MonitoringDashboardService', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitoring-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('loadConfigs', () => {
    it('returns empty array when all paths are missing', async () => {
      const service = makeService({
        builtInPath: path.join(tmpDir, 'nonexistent1'),
        userPath: path.join(tmpDir, 'nonexistent2'),
        privatePath: path.join(tmpDir, 'nonexistent3'),
      });
      const configs = await service.loadConfigs();
      expect(configs).toEqual([]);
    });

    it('loads configs from the builtIn path', async () => {
      const builtIn = path.join(tmpDir, 'builtin');
      writeConfig(builtIn, 'orders', 'by-status.yaml', VALID_YAML);

      const service = makeService({ builtInPath: builtIn });
      const configs = await service.loadConfigs();

      expect(configs).toHaveLength(1);
      expect(configs[0].id).toBe('orders/by-status');
      expect(configs[0].name).toBe('Test Chart');
      expect(configs[0].source).toBe('builtin');
    });

    it('user configs override builtin configs with the same id', async () => {
      const builtIn = path.join(tmpDir, 'builtin');
      const user = path.join(tmpDir, 'user');
      writeConfig(builtIn, 'orders', 'chart.yaml', VALID_YAML);
      writeConfig(user, 'orders', 'chart.yaml', VALID_YAML.replace('Test Chart', 'User Override'));

      const service = makeService({ builtInPath: builtIn, userPath: user });
      const configs = await service.loadConfigs();

      expect(configs).toHaveLength(1);
      expect(configs[0].name).toBe('User Override');
      expect(configs[0].source).toBe('user');
    });

    it('private configs override user configs with the same id', async () => {
      const user = path.join(tmpDir, 'user');
      const priv = path.join(tmpDir, 'private');
      writeConfig(user, 'orders', 'chart.yaml', VALID_YAML);
      writeConfig(
        priv,
        'orders',
        'chart.yaml',
        VALID_YAML.replace('Test Chart', 'Private Override'),
      );

      const service = makeService({ userPath: user, privatePath: priv });
      const configs = await service.loadConfigs();

      expect(configs).toHaveLength(1);
      expect(configs[0].name).toBe('Private Override');
      expect(configs[0].source).toBe('private');
    });

    it('skips files without name or soql', async () => {
      const builtIn = path.join(tmpDir, 'builtin');
      writeConfig(
        builtIn,
        'bad',
        'no-name.yaml',
        'soql: SELECT Id FROM Account\nlabelField: Id\nvalueFields:\n  - field: Id\n    label: Id',
      );
      writeConfig(
        builtIn,
        'bad',
        'no-soql.yaml',
        'name: Missing SOQL\nlabelField: X\nvalueFields:\n  - field: X\n    label: X',
      );

      const service = makeService({ builtInPath: builtIn });
      const configs = await service.loadConfigs();

      expect(configs).toEqual([]);
    });

    it('skips malformed YAML gracefully', async () => {
      const builtIn = path.join(tmpDir, 'builtin');
      writeConfig(builtIn, 'bad', 'broken.yaml', ':::not valid yaml{{{');

      const service = makeService({ builtInPath: builtIn });
      const configs = await service.loadConfigs();

      expect(configs).toEqual([]);
    });

    it('supports sub-folder nesting (category/sub-category)', async () => {
      const builtIn = path.join(tmpDir, 'builtin');
      const subDir = path.join(builtIn, 'orders', 'emea');
      fs.mkdirSync(subDir, { recursive: true });
      fs.writeFileSync(path.join(subDir, 'regional.yaml'), VALID_YAML, 'utf8');

      const service = makeService({ builtInPath: builtIn });
      const configs = await service.loadConfigs();

      expect(configs).toHaveLength(1);
      expect(configs[0].id).toBe('orders/emea/regional');
      expect(configs[0].folder).toBe('orders/emea');
    });

    it('defaults chartType to bar when not specified or invalid', async () => {
      const builtIn = path.join(tmpDir, 'builtin');
      writeConfig(
        builtIn,
        'test',
        'no-type.yaml',
        'name: No Type\nsoql: SELECT Id FROM Account\nlabelField: Id\nvalueFields:\n  - field: Id\n    label: Id',
      );

      const service = makeService({ builtInPath: builtIn });
      const configs = await service.loadConfigs();

      expect(configs[0].chartType).toBe('bar');
    });

    it('skips configs without labelField when chartType is not metric', async () => {
      const builtIn = path.join(tmpDir, 'builtin');
      writeConfig(
        builtIn,
        'test',
        'no-label.yaml',
        'name: No Label\nsoql: SELECT COUNT(Id) Cnt FROM Account\nchartType: bar\nvalueFields:\n  - field: Cnt\n    label: Count',
      );

      const service = makeService({ builtInPath: builtIn });
      const configs = await service.loadConfigs();

      expect(configs).toEqual([]);
    });

    it('allows metric charts without labelField', async () => {
      const builtIn = path.join(tmpDir, 'builtin');
      writeConfig(
        builtIn,
        'test',
        'metric.yaml',
        'name: KPI\nsoql: SELECT COUNT(Id) Cnt FROM Account\nchartType: metric\nvalueFields:\n  - field: Cnt\n    label: Count',
      );

      const service = makeService({ builtInPath: builtIn });
      const configs = await service.loadConfigs();

      expect(configs).toHaveLength(1);
      expect(configs[0].chartType).toBe('metric');
    });

    it('parses threshold and thresholdCondition from valueFields', async () => {
      const builtIn = path.join(tmpDir, 'builtin');
      writeConfig(
        builtIn,
        'test',
        'threshold.yaml',
        `name: Threshold Test
soql: SELECT Status, COUNT(Id) Cnt FROM Order GROUP BY Status
labelField: Status
valueFields:
  - field: Cnt
    label: Count
    threshold: 100
    thresholdCondition: below
chartType: bar`,
      );

      const service = makeService({ builtInPath: builtIn });
      const configs = await service.loadConfigs();

      expect(configs[0].valueFields[0].threshold).toBe(100);
      expect(configs[0].valueFields[0].thresholdCondition).toBe('below');
    });
  });

  describe('runQuery', () => {
    it('maps records to labels and datasets', async () => {
      const mockQuery = vi.fn().mockResolvedValue({
        records: [
          { Status: 'Open', Cnt: 5 },
          { Status: 'Closed', Cnt: 10 },
        ],
        totalSize: 2,
      });

      const service = makeService({}, makeMock({ query: mockQuery }));
      const result = await service.runQuery('test-id', 'SELECT ...', 'Status', [
        { field: 'Cnt', label: 'Count' },
      ]);

      expect(result.labels).toEqual(['Open', 'Closed']);
      expect(result.datasets).toEqual([{ label: 'Count', data: [5, 10] }]);
      expect(result.totalRows).toBe(2);
      expect(result.configId).toBe('test-id');
    });

    it('coerces non-numeric field values to 0', async () => {
      const mockQuery = vi.fn().mockResolvedValue({
        records: [{ Status: 'Open', Cnt: null }],
        totalSize: 1,
      });

      const service = makeService({}, makeMock({ query: mockQuery }));
      const result = await service.runQuery('id', 'SELECT ...', 'Status', [
        { field: 'Cnt', label: 'Count' },
      ]);

      expect(result.datasets[0].data).toEqual([0]);
    });
  });

  describe('runTableQuery', () => {
    it('includes labelField as first column', async () => {
      const mockQuery = vi.fn().mockResolvedValue({
        records: [{ Name: 'Acme', Amount: 100 }],
        totalSize: 1,
      });

      const service = makeService({}, makeMock({ query: mockQuery }));
      const result = await service.runTableQuery('id', 'SELECT ...', 'Name', [
        { field: 'Amount', label: 'Total Amount' },
      ]);

      expect(result.columnLabels).toEqual(['Name', 'Total Amount']);
      expect(result.rows).toEqual([['Acme', '100']]);
    });

    it('stringifies null cells as empty string', async () => {
      const mockQuery = vi.fn().mockResolvedValue({
        records: [{ Name: null, Amount: null }],
        totalSize: 1,
      });

      const service = makeService({}, makeMock({ query: mockQuery }));
      const result = await service.runTableQuery('id', 'SELECT ...', 'Name', [
        { field: 'Amount', label: 'Amount' },
      ]);

      expect(result.rows).toEqual([['', '']]);
    });
  });

  describe('saveConfig', () => {
    it('writes config to userPath/{folder}/{slug}.yaml', () => {
      const userPath = path.join(tmpDir, 'user');
      fs.mkdirSync(userPath, { recursive: true });

      const service = makeService({ userPath });
      const config = {
        id: '',
        folder: 'orders',
        name: 'My Chart',
        description: 'A description',
        soql: 'SELECT Id FROM Account',
        labelField: 'Id',
        valueFields: [{ field: 'Id', label: 'ID' }],
        chartType: 'bar' as const,
        refreshInterval: 0,
      };

      const saved = service.saveConfig(config);
      expect(saved.source).toBe('user');
      expect(saved.id).toBe('orders/my-chart');

      const filePath = path.join(userPath, 'orders', 'my-chart.yaml');
      expect(fs.existsSync(filePath)).toBe(true);
    });

    it('writes to privatePath when isPrivate=true', () => {
      const privatePath = path.join(tmpDir, 'private');
      fs.mkdirSync(privatePath, { recursive: true });

      const service = makeService({ privatePath });
      const config = {
        id: '',
        folder: 'test',
        name: 'Private Chart',
        description: '',
        soql: 'SELECT Id FROM Account',
        labelField: 'Id',
        valueFields: [{ field: 'Id', label: 'ID' }],
        chartType: 'bar' as const,
        refreshInterval: 0,
      };

      const saved = service.saveConfig(config, true);
      expect(saved.source).toBe('private');

      const filePath = path.join(privatePath, 'test', 'private-chart.yaml');
      expect(fs.existsSync(filePath)).toBe(true);
    });

    it('throws when same id exists in the other location', () => {
      const userPath = path.join(tmpDir, 'user');
      const privatePath = path.join(tmpDir, 'private');
      writeConfig(privatePath, 'orders', 'chart.yaml', VALID_YAML);

      const service = makeService({ userPath, privatePath });
      const config = {
        id: 'orders/chart',
        folder: 'orders',
        name: 'Chart',
        description: '',
        soql: 'SELECT Id FROM Account',
        labelField: 'Id',
        valueFields: [{ field: 'Id', label: 'ID' }],
        chartType: 'bar' as const,
        refreshInterval: 0,
      };

      expect(() => service.saveConfig(config, false)).toThrow(
        /already exists in the private folder/,
      );
    });
  });
});
