import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import type { ConnectionManager } from '../../../salesforce/connection';
import { toSlug } from '../../../utils/slug';
import { loadYamlItems, type YamlSource } from '../../../utils/yaml-loader';

export interface MonitoringValueField {
  field: string;
  label: string;
  format?: 'currency' | 'percent';
  threshold?: number;
  thresholdCondition?: 'above' | 'below';
}

export interface MonitoringConfig {
  id: string; // "{category}/{filename-without-ext}"
  folder: string;
  name: string;
  description: string;
  soql: string;
  labelField: string;
  valueFields: MonitoringValueField[];
  chartType: 'bar' | 'line' | 'pie' | 'doughnut' | 'metric' | 'table';
  refreshInterval: number; // seconds, 0 = manual
  stacked?: boolean;
  source?: 'builtin' | 'user' | 'private';
  position?: number;
}

export interface MonitoringQueryResult {
  configId: string;
  labels: string[];
  datasets: Array<{ label: string; data: number[] }>;
  totalRows: number;
}

export interface MonitoringTableResult {
  configId: string;
  columnLabels: string[];
  rows: string[][];
  totalRows: number;
}

interface MonitoringRawDoc {
  name?: string;
  description?: string;
  soql?: string;
  labelField?: string;
  valueFields?: unknown;
  valueField?: string;
  chartType?: string;
  refreshInterval?: number;
  stacked?: boolean;
  position?: number;
}

export class MonitoringDashboardService {
  constructor(
    private readonly connectionManager: ConnectionManager,
    private readonly paths: { builtInPath: string; userPath: string; privatePath: string },
  ) {}

  async loadConfigs(): Promise<MonitoringConfig[]> {
    return await loadYamlItems(this.paths, (filePath, id, folder, source) =>
      this.parseMonitoringFile(filePath, id, folder, source),
    );
  }

  async runQuery(
    configId: string,
    soql: string,
    labelField: string,
    valueFields: MonitoringValueField[],
  ): Promise<MonitoringQueryResult> {
    const result = await this.connectionManager.query(soql);
    const records = (result.records ?? []) as Record<string, unknown>[];

    const labels = records.map((r) => String(r[labelField] ?? ''));
    const datasets = valueFields.map((vf) => ({
      label: vf.label,
      data: records.map((r) => Number(r[vf.field] ?? 0)),
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
        const v = r[f];
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

  saveConfig(config: MonitoringConfig, isPrivate = false): MonitoringConfig {
    const basePath = isPrivate ? this.paths.privatePath : this.paths.userPath;
    const slug = toSlug(config.name, 'chart');
    const folder = config.folder || 'general';
    const id = config.id || `${folder}/${slug}`;

    const [resolvedFolder] = id.split('/');
    const filename = id.includes('/') ? id.split('/').slice(1).join('/') : slug;

    // Block duplicate IDs across shared/private
    const otherPath = isPrivate ? this.paths.userPath : this.paths.privatePath;
    if (otherPath && fs.existsSync(otherPath)) {
      const otherFile = path.join(otherPath, resolvedFolder, `${filename}.yaml`);
      const otherFileYml = path.join(otherPath, resolvedFolder, `${filename}.yml`);
      if (fs.existsSync(otherFile) || fs.existsSync(otherFileYml)) {
        throw new Error(
          `A config with the same category and name already exists in the ${isPrivate ? 'shared' : 'private'} folder.`,
        );
      }
    }

    const targetDir = path.join(basePath, resolvedFolder);
    const targetPath = path.join(targetDir, `${filename}.yaml`);
    fs.mkdirSync(targetDir, { recursive: true });

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
      // Enforce minimum refresh interval of 10 seconds to prevent API rate limit exhaustion
      refreshInterval: Math.max(config.refreshInterval ?? 0, 10),
    };

    if (config.stacked) {
      data.stacked = true;
    }

    if (typeof config.position === 'number') {
      data.position = config.position;
    }

    fs.writeFileSync(targetPath, yaml.dump(data), 'utf8');

    return { ...config, id, folder: resolvedFolder, source: isPrivate ? 'private' : 'user' };
  }

  private parseMonitoringFile(
    filePath: string,
    id: string,
    folder: string,
    source: YamlSource,
  ): MonitoringConfig | null {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const parsed = yaml.load(content) as MonitoringRawDoc;
      if (!parsed || typeof parsed !== 'object') return null;

      const validated = this._validateMonitoringDoc(parsed);
      if (!validated) return null;

      const valueFields = this._normalizeValueFields(parsed);
      if (!valueFields) return null;

      return this._buildMonitoringConfig(
        parsed,
        id,
        folder,
        source,
        valueFields,
        validated.chartType,
      );
    } catch {
      return null;
    }
  }

  private _validateMonitoringDoc(
    parsed: MonitoringRawDoc,
  ): { chartType: MonitoringConfig['chartType'] } | null {
    if (!parsed.name || !parsed.soql) return null;

    const validChartTypes = ['bar', 'line', 'pie', 'doughnut', 'metric', 'table'];
    const chartType = validChartTypes.includes(parsed.chartType ?? '')
      ? (parsed.chartType as MonitoringConfig['chartType'])
      : 'bar';

    // labelField is required for all types except metric
    if (!parsed.labelField && chartType !== 'metric') return null;

    return { chartType };
  }

  private _normalizeValueFields(parsed: MonitoringRawDoc): MonitoringValueField[] | null {
    if (Array.isArray(parsed.valueFields) && parsed.valueFields.length > 0) {
      return (
        parsed.valueFields as Array<{
          field: string;
          label?: string;
          format?: string;
          threshold?: number;
          thresholdCondition?: string;
        }>
      ).map((vf) => {
        const entry: MonitoringValueField = {
          field: String(vf.field),
          label: String(vf.label ?? vf.field),
        };
        if (vf.format === 'currency' || vf.format === 'percent') {
          entry.format = vf.format;
        }
        if (typeof vf.threshold === 'number') {
          entry.threshold = vf.threshold;
          entry.thresholdCondition = vf.thresholdCondition === 'below' ? 'below' : 'above';
        }
        return entry;
      });
    }
    if (parsed.valueField) {
      return [{ field: parsed.valueField, label: parsed.valueField }];
    }
    return null; // No value field defined
  }

  private _buildMonitoringConfig(
    parsed: MonitoringRawDoc,
    id: string,
    folder: string,
    source: YamlSource,
    valueFields: MonitoringValueField[],
    chartType: MonitoringConfig['chartType'],
  ): MonitoringConfig {
    return {
      id,
      folder,
      name: parsed.name!,
      description: parsed.description ?? '',
      soql: parsed.soql!,
      labelField: parsed.labelField ?? '',
      valueFields,
      chartType,
      refreshInterval: Number(parsed.refreshInterval ?? 0),
      stacked: Boolean(parsed.stacked),
      source,
      ...(typeof parsed.position === 'number' ? { position: parsed.position } : {}),
    };
  }

  async savePositions(
    positions: Array<{ id: string; position: number; source: string }>,
  ): Promise<void> {
    const updates = positions.map(async (entry) => {
      const basePath = entry.source === 'private' ? this.paths.privatePath : this.paths.userPath;
      if (!basePath) return;
      const parts = entry.id.split('/');
      const folder = parts[0];
      const filename = parts.slice(1).join('/');
      if (!filename) return;

      let filePath = path.join(basePath, folder, `${filename}.yaml`);
      try {
        await fs.promises.access(filePath);
      } catch {
        // Try .yml extension
        filePath = path.join(basePath, folder, `${filename}.yml`);
        try {
          await fs.promises.access(filePath);
        } catch {
          return; // File not found
        }
      }

      try {
        const content = await fs.promises.readFile(filePath, 'utf8');
        const doc = yaml.load(content) as Record<string, unknown>;
        if (!doc || typeof doc !== 'object') return;
        doc.position = entry.position;
        await fs.promises.writeFile(filePath, yaml.dump(doc), 'utf8');
      } catch {
        // Skip files that can't be updated
      }
    });

    await Promise.all(updates);
  }
}
