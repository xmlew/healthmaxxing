import Link from "next/link";
import { StatTile } from "@/components/stat-tile";
import { kjToKcal } from "@/lib/time";
import { ANOMALY_BASELINE_DAYS, getAnomalies } from "@/lib/anomalies";
import {
  getGoal,
  getLatestMetric,
  getLatestWeight,
  getTodayFoodTotal,
  getTodayMetricSum,
} from "@/lib/queries";

export const dynamic = "force-dynamic";

function fmt(n: number, digits = 0) {
  return n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

export default async function DashboardPage() {
  const [steps, activeKj, basalKj, distanceKm, restingHr, sleep, foodToday, weight, goal, anomalies] =
    await Promise.all([
      getTodayMetricSum("step_count"),
      getTodayMetricSum("active_energy"),
      getTodayMetricSum("basal_energy_burned"),
      getTodayMetricSum("walking_running_distance"),
      getLatestMetric("resting_heart_rate"),
      getLatestMetric("sleep_analysis"),
      getTodayFoodTotal(),
      getLatestWeight(),
      getGoal(),
      getAnomalies(),
    ]);

  const caloriesOut = kjToKcal(activeKj + basalKj);
  const caloriesIn = foodToday.calories;
  const balance = caloriesIn - caloriesOut;

  const proteinToday = foodToday.proteinG;
  const proteinTarget = goal?.daily_protein_target != null ? Number(goal.daily_protein_target) : null;
  // Nudge when behind on protein, but not when food was logged without protein
  // tracked (sum coalesces to 0) - that reads as "0 g" when we simply don't know.
  const proteinTracked = foodToday.entries === 0 || proteinToday > 0;
  const underProtein =
    proteinTarget != null && proteinTarget > 0 && proteinToday < proteinTarget && proteinTracked;

  const weightKg = weight ? Number(weight.weight_kg) : null;
  const startWeight = goal?.starting_weight_kg ? Number(goal.starting_weight_kg) : null;
  const targetWeight = goal?.target_weight_kg ? Number(goal.target_weight_kg) : null;
  const progress =
    weightKg != null && startWeight != null && targetWeight != null && startWeight !== targetWeight
      ? Math.min(1, Math.max(0, (startWeight - weightKg) / (startWeight - targetWeight)))
      : null;

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  return (
    <div className="flex flex-col gap-8">
      <header>
        <p className="text-sm text-muted">{today}</p>
        <h1 className="font-display text-3xl tracking-tight md:text-4xl">Today</h1>
      </header>

      {anomalies.length > 0 ? (
        <section className="flex flex-col gap-3">
          {anomalies.map((a) => {
            const deviationPct = Math.round(a.deviationPct * 100);
            const asOf = a.currentAt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
            return (
              <div
                key={a.key}
                className="rise-in flex items-start gap-4 rounded-3xl border border-warn/40 bg-warn/10 p-5"
              >
                <span
                  aria-hidden
                  className="mt-0.5 flex h-7 w-7 flex-none items-center justify-center rounded-full bg-warn/20 font-display text-warn"
                >
                  !
                </span>
                <div className="min-w-0">
                  <p className="font-medium text-warn">
                    {a.label} {a.direction === "above" ? "elevated" : "low"}
                  </p>
                  <p className="mt-1 text-sm text-foreground">
                    Now {fmt(a.current)} {a.unit}, {Math.abs(deviationPct)}% {a.direction} your{" "}
                    {ANOMALY_BASELINE_DAYS}-day baseline of {fmt(a.baselineMean)} {a.unit}.
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    Baseline from {a.baselineSampleCount} readings, as of {asOf}.
                  </p>
                </div>
              </div>
            );
          })}
        </section>
      ) : null}

      {underProtein ? (
        <div className="rise-in flex items-start gap-4 rounded-3xl border border-warn/40 bg-warn/10 p-5">
          <span
            aria-hidden
            className="mt-0.5 flex h-7 w-7 flex-none items-center justify-center rounded-full bg-warn/20 font-display text-warn"
          >
            !
          </span>
          <div className="min-w-0">
            <p className="font-medium text-warn">Under protein target</p>
            <p className="mt-1 text-sm text-foreground">
              {fmt(proteinToday)} g so far today, {fmt(proteinTarget as number)} g target -{" "}
              {fmt((proteinTarget as number) - proteinToday)} g to go.
            </p>
          </div>
        </div>
      ) : null}

      <section className="rise-in rounded-3xl border border-border bg-surface p-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted">Current weight</p>
            <p className="font-display text-4xl tabular-nums tracking-tight">
              {weightKg != null ? fmt(weightKg, 1) : "--"}
              <span className="ml-1 text-lg font-normal text-muted">kg</span>
            </p>
          </div>
          {targetWeight != null ? (
            <div className="text-right">
              <p className="text-xs font-medium uppercase tracking-wide text-muted">Goal</p>
              <p className="font-display text-2xl tabular-nums tracking-tight text-accent">
                {fmt(targetWeight, 1)}
                <span className="ml-1 text-sm font-normal text-muted">kg</span>
              </p>
            </div>
          ) : (
            <Link
              href="/goals"
              className="rounded-full border border-border px-4 py-2 text-sm font-medium text-muted transition-colors hover:text-foreground"
            >
              Set a goal
            </Link>
          )}
        </div>
        {progress != null ? (
          <div className="mt-5">
            <div className="h-2 w-full overflow-hidden rounded-full bg-surface-raised">
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-700 ease-out"
                style={{ width: `${Math.round(progress * 100)}%` }}
              />
            </div>
            <p className="mt-2 text-xs text-muted">{Math.round(progress * 100)}% to goal</p>
          </div>
        ) : null}
      </section>

      <section>
        <h2 className="mb-1 text-sm font-medium text-muted">Calories</h2>
        <div className="rounded-3xl border border-border bg-surface p-6">
          <div className="flex flex-wrap items-baseline justify-between gap-6">
            <StatTile label="Eaten" value={fmt(caloriesIn)} unit="kcal" />
            <StatTile label="Burned" value={fmt(caloriesOut)} unit="kcal" />
            <StatTile
              label={balance <= 0 ? "Deficit" : "Surplus"}
              value={fmt(Math.abs(balance))}
              unit="kcal"
              caption={balance <= 0 ? "on track" : "over burn"}
            />
            <StatTile
              label="Protein"
              value={fmt(proteinToday)}
              unit="g"
              caption={proteinTarget != null ? `of ${fmt(proteinTarget)} g` : undefined}
            />
          </div>
        </div>
      </section>

      <section className="grid grid-cols-2 gap-x-6 divide-y divide-border rounded-3xl border border-border bg-surface px-6 sm:grid-cols-4 sm:divide-y-0">
        <StatTile label="Steps" value={fmt(steps)} delay={0} />
        <StatTile label="Distance" value={fmt(distanceKm, 1)} unit="km" delay={40} />
        <StatTile
          label="Sleep"
          value={sleep ? fmt(Number(sleep.qty), 1) : "--"}
          unit={sleep ? "hr" : undefined}
          caption={sleep ? new Date(sleep.sample_ts).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : undefined}
          delay={80}
        />
        <StatTile label="Resting HR" value={restingHr ? fmt(Number(restingHr.qty)) : "--"} unit={restingHr ? "bpm" : undefined} delay={120} />
      </section>
    </div>
  );
}
