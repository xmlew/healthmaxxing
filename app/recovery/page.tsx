import Link from "next/link";
import { RecoveryChart } from "@/components/charts/recovery-chart";
import { getRecoveryAnalysis } from "@/lib/recovery";

export const dynamic = "force-dynamic";

const RANGES = [7, 30, 90] as const;

const FLAG_STYLES: Record<string, string> = {
  warning: "border-warn/40 bg-warn/10 text-foreground",
  steady: "border-good/40 bg-good/10 text-foreground",
  insufficient_data: "border-border bg-surface text-foreground",
};

const FLAG_DOT: Record<string, string> = {
  warning: "bg-warn",
  steady: "bg-good",
  insufficient_data: "bg-muted",
};

export default async function RecoveryPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const params = await searchParams;
  const days = RANGES.includes(Number(params.days) as (typeof RANGES)[number])
    ? Number(params.days)
    : 30;

  const analysis = await getRecoveryAnalysis(days);
  const { flag } = analysis;

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl tracking-tight md:text-4xl">Recovery</h1>
          <p className="mt-1 text-sm text-muted">Resting HR and HRV against training load - last {days} days</p>
        </div>
        <div className="flex gap-1 rounded-full border border-border p-1">
          {RANGES.map((r) => (
            <Link
              key={r}
              href={`/recovery?days=${r}`}
              className={`rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
                r === days ? "bg-surface-raised text-foreground" : "text-muted hover:text-foreground"
              }`}
            >
              {r}d
            </Link>
          ))}
        </div>
      </header>

      <div className={`rounded-3xl border p-6 ${FLAG_STYLES[flag.status]}`}>
        <div className="flex items-center gap-2">
          <span className={`inline-block h-2.5 w-2.5 rounded-full ${FLAG_DOT[flag.status]}`} aria-hidden />
          <h2 className="font-display text-lg">{flag.headline}</h2>
        </div>
        <p className="mt-2 text-sm text-muted">{flag.detail}</p>
      </div>

      <div className="rounded-3xl border border-border bg-surface p-6">
        <h2 className="mb-2 font-display text-lg">Resting HR, HRV, and load</h2>
        <RecoveryChart data={analysis.series} energyAvailable={analysis.energyAvailable} />
      </div>
    </div>
  );
}
