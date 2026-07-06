import { getMetricSeries, getWorkoutDailyLoad } from "./queries";
import { weeklyVolumeByMuscleGroup, type MuscleGroupWeeklyVolume } from "./strength";
import { dayKeyInZone, kjToKcal, shiftDayKey } from "./time";

const MS_PER_DAY = 86_400_000;
const RECENT_WINDOW_FRACTION = 1 / 3;
const MIN_VALUES_PER_PERIOD = 2;
const RESTING_HR_RISE_PCT = 3;
const HRV_DROP_PCT = 5;

// Overreaching: a muscle group whose weekly volume has stayed above its own
// earlier baseline for at least this many trailing weeks, while HRV is trending
// down. Needs a baseline week beyond the elevated stretch to compare against.
const OVERREACH_MIN_WEEKS = 2;

export type RecoveryPoint = {
  date: string;
  restingHr: number | null;
  hrv: number | null;
  loadKcal: number | null;
  loadMin: number;
  workoutCount: number;
};

export type RecoveryFlagStatus = "warning" | "steady" | "insufficient_data";

export type RecoveryFlag = {
  status: RecoveryFlagStatus;
  headline: string;
  detail: string;
  restingHrChangePct: number | null;
  hrvChangePct: number | null;
  recentLoadKcal: number | null;
  baselineLoadKcal: number | null;
};

export type OverreachingSignal = {
  muscleGroup: string;
  weeksElevated: number;
  recentWeeklyVolume: number;
  baselineWeeklyVolume: number;
};

export type RecoveryAnalysis = {
  days: number;
  series: RecoveryPoint[];
  hasRestingHr: boolean;
  hasHrv: boolean;
  energyAvailable: boolean;
  flag: RecoveryFlag;
  muscleGroupVolume: MuscleGroupWeeklyVolume[];
  overreaching: OverreachingSignal[];
};

// weeklyVolumeByMuscleGroup only emits weeks that had sets, so a deload week is
// simply absent. Fill the calendar gaps with 0 volume before scanning, so "N
// weeks running" means consecutive calendar weeks and a rest week breaks the streak.
function fillCalendarWeeks(weeks: { weekStart: string; volume: number }[]): { weekStart: string; volume: number }[] {
  if (weeks.length === 0) return [];
  const byWeek = new Map(weeks.map((w) => [w.weekStart, w.volume]));
  const sorted = [...weeks].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
  const last = sorted[sorted.length - 1].weekStart;
  const filled: { weekStart: string; volume: number }[] = [];
  for (let week = sorted[0].weekStart; week <= last; week = shiftDayKey(week, 7)) {
    filled.push({ weekStart: week, volume: byWeek.get(week) ?? 0 });
  }
  return filled;
}

// Overreaching needs a downtrending HRV; sustained high volume alone isn't it.
// For each muscle group, compare the trailing weeks against the average of the
// weeks before them; flag groups elevated for OVERREACH_MIN_WEEKS+ while HRV falls.
export function computeOverreaching(
  volume: MuscleGroupWeeklyVolume[],
  hrvChangePct: number | null,
): OverreachingSignal[] {
  if (hrvChangePct == null || hrvChangePct >= 0) return [];

  const signals: OverreachingSignal[] = [];
  for (const { muscleGroup, weeks: rawWeeks } of volume) {
    const weeks = fillCalendarWeeks(rawWeeks);
    if (weeks.length < OVERREACH_MIN_WEEKS + 1) continue;
    const baseline = weeks.slice(0, -OVERREACH_MIN_WEEKS);
    const baselineAvg = baseline.reduce((sum, w) => sum + w.volume, 0) / baseline.length;
    if (baselineAvg <= 0) continue;

    let weeksElevated = 0;
    for (let i = weeks.length - 1; i >= 0; i--) {
      if (weeks[i].volume > baselineAvg) weeksElevated += 1;
      else break;
    }
    if (weeksElevated < OVERREACH_MIN_WEEKS) continue;

    const recent = weeks.slice(-weeksElevated);
    signals.push({
      muscleGroup,
      weeksElevated,
      recentWeeklyVolume: Math.round(recent.reduce((sum, w) => sum + w.volume, 0) / recent.length),
      baselineWeeklyVolume: Math.round(baselineAvg),
    });
  }
  return signals;
}

function averageByDay(series: { date: Date; qty: number }[]): Map<string, number> {
  const buckets = new Map<string, { sum: number; count: number }>();
  for (const { date, qty } of series) {
    if (!Number.isFinite(qty)) continue;
    const key = dayKeyInZone(date);
    const current = buckets.get(key) ?? { sum: 0, count: 0 };
    current.sum += qty;
    current.count += 1;
    buckets.set(key, current);
  }
  const out = new Map<string, number>();
  for (const [key, { sum, count }] of buckets) out.set(key, sum / count);
  return out;
}

function stats(values: (number | null)[]): { avg: number; count: number } {
  const nums = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (nums.length === 0) return { avg: 0, count: 0 };
  return { avg: nums.reduce((a, b) => a + b, 0) / nums.length, count: nums.length };
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export async function getRecoveryAnalysis(days: number): Promise<RecoveryAnalysis> {
  const [restingHrRaw, hrvRaw, load, muscleGroupVolume] = await Promise.all([
    getMetricSeries("resting_heart_rate", days),
    getMetricSeries("heart_rate_variability", days),
    getWorkoutDailyLoad(days),
    weeklyVolumeByMuscleGroup(days),
  ]);

  const hrByDay = averageByDay(restingHrRaw);
  const hrvByDay = averageByDay(hrvRaw);
  const loadByDay = new Map(load.map((l) => [l.day, l]));

  const allDays = new Set<string>([...hrByDay.keys(), ...hrvByDay.keys(), ...loadByDay.keys()]);
  const series: RecoveryPoint[] = [...allDays].sort().map((date) => {
    const l = loadByDay.get(date);
    return {
      date,
      restingHr: hrByDay.get(date) ?? null,
      hrv: hrvByDay.get(date) ?? null,
      loadKcal: l && l.activeEnergyKj != null ? kjToKcal(l.activeEnergyKj) : null,
      loadMin: l ? l.durationMin : 0,
      workoutCount: l ? l.workoutCount : 0,
    };
  });

  const energyAvailable = series.some((p) => p.loadKcal != null);
  const flag = computeRecoveryFlag(series, days, energyAvailable);
  const overreaching = computeOverreaching(muscleGroupVolume, flag.hrvChangePct);

  return {
    days,
    series,
    hasRestingHr: hrByDay.size > 0,
    hasHrv: hrvByDay.size > 0,
    energyAvailable,
    flag,
    muscleGroupVolume,
    overreaching,
  };
}

export function computeRecoveryFlag(
  series: RecoveryPoint[],
  days: number,
  energyAvailable: boolean,
): RecoveryFlag {
  const recentDays = Math.max(1, Math.round(days * RECENT_WINDOW_FRACTION));
  const baselineDays = Math.max(1, days - recentDays);
  const cutoffKey = dayKeyInZone(new Date(Date.now() - recentDays * MS_PER_DAY));

  const recent = series.filter((p) => p.date >= cutoffKey);
  const baseline = series.filter((p) => p.date < cutoffKey);

  const recentHr = stats(recent.map((p) => p.restingHr));
  const baseHr = stats(baseline.map((p) => p.restingHr));
  const recentHrv = stats(recent.map((p) => p.hrv));
  const baseHrv = stats(baseline.map((p) => p.hrv));

  const hrComparable = baseHr.count >= MIN_VALUES_PER_PERIOD && recentHr.count >= MIN_VALUES_PER_PERIOD && baseHr.avg > 0;
  const hrvComparable = baseHrv.count >= MIN_VALUES_PER_PERIOD && recentHrv.count >= MIN_VALUES_PER_PERIOD && baseHrv.avg > 0;

  const restingHrChangePct = hrComparable ? round(((recentHr.avg - baseHr.avg) / baseHr.avg) * 100) : null;
  const hrvChangePct = hrvComparable ? round(((recentHrv.avg - baseHrv.avg) / baseHrv.avg) * 100) : null;

  const loadOf = (p: RecoveryPoint) => (energyAvailable ? p.loadKcal ?? 0 : p.loadMin);
  const recentLoadTotal = recent.reduce((sum, p) => sum + loadOf(p), 0);
  const baselineLoadTotal = baseline.reduce((sum, p) => sum + loadOf(p), 0);
  const recentLoadPerDay = recentLoadTotal / recentDays;
  const baselineLoadPerDay = baselineLoadTotal / baselineDays;
  const recentLoadElevated = recentLoadTotal > 0 && recentLoadPerDay > baselineLoadPerDay;

  const recentKcal = energyAvailable ? round(recent.reduce((s, p) => s + (p.loadKcal ?? 0), 0)) : null;
  const baselineKcal = energyAvailable ? round(baseline.reduce((s, p) => s + (p.loadKcal ?? 0), 0)) : null;

  const base: Pick<RecoveryFlag, "restingHrChangePct" | "hrvChangePct" | "recentLoadKcal" | "baselineLoadKcal"> = {
    restingHrChangePct,
    hrvChangePct,
    recentLoadKcal: recentKcal,
    baselineLoadKcal: baselineKcal,
  };

  if (!hrComparable && !hrvComparable) {
    return {
      ...base,
      status: "insufficient_data",
      headline: "Not enough recovery data",
      detail: gapDetail(baseHr, recentHr, baseHrv, recentHrv),
    };
  }

  const hrRising = restingHrChangePct != null && restingHrChangePct >= RESTING_HR_RISE_PCT;
  const hrvFalling = hrvChangePct != null && hrvChangePct <= -HRV_DROP_PCT;

  if (hrComparable && hrvComparable && hrRising && hrvFalling && recentLoadElevated) {
    return {
      ...base,
      status: "warning",
      headline: "Possible overtraining",
      detail:
        `Resting HR is up ${restingHrChangePct}% and HRV down ${Math.abs(hrvChangePct as number)}% ` +
        `versus your earlier baseline, following recent high-load days ` +
        `(${loadPhrase(recentLoadPerDay, energyAvailable)} vs ${loadPhrase(baselineLoadPerDay, energyAvailable)} per day). ` +
        `Consider an easier day.`,
    };
  }

  return {
    ...base,
    status: "steady",
    headline: "Recovery looks steady",
    detail: steadyDetail(restingHrChangePct, hrvChangePct, recentLoadElevated, hrComparable, hrvComparable),
  };
}

function loadPhrase(perDay: number, energyAvailable: boolean): string {
  return energyAvailable ? `${Math.round(perDay)} kcal` : `${Math.round(perDay)} min`;
}

function gapDetail(
  baseHr: { count: number },
  recentHr: { count: number },
  baseHrv: { count: number },
  recentHrv: { count: number },
): string {
  const reasons: string[] = [];
  if (baseHr.count + recentHr.count === 0) reasons.push("no resting HR samples");
  else if (baseHr.count < MIN_VALUES_PER_PERIOD || recentHr.count < MIN_VALUES_PER_PERIOD)
    reasons.push("resting HR is too sparse");
  if (baseHrv.count + recentHrv.count === 0) reasons.push("no HRV samples");
  else if (baseHrv.count < MIN_VALUES_PER_PERIOD || recentHrv.count < MIN_VALUES_PER_PERIOD)
    reasons.push("HRV is too sparse");
  const why = reasons.length > 0 ? reasons.join(" and ") : "not enough readings";
  return `Need more data to compare recent recovery against a baseline - ${why} in this range.`;
}

function steadyDetail(
  hrPct: number | null,
  hrvPct: number | null,
  loadElevated: boolean,
  hrComparable: boolean,
  hrvComparable: boolean,
): string {
  const parts: string[] = [];
  if (hrComparable && hrPct != null) parts.push(`resting HR ${signed(hrPct)}%`);
  if (hrvComparable && hrvPct != null) parts.push(`HRV ${signed(hrvPct)}%`);
  const change = parts.length > 0 ? parts.join(", ") + " vs baseline" : "no clear change vs baseline";
  const context = loadElevated
    ? " Recent training load is elevated, so keep watching these."
    : " Recent training load is not elevated.";
  return `${capitalize(change)}.${context}`;
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : `${value}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
