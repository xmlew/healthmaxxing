type IconProps = { className?: string };

const base = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  viewBox: "0 0 24 24",
};

export function HomeIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M3 11.5 12 4l9 7.5" />
      <path d="M5.5 9.5V20h13V9.5" />
      <path d="M9.5 20v-6h5v6" />
    </svg>
  );
}

export function StrengthIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M4 9v6M7 7v10M17 7v10M20 9v6M7 12h10" />
    </svg>
  );
}

export function TrendIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M4 17 9.5 11l4 3.5L20 6" />
      <path d="M14.5 6H20v5.5" />
    </svg>
  );
}

export function LogIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <circle cx="12" cy="12" r="8.25" />
      <path d="M12 8.5v7M8.5 12h7" />
    </svg>
  );
}

export function WorkoutIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M3 12h3.5l2-5 4 10 2-5H21" />
    </svg>
  );
}

export function RecoveryIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M20.5 8.5c0-2.2-1.7-4-3.9-4-1.5 0-2.8.8-3.5 2-.7-1.2-2-2-3.5-2-2.2 0-3.9 1.8-3.9 4 0 4.2 5.1 7.9 7.4 9.3 2.3-1.4 7.4-5.1 7.4-9.3Z" />
      <path d="M3 12.5h3.2l1.6-3 2.4 6 1.6-3H16" />
    </svg>
  );
}

export function TdeeIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M12 3c1.5 3 4.5 4.5 4.5 8.5A4.5 4.5 0 0 1 12 16a4.5 4.5 0 0 1-4.5-4.5C7.5 9 9 7 12 3Z" />
      <path d="M12 21a3 3 0 0 0 3-3c0-1.8-1.5-2.5-3-4.5-1.5 2-3 2.7-3 4.5a3 3 0 0 0 3 3Z" />
    </svg>
  );
}

export function CorrelationIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M4 4v16h16" />
      <circle cx="8" cy="15" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="11" cy="12" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="14" cy="10" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="17.5" cy="7" r="1.1" fill="currentColor" stroke="none" />
      <path d="M7 16.5 18 6" strokeDasharray="3 2" />
    </svg>
  );
}

export function GoalIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="4.25" />
      <circle cx="12" cy="12" r="0.75" fill="currentColor" stroke="none" />
    </svg>
  );
}
