"use client";

import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export type RecoveryChartPoint = {
  date: string;
  restingHr: number | null;
  hrv: number | null;
  loadKcal: number | null;
  loadMin: number;
  workoutCount: number;
};

const HR_COLOR = "var(--color-accent)";
const HRV_COLOR = "var(--color-chart-in)";
const LOAD_COLOR = "var(--color-chart-out)";

function formatDate(value: string) {
  return new Date(`${value}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

type PlotPoint = RecoveryChartPoint & { load: number };

function CustomTooltip({
  active,
  payload,
  energyAvailable,
}: {
  active?: boolean;
  payload?: { payload: PlotPoint }[];
  energyAvailable: boolean;
}) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload;
  const rows: { label: string; value: string; color: string }[] = [];
  if (point.restingHr != null)
    rows.push({ label: "Resting HR", value: `${Math.round(point.restingHr)} bpm`, color: HR_COLOR });
  if (point.hrv != null) rows.push({ label: "HRV", value: `${Math.round(point.hrv)} ms`, color: HRV_COLOR });
  if (point.workoutCount > 0)
    rows.push({
      label: "Load",
      value: energyAvailable && point.loadKcal != null
        ? `${Math.round(point.loadKcal)} kcal`
        : `${Math.round(point.loadMin)} min`,
      color: LOAD_COLOR,
    });
  return (
    <div className="rounded-xl border border-border bg-surface-raised px-3 py-2 text-xs shadow-sm">
      <p className="mb-1.5 text-muted">{formatDate(point.date)}</p>
      {rows.length === 0 ? (
        <p className="text-muted">No readings</p>
      ) : (
        rows.map((row) => (
          <p key={row.label} className="flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-3 rounded-full" style={{ backgroundColor: row.color }} />
            <span className="font-semibold tabular-nums text-foreground">{row.value}</span>
            <span className="text-muted">{row.label}</span>
          </p>
        ))
      )}
    </div>
  );
}

export function RecoveryChart({
  data,
  energyAvailable,
}: {
  data: RecoveryChartPoint[];
  energyAvailable: boolean;
}) {
  const hasHr = data.some((p) => p.restingHr != null);
  const hasHrv = data.some((p) => p.hrv != null);

  if (!hasHr && !hasHrv) {
    return <p className="py-8 text-center text-sm text-muted">No resting HR or HRV in this range yet.</p>;
  }

  const plot: PlotPoint[] = data.map((p) => ({
    ...p,
    load: energyAvailable ? p.loadKcal ?? 0 : p.loadMin,
  }));
  const maxLoad = plot.reduce((max, p) => Math.max(max, p.load), 0);
  const loadDomainMax = maxLoad > 0 ? maxLoad * 3 : 1;

  return (
    <div>
      <ResponsiveContainer width="100%" height={220}>
        <ComposedChart data={plot} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--color-border)" />
          <XAxis
            dataKey="date"
            tickFormatter={formatDate}
            tick={{ fill: "var(--color-muted)", fontSize: 11 }}
            axisLine={{ stroke: "var(--color-border)" }}
            tickLine={false}
            minTickGap={32}
          />
          <YAxis
            yAxisId="hr"
            tick={{ fill: "var(--color-muted)", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={36}
            domain={["auto", "auto"]}
          />
          <YAxis
            yAxisId="hrv"
            orientation="right"
            tick={{ fill: "var(--color-muted)", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={36}
            domain={["auto", "auto"]}
          />
          <YAxis yAxisId="load" hide domain={[0, loadDomainMax]} />
          <Tooltip content={<CustomTooltip energyAvailable={energyAvailable} />} cursor={{ fill: "var(--color-border)", fillOpacity: 0.3 }} />
          <Bar yAxisId="load" dataKey="load" fill={LOAD_COLOR} fillOpacity={0.22} radius={[3, 3, 0, 0]} maxBarSize={22} />
          <Line
            yAxisId="hr"
            type="monotone"
            dataKey="restingHr"
            stroke={HR_COLOR}
            strokeWidth={2}
            dot={false}
            connectNulls={false}
            activeDot={{ r: 4, stroke: "var(--color-surface)", strokeWidth: 2 }}
          />
          <Line
            yAxisId="hrv"
            type="monotone"
            dataKey="hrv"
            stroke={HRV_COLOR}
            strokeWidth={2}
            dot={false}
            connectNulls={false}
            activeDot={{ r: 4, stroke: "var(--color-surface)", strokeWidth: 2 }}
          />
        </ComposedChart>
      </ResponsiveContainer>
      <div className="mt-1 flex flex-wrap gap-4 text-xs text-muted">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-3 rounded-full" style={{ backgroundColor: HR_COLOR }} />
          Resting HR (bpm)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-3 rounded-full" style={{ backgroundColor: HRV_COLOR }} />
          HRV (ms)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: LOAD_COLOR, opacity: 0.4 }} />
          Training load ({energyAvailable ? "kcal" : "min"})
        </span>
      </div>
    </div>
  );
}
