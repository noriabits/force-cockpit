import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { toSlug } from '../../../../utils/slug';
import {
  checkDuplicateId,
  deleteYamlItem,
  dumpYaml,
  resolveYamlPath,
  splitItemId,
} from '../../../../utils/yamlRepository';
import type { MonitoringConfig } from '../types';

interface RepositoryPaths {
  userPath: string;
  privatePath: string;
}

export class MonitoringConfigRepository {
  constructor(private readonly paths: RepositoryPaths) {}

  saveConfig(config: MonitoringConfig, isPrivate = false): MonitoringConfig {
    const { basePath, slug, folder, id } = this.resolveSaveTarget(config, isPrivate);

    // Toggling the Private checkbox moves the config between shared/private
    const movingBetweenLocations =
      (config.source === 'user' || config.source === 'private') &&
      (config.source === 'private') !== isPrivate;

    // Block duplicate IDs across shared/private — except when the file in the
    // other location is this config's own previous file (a privacy move)
    const otherPath = isPrivate ? this.paths.userPath : this.paths.privatePath;
    const ownOldFile = movingBetweenLocations && config.id === id;
    if (!ownOldFile) {
      checkDuplicateId(id, otherPath, {
        noun: 'config',
        otherLabel: isPrivate ? 'shared' : 'private',
      });
    }

    const targetDir = path.join(basePath, folder);
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(
      path.join(targetDir, `${slug}.yaml`),
      dumpYaml(this.buildYamlData(config)),
      'utf8',
    );

    this.cleanupOldFile(config, id, movingBetweenLocations);

    return { ...config, id, folder, source: isPrivate ? 'private' : 'user' };
  }

  deleteConfig(id: string, isPrivate: boolean): void {
    const basePath = isPrivate ? this.paths.privatePath : this.paths.userPath;
    deleteYamlItem(basePath, id, 'config');
  }

  async savePositions(
    positions: Array<{ id: string; position: number; source: string }>,
  ): Promise<void> {
    const updates = positions.map(async (entry) => {
      const basePath = entry.source === 'private' ? this.paths.privatePath : this.paths.userPath;
      if (!basePath) return;
      const { folder, basename } = splitItemId(entry.id);
      if (!basename) return;

      const filePath = resolveYamlPath(basePath, folder, basename);
      if (!filePath) return; // File not found

      try {
        const content = await fs.promises.readFile(filePath, 'utf8');
        const doc = yaml.load(content) as Record<string, unknown>;
        if (!doc || typeof doc !== 'object') return;
        doc.position = entry.position;
        await fs.promises.writeFile(filePath, dumpYaml(doc), 'utf8');
      } catch {
        // Skip files that can't be updated
      }
    });

    await Promise.all(updates);
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private resolveSaveTarget(
    config: MonitoringConfig,
    isPrivate: boolean,
  ): { basePath: string; slug: string; folder: string; id: string } {
    const basePath = isPrivate ? this.paths.privatePath : this.paths.userPath;
    const slug = toSlug(config.name, 'chart');
    const folder = config.folder || 'general';
    // The id always follows the current category + name, so editing either
    // moves the file (the old one is removed afterwards)
    return { basePath, slug, folder, id: `${folder}/${slug}` };
  }

  private buildYamlData(config: MonitoringConfig): Record<string, unknown> {
    const data: Record<string, unknown> = {
      name: config.name,
      description: config.description || '',
      soql: config.soql,
      labelField: config.labelField,
      valueFields: config.valueFields.map((vf) => {
        const entry: Record<string, unknown> = { field: vf.field, label: vf.label };
        if (vf.format) entry.format = vf.format;
        if (vf.threshold != null) {
          entry.threshold = vf.threshold;
          if (vf.thresholdCondition && vf.thresholdCondition !== 'above') {
            entry.thresholdCondition = vf.thresholdCondition;
          }
        }
        return entry;
      }),
      chartType: config.chartType,
      // 0 = auto-refresh disabled; otherwise enforce a 10-second floor to avoid API rate limit exhaustion
      refreshInterval:
        config.refreshInterval && config.refreshInterval > 0
          ? Math.max(config.refreshInterval, 10)
          : 0,
    };

    if (config.stacked) data.stacked = true;
    if (config.notifyOnIncrease) data.notifyOnIncrease = true;
    if (typeof config.position === 'number') data.position = config.position;

    return data;
  }

  /**
   * Category/name change or privacy toggle on an existing user/private config:
   * remove the old file so the config moves instead of duplicating. Builtin
   * configs are bundled with the extension and never deleted.
   */
  private cleanupOldFile(
    config: MonitoringConfig,
    newId: string,
    movingBetweenLocations: boolean,
  ): void {
    if (
      config.id &&
      (config.id !== newId || movingBetweenLocations) &&
      (config.source === 'user' || config.source === 'private')
    ) {
      try {
        this.deleteConfig(config.id, config.source === 'private');
      } catch {
        // old file already gone — nothing to clean up
      }
    }
  }
}
