"use client";

import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

type Point = { date: string; in: number; out: number };

function formatDate(value: string) {
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function CustomTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: { value: number; dataKey: string; payload: Point }[];
}) {
  if (!active || !payload?.length) return null;
  const date = payload[0].payload.date;
  const rows = [
    { key: "out", label: "Burned", color: "var(--color-chart-out)" },
    { key: "in", label: "Eaten", color: "var(--color-chart-in)" },
  ];
  return (
    <div className="rounded-xl border border-border bg-surface-raised px-3 py-2 text-xs shadow-sm">
      <p className="mb-1.5 text-muted">{formatDate(date)}</p>
      {rows.map((row) => {
        const entry = payload.find((p) => p.dataKey === row.key);
        if (!entry) return null;
        return (
          <p key={row.key} className="flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-3 rounded-full" style={{ backgroundColor: row.color }} />
            <span className="font-semibold tabular-nums text-foreground">
              {Math.round(entry.value).toLocaleString("en-US")}
            </span>
            <span className="text-muted">{row.label}</span>
          </p>
        );
      })}
    </div>
  );
}

export function DualTrendLine({ data }: { data: Point[] }) {
  if (data.length === 0) {
    return <p className="py-8 text-center text-sm text-muted">Not enough data yet.</p>;
  }

  return (
    <div>
      <ResponsiveContainer width="100%" height={180}>
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--color-border)" />
          <XAxis
            dataKey="date"
            tickFormatter={formatDate}
            tick={{ fill: "var(--color-muted)", fontSize: 11 }}
            axisLine={{ stroke: "var(--color-border)" }}
            tickLine={false}
            minTickGap={32}
          />
          <YAxis tick={{ fill: "var(--color-muted)", fontSize: 11 }} axisLine={false} tickLine={false} width={40} />
          <Tooltip content={<CustomTooltip />} />
          <Line
            type="monotone"
            dataKey="out"
            stroke="var(--color-chart-out)"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, stroke: "var(--color-surface)", strokeWidth: 2 }}
          />
          <Line
            type="monotone"
            dataKey="in"
            stroke="var(--color-chart-in)"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, stroke: "var(--color-surface)", strokeWidth: 2 }}
          />
        </LineChart>
      </ResponsiveContainer>
      <div className="mt-1 flex gap-4 text-xs text-muted">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-3 rounded-full" style={{ backgroundColor: "var(--color-chart-out)" }} />
          Burned
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-3 rounded-full" style={{ backgroundColor: "var(--color-chart-in)" }} />
          Eaten
        </span>
      </div>
    </div>
  );
}
