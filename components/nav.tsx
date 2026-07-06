"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { GoalIcon, HomeIcon, LogIcon, RecoveryIcon, TrendIcon, WorkoutIcon } from "./icons";

const ITEMS = [
  { href: "/", label: "Home", Icon: HomeIcon },
  { href: "/trends", label: "Trends", Icon: TrendIcon },
  { href: "/recovery", label: "Recovery", Icon: RecoveryIcon },
  { href: "/log", label: "Log", Icon: LogIcon },
  { href: "/workouts", label: "Workouts", Icon: WorkoutIcon },
  { href: "/goals", label: "Goal", Icon: GoalIcon },
] as const;

function activeIndex(pathname: string) {
  const index = ITEMS.findIndex((item) =>
    item.href === "/" ? pathname === "/" : pathname.startsWith(item.href)
  );
  return index === -1 ? 0 : index;
}

export function BottomNav() {
  const pathname = usePathname();
  const index = activeIndex(pathname);

  return (
    <nav className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-background/95 backdrop-blur md:hidden">
      <div className="relative mx-auto grid max-w-lg grid-cols-6 px-2 pb-[calc(env(safe-area-inset-bottom))] pt-1">
        <span
          className="absolute inset-y-1 w-[16.6667%] rounded-2xl bg-surface-raised transition-transform duration-300 ease-out"
          style={{ transform: `translateX(${index * 100}%)` }}
          aria-hidden
        />
        {ITEMS.map((item, i) => {
          const active = i === index;
          return (
            <Link
              key={item.href}
              href={item.href}
              className="relative flex flex-col items-center gap-1 py-2 text-[11px] font-medium"
            >
              <item.Icon
                className={`h-5 w-5 transition-colors ${active ? "text-accent" : "text-muted"}`}
              />
              <span className={active ? "text-foreground" : "text-muted"}>{item.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

export function SideNav() {
  const pathname = usePathname();
  const index = activeIndex(pathname);

  return (
    <nav className="hidden w-56 shrink-0 flex-col gap-1 border-r border-border px-3 py-8 md:flex">
      <div className="mb-8 px-3 font-display text-xl tracking-tight">
        Health<span className="text-accent">Maxxing</span>
      </div>
      {ITEMS.map((item, i) => {
        const active = i === index;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${
              active ? "bg-surface-raised text-foreground" : "text-muted hover:text-foreground"
            }`}
          >
            <item.Icon className={`h-4.5 w-4.5 ${active ? "text-accent" : ""}`} />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
