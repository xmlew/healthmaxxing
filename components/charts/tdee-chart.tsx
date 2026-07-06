"use client";

import {
  CartesianGrid,
  Dot,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export type TdeePoint = {
  date: string;
  tdee: number | null;
  intake: number | null;
  hasBasal: boolean;
};

function formatDate(value: string) {
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function CustomTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: { value: number; dataKey: string; payload: TdeePoint }[];
}) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload;
  const rows = [
    { key: "tdee", label: "TDEE", color: "var(--color-chart-out)" },
    { key: "intake", label: "Eaten", color: "var(--color-chart-in)" },
  ];
  return (
    <div className="rounded-xl border border-border bg-surface-raised px-3 py-2 text-xs shadow-sm">
      <p className="mb-1.5 text-muted">{formatDate(point.date)}</p>
      {rows.map((row) => {
        const entry = payload.find((p) => p.dataKey === row.key);
        if (!entry || entry.value == null) return null;
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
      {point.tdee != null && !point.hasBasal ? (
        <p className="mt-1 text-[11px] text-amber-500">No basal - TDEE understated</p>
      ) : null}
    </div>
  );
}

function TdeeDot(props: { cx?: number; cy?: number; payload?: TdeePoint; value?: number | null }) {
  const { cx, cy, payload, value } = props;
  if (cx == null || cy == null || value == null) return null;
  if (payload && !payload.hasBasal) {
    return <Dot cx={cx} cy={cy} r={3} fill="var(--color-surface)" stroke="#f59e0b" strokeWidth={2} />;
  }
  return null;
}

export function TdeeChart({ data, target }: { data: TdeePoint[]; target?: number }) {
  if (data.length === 0) {
    return <p className="py-8 text-center text-sm text-muted">Not enough data yet.</p>;
  }

  return (
    <div>
      <ResponsiveContainer width="100%" height={200}>
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
          <YAxis tick={{ fill: "var(--color-muted)", fontSize: 11 }} axisLine={false} tickLine={false} width={44} />
          {target != null ? (
            <ReferenceLine y={target} stroke="var(--color-muted)" strokeDasharray="4 4" />
          ) : null}
          <Tooltip content={<CustomTooltip />} />
          <Line
            type="monotone"
            dataKey="tdee"
            stroke="var(--color-chart-out)"
            strokeWidth={2}
            connectNulls
            dot={(props) => {
              const { key, ...rest } = props as { key?: string } & Record<string, unknown>;
              return <TdeeDot key={key as string} {...(rest as object)} />;
            }}
            activeDot={{ r: 4, stroke: "var(--color-surface)", strokeWidth: 2 }}
          />
          <Line
            type="monotone"
            dataKey="intake"
            stroke="var(--color-chart-in)"
            strokeWidth={2}
            connectNulls
            dot={false}
            activeDot={{ r: 4, stroke: "var(--color-surface)", strokeWidth: 2 }}
          />
        </LineChart>
      </ResponsiveContainer>
      <div className="mt-1 flex flex-wrap gap-4 text-xs text-muted">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-3 rounded-full" style={{ backgroundColor: "var(--color-chart-out)" }} />
          TDEE (burned)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-3 rounded-full" style={{ backgroundColor: "var(--color-chart-in)" }} />
          Eaten
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full border-2 border-amber-500 bg-surface" />
          Missing basal
        </span>
      </div>
    </div>
  );
}
