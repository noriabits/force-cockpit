import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

/** Tuning for the Debug Logs tab's "hide empty logs" filter. */
export interface DebugLogNoiseConfig {
  /** Logs at or below this size (bytes) count as empty. */
  maxEmptyBytes?: number;
  /** Logs at or below this duration (ms) count as empty. */
  maxEmptyDurationMs?: number;
  /** Case-insensitive substrings matched against ApexLog.Operation. */
  operationPatterns?: string[];
}

export interface CockpitConfig {
  apiVersion: string;
  protectedSandboxes: string[];
  /** Workspace-relative dirs scanned for Agent Skills (AI scripts), in priority order. */
  skillsPaths: string[];
  /** Optional overrides for the Debug Logs noise filter (`debugLogs.noise` in config.yaml). */
  debugLogNoise: DebugLogNoiseConfig;
}

const DEFAULTS: CockpitConfig = {
  apiVersion: '66.0',
  protectedSandboxes: [],
  skillsPaths: ['.claude/skills', '.github/skills'],
  debugLogNoise: {},
};

export function loadConfig(extensionPath: string, userBasePath: string): CockpitConfig {
  const config = { ...DEFAULTS };

  // Layer 1: bundled defaults (extensionPath/config.yaml)
  mergeFromFile(config, path.join(extensionPath, 'config.yaml'));

  // Layer 2: user overrides (userBasePath/config.yaml)
  mergeFromFile(config, path.join(userBasePath, 'config.yaml'));

  return config;
}

function mergeFromFile(config: CockpitConfig, filePath: string): void {
  try {
    if (!fs.existsSync(filePath)) return;
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = yaml.load(raw);
    if (typeof parsed !== 'object' || parsed === null) return;

    const obj = parsed as Record<string, unknown>;

    if (typeof obj.apiVersion === 'string' && obj.apiVersion.trim()) {
      config.apiVersion = obj.apiVersion.trim();
    }
    if (Array.isArray(obj.protectedSandboxes)) {
      config.protectedSandboxes = obj.protectedSandboxes.filter(
        (s): s is string => typeof s === 'string',
      );
    }
    if (Array.isArray(obj.skillsPaths)) {
      config.skillsPaths = obj.skillsPaths.filter((s): s is string => typeof s === 'string');
    }
    mergeDebugLogNoise(config, obj.debugLogs);
  } catch {
    // Malformed YAML or read error — silently use existing config values
  }
}

/** `debugLogs: { noise: { maxEmptyBytes, maxEmptyDurationMs, operationPatterns } }` */
function mergeDebugLogNoise(config: CockpitConfig, debugLogs: unknown): void {
  if (typeof debugLogs !== 'object' || debugLogs === null) return;
  const noise = (debugLogs as Record<string, unknown>).noise;
  if (typeof noise !== 'object' || noise === null) return;
  const obj = noise as Record<string, unknown>;
  const merged: DebugLogNoiseConfig = { ...config.debugLogNoise };

  if (typeof obj.maxEmptyBytes === 'number' && obj.maxEmptyBytes >= 0) {
    merged.maxEmptyBytes = obj.maxEmptyBytes;
  }
  if (typeof obj.maxEmptyDurationMs === 'number' && obj.maxEmptyDurationMs >= 0) {
    merged.maxEmptyDurationMs = obj.maxEmptyDurationMs;
  }
  if (Array.isArray(obj.operationPatterns)) {
    merged.operationPatterns = obj.operationPatterns.filter(
      (s): s is string => typeof s === 'string',
    );
  }
  config.debugLogNoise = merged;
}
