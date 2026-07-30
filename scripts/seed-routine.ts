import { join } from "node:path";
import postgres from "postgres";
import { config } from "dotenv";
import { lbToKg } from "../lib/units";

config({ path: join(process.cwd(), ".env.local") });

type ExerciseSeed = {
  name: string;
  sets: number;
  reps: number | null;
  weightLb: number;
  notes?: string;
};

type RoutineSeed = {
  name: string;
  days: { name: string; muscleGroup: string; exercises: ExerciseSeed[] }[];
};

// The PPL v1.0 baseline, exactly as recorded on 2026-07-29. These are starting
// targets, not a ceiling: set_routine_target moves them as the lifts progress,
// and re-running this script never overwrites a target that already exists.
const PPL_V1: RoutineSeed = {
  name: "PPL v1.0",
  days: [
    {
      name: "push",
      muscleGroup: "push",
      exercises: [
        { name: "Incline DB Bench", sets: 3, reps: 8, weightLb: 40 },
        { name: "Seated DB Shoulder Press", sets: 3, reps: 8, weightLb: 25 },
        { name: "Lateral Raise", sets: 3, reps: 8, weightLb: 15, notes: "Burnout set to failure after the last working set" },
        { name: "Low-to-High Cable Fly", sets: 3, reps: 8, weightLb: 20 },
        { name: "Rope Tricep Pushdown", sets: 3, reps: 12, weightLb: 60 },
      ],
    },
    {
      name: "pull",
      muscleGroup: "pull",
      exercises: [
        { name: "Lat Pulldown", sets: 3, reps: 8, weightLb: 115, notes: "Warm-up 100 lb x 12; drop set to 100 lb after the last working set" },
        { name: "Seated Cable Row", sets: 3, reps: 8, weightLb: 85 },
        { name: "Face Pull", sets: 3, reps: 10, weightLb: 50, notes: "Rep range 10-12" },
        { name: "Incline DB Curl", sets: 3, reps: 8, weightLb: 20 },
        { name: "Hammer Curl", sets: 3, reps: 8, weightLb: 20 },
      ],
    },
    {
      name: "legs",
      muscleGroup: "legs",
      exercises: [
        { name: "Back Squat", sets: 3, reps: 8, weightLb: 135 },
        { name: "Romanian Deadlift", sets: 3, reps: 8, weightLb: 115 },
        { name: "Leg Extension", sets: 3, reps: 10, weightLb: 145 },
        { name: "Leg Curl", sets: 3, reps: 10, weightLb: 65 },
        { name: "Seated Calf Raise", sets: 3, reps: null, weightLb: 105, notes: "Baseline reps were not recorded" },
        { name: "Hanging Knee Raise", sets: 3, reps: 12, weightLb: 0, notes: "Bodyweight" },
      ],
    },
  ],
};

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set (check .env.local)");
  }

  const sql = postgres(connectionString, { max: 1 });
  let created = 0;
  let kept = 0;
  try {
    const [routine] = await sql`
      insert into routines (name) values (${PPL_V1.name})
      on conflict (lower(name)) do update set name = excluded.name
      returning id
    `;
    const routineId = Number(routine.id);

    for (const [dayIndex, day] of PPL_V1.days.entries()) {
      const [dayRow] = await sql`
        insert into routine_days (routine_id, name, position)
        values (${routineId}, ${day.name}, ${dayIndex + 1})
        on conflict (routine_id, lower(name)) do update set position = excluded.position
        returning id
      `;
      const dayId = Number(dayRow.id);

      for (const [exerciseIndex, exercise] of day.exercises.entries()) {
        const [exerciseRow] = await sql`
          insert into exercises (name, muscle_group)
          values (${exercise.name}, ${day.muscleGroup})
          on conflict (lower(name)) do update set
            muscle_group = coalesce(exercises.muscle_group, excluded.muscle_group)
          returning id
        `;
        // do nothing, not do update: a target the user has already advanced past
        // must survive a re-run of the baseline.
        const inserted = await sql`
          insert into routine_exercises
            (day_id, exercise_id, position, target_sets, target_reps, target_weight_kg, notes)
          values
            (${dayId}, ${Number(exerciseRow.id)}, ${exerciseIndex + 1},
             ${exercise.sets}, ${exercise.reps},
             ${lbToKg(exercise.weightLb)}, ${exercise.notes ?? null})
          on conflict (day_id, exercise_id) do nothing
          returning id
        `;
        if (inserted.length > 0) created += 1;
        else kept += 1;
      }
    }

    console.log(
      `Seeded "${PPL_V1.name}": ${created} target(s) created, ${kept} left as they were.`,
    );
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
