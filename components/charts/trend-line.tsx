"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  Dot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

type Point = { date: string; value: number };

function formatDate(value: string) {
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function CustomTooltip({
  active,
  payload,
  unit,
}: {
  active?: boolean;
  payload?: { value: number; payload: Point }[];
  unit: string;
}) {
  if (!active || !payload?.length) return null;
  const point = payload[0];
  return (
    <div className="rounded-xl border border-border bg-surface-raised px-3 py-2 text-xs shadow-sm">
      <p className="font-semibold tabular-nums text-foreground">
        {point.value.toLocaleString("en-US", { maximumFractionDigits: 1 })}
        <span className="ml-1 font-normal text-muted">{unit}</span>
      </p>
      <p className="text-muted">{formatDate(point.payload.date)}</p>
    </div>
  );
}

function EndDot(props: { cx?: number; cy?: number; index?: number; dataLength: number; color: string }) {
  const { cx, cy, index, dataLength, color } = props;
  if (index !== dataLength - 1 || cx == null || cy == null) return null;
  return <Dot cx={cx} cy={cy} r={4} fill={color} stroke="var(--color-surface)" strokeWidth={2} />;
}

export function TrendLine({
  data,
  unit,
  color = "var(--color-accent)",
  goal,
}: {
  data: Point[];
  unit: string;
  color?: string;
  goal?: number;
}) {
  if (data.length === 0) {
    return <p className="py-8 text-center text-sm text-muted">Not enough data yet.</p>;
  }

  return (
    <ResponsiveContainer width="100%" height={180}>
      <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id="trend-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.12} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} stroke="var(--color-border)" strokeDasharray="0" />
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
          width={36}
          domain={["auto", "auto"]}
        />
        {goal != null ? (
          <ReferenceLine y={goal} stroke="var(--color-muted)" strokeDasharray="4 4" />
        ) : null}
        <Tooltip content={<CustomTooltip unit={unit} />} />
        <Area
          type="monotone"
          dataKey="value"
          stroke={color}
          strokeWidth={2}
          fill="url(#trend-fill)"
          dot={(props: { cx?: number; cy?: number; index?: number }) => (
            <EndDot key={props.index} {...props} dataLength={data.length} color={color} />
          )}
          activeDot={{ r: 4, fill: color, stroke: "var(--color-surface)", strokeWidth: 2 }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
