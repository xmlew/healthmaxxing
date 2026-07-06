import { getMetricSeries } from "./queries";

export const ANOMALY_BASELINE_DAYS = 30;
export const MIN_BASELINE_SAMPLES = 7;
export const RESTING_HR_ELEVATED_THRESHOLD = 0.1;

type MetricSample = { date: Date; qty: number };

type BaselineSignalConfig = {
  key: string;
  label: string;
  metricName: string;
  unit: string;
  direction: "above" | "below";
  thresholdPct: number;
};

export type Anomaly = {
  key: string;
  label: string;
  unit: string;
  direction: "above" | "below";
  current: number;
  currentAt: Date;
  baselineMean: number;
  baselineStdDev: number;
  baselineSampleCount: number;
  deviationPct: number;
  thresholdPct: number;
};

export type AnomalyStatus =
  | "flagged"
  | "within_baseline"
  | "insufficient_data"
  | "degenerate_baseline";

export type AnomalyEvaluation = {
  key: string;
  label: string;
  status: AnomalyStatus;
  baselineSampleCount: number;
  anomaly: Anomaly | null;
};

const SIGNALS: BaselineSignalConfig[] = [
  {
    key: "resting_heart_rate",
    label: "Resting heart rate",
    metricName: "resting_heart_rate",
    unit: "bpm",
    direction: "above",
    thresholdPct: RESTING_HR_ELEVATED_THRESHOLD,
  },
];

function mean(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function sampleStdDev(values: number[], avg: number): number {
  if (values.length < 2) return 0;
  const variance =
    values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export function evaluateBaselineSignal(
  series: MetricSample[],
  config: BaselineSignalConfig,
): AnomalyEvaluation {
  const sorted = [...series].sort((a, b) => a.date.getTime() - b.date.getTime());
  const latest = sorted.at(-1);
  const baseline = sorted.slice(0, -1);

  const base = { key: config.key, label: config.label, anomaly: null } as const;

  if (!latest) {
    return { ...base, status: "insufficient_data", baselineSampleCount: 0 };
  }

  if (baseline.length < MIN_BASELINE_SAMPLES) {
    return {
      ...base,
      status: "insufficient_data",
      baselineSampleCount: baseline.length,
    };
  }

  const baselineMean = mean(baseline.map((s) => s.qty));
  if (baselineMean <= 0) {
    return {
      ...base,
      status: "degenerate_baseline",
      baselineSampleCount: baseline.length,
    };
  }

  const deviationPct = (latest.qty - baselineMean) / baselineMean;
  const flagged =
    config.direction === "above"
      ? deviationPct >= config.thresholdPct
      : deviationPct <= -config.thresholdPct;

  if (!flagged) {
    return {
      ...base,
      status: "within_baseline",
      baselineSampleCount: baseline.length,
    };
  }

  return {
    key: config.key,
    label: config.label,
    status: "flagged",
    baselineSampleCount: baseline.length,
    anomaly: {
      key: config.key,
      label: config.label,
      unit: config.unit,
      direction: config.direction,
      current: latest.qty,
      currentAt: latest.date,
      baselineMean,
      baselineStdDev: sampleStdDev(
        baseline.map((s) => s.qty),
        baselineMean,
      ),
      baselineSampleCount: baseline.length,
      deviationPct,
      thresholdPct: config.thresholdPct,
    },
  };
}

export async function evaluateAnomalies(): Promise<AnomalyEvaluation[]> {
  return Promise.all(
    SIGNALS.map(async (config) => {
      const series = await getMetricSeries(
        config.metricName,
        ANOMALY_BASELINE_DAYS + 1,
      );
      return evaluateBaselineSignal(series, config);
    }),
  );
}

export async function getAnomalies(): Promise<Anomaly[]> {
  const evaluations = await evaluateAnomalies();
  return evaluations
    .filter((e) => e.status === "flagged" && e.anomaly)
    .map((e) => e.anomaly as Anomaly);
}
