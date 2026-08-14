import { describe, it, expect } from 'vitest';
import { dedupeModels, isAutoModel, pickModel, VENDOR_PRIORITY } from './modelSelection';

interface FakeModel {
  id: string;
  vendor: string;
  name: string;
}

const model = (id: string, vendor: string, name = id): FakeModel => ({ id, vendor, name });

/** Mirrors the real shape: `copilot` and `copilotcli` offering the same ids. */
const rawList = (): FakeModel[] => [
  model('claude-opus-4.6', 'copilot', 'Claude Opus 4.6'),
  model('claude-sonnet-5', 'copilot', 'Claude Sonnet 5'),
  model('gpt-5.4', 'copilot', 'GPT-5.4'),
  model('auto', 'copilot', 'Auto'),
  model('auto', 'copilotcli', 'Auto'),
  model('claude-sonnet-5', 'copilotcli', 'Claude Sonnet 5'),
  model('gpt-5.4', 'copilotcli', 'GPT-5.4'),
  model('claude-opus-4.6', 'copilotcli', 'Claude Opus 4.6'),
];

describe('isAutoModel', () => {
  it('matches by id or name, case-insensitively', () => {
    expect(isAutoModel({ id: 'auto', name: 'Auto' })).toBe(true);
    expect(isAutoModel({ id: 'AUTO', name: 'whatever' })).toBe(true);
    expect(isAutoModel({ id: 'some-id', name: ' auto ' })).toBe(true);
  });

  it('does not match a model that merely starts with "auto"', () => {
    expect(isAutoModel({ id: 'autopilot', name: 'Autopilot' })).toBe(false);
  });

  it('tolerates a missing name', () => {
    expect(isAutoModel({ id: 'auto' })).toBe(true);
    expect(isAutoModel({ id: 'gpt-5.4' })).toBe(false);
  });
});

describe('dedupeModels', () => {
  it('keeps exactly one entry per id', () => {
    const deduped = dedupeModels(rawList());
    expect(deduped).toHaveLength(4);
    expect(deduped.map((m) => m.id).sort()).toEqual([
      'auto',
      'claude-opus-4.6',
      'claude-sonnet-5',
      'gpt-5.4',
    ]);
  });

  it('collapses the two "auto" entries into one', () => {
    expect(dedupeModels(rawList()).filter(isAutoModel)).toHaveLength(1);
  });

  it('resolves a collision the same way regardless of input order', () => {
    const forwards = dedupeModels(rawList());
    const backwards = dedupeModels(rawList().reverse());
    const vendorsById = (models: FakeModel[]) =>
      Object.fromEntries(models.map((m) => [m.id, m.vendor]));

    // This is the property the old first-match-wins dedupe did NOT have: the
    // surviving vendor was whatever VS Code happened to return first.
    expect(vendorsById(forwards)).toEqual(vendorsById(backwards));
    expect(vendorsById(forwards)['claude-sonnet-5']).toBe('copilot');
  });

  it('prefers a listed vendor over an unlisted one whichever comes first', () => {
    const byok = model('claude-sonnet-5', 'anthropic');
    const copilot = model('claude-sonnet-5', 'copilot');
    expect(dedupeModels([byok, copilot])[0].vendor).toBe('copilot');
    expect(dedupeModels([copilot, byok])[0].vendor).toBe('copilot');
  });

  it('keeps distinct ids from other vendors instead of hiding them', () => {
    const models = [
      model('claude-sonnet-4.5', 'copilot', 'Claude Sonnet 4.5'),
      model('claude-sonnet-4-5-20250929', 'anthropic', 'Claude Sonnet 4.5'),
    ];
    // Same display name, different endpoints — both must survive.
    expect(dedupeModels(models)).toHaveLength(2);
  });

  it('keeps unlisted vendors in their original relative order', () => {
    const models = [model('a', 'ollama'), model('b', 'anthropic'), model('c', 'openai')];
    expect(dedupeModels(models).map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('returns an empty array for an empty list', () => {
    expect(dedupeModels([])).toEqual([]);
    expect(VENDOR_PRIORITY).toContain('copilot');
  });
});

describe('pickModel', () => {
  const models = dedupeModels(rawList());

  it('returns the requested model when it is available', () => {
    const { model: picked, fellBack } = pickModel(models, 'gpt-5.4');
    expect(picked?.id).toBe('gpt-5.4');
    expect(fellBack).toBe(false);
  });

  it('falls back to Auto and reports it when the requested model is gone', () => {
    const { model: picked, fellBack } = pickModel(models, 'retired-model');
    expect(picked?.id).toBe('auto');
    expect(fellBack).toBe(true);
  });

  it('uses Auto without reporting a fallback when nothing was requested', () => {
    const { model: picked, fellBack } = pickModel(models);
    expect(picked?.id).toBe('auto');
    expect(fellBack).toBe(false);
  });

  it('falls back to the first entry when there is no Auto model', () => {
    const withoutAuto = models.filter((m) => !isAutoModel(m));
    const { model: picked, fellBack } = pickModel(withoutAuto, 'retired-model');
    expect(picked).toBe(withoutAuto[0]);
    expect(fellBack).toBe(true);
  });

  it('returns no model for an empty list, so callers can raise NoModelsAvailableError', () => {
    expect(pickModel([], 'anything').model).toBeUndefined();
  });

  it('resolves every listed id back to the exact entry the picker was built from', () => {
    // The invariant the gateway depends on: listModels() and send() read the
    // same deduped array, so a saved id can never resolve to a different
    // vendor's model than the one the user picked.
    const deduped = dedupeModels(rawList());
    for (const entry of deduped) {
      expect(pickModel(deduped, entry.id).model).toBe(entry);
    }
  });
});
