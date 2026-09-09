import { formatDate } from "@/lib/time";
import { getRoutinePlan, type PlannedExercise } from "@/lib/routines";
import { isWorkingSet } from "@/lib/set-types";
import { displayLb } from "@/lib/units";

function formatTarget(exercise: PlannedExercise) {
  const weight =
    exercise.targetWeightKg != null ? `${displayLb(exercise.targetWeightKg)} lb` : null;
  const reps =
    exercise.targetSets != null && exercise.targetReps != null
      ? `${exercise.targetSets} x ${exercise.targetReps}`
      : exercise.targetSets != null
        ? `${exercise.targetSets} sets`
        : null;
  return [reps, weight].filter(Boolean).join(" @ ") || "-";
}

// Working sets collapse to "40 lb x 8, 8, 8" when the weight held; anything else
// is spelled out set by set so a drop or a missed rep stays visible.
function formatLastSets(exercise: PlannedExercise) {
  if (!exercise.last) return null;
  const working = exercise.last.sets.filter(isWorkingSet);
  if (working.length === 0) return "no working sets";
  const weights = new Set(working.map((s) => (s.weightKg != null ? displayLb(s.weightKg) : null)));
  const reps = working.map((s) => s.reps ?? "-").join(", ");
  if (weights.size === 1) {
    const [weight] = [...weights];
    return `${weight != null ? `${weight} lb` : "-"} x ${reps}`;
  }
  return working
    .map((s) => `${s.weightKg != null ? `${displayLb(s.weightKg)} lb` : "-"} x ${s.reps ?? "-"}`)
    .join(", ");
}

const SUGGESTION_STYLES = {
  advance: "border-accent/40 bg-accent/10 text-accent",
  repeat: "border-border bg-background text-muted",
  no_history: "border-border bg-background text-muted",
} as const;

const SUGGESTION_LABELS = {
  advance: "Advance",
  repeat: "Repeat",
  no_history: "Start",
} as const;

export async function RoutinePlan() {
  const plan = await getRoutinePlan({});

  if ("message" in plan) {
    return (
      <div className="rounded-3xl border border-border bg-surface p-6">
        <h2 className="font-display text-xl">Next session</h2>
        <p className="mt-2 text-sm text-muted">{plan.message}</p>
      </div>
    );
  }

  return (
    <div className="rounded-3xl border border-border bg-surface p-6">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="flex items-baseline gap-2">
          <h2 className="font-display text-xl">Next session</h2>
          <span className="rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-accent">
            {plan.dayName}
          </span>
        </div>
        <p className="text-xs text-muted">
          {plan.routineName}
          {plan.lastTrained ? ` - last trained ${formatDate(plan.lastTrained)}` : " - not yet trained"}
        </p>
      </div>

      {plan.exercises.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted">This day has no exercises yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {plan.exercises.map((exercise) => {
            const lastSets = formatLastSets(exercise);
            return (
              <li key={exercise.exerciseName} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <span className="font-medium capitalize">{exercise.exerciseName}</span>
                  <span className="tabular-nums text-sm">{formatTarget(exercise)}</span>
                </div>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs text-muted">
                  <span>
                    {lastSets != null && exercise.last != null
                      ? `Last ${formatDate(exercise.last.date)}: ${lastSets}`
                      : "No previous session"}
                  </span>
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                      SUGGESTION_STYLES[exercise.progression.status]
                    }`}
                  >
                    {SUGGESTION_LABELS[exercise.progression.status]}
                    {exercise.progression.suggestedWeightLb != null
                      ? ` ${exercise.progression.suggestedWeightLb} lb`
                      : ""}
                  </span>
                </div>
                {exercise.notes ? (
                  <p className="text-xs text-muted">{exercise.notes}</p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
