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

export function GoalIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="4.25" />
      <circle cx="12" cy="12" r="0.75" fill="currentColor" stroke="none" />
    </svg>
  );
}
