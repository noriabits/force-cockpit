import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MonitoringConfigParser } from './MonitoringConfigParser';

function writeFile(baseDir: string, name: string, content: string): string {
  fs.mkdirSync(baseDir, { recursive: true });
  const filePath = path.join(baseDir, name);
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
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

describe('MonitoringConfigParser', () => {
  let tmpDir: string;
  const parser = new MonitoringConfigParser();

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mon-parser-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parses a valid config', () => {
    const fp = writeFile(tmpDir, 'chart.yaml', VALID_YAML);
    const cfg = parser.parse(fp, 'orders/chart', 'orders', 'user');
    expect(cfg).not.toBeNull();
    expect(cfg!.name).toBe('Test Chart');
    expect(cfg!.id).toBe('orders/chart');
    expect(cfg!.folder).toBe('orders');
    expect(cfg!.source).toBe('user');
    expect(cfg!.chartType).toBe('bar');
    expect(cfg!.valueFields).toEqual([{ field: 'Cnt', label: 'Count' }]);
  });

  it('returns null when name is missing', () => {
    const fp = writeFile(
      tmpDir,
      'x.yaml',
      'soql: SELECT Id FROM Account\nlabelField: Id\nvalueFields:\n  - field: Id\n    label: Id',
    );
    expect(parser.parse(fp, 'x/x', 'x', 'builtin')).toBeNull();
  });

  it('returns null when soql is missing', () => {
    const fp = writeFile(
      tmpDir,
      'x.yaml',
      'name: No SOQL\nlabelField: Id\nvalueFields:\n  - field: Id\n    label: Id',
    );
    expect(parser.parse(fp, 'x/x', 'x', 'builtin')).toBeNull();
  });

  it('returns null for malformed YAML', () => {
    const fp = writeFile(tmpDir, 'x.yaml', ':::not valid{{{');
    expect(parser.parse(fp, 'x/x', 'x', 'builtin')).toBeNull();
  });

  it('returns null for a missing file', () => {
    expect(parser.parse(path.join(tmpDir, 'nope.yaml'), 'x/x', 'x', 'builtin')).toBeNull();
  });

  it('defaults invalid/missing chartType to bar', () => {
    const fp = writeFile(
      tmpDir,
      'x.yaml',
      'name: No Type\nsoql: SELECT Id FROM Account\nlabelField: Id\nvalueFields:\n  - field: Id\n    label: Id',
    );
    expect(parser.parse(fp, 'x/x', 'x', 'builtin')!.chartType).toBe('bar');
  });

  it('requires labelField for non-metric charts', () => {
    const fp = writeFile(
      tmpDir,
      'x.yaml',
      'name: No Label\nsoql: SELECT COUNT(Id) Cnt FROM Account\nchartType: bar\nvalueFields:\n  - field: Cnt\n    label: Count',
    );
    expect(parser.parse(fp, 'x/x', 'x', 'builtin')).toBeNull();
  });

  it('allows metric charts without labelField', () => {
    const fp = writeFile(
      tmpDir,
      'x.yaml',
      'name: KPI\nsoql: SELECT COUNT(Id) Cnt FROM Account\nchartType: metric\nvalueFields:\n  - field: Cnt\n    label: Count',
    );
    const cfg = parser.parse(fp, 'x/x', 'x', 'builtin');
    expect(cfg!.chartType).toBe('metric');
    expect(cfg!.labelField).toBe('');
  });

  it('falls back to scalar valueField when valueFields is absent', () => {
    const fp = writeFile(
      tmpDir,
      'x.yaml',
      'name: Scalar\nsoql: SELECT COUNT(Id) Cnt FROM Account\nlabelField: Id\nvalueField: Cnt',
    );
    expect(parser.parse(fp, 'x/x', 'x', 'builtin')!.valueFields).toEqual([
      { field: 'Cnt', label: 'Cnt' },
    ]);
  });

  it('returns null when no value field is defined', () => {
    const fp = writeFile(
      tmpDir,
      'x.yaml',
      'name: NoVal\nsoql: SELECT Id FROM Account\nlabelField: Id',
    );
    expect(parser.parse(fp, 'x/x', 'x', 'builtin')).toBeNull();
  });

  it('normalizes format and threshold/thresholdCondition', () => {
    const fp = writeFile(
      tmpDir,
      'x.yaml',
      `name: Threshold
soql: SELECT Status, COUNT(Id) Cnt FROM Order GROUP BY Status
labelField: Status
valueFields:
  - field: Cnt
    label: Count
    format: currency
    threshold: 100
    thresholdCondition: below
chartType: bar`,
    );
    const vf = parser.parse(fp, 'x/x', 'x', 'builtin')!.valueFields[0];
    expect(vf.format).toBe('currency');
    expect(vf.threshold).toBe(100);
    expect(vf.thresholdCondition).toBe('below');
  });

  it("defaults thresholdCondition to 'above' when threshold present without condition", () => {
    const fp = writeFile(
      tmpDir,
      'x.yaml',
      `name: T
soql: SELECT Status, COUNT(Id) Cnt FROM Order GROUP BY Status
labelField: Status
valueFields:
  - field: Cnt
    label: Count
    threshold: 50
chartType: bar`,
    );
    expect(parser.parse(fp, 'x/x', 'x', 'builtin')!.valueFields[0].thresholdCondition).toBe(
      'above',
    );
  });

  it('parses stacked, notifyOnIncrease, position and refreshInterval', () => {
    const fp = writeFile(
      tmpDir,
      'x.yaml',
      VALID_YAML + '\nstacked: true\nnotifyOnIncrease: true\nposition: 3\nrefreshInterval: 30\n',
    );
    const cfg = parser.parse(fp, 'x/x', 'x', 'builtin')!;
    expect(cfg.stacked).toBe(true);
    expect(cfg.notifyOnIncrease).toBe(true);
    expect(cfg.position).toBe(3);
    expect(cfg.refreshInterval).toBe(30);
  });
});
