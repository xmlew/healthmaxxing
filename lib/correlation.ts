import { shiftDayKey, zonedDayKey } from "./time";

export type SeriesPoint = { date: Date; value: number };

export type CorrelationPoint = { day: string; x: number; y: number };

export type CorrelationStatus = "ok" | "insufficient-data" | "zero-variance";

export type CorrelationResult = {
  points: CorrelationPoint[];
  n: number;
  r: number | null;
  status: CorrelationStatus;
};

export const MIN_PAIRED_POINTS = 7;

function bucketByDay(series: SeriesPoint[]): Map<string, number> {
  const groups = new Map<string, number[]>();
  for (const point of series) {
    if (!Number.isFinite(point.value)) continue;
    const key = zonedDayKey(point.date);
    const bucket = groups.get(key);
    if (bucket) bucket.push(point.value);
    else groups.set(key, [point.value]);
  }
  const means = new Map<string, number>();
  for (const [key, values] of groups) {
    const sum = values.reduce((acc, value) => acc + value, 0);
    means.set(key, sum / values.length);
  }
  return means;
}

export function alignSeries(
  x: SeriesPoint[],
  y: SeriesPoint[],
  lagDays = 0,
): CorrelationPoint[] {
  const xByDay = bucketByDay(x);
  const yByDay = bucketByDay(y);
  const points: CorrelationPoint[] = [];
  for (const [day, xValue] of xByDay) {
    const yValue = yByDay.get(shiftDayKey(day, lagDays));
    if (yValue === undefined) continue;
    points.push({ day, x: xValue, y: yValue });
  }
  points.sort((a, b) => a.day.localeCompare(b.day));
  return points;
}

export function pearson(points: CorrelationPoint[]): number | null {
  const n = points.length;
  if (n === 0) return null;
  let sumX = 0;
  let sumY = 0;
  for (const point of points) {
    sumX += point.x;
    sumY += point.y;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const point of points) {
    const dx = point.x - meanX;
    const dy = point.y - meanY;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const denominator = Math.sqrt(sxx * syy);
  if (denominator === 0) return null;
  return sxy / denominator;
}

export function correlate(
  x: SeriesPoint[],
  y: SeriesPoint[],
  lagDays = 0,
): CorrelationResult {
  const points = alignSeries(x, y, lagDays);
  const n = points.length;
  if (n < MIN_PAIRED_POINTS) {
    return { points, n, r: null, status: "insufficient-data" };
  }
  const r = pearson(points);
  if (r === null) {
    return { points, n, r: null, status: "zero-variance" };
  }
  return { points, n, r, status: "ok" };
}

// Day-over-day loss in kg per day, assigned to the later day. Positive means
// weight went down since the previous logged day (i.e. weight was lost); the
// per-day divisor normalises gaps between non-consecutive weigh-ins.
//
// The emitted date must round-trip through zonedDayKey back to currentDay,
// because correlate() re-buckets this series by zonedDayKey. TIME_ZONE has a
// negative UTC offset (America/Los_Angeles, -07:00/-08:00), so anchoring at
// noon UTC keeps the instant on the same zoned calendar day; midnight UTC would
// fall into the previous zoned day and shift every rate one day early.
export function weightLossRateSeries(weights: SeriesPoint[]): SeriesPoint[] {
  const byDay = bucketByDay(weights);
  const days = [...byDay.keys()].sort((a, b) => a.localeCompare(b));
  const rates: SeriesPoint[] = [];
  for (let i = 1; i < days.length; i += 1) {
    const previousDay = days[i - 1];
    const currentDay = days[i];
    const gapDays = Math.round(
      (Date.parse(`${currentDay}T00:00:00Z`) - Date.parse(`${previousDay}T00:00:00Z`)) /
        86_400_000,
    );
    if (gapDays <= 0) continue;
    const lossPerDay = (byDay.get(previousDay)! - byDay.get(currentDay)!) / gapDays;
    rates.push({ date: new Date(`${currentDay}T12:00:00Z`), value: lossPerDay });
  }
  return rates;
}

export type PairingKey = "sleep-vs-next-day-rhr" | "steps-vs-weight-loss-rate";

export type PairingDef = {
  key: PairingKey;
  title: string;
  description: string;
  xLabel: string;
  yLabel: string;
  xUnit: string;
  yUnit: string;
  lagDays: number;
};

export const PAIRINGS: PairingDef[] = [
  {
    key: "sleep-vs-next-day-rhr",
    title: "Sleep vs next-day resting HR",
    description: "Hours slept on a night against the following day's resting heart rate.",
    xLabel: "Sleep",
    yLabel: "Next-day resting HR",
    xUnit: "hr",
    yUnit: "bpm",
    lagDays: 1,
  },
  {
    key: "steps-vs-weight-loss-rate",
    title: "Steps vs weight-loss rate",
    description: "Daily step count against that day's weight-loss rate (kg lost per day).",
    xLabel: "Steps",
    yLabel: "Weight-loss rate",
    xUnit: "steps",
    yUnit: "kg/day",
    lagDays: 0,
  },
];
