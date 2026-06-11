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
  notifyOnIncrease?: boolean;
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
