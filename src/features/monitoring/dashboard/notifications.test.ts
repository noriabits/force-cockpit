import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const showWarningMessage = vi.fn();
vi.mock('vscode', () => ({
  window: { showWarningMessage },
}));

const playRowCountPing = vi.fn();
vi.mock('./audio', () => ({ playRowCountPing }));

type NotificationsModule = typeof import('./notifications');
type MonitoringValueField = import('./MonitoringDashboardService').MonitoringValueField;

function makeMemento() {
  const store: Record<string, unknown> = {};
  return {
    store,
    get: vi.fn((key: string, fallback: unknown) => store[key] ?? fallback),
    update: vi.fn((key: string, value: unknown) => {
      store[key] = value;
      return Promise.resolve();
    }),
  };
}

function vf(overrides: Partial<MonitoringValueField> = {}): MonitoringValueField {
  return { field: 'Cnt', label: 'Count', ...overrides };
}

async function load(): Promise<NotificationsModule> {
  return (await import('./notifications')) as NotificationsModule;
}

describe('notifications', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    showWarningMessage.mockReset();
    playRowCountPing.mockReset();
    const mod = await load();
    mod.__resetNotificationStateForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('checkThresholds', () => {
    it('breaches with the default "above" condition when a value is >= threshold', async () => {
      const { checkThresholds } = await load();
      const breaches = checkThresholds(
        'cat/c',
        'My Chart',
        [{ data: [50, 150] }],
        [vf({ threshold: 100 })],
      );
      expect(breaches).toHaveLength(1);
      expect(breaches[0].cooldownKey).toBe('cat/c:0:');
      expect(breaches[0].message).toContain('exceeded threshold of 100');
      expect(breaches[0].message).toContain('current: 150');
    });

    it('does not breach when all values are below an "above" threshold', async () => {
      const { checkThresholds } = await load();
      expect(checkThresholds('id', 'n', [{ data: [10, 20] }], [vf({ threshold: 100 })])).toEqual(
        [],
      );
    });

    it('breaches with "below" condition when a value is <= threshold', async () => {
      const { checkThresholds } = await load();
      const breaches = checkThresholds(
        'id',
        'n',
        [{ data: [5, 50] }],
        [vf({ threshold: 10, thresholdCondition: 'below' })],
      );
      expect(breaches).toHaveLength(1);
      expect(breaches[0].message).toContain('fell below threshold of 10');
      // worst = Math.min for "below"
      expect(breaches[0].message).toContain('current: 5');
    });

    it('ignores value fields without a threshold', async () => {
      const { checkThresholds } = await load();
      expect(checkThresholds('id', 'n', [{ data: [999] }], [vf()])).toEqual([]);
    });

    it('suppresses a repeat breach within the 1-minute cooldown, then fires after it expires', async () => {
      const { checkThresholds } = await load();
      const args = ['id', 'n', [{ data: [150] }], [vf({ threshold: 100 })]] as const;

      expect(checkThresholds(...args)).toHaveLength(1);
      // Second check immediately after → suppressed by cooldown
      expect(checkThresholds(...args)).toHaveLength(0);
      // Just before the cooldown expires → still suppressed
      vi.advanceTimersByTime(59_000);
      expect(checkThresholds(...args)).toHaveLength(0);
      // After cooldown → fires again
      vi.advanceTimersByTime(2_000);
      expect(checkThresholds(...args)).toHaveLength(1);
    });

    it('formats currency and percent values in the message', async () => {
      const { checkThresholds } = await load();
      const cur = checkThresholds(
        'a',
        'n',
        [{ data: [1234.5] }],
        [vf({ threshold: 1000, format: 'currency' })],
      );
      // Derive from the same toLocaleString options the formatter uses so the
      // assertion holds under any host locale ("1,234.50" vs "1234,50").
      const expectedCurrency = (1234.5).toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
      expect(cur[0].message).toContain(expectedCurrency);

      const pct = checkThresholds(
        'b',
        'n',
        [{ data: [42.25] }],
        [vf({ threshold: 10, format: 'percent' })],
      );
      expect(pct[0].message).toContain('42.3%');
    });
  });

  describe('fireBreachNotifications + snooze persistence', () => {
    it('persists a "Snooze 1h" snooze and prunes expired entries on load', async () => {
      const mod = await load();
      showWarningMessage.mockResolvedValue('Snooze 1h');
      const memento = makeMemento();

      mod.fireBreachNotifications([{ message: 'boom', cooldownKey: 'cat/c:0:' }], memento as never);
      // Flush the .then() on the showWarningMessage promise
      await Promise.resolve();
      await Promise.resolve();

      expect(memento.update).toHaveBeenCalled();
      const saved = memento.store['monitoring.notificationCooldowns'] as Record<string, number>;
      expect(saved['cat/c:0:']).toBeGreaterThan(Date.now());

      // A fresh module load with an expired snooze prunes it
      mod.__resetNotificationStateForTests();
      const expiredMemento = makeMemento();
      expiredMemento.store['monitoring.notificationCooldowns'] = {
        'old:0:': Date.now() - 1000,
        'live:0:': Date.now() + 5_000_000,
      };
      mod.loadPersistedSnoozes(expiredMemento as never);
      // live key still silences a breach; old key does not
      const breaches = mod.checkThresholds(
        'live',
        'n',
        [{ data: [150] }],
        [vf({ threshold: 100 })],
      );
      expect(breaches).toEqual([]);
    });

    it('does not persist the ephemeral 1-minute dedup cooldown', async () => {
      const mod = await load();
      const memento = makeMemento();
      // A plain breach sets only the short cooldown
      mod.checkThresholds('cat/c', 'n', [{ data: [150] }], [vf({ threshold: 100 })]);
      // clearAllCooldownsFor triggers a persist; the short cooldown must be filtered out
      mod.clearAllCooldownsFor('other', memento as never);
      const saved = (memento.store['monitoring.notificationCooldowns'] ?? {}) as Record<
        string,
        number
      >;
      expect(saved['cat/c:0:']).toBeUndefined();
    });
  });

  describe('clearAllCooldownsFor', () => {
    it('clears the matching configId cooldown so the next check fires again', async () => {
      const mod = await load();
      const memento = makeMemento();
      const breach = ['drop', 'n', [{ data: [150] }], [vf({ threshold: 100 })]] as const;

      // Establish the dedup cooldown — a repeat is now suppressed
      expect(mod.checkThresholds(...breach)).toHaveLength(1);
      expect(mod.checkThresholds(...breach)).toHaveLength(0);

      // Clearing the cooldown lets it fire again immediately
      mod.clearAllCooldownsFor('drop', memento as never);
      expect(mod.checkThresholds(...breach)).toHaveLength(1);
    });

    it('does not touch cooldowns for other configIds', async () => {
      const mod = await load();
      const memento = makeMemento();
      mod.checkThresholds('keep', 'n', [{ data: [150] }], [vf({ threshold: 100 })]);

      mod.clearAllCooldownsFor('drop', memento as never);
      // 'keep' cooldown survives → repeat still suppressed
      expect(
        mod.checkThresholds('keep', 'n', [{ data: [150] }], [vf({ threshold: 100 })]),
      ).toHaveLength(0);
    });
  });

  describe('checkRowCountIncrease', () => {
    it('establishes the baseline silently on first call', async () => {
      const { checkRowCountIncrease } = await load();
      expect(checkRowCountIncrease('id', 'org', 'n', 5, true)).toEqual([]);
    });

    it('fires on growth with a delta message, then updates the baseline', async () => {
      const { checkRowCountIncrease } = await load();
      checkRowCountIncrease('id', 'org', 'n', 5, true); // baseline
      const msgs = checkRowCountIncrease('id', 'org', 'n', 8, true);
      expect(msgs).toHaveLength(1);
      expect(msgs[0].message).toContain('3 new records');
      expect(msgs[0].message).toContain('(5 → 8)');
      // baseline now 8 → another check at 8 does not fire
      expect(checkRowCountIncrease('id', 'org', 'n', 8, true)).toEqual([]);
    });

    it('uses singular "record" for a delta of 1', async () => {
      const { checkRowCountIncrease } = await load();
      checkRowCountIncrease('id', 'org', 'n', 5, true);
      expect(checkRowCountIncrease('id', 'org', 'n', 6, true)[0].message).toContain(
        '1 new record (',
      );
    });

    it('does not fire when the count shrinks', async () => {
      const { checkRowCountIncrease } = await load();
      checkRowCountIncrease('id', 'org', 'n', 10, true);
      expect(checkRowCountIncrease('id', 'org', 'n', 4, true)).toEqual([]);
    });

    it('does not fire when notifyOnIncrease is false but still tracks the baseline', async () => {
      const { checkRowCountIncrease } = await load();
      expect(checkRowCountIncrease('id', 'org', 'n', 5, false)).toEqual([]);
      // enabling later: baseline is 5, growth to 9 fires
      expect(checkRowCountIncrease('id', 'org', 'n', 9, true)).toHaveLength(1);
    });

    it('tracks baselines per org — one org does not leak into another', async () => {
      const { checkRowCountIncrease } = await load();
      // orgA establishes a baseline of 5
      expect(checkRowCountIncrease('id', 'orgA', 'n', 5, true)).toEqual([]);
      // switching to orgB with a higher count must NOT fire — it starts fresh
      expect(checkRowCountIncrease('id', 'orgB', 'n', 100, true)).toEqual([]);
      // orgB growth fires against orgB's own baseline, not orgA's
      expect(checkRowCountIncrease('id', 'orgB', 'n', 105, true)).toHaveLength(1);
    });

    it('compares against the same org when switching back', async () => {
      const { checkRowCountIncrease } = await load();
      checkRowCountIncrease('id', 'orgA', 'n', 5, true); // orgA baseline 5
      checkRowCountIncrease('id', 'orgB', 'n', 100, true); // orgB baseline 100
      // back to orgA: growth from 5 → 9 fires against orgA's retained baseline
      const msgs = checkRowCountIncrease('id', 'orgA', 'n', 9, true);
      expect(msgs).toHaveLength(1);
      expect(msgs[0].message).toContain('(5 → 9)');
    });

    it('clearRowCountBaseline resets every org so the next call re-establishes silently', async () => {
      const { checkRowCountIncrease, clearRowCountBaseline } = await load();
      checkRowCountIncrease('id', 'orgA', 'n', 5, true);
      checkRowCountIncrease('id', 'orgB', 'n', 50, true);
      clearRowCountBaseline('id');
      expect(checkRowCountIncrease('id', 'orgA', 'n', 100, true)).toEqual([]);
      expect(checkRowCountIncrease('id', 'orgB', 'n', 100, true)).toEqual([]);
    });
  });

  describe('org label in messages', () => {
    it('orgLabelOf: alias wins, then Production, then the last dot-part of the username', async () => {
      const { orgLabelOf } = await load();
      expect(orgLabelOf({ alias: 'uat', username: 'a@b.com.uat' }, false)).toBe('uat');
      expect(orgLabelOf({ alias: 'prod-alias', username: 'a@b.com' }, true)).toBe('prod-alias');
      expect(orgLabelOf({ username: 'a@b.com' }, true)).toBe('Production');
      expect(orgLabelOf({ username: 'a@company.com.dev02' }, false)).toBe('dev02');
      expect(orgLabelOf({ username: 'nodots' }, false)).toBe('nodots');
      expect(orgLabelOf(null, true)).toBe('');
    });

    it('currentOrgLabel treats a missing sandbox name as production', async () => {
      const { currentOrgLabel } = await load();
      const cm = (sandbox: string | null) =>
        ({
          getCurrentOrg: () => ({ username: 'a@company.com.dev02' }),
          getSandboxName: () => sandbox,
        }) as never;
      expect(currentOrgLabel(cm(null))).toBe('Production');
      expect(currentOrgLabel(cm('dev02'))).toBe('dev02');
    });

    it('tags a threshold breach and a row-count increase with the org', async () => {
      const { checkThresholds, checkRowCountIncrease } = await load();
      const [breach] = checkThresholds(
        'c',
        'Cases',
        [{ data: [150] }],
        [vf({ threshold: 100 })],
        'a@b.com',
        'uat',
      );
      expect(breach.message.startsWith('[Cases · uat] ')).toBe(true);
      checkRowCountIncrease('c', 'a@b.com', 'Cases', 5, true, 'uat');
      const [inc] = checkRowCountIncrease('c', 'a@b.com', 'Cases', 7, true, 'uat');
      expect(inc.message.startsWith('[Cases · uat] 2 new records')).toBe(true);
    });

    it('keeps the plain [Config] tag when no org label is known', async () => {
      const { checkThresholds } = await load();
      const [breach] = checkThresholds('c', 'Cases', [{ data: [150] }], [vf({ threshold: 100 })]);
      expect(breach.message.startsWith('[Cases] ')).toBe(true);
    });
  });

  describe('per-org snooze keys', () => {
    it('a threshold snoozed in one org still fires in another', async () => {
      const mod = await load();
      showWarningMessage.mockResolvedValue('Snooze 1h');
      const memento = makeMemento();
      const args = [[{ data: [150] }], [vf({ threshold: 100 })]] as const;
      const [breach] = mod.checkThresholds('c', 'n', ...args, 'orgA');
      mod.fireBreachNotifications([breach], memento as never);
      await Promise.resolve();
      await Promise.resolve();
      vi.advanceTimersByTime(61_000); // past the 1-minute dedup, still inside the 1h snooze
      expect(mod.checkThresholds('c', 'n', ...args, 'orgA')).toHaveLength(0);
      expect(mod.checkThresholds('c', 'n', ...args, 'orgB')).toHaveLength(1);
    });
  });

  describe('fireRowCountNotifications', () => {
    const inc = (message: string, cooldownKey = 'id:rows:org') => ({ message, cooldownKey });

    it('plays the ping and shows a snoozable warning per increase', async () => {
      const { fireRowCountNotifications } = await load();
      showWarningMessage.mockResolvedValue(undefined);
      fireRowCountNotifications(
        [inc('m1', 'a:rows:o'), inc('m2', 'b:rows:o')],
        makeMemento() as never,
      );
      expect(playRowCountPing).toHaveBeenCalledTimes(1);
      expect(showWarningMessage).toHaveBeenCalledTimes(2);
      expect(showWarningMessage).toHaveBeenCalledWith('m1', 'Snooze 1h', 'Snooze for today');
    });

    it('is a no-op for an empty list', async () => {
      const { fireRowCountNotifications } = await load();
      fireRowCountNotifications([], makeMemento() as never);
      expect(playRowCountPing).not.toHaveBeenCalled();
      expect(showWarningMessage).not.toHaveBeenCalled();
    });

    it('persists "Snooze 1h", then stays silent (toast and ping) while snoozed', async () => {
      const { fireRowCountNotifications } = await load();
      showWarningMessage.mockResolvedValue('Snooze 1h');
      const memento = makeMemento();
      fireRowCountNotifications([inc('m1')], memento as never);
      await Promise.resolve();
      await Promise.resolve();
      const saved = memento.store['monitoring.notificationCooldowns'] as Record<string, number>;
      expect(saved['id:rows:org']).toBeGreaterThan(Date.now());

      showWarningMessage.mockClear();
      playRowCountPing.mockClear();
      fireRowCountNotifications([inc('m2')], memento as never);
      expect(showWarningMessage).not.toHaveBeenCalled();
      expect(playRowCountPing).not.toHaveBeenCalled();
    });

    it('"Snooze for today" lasts until local midnight', async () => {
      const { fireRowCountNotifications } = await load();
      showWarningMessage.mockResolvedValue('Snooze for today');
      const memento = makeMemento();
      fireRowCountNotifications([inc('m1')], memento as never);
      await Promise.resolve();
      await Promise.resolve();
      const saved = memento.store['monitoring.notificationCooldowns'] as Record<string, number>;
      const midnight = new Date();
      midnight.setHours(24, 0, 0, 0);
      expect(saved['id:rows:org']).toBe(midnight.getTime());
    });

    it('a snooze for one org does not silence another', async () => {
      const { fireRowCountNotifications } = await load();
      showWarningMessage.mockResolvedValue('Snooze 1h');
      const memento = makeMemento();
      fireRowCountNotifications([inc('m1', 'id:rows:orgA')], memento as never);
      await Promise.resolve();
      await Promise.resolve();
      showWarningMessage.mockClear();
      fireRowCountNotifications([inc('m2', 'id:rows:orgB')], memento as never);
      expect(showWarningMessage).toHaveBeenCalledTimes(1);
    });

    it('keeps advancing the baseline while snoozed, so a later alert reports only the new delta', async () => {
      const { checkRowCountIncrease, fireRowCountNotifications } = await load();
      showWarningMessage.mockResolvedValue('Snooze 1h');
      const memento = makeMemento();
      checkRowCountIncrease('id', 'org', 'n', 5, true);
      fireRowCountNotifications(checkRowCountIncrease('id', 'org', 'n', 8, true), memento as never);
      await Promise.resolve();
      await Promise.resolve();
      // during the snooze: 8 → 20 is detected but silent
      const silent = checkRowCountIncrease('id', 'org', 'n', 20, true);
      fireRowCountNotifications(silent, memento as never);
      expect(showWarningMessage).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(2 * 60 * 60 * 1000);
      const next = checkRowCountIncrease('id', 'org', 'n', 21, true);
      expect(next[0].message).toContain('(20 → 21)');
    });
  });

  describe('pruneCooldowns', () => {
    function seed(mod: NotificationsModule) {
      mod.loadPersistedSnoozes({
        get: () => ({
          'c:0:org': Date.now() + 5_000_000,
          'c:3:org': Date.now() + 5_000_000,
          'c:rows:org': Date.now() + 5_000_000,
        }),
      } as never);
    }
    const persisted = (m: ReturnType<typeof makeMemento>) =>
      Object.keys((m.store['monitoring.notificationCooldowns'] ?? {}) as object).sort();

    it('keeps the row-count key while notifyOnIncrease is on, drops stale indices', async () => {
      const mod = await load();
      seed(mod);
      const memento = makeMemento();
      mod.pruneCooldowns('c', [vf({ threshold: 1 })], true, memento as never);
      expect(persisted(memento)).toEqual(['c:0:org', 'c:rows:org']);
    });

    it('drops the row-count key once notifyOnIncrease is turned off', async () => {
      const mod = await load();
      seed(mod);
      const memento = makeMemento();
      mod.pruneCooldowns('c', [vf({ threshold: 1 })], false, memento as never);
      expect(persisted(memento)).toEqual(['c:0:org']);
    });
  });
});
