import { getGoal, getLatestWeight } from "@/lib/queries";
import { saveGoal } from "./actions";

export const dynamic = "force-dynamic";

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

  let paceNote: string | null = null;
  if (startingWeight != null && targetWeight != null && targetDate && startingDate) {
    const weeks = Math.max(
      1 / 7,
      (new Date(targetDate).getTime() - new Date(startingDate).getTime()) / (1000 * 60 * 60 * 24 * 7)
    );
    const perWeek = (startingWeight - targetWeight) / weeks;
    if (perWeek > 0) {
      paceNote =
        perWeek > 1
          ? `That's about ${perWeek.toFixed(2)} kg/week - faster than the commonly recommended 0.5-1 kg/week pace.`
          : `About ${perWeek.toFixed(2)} kg/week - within a typically sustainable range.`;
    } else if (perWeek < 0) {
      paceNote = "Target weight is above your starting weight - this is set up as a gain goal.";
    }
  }

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
        <button
          type="submit"
          className="rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-accent-foreground transition-opacity hover:opacity-90"
        >
          Save goal
        </button>
      </form>

      {paceNote ? (
        <p className="max-w-md text-sm text-muted">{paceNote}</p>
      ) : null}
    </div>
  );
}
