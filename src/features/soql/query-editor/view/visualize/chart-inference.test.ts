import { describe, expect, it } from 'vitest';
import {
  expressionLabels,
  numericColumns,
  pinBlocker,
  suggestChart,
  toChartData,
  toPinConfig,
} from './chart-inference';

const ID_A = '001000000000001AAA';
const ID_B = '001000000000002AAA';

describe('numericColumns', () => {
  it('keeps columns whose non-blank cells all parse as numbers', () => {
    const cols = ['StageName', 'n', 'amt', 'Mixed'];
    const rows = [
      ['Won', '3', '1000.5', '7'],
      ['Lost', '1', null, 'x'],
    ];
    expect(numericColumns(cols, rows)).toEqual(['n', 'amt']);
  });

  it('does not treat an all-blank column as numeric', () => {
    expect(numericColumns(['a'], [[null], ['  ']])).toEqual([]);
  });

  it('rejects booleans, dates and Ids', () => {
    const cols = ['b', 'd', 'Id'];
    expect(numericColumns(cols, [['true', '2024-01-01', ID_A]])).toEqual([]);
  });
});

describe('suggestChart', () => {
  it('labels an aggregate by its text column and plots every measure, including expr0', () => {
    const cols = ['StageName', 'expr0', 'amt'];
    const rows = Array.from({ length: 10 }, (_, i) => [`S${i}`, String(i), String(i * 10)]);
    expect(suggestChart(cols, rows)).toEqual({
      labelField: 'StageName',
      valueFields: ['expr0', 'amt'],
      chartType: 'bar',
    });
  });

  it('skips an Id column when picking the label', () => {
    const cols = ['Id', 'Owner.Name', 'Amount'];
    const rows = Array.from({ length: 10 }, (_, i) => [
      i % 2 ? ID_A : ID_B,
      `Owner ${i}`,
      String(i),
    ]);
    expect(suggestChart(cols, rows)?.labelField).toBe('Owner.Name');
  });

  it('falls back to an Id column when it is the only text column', () => {
    const rows = Array.from({ length: 10 }, (_, i) => [ID_A, String(i)]);
    expect(suggestChart(['Id', 'Amount'], rows)?.labelField).toBe('Id');
  });

  it('suggests a pie for a single series with a handful of slices', () => {
    const rows = [
      ['Open', '3'],
      ['Closed', '5'],
    ];
    expect(suggestChart(['Status', 'n'], rows)?.chartType).toBe('pie');
  });

  it('suggests a metric for a single unlabelled value', () => {
    expect(suggestChart(['n'], [['42']])).toEqual({
      labelField: '',
      valueFields: ['n'],
      chartType: 'metric',
    });
  });

  it('caps the default series at three', () => {
    const cols = ['k', 'a', 'b', 'c', 'd'];
    const rows = Array.from({ length: 10 }, () => ['x', '1', '2', '3', '4']);
    expect(suggestChart(cols, rows)?.valueFields).toEqual(['a', 'b', 'c']);
  });

  it('returns null when nothing is numeric', () => {
    expect(suggestChart(['Name'], [['Acme']])).toBeNull();
  });
});

describe('toChartData', () => {
  const cols = ['Status', 'n'];

  it('builds labels and datasets, plotting a blank value as 0', () => {
    const rows = [
      ['Open', '3'],
      [null, null],
    ];
    expect(toChartData(cols, rows, { labelField: 'Status', valueFields: ['n'] })).toEqual({
      labels: ['Open', ''],
      datasets: [{ label: 'n', data: [3, 0] }],
      truncated: false,
    });
  });

  it('numbers the points when there is no label column', () => {
    const data = toChartData(['n'], [['1'], ['2']], { labelField: '', valueFields: ['n'] });
    expect(data.labels).toEqual(['1', '2']);
  });

  it('stops at the cap and says so', () => {
    const rows = Array.from({ length: 5 }, (_, i) => [`S${i}`, String(i)]);
    const data = toChartData(cols, rows, { labelField: 'Status', valueFields: ['n'] }, {}, 3);
    expect(data.labels).toEqual(['S0', 'S1', 'S2']);
    expect(data.truncated).toBe(true);
  });
});

describe('pinBlocker', () => {
  it('needs at least one series', () => {
    expect(pinBlocker(null)).toBe('noSeries');
    expect(pinBlocker({ labelField: 'a', valueFields: [], chartType: 'bar' })).toBe('noSeries');
  });

  it('needs a label for anything but a metric', () => {
    expect(pinBlocker({ labelField: '', valueFields: ['n'], chartType: 'bar' })).toBe('noLabel');
    expect(pinBlocker({ labelField: '', valueFields: ['n'], chartType: 'metric' })).toBeNull();
    expect(pinBlocker({ labelField: 'a', valueFields: ['n'], chartType: 'pie' })).toBeNull();
  });
});

describe('toPinConfig', () => {
  const base = {
    name: '  Pipeline by stage ',
    folder: '',
    soql: 'SELECT StageName, COUNT(Id) n FROM Opportunity GROUP BY StageName',
    labelField: 'StageName',
    valueFields: ['n'],
    chartType: 'bar' as const,
    refreshInterval: 300,
  };

  it('builds a new config the host will slug and place', () => {
    expect(toPinConfig(base)).toEqual({
      id: '',
      folder: 'soql',
      name: 'Pipeline by stage',
      description: 'Pinned from the SOQL tab.',
      soql: base.soql,
      labelField: 'StageName',
      valueFields: [{ field: 'n', label: 'n' }],
      chartType: 'bar',
      refreshInterval: 300,
    });
  });

  it('drops the label for a metric', () => {
    expect(toPinConfig({ ...base, chartType: 'metric', folder: 'kpi' })).toMatchObject({
      labelField: '',
      folder: 'kpi',
    });
  });
});

describe('expressionLabels', () => {
  it('names each unaliased aggregate exprN in order, labelled by its expression', () => {
    expect(
      expressionLabels(
        'SELECT StageName, COUNT(Id), SUM(Amount) total, AVG( Amount ) FROM Opportunity GROUP BY StageName',
      ),
    ).toEqual({ expr0: 'COUNT(Id)', expr1: 'AVG( Amount )' });
  });

  it('skips name-keeping functions, plain fields and subqueries', () => {
    expect(
      expressionLabels(
        'SELECT FORMAT(Amount), toLabel(Status), Name, (SELECT Id FROM Contacts), MAX(CloseDate) FROM Account',
      ),
    ).toEqual({ expr0: 'MAX(CloseDate)' });
  });

  it('returns nothing for text that is not a query', () => {
    expect(expressionLabels('')).toEqual({});
  });
});

describe('labels in the chart and the pin', () => {
  it('uses the readable label on the series but keeps the exprN field', () => {
    const labels = { expr0: 'COUNT(Id)' };
    const data = toChartData(
      ['S', 'expr0'],
      [['a', '1']],
      { labelField: 'S', valueFields: ['expr0'] },
      labels,
    );
    expect(data.datasets[0].label).toBe('COUNT(Id)');
    const pin = toPinConfig({
      name: 'x',
      folder: 'f',
      soql: 'q',
      labelField: 'S',
      valueFields: ['expr0'],
      chartType: 'bar',
      refreshInterval: 0,
      columnLabels: labels,
    });
    expect(pin.valueFields).toEqual([{ field: 'expr0', label: 'COUNT(Id)' }]);
  });
});
