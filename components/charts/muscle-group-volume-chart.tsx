"use client";

import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

type GroupVolume = { muscleGroup: string; weeks: { weekStart: string; volume: number }[] };

// Distinct series colors; cycles if there are more groups than colors.
const COLORS = [
  "var(--color-accent)",
  "var(--color-chart-in)",
  "var(--color-chart-out)",
  "var(--color-warn)",
  "var(--color-good)",
  "var(--color-muted)",
];

function formatWeek(value: string) {
  return new Date(`${value}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function CustomTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: { value: number; dataKey: string; color: string }[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl border border-border bg-surface-raised px-3 py-2 text-xs shadow-sm">
      <p className="mb-1.5 text-muted">Week of {label ? formatWeek(label) : ""}</p>
      {payload
        .filter((p) => p.value > 0)
        .map((p) => (
          <p key={p.dataKey} className="flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-3 rounded-full" style={{ backgroundColor: p.color }} />
            <span className="font-semibold tabular-nums text-foreground">
              {Math.round(p.value).toLocaleString("en-US")}
            </span>
            <span className="text-muted">{p.dataKey}</span>
          </p>
        ))}
    </div>
  );
}

export function MuscleGroupVolumeChart({ data }: { data: GroupVolume[] }) {
  if (data.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted">
        Log strength sets (with a muscle group) to see weekly volume here.
      </p>
    );
  }

  const weekStarts = [...new Set(data.flatMap((g) => g.weeks.map((w) => w.weekStart)))].sort();
  const rows = weekStarts.map((weekStart) => {
    const row: Record<string, string | number> = { weekStart };
    for (const g of data) {
      row[g.muscleGroup] = g.weeks.find((w) => w.weekStart === weekStart)?.volume ?? 0;
    }
    return row;
  });

  return (
    <div>
      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--color-border)" />
          <XAxis
            dataKey="weekStart"
            tickFormatter={formatWeek}
            tick={{ fill: "var(--color-muted)", fontSize: 11 }}
            axisLine={{ stroke: "var(--color-border)" }}
            tickLine={false}
            minTickGap={24}
          />
          <YAxis tick={{ fill: "var(--color-muted)", fontSize: 11 }} axisLine={false} tickLine={false} width={44} />
          <Tooltip content={<CustomTooltip />} />
          {data.map((g, i) => (
            <Line
              key={g.muscleGroup}
              type="monotone"
              dataKey={g.muscleGroup}
              stroke={COLORS[i % COLORS.length]}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, stroke: "var(--color-surface)", strokeWidth: 2 }}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        {data.map((g, i) => (
          <span key={g.muscleGroup} className="flex items-center gap-1.5">
            <span
              className="inline-block h-0.5 w-3 rounded-full"
              style={{ backgroundColor: COLORS[i % COLORS.length] }}
            />
            {g.muscleGroup}
          </span>
        ))}
      </div>
    </div>
  );
}
