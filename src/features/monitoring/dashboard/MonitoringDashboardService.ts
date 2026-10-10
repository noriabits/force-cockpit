import type { ConnectionManager } from '../../../salesforce/connection';
import { loadYamlItems } from '../../../utils/yaml-loader';
import { MonitoringConfigParser } from './parsing/MonitoringConfigParser';
import { MonitoringConfigRepository } from './persistence/MonitoringConfigRepository';
import type {
  MonitoringConfig,
  MonitoringQueryResult,
  MonitoringTableResult,
  MonitoringValueField,
} from './types';

// Re-export the shared types so existing importers keep working.
export type {
  MonitoringConfig,
  MonitoringQueryResult,
  MonitoringTableResult,
  MonitoringValueField,
} from './types';

/**
 * Read a field by API path. A non-aggregate query returns a relationship as a
 * nested record (`{ Owner: { Name: 'Ana' } }`), so `labelField: Owner.Name` read
 * as a flat key would be blank on every row — exactly the column name the SOQL
 * tab shows for it, and what a chart pinned from there carries. Aggregate
 * results are already flat (`Name`, `expr0`), and a flat key is tried first so
 * an alias that happens to contain a dot still wins.
 */
function readField(record: Record<string, unknown>, fieldPath: string): unknown {
  if (fieldPath in record) return record[fieldPath];
  let value: unknown = record;
  for (const part of fieldPath.split('.')) {
    if (value === null || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

export class MonitoringDashboardService {
  private readonly parser = new MonitoringConfigParser();
  private readonly repo: MonitoringConfigRepository;

  constructor(
    private readonly connectionManager: ConnectionManager,
    private readonly paths: { builtInPath: string; userPath: string; privatePath: string },
  ) {
    this.repo = new MonitoringConfigRepository({
      userPath: paths.userPath,
      privatePath: paths.privatePath,
    });
  }

  async loadConfigs(hiddenBuiltinIds?: Set<string>): Promise<MonitoringConfig[]> {
    const items = await loadYamlItems(this.paths, (filePath, id, folder, source) =>
      this.parser.parse(filePath, id, folder, source),
    );
    if (!hiddenBuiltinIds || hiddenBuiltinIds.size === 0) return items;
    return items.filter((cfg) => !(cfg.source === 'builtin' && hiddenBuiltinIds.has(cfg.id)));
  }

  async runQuery(
    configId: string,
    soql: string,
    labelField: string,
    valueFields: MonitoringValueField[],
  ): Promise<MonitoringQueryResult> {
    const result = await this.connectionManager.query(soql);
    const records = (result.records ?? []) as Record<string, unknown>[];

    const labels = records.map((r) => String(readField(r, labelField) ?? ''));
    const datasets = valueFields.map((vf) => ({
      label: vf.label,
      data: records.map((r) => Number(readField(r, vf.field) ?? 0)),
    }));

    return {
      configId,
      labels,
      datasets,
      totalRows: result.totalSize ?? records.length,
    };
  }

  async runTableQuery(
    configId: string,
    soql: string,
    labelField: string,
    valueFields: MonitoringValueField[],
  ): Promise<MonitoringTableResult> {
    const result = await this.connectionManager.query(soql);
    const records = (result.records ?? []) as Record<string, unknown>[];

    const fields = labelField
      ? [labelField, ...valueFields.map((vf) => vf.field)]
      : valueFields.map((vf) => vf.field);
    const columnLabels = labelField
      ? [labelField, ...valueFields.map((vf) => vf.label || vf.field)]
      : valueFields.map((vf) => vf.label || vf.field);

    const rows = records.map((r) =>
      fields.map((f) => {
        const v = readField(r, f);
        return v === null || v === undefined ? '' : String(v);
      }),
    );

    return {
      configId,
      columnLabels,
      rows,
      totalRows: result.totalSize ?? records.length,
    };
  }

  saveConfig(
    config: MonitoringConfig,
    isPrivate = false,
    options: { createOnly?: boolean } = {},
  ): MonitoringConfig {
    return this.repo.saveConfig(config, isPrivate, options);
  }

  deleteConfig(id: string, isPrivate: boolean): void {
    this.repo.deleteConfig(id, isPrivate);
  }

  savePositions(positions: Array<{ id: string; position: number; source: string }>): Promise<void> {
    return this.repo.savePositions(positions);
  }
}
