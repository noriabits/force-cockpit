import { describe, it, expect } from 'vitest';
import {
  autoModelId,
  excludeAutoModel,
  groupModelsByVendor,
  resolveSelectedModelId,
  vendorLabel,
  type ModelOption,
} from './model-picker';

const copilotModels: ModelOption[] = [
  { id: 'auto', name: 'Auto', vendor: 'copilot' },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', vendor: 'copilot' },
  { id: 'gpt-5.4', name: 'GPT-5.4', vendor: 'copilot' },
];

describe('vendorLabel', () => {
  it('maps known vendor ids to their display names', () => {
    expect(vendorLabel('copilot')).toBe('Copilot');
    expect(vendorLabel('gemini')).toBe('Google');
  });

  it('falls back to the raw id for a vendor it does not know', () => {
    expect(vendorLabel('somenewvendor')).toBe('somenewvendor');
  });
});

describe('autoModelId', () => {
  it('finds the Auto model', () => {
    expect(autoModelId(copilotModels)).toBe('auto');
  });

  it('returns empty when the list has no Auto model', () => {
    expect(autoModelId(copilotModels.filter((m) => m.id !== 'auto'))).toBe('');
    expect(autoModelId([])).toBe('');
  });
});

describe('excludeAutoModel', () => {
  it('removes the Auto model, which the pickers already show as their own sentinel', () => {
    const list = excludeAutoModel(copilotModels);
    expect(list.map((m) => m.id)).toEqual(['claude-sonnet-5', 'gpt-5.4']);
  });

  it('leaves a list without an Auto model untouched', () => {
    const withoutAuto = copilotModels.filter((m) => m.id !== 'auto');
    expect(excludeAutoModel(withoutAuto)).toHaveLength(2);
    expect(excludeAutoModel([])).toEqual([]);
  });

  it('does not remove a model that merely starts with "auto"', () => {
    const models = [{ id: 'autopilot', name: 'Autopilot', vendor: 'copilot' }];
    expect(excludeAutoModel(models)).toHaveLength(1);
  });
});

describe('groupModelsByVendor', () => {
  it('returns one unlabelled group for a single vendor, so the picker renders flat', () => {
    const groups = groupModelsByVendor(copilotModels);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe('');
    expect(groups[0].models).toHaveLength(3);
  });

  it('returns no groups for an empty list', () => {
    expect(groupModelsByVendor([])).toEqual([]);
  });

  it('labels each vendor once a second one appears', () => {
    const groups = groupModelsByVendor([
      ...copilotModels,
      { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5', vendor: 'anthropic' },
    ]);
    expect(groups.map((g) => g.label)).toEqual(['Copilot', 'Anthropic']);
    expect(groups[1].models).toHaveLength(1);
  });

  it('keeps Copilot first and sorts the remaining vendors by label', () => {
    const groups = groupModelsByVendor([
      { id: 'llama3.1', name: 'llama3.1', vendor: 'ollama' },
      { id: 'claude-x', name: 'Claude X', vendor: 'anthropic' },
      ...copilotModels,
    ]);
    expect(groups.map((g) => g.label)).toEqual(['Copilot', 'Anthropic', 'Ollama']);
  });

  it('groups models that share a display name but come from different vendors', () => {
    // The case a bare model name cannot express: same name, different endpoint,
    // different subscription paying for it.
    const groups = groupModelsByVendor([
      { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5', vendor: 'copilot' },
      { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5', vendor: 'anthropic' },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.models[0].id)).toEqual([
      'claude-sonnet-4.5',
      'claude-sonnet-4-5-20250929',
    ]);
  });
});

describe('resolveSelectedModelId', () => {
  it('keeps the live DOM value over a stale remembered pick', () => {
    // The clobber case: the user picked gpt-5.4, the host knows, the local
    // variable does not, and a background refresh rebuilds the <select>.
    expect(resolveSelectedModelId(copilotModels, ['gpt-5.4', 'claude-sonnet-5'])).toBe('gpt-5.4');
  });

  it('falls through to the next candidate when the first is empty', () => {
    expect(resolveSelectedModelId(copilotModels, ['', 'claude-sonnet-5'])).toBe('claude-sonnet-5');
    expect(resolveSelectedModelId(copilotModels, [null, undefined, 'gpt-5.4'])).toBe('gpt-5.4');
  });

  it('skips a candidate that is no longer in the list', () => {
    expect(resolveSelectedModelId(copilotModels, ['retired-model', 'gpt-5.4'])).toBe('gpt-5.4');
  });

  it('returns the fallback when no candidate survives', () => {
    expect(resolveSelectedModelId(copilotModels, ['retired-model'])).toBe('');
    expect(resolveSelectedModelId(copilotModels, ['retired-model'], 'auto')).toBe('auto');
  });

  it('returns the fallback for an empty model list', () => {
    expect(resolveSelectedModelId([], ['gpt-5.4'], 'auto')).toBe('auto');
  });
});
