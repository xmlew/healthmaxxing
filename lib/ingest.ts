import type { Sql } from "postgres";

type MetricRecord = Record<string, unknown> & {
  date?: string;
  qty?: number;
  source?: string;
  Min?: number;
  Avg?: number;
  Max?: number;
  totalSleep?: number;
  sleepStart?: string;
};

type MetricGroup = {
  name: string;
  units?: string;
  data: MetricRecord[];
};

type WorkoutQty = { qty?: number; units?: string };

type WorkoutRecord = Record<string, unknown> & {
  id?: string;
  name?: string;
  location?: string;
  isIndoor?: boolean;
  start?: string;
  end?: string;
  duration?: number;
  activeEnergy?: WorkoutQty;
  activeEnergyBurned?: WorkoutQty;
  basalEnergy?: WorkoutQty;
  distance?: WorkoutQty;
  walkingAndRunningDistance?: WorkoutQty;
  avgHeartRate?: WorkoutQty;
  maxHeartRate?: WorkoutQty;
  stepCount?: WorkoutQty | number;
};

export type HealthExportPayload = {
  data: {
    metrics?: MetricGroup[];
    workouts?: WorkoutRecord[];
  };
};

// Fields that carry per-minute telemetry we don't need for dashboard
// aggregates and that would otherwise bloat every stored workout row.
const HEAVY_WORKOUT_FIELDS = ["heartRateData", "route", "stepCadence", "speed", "power", "cyclingCadence"];

function extractMetricValues(record: MetricRecord) {
  if (typeof record.qty === "number") {
    return { qty: record.qty, min: null, avg: null, max: null };
  }
  if (typeof record.Avg === "number") {
    return { qty: record.Avg, min: record.Min ?? null, avg: record.Avg, max: record.Max ?? null };
  }
  if (typeof record.totalSleep === "number") {
    return { qty: record.totalSleep, min: null, avg: null, max: null };
  }
  return { qty: null, min: null, avg: null, max: null };
}

function numeric(value: WorkoutQty | number | undefined): number | null {
  if (typeof value === "number") return value;
  if (value && typeof value.qty === "number") return value.qty;
  return null;
}

// postgres.js's sql.json() expects a JSONValue-typed argument; our records are
// plain JSON already, so round-tripping strips the `unknown` index signature
// that trips up its structural check.
function toJson(value: unknown) {
  return JSON.parse(JSON.stringify(value));
}

export async function ingestMetrics(sql: Sql, metrics: MetricGroup[]): Promise<number> {
  let count = 0;
  for (const group of metrics) {
    for (const record of group.data ?? []) {
      const sampleTs = record.sleepStart ?? record.date;
      if (!sampleTs) continue;
      const { qty, min, avg, max } = extractMetricValues(record);
      const source = record.source ?? "";

      await sql`
        insert into health_metric_samples
          (metric_name, unit, sample_ts, source, qty, min_value, avg_value, max_value, payload)
        values
          (${group.name}, ${group.units ?? null}, ${sampleTs}::timestamptz, ${source},
           ${qty}, ${min}, ${avg}, ${max}, ${sql.json(toJson(record))})
        on conflict (metric_name, sample_ts, source)
        do update set
          unit = excluded.unit,
          qty = excluded.qty,
          min_value = excluded.min_value,
          avg_value = excluded.avg_value,
          max_value = excluded.max_value,
          payload = excluded.payload
      `;
      count++;
    }
  }
  return count;
}

export async function ingestWorkouts(sql: Sql, workouts: WorkoutRecord[]): Promise<number> {
  let count = 0;
  for (const workout of workouts) {
    const id = workout.id ?? `${workout.name ?? "workout"}-${workout.start ?? ""}`;
    const trimmedPayload = { ...workout };
    for (const field of HEAVY_WORKOUT_FIELDS) delete trimmedPayload[field];
    const durationSeconds = numeric(workout.duration);

    await sql`
      insert into workouts
        (id, name, location, is_indoor, start_time, end_time, duration_min,
         active_energy_kj, basal_energy_kj, distance_km, avg_heart_rate, max_heart_rate,
         step_count, payload)
      values
        (${id}, ${workout.name ?? null}, ${workout.location ?? null}, ${workout.isIndoor ?? null},
         ${workout.start ?? null}::timestamptz,
         ${workout.end ?? null}::timestamptz,
         ${durationSeconds !== null ? durationSeconds / 60 : null},
         ${numeric(workout.activeEnergy) ?? numeric(workout.activeEnergyBurned)},
         ${numeric(workout.basalEnergy)},
         ${numeric(workout.distance) ?? numeric(workout.walkingAndRunningDistance)},
         ${numeric(workout.avgHeartRate)}, ${numeric(workout.maxHeartRate)},
         ${numeric(workout.stepCount)}, ${sql.json(toJson(trimmedPayload))})
      on conflict (id) do update set
        name = excluded.name,
        location = excluded.location,
        is_indoor = excluded.is_indoor,
        start_time = excluded.start_time,
        end_time = excluded.end_time,
        duration_min = excluded.duration_min,
        active_energy_kj = excluded.active_energy_kj,
        basal_energy_kj = excluded.basal_energy_kj,
        distance_km = excluded.distance_km,
        avg_heart_rate = excluded.avg_heart_rate,
        max_heart_rate = excluded.max_heart_rate,
        step_count = excluded.step_count,
        payload = excluded.payload
    `;
    count++;
  }
  return count;
}

export async function ingestHealthExport(sql: Sql, payload: HealthExportPayload) {
  const metricsProcessed = await ingestMetrics(sql, payload.data.metrics ?? []);
  const workoutsProcessed = await ingestWorkouts(sql, payload.data.workouts ?? []);
  return { metricsProcessed, workoutsProcessed };
}
