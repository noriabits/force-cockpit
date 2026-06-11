import * as fs from 'fs';
import * as yaml from 'js-yaml';
import type { YamlSource } from '../../../../utils/yaml-loader';
import type { MonitoringConfig, MonitoringValueField } from '../types';

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
  notifyOnIncrease?: boolean;
  position?: number;
}

const VALID_CHART_TYPES = ['bar', 'line', 'pie', 'doughnut', 'metric', 'table'];

export class MonitoringConfigParser {
  parse(filePath: string, id: string, folder: string, source: YamlSource): MonitoringConfig | null {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const parsed = yaml.load(content) as MonitoringRawDoc;
      if (!parsed || typeof parsed !== 'object') return null;

      const validated = this.validateDoc(parsed);
      if (!validated) return null;

      const valueFields = this.normalizeValueFields(parsed);
      if (!valueFields) return null;

      return this.buildConfig(parsed, id, folder, source, valueFields, validated.chartType);
    } catch {
      return null;
    }
  }

  // ── Validation / normalization / build ──────────────────────────────────

  private validateDoc(
    parsed: MonitoringRawDoc,
  ): { chartType: MonitoringConfig['chartType'] } | null {
    if (!parsed.name || !parsed.soql) return null;

    const chartType = VALID_CHART_TYPES.includes(parsed.chartType ?? '')
      ? (parsed.chartType as MonitoringConfig['chartType'])
      : 'bar';

    // labelField is required for all types except metric
    if (!parsed.labelField && chartType !== 'metric') return null;

    return { chartType };
  }

  private normalizeValueFields(parsed: MonitoringRawDoc): MonitoringValueField[] | null {
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

  private buildConfig(
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
      notifyOnIncrease: Boolean(parsed.notifyOnIncrease),
      source,
      ...(typeof parsed.position === 'number' ? { position: parsed.position } : {}),
    };
  }
}
