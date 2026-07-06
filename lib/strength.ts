import { sql } from "./db";
import { TIME_ZONE } from "./time";

export type ExerciseRow = {
  id: number;
  name: string;
  muscleGroup: string | null;
  defaultUnit: string;
};

export type StrengthSetRow = {
  setId: number;
  sessionId: number;
  sessionDate: string;
  exerciseId: number;
  exerciseName: string;
  muscleGroup: string | null;
  setNumber: number;
  weight: number | null;
  reps: number | null;
  rpe: number | null;
  rir: number | null;
};

function toDateStr(value: unknown): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
}

// Upserts by unique name. A later log that omits muscle_group/default_unit keeps
// whatever was set before (coalesce), so re-logging a bare set never wipes a group.
export async function upsertExercise(input: {
  name: string;
  muscleGroup?: string | null;
  defaultUnit?: string | null;
}): Promise<number> {
  const rows = await sql`
    insert into exercises (name, muscle_group, default_unit)
    values (${input.name}, ${input.muscleGroup ?? null}, ${input.defaultUnit ?? "kg"})
    on conflict (lower(name)) do update set
      muscle_group = coalesce(${input.muscleGroup ?? null}, exercises.muscle_group),
      default_unit = coalesce(${input.defaultUnit ?? null}, exercises.default_unit)
    returning id
  `;
  return Number(rows[0].id);
}

export async function listExercises(): Promise<ExerciseRow[]> {
  const rows = await sql`
    select id, name, muscle_group, default_unit
    from exercises
    order by name asc
  `;
  return rows.map((r) => ({
    id: Number(r.id),
    name: r.name as string,
    muscleGroup: r.muscle_group as string | null,
    defaultUnit: r.default_unit as string,
  }));
}

export async function createSession(input: {
  sessionDate: string;
  notes?: string | null;
  workoutId?: string | null;
}): Promise<number> {
  const rows = await sql`
    insert into strength_sessions (session_date, notes, workout_id)
    values (${input.sessionDate}::date, ${input.notes ?? null}, ${input.workoutId ?? null})
    returning id
  `;
  return Number(rows[0].id);
}

// Gets-or-creates the manual (non-workout) session for a calendar day, so all
// sets logged for that day group into one session without the caller tracking ids.
export async function resolveManualSession(sessionDate: string): Promise<number> {
  const existing = await sql`
    select id from strength_sessions
    where session_date = ${sessionDate}::date and workout_id is null
    order by id asc
    limit 1
  `;
  if (existing[0]) return Number(existing[0].id);
  return createSession({ sessionDate });
}

export async function addSet(input: {
  sessionId: number;
  exerciseId: number;
  setNumber: number;
  weight: number | null;
  reps: number | null;
  rpe: number | null;
  rir: number | null;
}): Promise<number> {
  const rows = await sql`
    insert into strength_sets
      (session_id, exercise_id, set_number, weight, reps, rpe, rir)
    values
      (${input.sessionId}, ${input.exerciseId}, ${input.setNumber},
       ${input.weight}, ${input.reps}, ${input.rpe}, ${input.rir})
    returning id
  `;
  return Number(rows[0].id);
}

export async function getExerciseHistory(
  exerciseName: string,
  days: number,
): Promise<StrengthSetRow[]> {
  const rows = await sql`
    select
      st.id as set_id, st.session_id, ss.session_date,
      e.id as exercise_id, e.name as exercise_name, e.muscle_group,
      st.set_number, st.weight, st.reps, st.rpe, st.rir
    from strength_sets st
    join strength_sessions ss on ss.id = st.session_id
    join exercises e on e.id = st.exercise_id
    where lower(e.name) = lower(${exerciseName})
      and ss.session_date >= (now() at time zone ${TIME_ZONE})::date - ${days}::int
    order by ss.session_date asc, st.set_number asc
  `;
  return rows.map((r) => ({
    setId: Number(r.set_id),
    sessionId: Number(r.session_id),
    sessionDate: toDateStr(r.session_date),
    exerciseId: Number(r.exercise_id),
    exerciseName: r.exercise_name as string,
    muscleGroup: r.muscle_group as string | null,
    setNumber: Number(r.set_number),
    weight: r.weight == null ? null : Number(r.weight),
    reps: r.reps == null ? null : Number(r.reps),
    rpe: r.rpe == null ? null : Number(r.rpe),
    rir: r.rir == null ? null : Number(r.rir),
  }));
}

export const UNTAGGED_MUSCLE_GROUP = "untagged";

export type MuscleGroupWeeklyVolume = {
  muscleGroup: string;
  weeks: { weekStart: string; volume: number }[];
};

// Weekly training volume (sum of weight x reps) per muscle group over N days.
// Weeks are Monday-anchored; only weeks with logged sets appear. Sets on an
// exercise with no muscle_group fall under 'untagged'.
export async function weeklyVolumeByMuscleGroup(days: number): Promise<MuscleGroupWeeklyVolume[]> {
  const rows = await sql`
    select
      coalesce(e.muscle_group, ${UNTAGGED_MUSCLE_GROUP}) as muscle_group,
      to_char(date_trunc('week', ss.session_date), 'YYYY-MM-DD') as week_start,
      sum(coalesce(st.weight, 0) * coalesce(st.reps, 0)) as volume
    from strength_sets st
    join strength_sessions ss on ss.id = st.session_id
    join exercises e on e.id = st.exercise_id
    where ss.session_date >= (now() at time zone ${TIME_ZONE})::date - ${days}::int
    group by 1, 2
    order by 1, 2
  `;
  const byGroup = new Map<string, { weekStart: string; volume: number }[]>();
  for (const r of rows) {
    const group = r.muscle_group as string;
    const weeks = byGroup.get(group) ?? [];
    weeks.push({ weekStart: r.week_start as string, volume: Math.round(Number(r.volume)) });
    byGroup.set(group, weeks);
  }
  return [...byGroup.entries()].map(([muscleGroup, weeks]) => ({ muscleGroup, weeks }));
}
