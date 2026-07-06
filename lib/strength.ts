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

export async function deleteSet(id: string): Promise<boolean> {
  const rows = await sql`delete from strength_sets where id = ${id} returning id`;
  return rows.length > 0;
}

export async function nextSetNumber(sessionId: number, exerciseId: number): Promise<number> {
  const rows = await sql`
    select coalesce(max(set_number), 0) + 1 as n
    from strength_sets
    where session_id = ${sessionId} and exercise_id = ${exerciseId}
  `;
  return Number(rows[0].n);
}

export const ONE_RM_FORMULAS = ["epley", "brzycki"] as const;
export type OneRepMaxFormula = (typeof ONE_RM_FORMULAS)[number];

// Estimated one-rep max from a working set. Epley: w*(1+reps/30);
// Brzycki: w*36/(37-reps). A single rep is its own 1RM; both formulas break
// down as reps approach Brzycki's asymptote, so clamp very high reps to the weight.
export function estimate1RM(weight: number, reps: number, formula: OneRepMaxFormula = "epley"): number {
  if (reps <= 1) return weight;
  if (formula === "brzycki") {
    if (reps >= 37) return weight;
    return (weight * 36) / (37 - reps);
  }
  return weight * (1 + reps / 30);
}

export type OneRepMaxPoint = { date: string; oneRepMax: number };

// Best estimated 1RM per session date, ascending - the series a 1RM chart plots.
export function oneRepMaxSeries(sets: StrengthSetRow[], formula: OneRepMaxFormula): OneRepMaxPoint[] {
  const byDate = new Map<string, number>();
  for (const s of sets) {
    if (s.weight == null || s.reps == null) continue;
    const est = estimate1RM(s.weight, s.reps, formula);
    byDate.set(s.sessionDate, Math.max(byDate.get(s.sessionDate) ?? 0, est));
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, oneRepMax]) => ({ date, oneRepMax: Math.round(oneRepMax * 10) / 10 }));
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

// Sessions with no new best-set-volume PR after which an exercise is "stalled" -
// the real signal that progressive overload has plateaued (mirrors the
// recovery overtraining flag: a trailing-window comparison against the best so far).
export const STALL_SESSIONS = 3;

export type OverloadSession = { date: string; sessionVolume: number; bestSetVolume: number };

export type OverloadStatus = {
  exercise: string;
  muscleGroup: string | null;
  sessions: OverloadSession[];
  latestSessionVolume: number | null;
  bestSetVolumeAllTime: number | null;
  sessionsSinceImprovement: number;
  stalled: boolean;
};

// Best-set volume = the heaviest single set's weight x reps; session volume = the
// sum across sets. An exercise stalls when best-set volume hasn't set a new high
// for STALL_SESSIONS+ sessions (needs more than that many sessions to judge).
export function computeOverloadStatus(
  exercise: string,
  muscleGroup: string | null,
  sets: StrengthSetRow[],
  stallSessions = STALL_SESSIONS,
): OverloadStatus {
  const bySession = new Map<string, StrengthSetRow[]>();
  for (const s of sets) {
    const list = bySession.get(s.sessionDate) ?? [];
    list.push(s);
    bySession.set(s.sessionDate, list);
  }
  const sessions: OverloadSession[] = [...bySession.entries()]
    .map(([date, rows]) => {
      const setVolume = (r: StrengthSetRow) => (r.weight ?? 0) * (r.reps ?? 0);
      return {
        date,
        sessionVolume: Math.round(rows.reduce((sum, r) => sum + setVolume(r), 0)),
        bestSetVolume: Math.round(rows.reduce((max, r) => Math.max(max, setVolume(r)), 0)),
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  let runningMax = -Infinity;
  let lastImprovementIdx = -1;
  sessions.forEach((s, i) => {
    if (s.bestSetVolume > runningMax) {
      runningMax = s.bestSetVolume;
      lastImprovementIdx = i;
    }
  });

  const sessionsSinceImprovement = sessions.length > 0 ? sessions.length - 1 - lastImprovementIdx : 0;

  return {
    exercise,
    muscleGroup,
    sessions,
    latestSessionVolume: sessions.length > 0 ? sessions[sessions.length - 1].sessionVolume : null,
    bestSetVolumeAllTime: runningMax === -Infinity ? null : runningMax,
    sessionsSinceImprovement,
    stalled: sessions.length > stallSessions && sessionsSinceImprovement >= stallSessions,
  };
}
