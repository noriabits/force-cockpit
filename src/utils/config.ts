import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

export interface CockpitConfig {
  apiVersion: string;
  protectedSandboxes: string[];
}

const DEFAULTS: CockpitConfig = {
  apiVersion: '65.0',
  protectedSandboxes: [],
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
  } catch {
    // Malformed YAML or read error — silently use existing config values
  }
}
