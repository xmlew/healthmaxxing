import type { Sql } from "postgres";
import type { Db } from "./db";
import type { Sport } from "./sports";
import { insertSegments } from "./training-segments";
import { TIME_ZONE } from "./time";

// Apple Health's generic strength workout. Ingesting one links a strength_sessions
// shell to it so sets can be attached later; other workout names are untouched.
const STRENGTH_WORKOUT_NAME = "Traditional Strength Training";

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

type ImportedWorkout = {
  workoutId: string;
  sessionDate: string;
  sport: Sport;
  durationMin: number | null;
  distanceKm: number | null;
};

// Turns an Apple Health swim/ride/run into a completed session. A session already
// logged for that day and sport without a workout link is taken to be the same
// effort and is linked instead of duplicated, so a ride told to Claude and later
// synced from the watch counts once. A planned session is completed with the
// measured values; a session already logged as completed keeps what was entered,
// because asserted data outranks inferred data. Idempotent per workout.
async function linkImportedWorkout(sql: Db, workout: ImportedWorkout): Promise<void> {
  const [alreadyLinked] = await sql`
    select 1 from training_sessions where workout_id = ${workout.workoutId}
  `;
  if (alreadyLinked) return;

  const [match] = await sql`
    select ts.id, ts.status
    from training_sessions ts
    where ts.session_date = ${workout.sessionDate}::date
      and ts.workout_id is null
      and ts.deleted_at is null
      and (select count(*) from training_segments seg where seg.session_id = ts.id) = 1
      and exists (
        select 1 from training_segments seg
        where seg.session_id = ts.id and seg.sport = ${workout.sport}
      )
    order by (ts.status = 'planned'), ts.id
    limit 1
  `;

  if (!match) {
    const [row] = await sql`
      insert into training_sessions (session_date, status, workout_id)
      values (${workout.sessionDate}::date, 'completed', ${workout.workoutId})
      on conflict (workout_id) where workout_id is not null do nothing
      returning id
    `;
    if (!row) return;
    await insertSegments(sql, Number(row.id), [
      {
        sport: workout.sport,
        durationMin: workout.durationMin,
        distanceKm: workout.distanceKm,
        equipmentIds: [],
      },
    ]);
    return;
  }

  await sql`
    update training_sessions
    set workout_id = ${workout.workoutId}, status = 'completed', updated_at = now()
    where id = ${match.id}
  `;
  if (match.status === "planned") {
    await sql`
      update training_segments
      set duration_min = coalesce(${workout.durationMin}, duration_min),
          distance_km = coalesce(${workout.distanceKm}, distance_km)
      where session_id = ${match.id}
    `;
  }
}

// Apple Health names a workout by activity and setting ("Outdoor Cycling",
// "Pool Swim", "Indoor Run"), so the sport is the activity word. Walks, hikes,
// and strength sessions match none and stay workouts only.
const SPORT_PATTERNS: [RegExp, Sport][] = [
  [/\bswim/i, "swim"],
  [/\b(cycling|bike|biking)\b/i, "bike"],
  [/\brun(ning)?\b/i, "run"],
];

function sportForWorkout(name: string | undefined): Sport | null {
  if (!name) return null;
  return SPORT_PATTERNS.find(([pattern]) => pattern.test(name))?.[1] ?? null;
}

const KM_PER_UNIT: Record<string, number> = { km: 1, m: 0.001, mi: 1.609344, yd: 0.0009144 };

// Distance is converted by its declared unit. An unrecognized unit yields no
// distance rather than a guess, since gear mileage is summed from this value.
function distanceKm(value: WorkoutQty | undefined): number | null {
  if (!value || typeof value.qty !== "number") return null;
  const factor = value.units ? KM_PER_UNIT[value.units.toLowerCase()] : undefined;
  return factor == null ? null : value.qty * factor;
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

    // Link a strength session to Apple Health's strength workout. Idempotent via
    // the partial unique index on workout_id, so re-imports don't duplicate.
    if (workout.name === STRENGTH_WORKOUT_NAME && workout.start) {
      await sql`
        insert into strength_sessions (session_date, workout_id)
        select (${workout.start}::timestamptz at time zone ${TIME_ZONE})::date, ${id}
        where not exists (
          select 1 from strength_sessions where workout_id = ${id}
        )
      `;
    }

    // A workout with no positive duration was aborted; it stays a workout only.
    const sport = sportForWorkout(workout.name);
    if (sport && workout.start && durationSeconds != null && durationSeconds > 0) {
      const [row] = await sql`
        select (${workout.start}::timestamptz at time zone ${TIME_ZONE})::date::text as day
      `;
      // One transaction, so a failure cannot leave a session without its leg -
      // and an already-linked workout is never revisited to repair one.
      await sql.begin((tx) =>
        linkImportedWorkout(tx, {
          workoutId: id,
          sessionDate: row.day,
          sport,
          durationMin: durationSeconds / 60,
          distanceKm: distanceKm(workout.distance),
        }),
      );
    }

    count++;
  }
  return count;
}

export async function ingestHealthExport(sql: Sql, payload: HealthExportPayload) {
  const metricsProcessed = await ingestMetrics(sql, payload.data.metrics ?? []);
  const workoutsProcessed = await ingestWorkouts(sql, payload.data.workouts ?? []);
  return { metricsProcessed, workoutsProcessed };
}
