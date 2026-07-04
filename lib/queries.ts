import { sql } from "./db";
import { TIME_ZONE } from "./time";

function todayStart() {
  return sql`(date_trunc('day', now() at time zone ${TIME_ZONE}) at time zone ${TIME_ZONE})`;
}

function todayEnd() {
  return sql`(${todayStart()} + interval '1 day')`;
}

export async function getLatestMetric(metricName: string) {
  const rows = await sql`
    select sample_ts, unit, qty, min_value, avg_value, max_value
    from health_metric_samples
    where metric_name = ${metricName}
    order by sample_ts desc
    limit 1
  `;
  return rows[0] ?? null;
}

export async function getTodayMetricSum(metricName: string) {
  const rows = await sql`
    select coalesce(sum(qty), 0) as total
    from health_metric_samples
    where metric_name = ${metricName}
      and sample_ts >= ${todayStart()} and sample_ts < ${todayEnd()}
  `;
  return Number(rows[0]?.total ?? 0);
}

export async function getMetricSeries(metricName: string, days: number) {
  const rows = await sql`
    select sample_ts, qty
    from health_metric_samples
    where metric_name = ${metricName}
      and qty is not null
      and sample_ts >= now() - (${days} || ' days')::interval
    order by sample_ts asc
  `;
  return rows.map((r) => ({ date: r.sample_ts as Date, qty: Number(r.qty) }));
}

export async function getLatestWeight() {
  const rows = await sql`
    select logged_at, weight_kg, body_fat_pct, source
    from weight_logs
    order by logged_at desc
    limit 1
  `;
  return rows[0] ?? null;
}

export async function getWeightSeries(days: number) {
  const rows = await sql`
    select logged_at, weight_kg
    from weight_logs
    where logged_at >= now() - (${days} || ' days')::interval
    order by logged_at asc
  `;
  return rows.map((r) => ({ date: r.logged_at as Date, weightKg: Number(r.weight_kg) }));
}

export async function getGoal() {
  const rows = await sql`select * from goals where id = 1`;
  return rows[0] ?? null;
}

export async function upsertGoal(input: {
  startingWeightKg: number | null;
  startingDate: string | null;
  targetWeightKg: number | null;
  targetDate: string | null;
  dailyCalorieTarget: number | null;
}) {
  await sql`
    insert into goals (id, starting_weight_kg, starting_date, target_weight_kg, target_date, daily_calorie_target, updated_at)
    values (1, ${input.startingWeightKg}, ${input.startingDate}, ${input.targetWeightKg}, ${input.targetDate}, ${input.dailyCalorieTarget}, now())
    on conflict (id) do update set
      starting_weight_kg = excluded.starting_weight_kg,
      starting_date = excluded.starting_date,
      target_weight_kg = excluded.target_weight_kg,
      target_date = excluded.target_date,
      daily_calorie_target = excluded.daily_calorie_target,
      updated_at = now()
  `;
}

export async function addWeightLog(input: { loggedAt: string; weightKg: number; bodyFatPct: number | null; note: string | null }) {
  await sql`
    insert into weight_logs (logged_at, weight_kg, body_fat_pct, source, note)
    values (${input.loggedAt}::timestamptz, ${input.weightKg}, ${input.bodyFatPct}, 'manual', ${input.note})
    on conflict (logged_at, source) do update set
      weight_kg = excluded.weight_kg,
      body_fat_pct = excluded.body_fat_pct,
      note = excluded.note
  `;
}

export async function addFoodLog(input: {
  loggedAt: string;
  description: string;
  calories: number;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
  meal: string | null;
}) {
  await sql`
    insert into food_logs (logged_at, description, calories, protein_g, carbs_g, fat_g, meal)
    values (${input.loggedAt}::timestamptz, ${input.description}, ${input.calories}, ${input.proteinG}, ${input.carbsG}, ${input.fatG}, ${input.meal})
  `;
}

export async function getTodayFoodTotal() {
  const rows = await sql`
    select coalesce(sum(calories), 0) as total, count(*) as entries
    from food_logs
    where logged_at >= ${todayStart()} and logged_at < ${todayEnd()}
  `;
  return { calories: Number(rows[0]?.total ?? 0), entries: Number(rows[0]?.entries ?? 0) };
}

export async function getRecentWeightLogs(limit: number) {
  return sql`
    select id, logged_at, weight_kg, body_fat_pct, note
    from weight_logs
    order by logged_at desc
    limit ${limit}
  `;
}

export async function getRecentFoodLogs(limit: number) {
  return sql`
    select id, logged_at, description, calories, meal
    from food_logs
    order by logged_at desc
    limit ${limit}
  `;
}

export async function deleteWeightLog(id: string) {
  const rows = await sql`delete from weight_logs where id = ${id} returning id`;
  return rows.length > 0;
}

export async function deleteFoodLog(id: string) {
  const rows = await sql`delete from food_logs where id = ${id} returning id`;
  return rows.length > 0;
}

export async function getFoodDailyTotals(days: number) {
  const rows = await sql`
    select date_trunc('day', logged_at at time zone ${TIME_ZONE}) as day, sum(calories) as total
    from food_logs
    where logged_at >= now() - (${days} || ' days')::interval
    group by 1
    order by 1 asc
  `;
  return rows.map((r) => ({ date: r.day as Date, calories: Number(r.total) }));
}

export async function getEnergyOutDailyTotals(days: number) {
  const rows = await sql`
    select date_trunc('day', sample_ts at time zone ${TIME_ZONE}) as day, sum(qty) as total_kj
    from health_metric_samples
    where metric_name in ('active_energy', 'basal_energy_burned')
      and sample_ts >= now() - (${days} || ' days')::interval
    group by 1
    order by 1 asc
  `;
  return rows.map((r) => ({ date: r.day as Date, kj: Number(r.total_kj) }));
}

export async function getRecentWorkouts(limit: number) {
  return sql`
    select id, name, location, start_time, end_time, duration_min, active_energy_kj, distance_km, avg_heart_rate, max_heart_rate
    from workouts
    order by start_time desc
    limit ${limit}
  `;
}

export async function getWorkoutById(id: string) {
  const rows = await sql`select * from workouts where id = ${id}`;
  return rows[0] ?? null;
}
