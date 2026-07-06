import Link from "next/link";
import { TdeeChart } from "@/components/charts/tdee-chart";
import { StatTile } from "@/components/stat-tile";
import { getTdeeAnalysis, DEFAULT_ROLLING_WINDOW, KCAL_PER_KG } from "@/lib/tdee";

export const dynamic = "force-dynamic";

const RANGES = [7, 30, 90] as const;

function fmt(n: number, digits = 0) {
  return n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function signed(n: number, digits = 0) {
  return `${n > 0 ? "+" : ""}${fmt(n, digits)}`;
}

function Card({ title, children, aside }: { title: string; children: React.ReactNode; aside?: string }) {
  return (
    <div className="rounded-3xl border border-border bg-surface p-6">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="font-display text-lg">{title}</h2>
        {aside ? <span className="text-xs text-muted">{aside}</span> : null}
      </div>
      {children}
    </div>
  );
}

export default async function TdeePage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const params = await searchParams;
  const days = RANGES.includes(Number(params.days) as (typeof RANGES)[number])
    ? Number(params.days)
    : 30;

  const rollingWindow = Math.min(DEFAULT_ROLLING_WINDOW, days);
  const a = await getTdeeAnalysis(days, rollingWindow);

  const chartData = a.days.map((d) => ({
    date: d.date,
    tdee: d.tdee,
    intake: d.intake,
    hasBasal: d.hasBasal,
  }));

  const netIsDeficit = a.rollingNet != null && a.rollingNet < 0;
  const cumIsDeficit = a.cumulativeNet != null && a.cumulativeNet < 0;

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl tracking-tight md:text-4xl">TDEE</h1>
          <p className="mt-1 text-sm text-muted">
            Energy burned vs. logged intake - last {days} days
          </p>
        </div>
        <div className="flex gap-1 rounded-full border border-border p-1">
          {RANGES.map((r) => (
            <Link
              key={r}
              href={`/tdee?days=${r}`}
              className={`rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
                r === days ? "bg-surface-raised text-foreground" : "text-muted hover:text-foreground"
              }`}
            >
              {r}d
            </Link>
          ))}
        </div>
      </header>

      {!a.hasEnergyData ? (
        <Card title="No energy data yet">
          <p className="py-6 text-center text-sm text-muted">
            TDEE needs Apple Health active and basal energy. Once those samples are imported, your
            estimated burn will appear here.
          </p>
        </Card>
      ) : (
        <>
          <section className="rounded-3xl border border-border bg-surface p-6">
            <div className="grid grid-cols-2 gap-x-6 divide-border md:grid-cols-4">
              <StatTile
                label={`TDEE (${rollingWindow}d avg)`}
                value={a.rollingTdee != null ? fmt(a.rollingTdee) : "-"}
                unit="kcal"
                caption={
                  a.rollingTdee != null ? `over ${a.validDayCount} valid day${a.validDayCount === 1 ? "" : "s"}` : "no valid days"
                }
              />
              <StatTile
                label="Fixed target"
                value={a.dailyCalorieTarget != null ? fmt(a.dailyCalorieTarget) : "not set"}
                unit={a.dailyCalorieTarget != null ? "kcal" : undefined}
                caption={
                  a.targetVsTdee != null
                    ? `${signed(a.targetVsTdee)} kcal vs TDEE`
                    : "set a target on Goals"
                }
                delay={40}
              />
              <StatTile
                label="Intake avg"
                value={a.rollingIntake != null ? fmt(a.rollingIntake) : "-"}
                unit="kcal"
                caption={a.rollingIntake == null ? "no food logged" : "logged food"}
                delay={80}
              />
              <StatTile
                label="Net balance"
                value={a.rollingNet != null ? signed(a.rollingNet) : "-"}
                unit="kcal/day"
                caption={
                  a.rollingNet != null
                    ? netIsDeficit
                      ? "deficit - losing"
                      : "surplus - gaining"
                    : "needs intake + TDEE"
                }
                delay={120}
              />
            </div>
            {a.lowConfidence ? (
              <p className="mt-4 rounded-xl bg-surface-raised px-3 py-2 text-xs text-muted">
                Low confidence: only {a.validDayCount} day{a.validDayCount === 1 ? "" : "s"} with
                basal energy in the rolling window. Treat the average as provisional.
              </p>
            ) : null}
          </section>

          {a.missingBasalDays.length > 0 ? (
            <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
              <p className="font-medium text-amber-600 dark:text-amber-400">
                {a.missingBasalDays.length} day{a.missingBasalDays.length === 1 ? "" : "s"} missing
                basal energy
              </p>
              <p className="mt-0.5 text-xs text-muted">
                Apple Health did not record resting burn on{" "}
                {a.missingBasalDays
                  .map((d) => new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" }))
                  .join(", ")}
                . These days are excluded from the TDEE average so it is not understated.
              </p>
            </div>
          ) : null}

          <Card title="TDEE vs intake" aside="kcal / day">
            <TdeeChart data={chartData} target={a.dailyCalorieTarget ?? undefined} />
          </Card>

          <Card title="Cumulative balance" aside={`last ${days} days`}>
            {a.cumulativeNet != null && a.impliedWeightChangeKg != null ? (
              <div className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
                <StatTile
                  label="Cumulative net"
                  value={signed(a.cumulativeNet)}
                  unit="kcal"
                  caption={cumIsDeficit ? "net deficit" : "net surplus"}
                />
                <StatTile
                  label="Implied weight change"
                  value={signed(a.impliedWeightChangeKg, 2)}
                  unit="kg"
                  caption={`at ~${fmt(KCAL_PER_KG)} kcal/kg`}
                  delay={40}
                />
              </div>
            ) : (
              <p className="py-6 text-center text-sm text-muted">
                Log food alongside energy data to see the cumulative deficit and implied weight
                change.
              </p>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
