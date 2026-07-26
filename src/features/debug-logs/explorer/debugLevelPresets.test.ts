import { describe, expect, it } from 'vitest';
import {
  DEBUG_LEVEL_PRESETS,
  describeLevels,
  findPreset,
  LOG_CATEGORIES,
  LOG_LEVELS,
  presetDeveloperName,
  RECOMMENDED_PRESET_ID,
} from './debugLevelPresets';

describe('DEBUG_LEVEL_PRESETS', () => {
  it('documents every preset so the UI can explain when to use it', () => {
    for (const preset of DEBUG_LEVEL_PRESETS) {
      expect(preset.whenToUse.trim().length).toBeGreaterThan(10);
      expect(preset.description.trim().length).toBeGreaterThan(30);
    }
  });

  it('sets all eight categories to a valid level', () => {
    for (const preset of DEBUG_LEVEL_PRESETS) {
      for (const category of LOG_CATEGORIES) {
        expect(LOG_LEVELS).toContain(preset.levels[category]);
      }
    }
  });

  it('marks exactly one preset as recommended, and it is Balanced', () => {
    const recommended = DEBUG_LEVEL_PRESETS.filter((p) => p.recommended);
    expect(recommended).toHaveLength(1);
    expect(recommended[0].id).toBe(RECOMMENDED_PRESET_ID);
    expect(recommended[0].id).toBe('balanced');
  });

  it('warns about truncation only on the FINEST-everything preset', () => {
    const warned = DEBUG_LEVEL_PRESETS.filter((p) => p.truncationWarning).map((p) => p.id);
    expect(warned).toEqual(['deep-trace']);
  });

  it('uses unique ids', () => {
    const ids = DEBUG_LEVEL_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('findPreset', () => {
  it('resolves a known id and returns undefined otherwise', () => {
    expect(findPreset('balanced')?.label).toBe('Balanced');
    expect(findPreset('nope')).toBeUndefined();
  });
});

describe('presetDeveloperName', () => {
  it('builds a valid DeveloperName from the preset id', () => {
    expect(presetDeveloperName(findPreset('soql-deep-dive')!)).toBe('ForceCockpit_SoqlDeepDive');
    expect(presetDeveloperName(findPreset('balanced')!)).toBe('ForceCockpit_Balanced');
  });
});

describe('describeLevels', () => {
  it('lists only the categories that are actually captured', () => {
    const text = describeLevels(findPreset('user-debug-only')!.levels);
    expect(text).toContain('APEX_CODE,DEBUG');
    expect(text).toContain('SYSTEM,ERROR');
    expect(text).not.toContain('DB');
  });
});
