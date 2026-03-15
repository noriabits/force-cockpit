import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import type { ConnectionManager } from '../../../salesforce/connection';

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

export class MonitoringDashboardService {
  constructor(
    private readonly connectionManager: ConnectionManager,
    private readonly paths: { builtInPath: string; userPath: string; privatePath: string },
  ) {}

  async loadConfigs(): Promise<MonitoringConfig[]> {
    const builtIn = this.loadFromPath(this.paths.builtInPath, 'builtin');
    const user = this.loadFromPath(this.paths.userPath, 'user');
    const priv = this.loadFromPath(this.paths.privatePath, 'private');

    // Merge: builtin < user < private (later sources override earlier by same id)
    const map = new Map<string, MonitoringConfig>();
    for (const cfg of builtIn) {
      map.set(cfg.id, cfg);
    }
    for (const cfg of user) {
      map.set(cfg.id, cfg);
    }
    for (const cfg of priv) {
      map.set(cfg.id, cfg);
    }

    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
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
    const slug = this.toSlug(config.name);
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
      refreshInterval: config.refreshInterval ?? 0,
    };

    if (config.stacked) {
      data.stacked = true;
    }

    fs.writeFileSync(targetPath, yaml.dump(data), 'utf8');

    return { ...config, id, folder: resolvedFolder, source: isPrivate ? 'private' : 'user' };
  }

  private loadFromPath(
    basePath: string,
    source: 'builtin' | 'user' | 'private',
  ): MonitoringConfig[] {
    if (!basePath || !fs.existsSync(basePath)) {
      return [];
    }

    const configs: MonitoringConfig[] = [];

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(basePath, { withFileTypes: true });
    } catch {
      return [];
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const parentFolder = entry.name;
      const folderPath = path.join(basePath, parentFolder);

      let folderEntries: fs.Dirent[];
      try {
        folderEntries = fs.readdirSync(folderPath, { withFileTypes: true });
      } catch {
        continue;
      }

      // Process YAML files in this folder
      this.loadMonitoringYamlFiles(folderPath, parentFolder, source, configs);

      // Process sub-folders (one level of nesting)
      for (const subEntry of folderEntries) {
        if (!subEntry.isDirectory()) continue;
        const subFolder = `${parentFolder}/${subEntry.name}`;
        const subFolderPath = path.join(folderPath, subEntry.name);
        this.loadMonitoringYamlFiles(subFolderPath, subFolder, source, configs);
      }
    }

    return configs;
  }

  private loadMonitoringYamlFiles(
    dirPath: string,
    folder: string,
    source: 'builtin' | 'user' | 'private',
    configs: MonitoringConfig[],
  ): void {
    let files: string[];
    try {
      files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
    } catch {
      return;
    }

    for (const file of files) {
      const filePath = path.join(dirPath, file);
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const parsed = yaml.load(content) as {
          name?: string;
          description?: string;
          soql?: string;
          labelField?: string;
          valueFields?: unknown;
          valueField?: string;
          chartType?: string;
          refreshInterval?: number;
          stacked?: boolean;
        };

        if (!parsed || typeof parsed !== 'object' || !parsed.name || !parsed.soql) {
          continue;
        }

        const validChartTypes = ['bar', 'line', 'pie', 'doughnut', 'metric', 'table'];
        const chartType = validChartTypes.includes(parsed.chartType ?? '')
          ? (parsed.chartType as MonitoringConfig['chartType'])
          : 'bar';

        // labelField is required for all types except metric
        if (!parsed.labelField && chartType !== 'metric') {
          continue;
        }

        // Support both valueField (shorthand) and valueFields (full)
        let valueFields: MonitoringValueField[];
        if (Array.isArray(parsed.valueFields) && parsed.valueFields.length > 0) {
          valueFields = (
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
        } else if (parsed.valueField) {
          valueFields = [{ field: parsed.valueField, label: parsed.valueField }];
        } else {
          continue; // No value field defined — skip
        }

        const basename = path.basename(file, path.extname(file));
        configs.push({
          id: `${folder}/${basename}`,
          folder,
          name: parsed.name,
          description: parsed.description ?? '',
          soql: parsed.soql,
          labelField: parsed.labelField ?? '',
          valueFields,
          chartType,
          refreshInterval: Number(parsed.refreshInterval ?? 0),
          stacked: Boolean(parsed.stacked),
          source,
        });
      } catch {
        // Skip malformed YAML files silently
      }
    }
  }

  private toSlug(name: string): string {
    return (
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'chart'
    );
  }
}
