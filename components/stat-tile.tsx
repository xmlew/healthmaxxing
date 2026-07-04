export function StatTile({
  label,
  value,
  unit,
  caption,
  delay = 0,
}: {
  label: string;
  value: string;
  unit?: string;
  caption?: string;
  delay?: number;
}) {
  return (
    <div
      className="rise-in flex flex-col gap-1 py-4"
      style={{ animationDelay: `${delay}ms` }}
    >
      <span className="text-xs font-medium uppercase tracking-wide text-muted">{label}</span>
      <span className="font-display text-3xl tabular-nums tracking-tight">
        {value}
        {unit ? <span className="ml-1 text-base font-normal text-muted">{unit}</span> : null}
      </span>
      {caption ? <span className="text-xs text-muted">{caption}</span> : null}
    </div>
  );
}
