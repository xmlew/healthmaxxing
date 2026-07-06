"use client";

import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

type Point = { date: string; lean: number; fat: number };

const LEAN_COLOR = "var(--color-chart-in)";
const FAT_COLOR = "var(--color-chart-out)";

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
  const point = payload[0].payload;
  const rows = [
    { key: "lean", label: "Lean mass", color: LEAN_COLOR },
    { key: "fat", label: "Fat mass", color: FAT_COLOR },
  ];
  return (
    <div className="rounded-xl border border-border bg-surface-raised px-3 py-2 text-xs shadow-sm">
      <p className="mb-1.5 text-muted">{formatDate(point.date)}</p>
      {rows.map((row) => {
        const entry = payload.find((p) => p.dataKey === row.key);
        if (!entry) return null;
        return (
          <p key={row.key} className="flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-3 rounded-full" style={{ backgroundColor: row.color }} />
            <span className="font-semibold tabular-nums text-foreground">
              {entry.value.toLocaleString("en-US", { maximumFractionDigits: 1 })}
            </span>
            <span className="text-muted">{row.label} kg</span>
          </p>
        );
      })}
      <p className="mt-1 text-muted">
        Total{" "}
        <span className="font-semibold tabular-nums text-foreground">
          {(point.lean + point.fat).toLocaleString("en-US", { maximumFractionDigits: 1 })}
        </span>{" "}
        kg
      </p>
    </div>
  );
}

export function BodyCompositionChart({ data }: { data: Point[] }) {
  if (data.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted">
        Log a weight entry with body fat % to see lean vs. fat mass.
      </p>
    );
  }

  return (
    <div>
      <ResponsiveContainer width="100%" height={200}>
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
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
            tick={{ fill: "var(--color-muted)", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={40}
            domain={["auto", "auto"]}
          />
          <Tooltip content={<CustomTooltip />} />
          <Area
            type="monotone"
            dataKey="lean"
            stackId="mass"
            stroke={LEAN_COLOR}
            strokeWidth={2}
            fill={LEAN_COLOR}
            fillOpacity={0.2}
            activeDot={{ r: 4, stroke: "var(--color-surface)", strokeWidth: 2 }}
          />
          <Area
            type="monotone"
            dataKey="fat"
            stackId="mass"
            stroke={FAT_COLOR}
            strokeWidth={2}
            fill={FAT_COLOR}
            fillOpacity={0.2}
            activeDot={{ r: 4, stroke: "var(--color-surface)", strokeWidth: 2 }}
          />
        </AreaChart>
      </ResponsiveContainer>
      <div className="mt-1 flex gap-4 text-xs text-muted">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-3 rounded-full" style={{ backgroundColor: LEAN_COLOR }} />
          Lean mass
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-3 rounded-full" style={{ backgroundColor: FAT_COLOR }} />
          Fat mass
        </span>
      </div>
    </div>
  );
}
