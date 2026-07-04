"use client";

import {
  CartesianGrid,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";

type Point = { x: number; y: number };

function formatNumber(value: number) {
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function CustomTooltip({
  active,
  payload,
  xLabel,
  yLabel,
  xUnit,
  yUnit,
}: {
  active?: boolean;
  payload?: { payload: Point }[];
  xLabel: string;
  yLabel: string;
  xUnit: string;
  yUnit: string;
}) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload;
  const rows = [
    { label: xLabel, value: point.x, unit: xUnit },
    { label: yLabel, value: point.y, unit: yUnit },
  ];
  return (
    <div className="rounded-xl border border-border bg-surface-raised px-3 py-2 text-xs shadow-sm">
      {rows.map((row) => (
        <p key={row.label} className="flex items-baseline gap-1.5">
          <span className="text-muted">{row.label}</span>
          <span className="font-semibold tabular-nums text-foreground">
            {formatNumber(row.value)}
            <span className="ml-1 font-normal text-muted">{row.unit}</span>
          </span>
        </p>
      ))}
    </div>
  );
}

export function ScatterPlot({
  points,
  xLabel,
  yLabel,
  xUnit,
  yUnit,
  color = "var(--color-accent)",
}: {
  points: Point[];
  xLabel: string;
  yLabel: string;
  xUnit: string;
  yUnit: string;
  color?: string;
}) {
  if (points.length === 0) {
    return <p className="py-8 text-center text-sm text-muted">Not enough data yet.</p>;
  }

  return (
    <ResponsiveContainer width="100%" height={220}>
      <ScatterChart margin={{ top: 8, right: 12, bottom: 20, left: 4 }}>
        <CartesianGrid stroke="var(--color-border)" />
        <XAxis
          type="number"
          dataKey="x"
          name={xLabel}
          tick={{ fill: "var(--color-muted)", fontSize: 11 }}
          axisLine={{ stroke: "var(--color-border)" }}
          tickLine={false}
          domain={["auto", "auto"]}
          tickFormatter={formatNumber}
        />
        <YAxis
          type="number"
          dataKey="y"
          name={yLabel}
          tick={{ fill: "var(--color-muted)", fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          width={44}
          domain={["auto", "auto"]}
          tickFormatter={formatNumber}
        />
        <ZAxis range={[48, 48]} />
        <Tooltip
          cursor={{ stroke: "var(--color-border)", strokeDasharray: "4 4" }}
          content={
            <CustomTooltip
              xLabel={xLabel}
              yLabel={yLabel}
              xUnit={xUnit}
              yUnit={yUnit}
            />
          }
        />
        <Scatter
          data={points}
          fill={color}
          fillOpacity={0.65}
          stroke={color}
          strokeWidth={1}
        />
      </ScatterChart>
    </ResponsiveContainer>
  );
}
