import { getGoal, getLatestWeight } from "@/lib/queries";
import { asGoalPhase, evaluatePace, GOAL_PHASES } from "@/lib/goals";
import { saveGoal } from "./actions";

export const dynamic = "force-dynamic";

const PHASE_LABELS: Record<(typeof GOAL_PHASES)[number], string> = {
  cut: "Cut (lose fat)",
  bulk: "Bulk (build muscle)",
  recomp: "Recomp (hold weight)",
  maintenance: "Maintenance",
};

function toDateInputValue(value: string | Date | null): string {
  if (!value) return "";
  const d = new Date(value);
  return d.toISOString().slice(0, 10);
}

export default async function GoalsPage() {
  const [goal, latestWeight] = await Promise.all([getGoal(), getLatestWeight()]);

  const startingWeight = goal?.starting_weight_kg != null ? Number(goal.starting_weight_kg) : null;
  const targetWeight = goal?.target_weight_kg != null ? Number(goal.target_weight_kg) : null;
  const targetDate = goal?.target_date ?? null;
  const startingDate = goal?.starting_date ?? null;
  const phase = asGoalPhase(goal?.phase);

  const pace = evaluatePace({
    phase,
    startingWeightKg: startingWeight,
    targetWeightKg: targetWeight,
    startingDate,
    targetDate,
  });
  const paceIsWarning = pace.status === "too-fast" || pace.status === "wrong-direction";

  return (
    <div className="flex flex-col gap-8">
      <header>
        <h1 className="font-display text-3xl tracking-tight md:text-4xl">Goal</h1>
        <p className="mt-1 text-sm text-muted">
          {latestWeight
            ? `Latest logged weight: ${Number(latestWeight.weight_kg).toFixed(1)} kg`
            : "Log a weight entry to track progress against your goal."}
        </p>
      </header>

      <form action={saveGoal} className="flex max-w-md flex-col gap-4 rounded-3xl border border-border bg-surface p-6">
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="text-muted">Phase</span>
          <select
            name="phase"
            defaultValue={phase}
            className="rounded-xl border border-border bg-background px-3 py-2.5 outline-none focus:border-accent"
          >
            {GOAL_PHASES.map((p) => (
              <option key={p} value={p}>
                {PHASE_LABELS[p]}
              </option>
            ))}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-4">
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-muted">Starting weight (kg)</span>
            <input
              name="startingWeightKg"
              type="number"
              step="0.1"
              inputMode="decimal"
              defaultValue={startingWeight ?? ""}
              className="rounded-xl border border-border bg-background px-3 py-2.5 outline-none focus:border-accent"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-muted">Starting date</span>
            <input
              name="startingDate"
              type="date"
              defaultValue={toDateInputValue(goal?.starting_date ?? null)}
              className="rounded-xl border border-border bg-background px-3 py-2.5 outline-none focus:border-accent"
            />
          </label>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-muted">Target weight (kg)</span>
            <input
              name="targetWeightKg"
              type="number"
              step="0.1"
              inputMode="decimal"
              defaultValue={targetWeight ?? ""}
              className="rounded-xl border border-border bg-background px-3 py-2.5 outline-none focus:border-accent"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-muted">Target date</span>
            <input
              name="targetDate"
              type="date"
              defaultValue={toDateInputValue(targetDate)}
              className="rounded-xl border border-border bg-background px-3 py-2.5 outline-none focus:border-accent"
            />
          </label>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-muted">Daily calorie target (optional)</span>
            <input
              name="dailyCalorieTarget"
              type="number"
              inputMode="numeric"
              defaultValue={goal?.daily_calorie_target ?? ""}
              className="rounded-xl border border-border bg-background px-3 py-2.5 outline-none focus:border-accent"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-muted">Daily protein target g (optional)</span>
            <input
              name="dailyProteinTarget"
              type="number"
              inputMode="numeric"
              min="0"
              placeholder="150"
              defaultValue={goal?.daily_protein_target ?? ""}
              className="rounded-xl border border-border bg-background px-3 py-2.5 outline-none focus:border-accent"
            />
          </label>
        </div>
        <button
          type="submit"
          className="rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-accent-foreground transition-opacity hover:opacity-90"
        >
          Save goal
        </button>
      </form>

      {pace.note ? (
        <p className={`max-w-md text-sm ${paceIsWarning ? "text-warn" : "text-muted"}`}>{pace.note}</p>
      ) : null}
    </div>
  );
}
