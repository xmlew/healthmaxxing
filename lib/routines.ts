import { sql } from "./db";
import { isWorkingSet, type SetType } from "./set-types";
import { TIME_ZONE } from "./time";
import { displayLb, kgToLb } from "./units";

export type RoutineRef = { id: number; name: string };

export type RoutineTarget = {
  exerciseId: number;
  exerciseName: string;
  muscleGroup: string | null;
  position: number;
  targetSets: number | null;
  targetReps: number | null;
  targetWeightKg: number | null;
  notes: string | null;
};

export type RoutineDay = {
  id: number;
  name: string;
  position: number;
};

export type LoggedSet = {
  setNumber: number;
  setType: SetType;
  weightKg: number | null;
  reps: number | null;
};

export type LastPerformance = { date: string; sets: LoggedSet[] };

// The current plan. Named explicitly when several versions coexist; otherwise
// the newest routine, which is the one a just-created "v2" would be.
export async function getRoutine(name?: string): Promise<RoutineRef | null> {
  const rows = name
    ? await sql`select id, name from routines where lower(name) = lower(${name})`
    : await sql`select id, name from routines order by created_at desc, id desc limit 1`;
  return rows[0] ? { id: Number(rows[0].id), name: rows[0].name as string } : null;
}

export async function listRoutineDays(routineId: number): Promise<RoutineDay[]> {
  const rows = await sql`
    select id, name, position
    from routine_days
    where routine_id = ${routineId}
    order by position asc
  `;
  return rows.map((r) => ({
    id: Number(r.id),
    name: r.name as string,
    position: Number(r.position),
  }));
}

export async function getRoutineDay(routineId: number, day: string): Promise<RoutineDay | null> {
  const rows = await sql`
    select id, name, position
    from routine_days
    where routine_id = ${routineId} and lower(name) = lower(${day})
  `;
  return rows[0]
    ? { id: Number(rows[0].id), name: rows[0].name as string, position: Number(rows[0].position) }
    : null;
}

export async function getRoutineTargets(dayId: number): Promise<RoutineTarget[]> {
  const rows = await sql`
    select
      re.exercise_id, e.name as exercise_name, e.muscle_group, re.position,
      re.target_sets, re.target_reps, re.target_weight_kg, re.notes
    from routine_exercises re
    join exercises e on e.id = re.exercise_id
    where re.day_id = ${dayId}
    order by re.position asc
  `;
  return rows.map((r) => ({
    exerciseId: Number(r.exercise_id),
    exerciseName: r.exercise_name as string,
    muscleGroup: r.muscle_group as string | null,
    position: Number(r.position),
    targetSets: r.target_sets == null ? null : Number(r.target_sets),
    targetReps: r.target_reps == null ? null : Number(r.target_reps),
    targetWeightKg: r.target_weight_kg == null ? null : Number(r.target_weight_kg),
    notes: r.notes as string | null,
  }));
}

// The most recent session of each given exercise, with its sets. One query for
// the whole day rather than one per exercise.
export async function getLastPerformances(
  exerciseIds: number[],
): Promise<Map<number, LastPerformance>> {
  if (exerciseIds.length === 0) return new Map();
  const rows = await sql`
    select st.exercise_id, ss.session_date, st.set_number, st.set_type, st.weight_kg, st.reps
    from strength_sets st
    join strength_sessions ss on ss.id = st.session_id
    join (
      select st2.exercise_id, max(ss2.session_date) as session_date
      from strength_sets st2
      join strength_sessions ss2 on ss2.id = st2.session_id
      where st2.exercise_id = any(${exerciseIds})
      group by st2.exercise_id
    ) latest
      on latest.exercise_id = st.exercise_id and latest.session_date = ss.session_date
    order by st.exercise_id asc, st.set_number asc
  `;
  const byExercise = new Map<number, LastPerformance>();
  for (const r of rows) {
    const id = Number(r.exercise_id);
    const date =
      r.session_date instanceof Date
        ? r.session_date.toISOString().slice(0, 10)
        : String(r.session_date);
    const entry = byExercise.get(id) ?? { date, sets: [] };
    entry.sets.push({
      setNumber: Number(r.set_number),
      setType: r.set_type as SetType,
      weightKg: r.weight_kg == null ? null : Number(r.weight_kg),
      reps: r.reps == null ? null : Number(r.reps),
    });
    byExercise.set(id, entry);
  }
  return byExercise;
}

// Which day to train next: the one after the most recent logged session's day,
// wrapping around. Falls back to the first day when nothing has been logged
// against the routine yet.
export async function nextDayInRotation(routineId: number): Promise<RoutineDay | null> {
  const days = await listRoutineDays(routineId);
  if (days.length === 0) return null;
  const rows = await sql`
    select ss.routine_day_id
    from strength_sessions ss
    join routine_days rd on rd.id = ss.routine_day_id
    where rd.routine_id = ${routineId}
    order by ss.session_date desc, ss.id desc
    limit 1
  `;
  if (!rows[0]) return days[0];
  const lastIndex = days.findIndex((d) => d.id === Number(rows[0].routine_day_id));
  if (lastIndex === -1) return days[0];
  return days[(lastIndex + 1) % days.length];
}

export async function setSessionRoutineDay(sessionId: number, dayId: number): Promise<void> {
  await sql`update strength_sessions set routine_day_id = ${dayId} where id = ${sessionId}`;
}

export async function upsertRoutineTarget(input: {
  dayId: number;
  exerciseId: number;
  position?: number;
  targetSets?: number | null;
  targetReps?: number | null;
  targetWeightKg?: number | null;
  notes?: string | null;
}): Promise<void> {
  // A target left out of the call keeps its stored value, so bumping the weight
  // never silently clears the set and rep targets alongside it.
  const nextPosition =
    input.position ??
    Number(
      (
        await sql`select coalesce(max(position), 0) + 1 as n from routine_exercises where day_id = ${input.dayId}`
      )[0].n,
    );
  await sql`
    insert into routine_exercises
      (day_id, exercise_id, position, target_sets, target_reps, target_weight_kg, notes)
    values
      (${input.dayId}, ${input.exerciseId}, ${nextPosition},
       ${input.targetSets ?? null}, ${input.targetReps ?? null},
       ${input.targetWeightKg ?? null}, ${input.notes ?? null})
    on conflict (day_id, exercise_id) do update set
      target_sets = coalesce(${input.targetSets ?? null}, routine_exercises.target_sets),
      target_reps = coalesce(${input.targetReps ?? null}, routine_exercises.target_reps),
      target_weight_kg = coalesce(
        ${input.targetWeightKg ?? null}, routine_exercises.target_weight_kg
      ),
      notes = coalesce(${input.notes ?? null}, routine_exercises.notes)
  `;
}

// The smallest jump available on essentially all gym equipment: dumbbells step
// in 5 lb, cable stacks in 5-10, and a barbell takes 2.5 lb plates a side.
// Deliberately a flat increment rather than a percentage - a percentage makes
// light isolation work unprogressable and heavy compounds jump too far. Override
// any individual target with set_routine_target.
export const WEIGHT_INCREMENT_LB = 5;

export type ProgressionStatus = "advance" | "repeat" | "no_history";

export type Progression = {
  status: ProgressionStatus;
  suggestedWeightLb: number | null;
  suggestedReps: number | null;
  reason: string;
};

// Advance only when the last session met the target on every working set: all
// the prescribed sets, at or above the target reps and weight. Anything short
// repeats the same target, which is what progressive overload actually asks for.
export function suggestProgression(
  target: RoutineTarget,
  last: LastPerformance | undefined,
): Progression {
  const targetWeightLb = target.targetWeightKg != null ? displayLb(target.targetWeightKg) : null;

  if (!last) {
    return {
      status: "no_history",
      suggestedWeightLb: targetWeightLb,
      suggestedReps: target.targetReps,
      reason: "No previous session logged - start at the target and record what you hit.",
    };
  }

  const working = last.sets.filter(isWorkingSet);
  if (working.length === 0 || target.targetReps == null || target.targetWeightKg == null) {
    return {
      status: "repeat",
      suggestedWeightLb: targetWeightLb,
      suggestedReps: target.targetReps,
      reason: "Not enough of a target set to judge progress - repeat and log the result.",
    };
  }

  const lastWeightLb = Math.max(...working.map((s) => (s.weightKg != null ? kgToLb(s.weightKg) : 0)));
  const enoughSets = target.targetSets == null || working.length >= target.targetSets;
  const metReps = working.every((s) => s.reps != null && s.reps >= target.targetReps!);
  const metWeight = working.every(
    (s) => s.weightKg != null && s.weightKg >= target.targetWeightKg! - 1e-9,
  );

  if (enoughSets && metReps && metWeight) {
    const nextLb = Math.round(lastWeightLb) + WEIGHT_INCREMENT_LB;
    return {
      status: "advance",
      suggestedWeightLb: nextLb,
      suggestedReps: target.targetReps,
      reason: `Hit ${working.length}x${target.targetReps} at ${Math.round(lastWeightLb)} lb - add ${WEIGHT_INCREMENT_LB} lb.`,
    };
  }

  const shortfall = !enoughSets
    ? `only ${working.length} of ${target.targetSets} sets`
    : !metWeight
      ? `below the ${targetWeightLb} lb target`
      : `short of ${target.targetReps} reps on at least one set`;
  return {
    status: "repeat",
    suggestedWeightLb: targetWeightLb,
    suggestedReps: target.targetReps,
    reason: `Last session was ${shortfall} - repeat this target before adding weight.`,
  };
}

export async function lastSessionDateForDay(dayId: number): Promise<string | null> {
  const rows = await sql`
    select to_char(max(session_date), 'YYYY-MM-DD') as date
    from strength_sessions
    where routine_day_id = ${dayId}
      and session_date <= (now() at time zone ${TIME_ZONE})::date
  `;
  return (rows[0]?.date as string | null) ?? null;
}
