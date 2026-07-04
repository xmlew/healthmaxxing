import Link from "next/link";
import { ScatterPlot } from "@/components/charts/scatter-plot";
import { MIN_PAIRED_POINTS, PAIRINGS } from "@/lib/correlation";
import { getPairingCorrelation, type PairingCorrelation } from "@/lib/queries";

export const dynamic = "force-dynamic";

const RANGES = [30, 90, 180] as const;

function CorrelationStat({ result }: { result: PairingCorrelation }) {
  if (result.status === "insufficient-data") {
    return (
      <div className="text-sm text-muted">
        <span className="font-semibold text-foreground">Not enough data</span>
        {" - "}
        {result.n} paired {result.n === 1 ? "point" : "points"}, need at least {MIN_PAIRED_POINTS}.
      </div>
    );
  }
  if (result.status === "zero-variance") {
    return (
      <div className="text-sm text-muted">
        <span className="font-semibold text-foreground">Undefined</span>
        {" - "}
        one series is constant over these {result.n} points, so r cannot be computed.
      </div>
    );
  }
  const r = result.r as number;
  return (
    <div className="flex items-baseline gap-4">
      <div>
        <span className="font-display text-3xl tabular-nums text-foreground">
          {r >= 0 ? "+" : ""}
          {r.toFixed(2)}
        </span>
        <span className="ml-1.5 text-sm text-muted">Pearson r</span>
      </div>
      <div className="text-sm text-muted">
        n = <span className="tabular-nums text-foreground">{result.n}</span>
      </div>
    </div>
  );
}

function PairingCard({ result }: { result: PairingCorrelation }) {
  const { pairing } = result;
  return (
    <div className="rounded-3xl border border-border bg-surface p-6">
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <h2 className="font-display text-lg">{pairing.title}</h2>
        <span className="text-xs text-muted">
          {pairing.xLabel} vs {pairing.yLabel}
        </span>
      </div>
      <p className="mb-4 text-sm text-muted">{pairing.description}</p>
      <div className="mb-4">
        <CorrelationStat result={result} />
      </div>
      {result.status === "insufficient-data" && result.n === 0 ? null : (
        <ScatterPlot
          points={result.points}
          xLabel={pairing.xLabel}
          yLabel={pairing.yLabel}
          xUnit={pairing.xUnit}
          yUnit={pairing.yUnit}
        />
      )}
    </div>
  );
}

export default async function CorrelationsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const params = await searchParams;
  const days = RANGES.includes(Number(params.days) as (typeof RANGES)[number])
    ? Number(params.days)
    : 90;

  const results = await Promise.all(
    PAIRINGS.map((pairing) => getPairingCorrelation(pairing.key, days)),
  );

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl tracking-tight md:text-4xl">Correlations</h1>
          <p className="mt-1 text-sm text-muted">Paired daily series over the last {days} days</p>
        </div>
        <div className="flex gap-1 rounded-full border border-border p-1">
          {RANGES.map((r) => (
            <Link
              key={r}
              href={`/correlations?days=${r}`}
              className={`rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
                r === days ? "bg-surface-raised text-foreground" : "text-muted hover:text-foreground"
              }`}
            >
              {r}d
            </Link>
          ))}
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-2">
        {results.map((result) => (
          <PairingCard key={result.pairing.key} result={result} />
        ))}
      </div>

      <p className="text-xs text-muted">
        Correlation is not causation. Pearson r ranges from -1 to +1; values near 0 mean no linear
        relationship. With only a short history the paired-point count stays low, so treat these as
        hints rather than conclusions.
      </p>
    </div>
  );
}
