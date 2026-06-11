import { describe, expect, it } from 'vitest';
import { hasNotifications } from './notification-config';
import type { MonitoringConfig } from './types';

function baseConfig(overrides: Partial<MonitoringConfig> = {}): MonitoringConfig {
  return {
    id: 'cat/chart',
    folder: 'cat',
    name: 'Chart',
    description: '',
    soql: 'SELECT Id FROM Account',
    labelField: 'Id',
    valueFields: [{ field: 'Cnt', label: 'Count' }],
    chartType: 'bar',
    refreshInterval: 30,
    ...overrides,
  };
}

describe('hasNotifications', () => {
  it('returns true when any value field has a threshold', () => {
    expect(
      hasNotifications(baseConfig({ valueFields: [{ field: 'A', label: 'A', threshold: 10 }] })),
    ).toBe(true);
  });

  it('returns true for a zero threshold (!= null semantics)', () => {
    expect(
      hasNotifications(baseConfig({ valueFields: [{ field: 'A', label: 'A', threshold: 0 }] })),
    ).toBe(true);
  });

  it('returns true when notifyOnIncrease is set', () => {
    expect(hasNotifications(baseConfig({ notifyOnIncrease: true }))).toBe(true);
  });

  it('returns false when neither thresholds nor notifyOnIncrease are set', () => {
    expect(hasNotifications(baseConfig())).toBe(false);
  });

  it('returns false when valueFields is missing', () => {
    expect(hasNotifications(baseConfig({ valueFields: undefined as never }))).toBe(false);
  });
});
