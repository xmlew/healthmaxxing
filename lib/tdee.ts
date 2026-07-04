import {
  getEnergyOutDailyTotals,
  getFoodDailyTotals,
  getGoal,
  getMetricSeries,
} from "./queries";
import { kjToKcal } from "./time";

// Wishnofsky's rule: roughly 7700 kcal of energy balance per kilogram of body
// mass, used to translate a cumulative net deficit/surplus into implied kg.
export const KCAL_PER_KG = 7700;

export const DEFAULT_ROLLING_WINDOW = 7;

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export type TdeeDay = {
  date: string;
  tdee: number | null;
  intake: number | null;
  net: number | null;
  hasBasal: boolean;
};

export type TdeeAnalysis = {
  days: TdeeDay[];
  rollingWindow: number;
  rollingTdee: number | null;
  rollingIntake: number | null;
  rollingNet: number | null;
  validDayCount: number;
  missingBasalDays: string[];
  cumulativeNet: number | null;
  impliedWeightChangeKg: number | null;
  dailyCalorieTarget: number | null;
  targetVsTdee: number | null;
  hasEnergyData: boolean;
  hasFoodData: boolean;
  lowConfidence: boolean;
};

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export async function getTdeeAnalysis(
  days: number,
  rollingWindow: number = DEFAULT_ROLLING_WINDOW
): Promise<TdeeAnalysis> {
  const [energyOutDaily, foodDaily, basalDaily, goal] = await Promise.all([
    getEnergyOutDailyTotals(days),
    getFoodDailyTotals(days),
    getMetricSeries("basal_energy_burned", days),
    getGoal(),
  ]);

  const intakeByDay = new Map<string, number>();
  for (const f of foodDaily) intakeByDay.set(dayKey(f.date), f.calories);

  const basalByDay = new Map<string, number>();
  for (const b of basalDaily) {
    const key = dayKey(b.date);
    basalByDay.set(key, (basalByDay.get(key) ?? 0) + b.qty);
  }

  const dayKeys = new Set<string>([...intakeByDay.keys()]);
  for (const e of energyOutDaily) dayKeys.add(dayKey(e.date));

  const tdeeByDay = new Map<string, number>();
  for (const e of energyOutDaily) tdeeByDay.set(dayKey(e.date), kjToKcal(e.kj));

  const days_: TdeeDay[] = Array.from(dayKeys)
    .sort((a, b) => a.localeCompare(b))
    .map((key) => {
      const tdee = tdeeByDay.get(key) ?? null;
      const intake = intakeByDay.get(key) ?? null;
      const hasBasal = (basalByDay.get(key) ?? 0) > 0;
      const net = tdee != null && intake != null ? intake - tdee : null;
      return { date: key, tdee, intake, net, hasBasal };
    });

  const missingBasalDays = days_
    .filter((d) => d.tdee != null && !d.hasBasal)
    .map((d) => d.date);

  const validTdeeDays = days_.filter((d) => d.tdee != null && d.hasBasal);
  const windowDays = validTdeeDays.slice(-rollingWindow);
  const rollingTdee = mean(windowDays.map((d) => d.tdee as number));
  const validDayCount = windowDays.length;

  const windowKeys = new Set(windowDays.map((d) => d.date));
  const rollingIntakeDays = days_.filter(
    (d) => windowKeys.has(d.date) && d.intake != null
  );
  const rollingIntake = mean(rollingIntakeDays.map((d) => d.intake as number));
  const rollingNet =
    rollingTdee != null && rollingIntake != null ? rollingIntake - rollingTdee : null;

  const netDays = days_.filter((d) => d.net != null && d.hasBasal);
  const cumulativeNet =
    netDays.length > 0
      ? netDays.reduce((sum, d) => sum + (d.net as number), 0)
      : null;
  const impliedWeightChangeKg =
    cumulativeNet != null ? cumulativeNet / KCAL_PER_KG : null;

  const dailyCalorieTarget =
    goal?.daily_calorie_target != null && Number(goal.daily_calorie_target) > 0
      ? Number(goal.daily_calorie_target)
      : null;
  const targetVsTdee =
    dailyCalorieTarget != null && rollingTdee != null
      ? dailyCalorieTarget - rollingTdee
      : null;

  return {
    days: days_,
    rollingWindow,
    rollingTdee,
    rollingIntake,
    rollingNet,
    validDayCount,
    missingBasalDays,
    cumulativeNet,
    impliedWeightChangeKg,
    dailyCalorieTarget,
    targetVsTdee,
    hasEnergyData: energyOutDaily.length > 0,
    hasFoodData: foodDaily.length > 0,
    lowConfidence: validDayCount > 0 && validDayCount < rollingWindow,
  };
}
