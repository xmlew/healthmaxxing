import Link from "next/link";
import { TrendLine } from "@/components/charts/trend-line";
import { DualTrendLine } from "@/components/charts/dual-trend-line";
import { BodyCompositionChart } from "@/components/charts/body-composition-chart";
import { kjToKcal } from "@/lib/time";
import {
  getEnergyOutDailyTotals,
  getFoodDailyTotals,
  getGoal,
  getMetricSeries,
  getWeightSeries,
} from "@/lib/queries";

export const dynamic = "force-dynamic";

const RANGES = [7, 30, 90] as const;

function ChartCard({ title, unit, children }: { title: string; unit?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-3xl border border-border bg-surface p-6">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="font-display text-lg">{title}</h2>
        {unit ? <span className="text-xs text-muted">{unit}</span> : null}
      </div>
      {children}
    </div>
  );
}

export default async function TrendsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const params = await searchParams;
  const days = RANGES.includes(Number(params.days) as (typeof RANGES)[number])
    ? Number(params.days)
    : 30;

  const [weight, steps, sleep, restingHr, hrv, foodDaily, energyOutDaily, goal] = await Promise.all([
    getWeightSeries(days),
    getMetricSeries("step_count", days),
    getMetricSeries("sleep_analysis", days),
    getMetricSeries("resting_heart_rate", days),
    getMetricSeries("heart_rate_variability", days),
    getFoodDailyTotals(days),
    getEnergyOutDailyTotals(days),
    getGoal(),
  ]);

  const caloriesByDay = new Map<string, { in: number; out: number }>();
  for (const f of foodDaily) {
    const key = f.date.toISOString().slice(0, 10);
    caloriesByDay.set(key, { in: f.calories, out: caloriesByDay.get(key)?.out ?? 0 });
  }
  for (const e of energyOutDaily) {
    const key = e.date.toISOString().slice(0, 10);
    caloriesByDay.set(key, { in: caloriesByDay.get(key)?.in ?? 0, out: kjToKcal(e.kj) });
  }
  const caloriesData = Array.from(caloriesByDay.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({ date, in: v.in, out: v.out }));

  // Split each weigh-in that carries a body-fat reading into lean vs fat mass.
  const bodyCompositionData = weight
    .filter((w) => w.bodyFatPct != null)
    .map((w) => {
      const fat = (w.weightKg * (w.bodyFatPct as number)) / 100;
      return { date: w.date.toISOString(), lean: w.weightKg - fat, fat };
    });

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl tracking-tight md:text-4xl">Trends</h1>
          <p className="mt-1 text-sm text-muted">Last {days} days</p>
        </div>
        <div className="flex gap-1 rounded-full border border-border p-1">
          {RANGES.map((r) => (
            <Link
              key={r}
              href={`/trends?days=${r}`}
              className={`rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
                r === days ? "bg-surface-raised text-foreground" : "text-muted hover:text-foreground"
              }`}
            >
              {r}d
            </Link>
          ))}
        </div>
      </header>

      <ChartCard title="Weight" unit="kg">
        <TrendLine
          data={weight.map((w) => ({ date: w.date.toISOString(), value: w.weightKg }))}
          unit="kg"
          goal={goal?.target_weight_kg != null ? Number(goal.target_weight_kg) : undefined}
        />
      </ChartCard>

      {bodyCompositionData.length > 0 ? (
        <ChartCard title="Body composition" unit="kg">
          <BodyCompositionChart data={bodyCompositionData} />
        </ChartCard>
      ) : null}

      <ChartCard title="Calories in vs. out" unit="kcal">
        <DualTrendLine data={caloriesData} />
      </ChartCard>

      <div className="grid gap-6 md:grid-cols-2">
        <ChartCard title="Steps">
          <TrendLine data={steps.map((s) => ({ date: s.date.toISOString(), value: s.qty }))} unit="steps" />
        </ChartCard>
        <ChartCard title="Sleep" unit="hr">
          <TrendLine data={sleep.map((s) => ({ date: s.date.toISOString(), value: s.qty }))} unit="hr" />
        </ChartCard>
        <ChartCard title="Resting heart rate" unit="bpm">
          <TrendLine data={restingHr.map((s) => ({ date: s.date.toISOString(), value: s.qty }))} unit="bpm" />
        </ChartCard>
        <ChartCard title="Heart rate variability" unit="ms">
          <TrendLine data={hrv.map((s) => ({ date: s.date.toISOString(), value: s.qty }))} unit="ms" />
        </ChartCard>
      </div>
    </div>
  );
}
