import Link from "next/link";
import { getRecentWorkouts } from "@/lib/queries";
import { kjToKcal } from "@/lib/time";

export const dynamic = "force-dynamic";

function fmt(n: number | null, digits = 0) {
  if (n == null) return "--";
  return n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

export default async function WorkoutsPage() {
  const workouts = await getRecentWorkouts(60);

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="font-display text-3xl tracking-tight md:text-4xl">Workouts</h1>
        <p className="mt-1 text-sm text-muted">{workouts.length} recorded</p>
      </header>

      <ul className="flex flex-col divide-y divide-border rounded-3xl border border-border bg-surface">
        {workouts.length === 0 ? (
          <li className="px-5 py-6 text-sm text-muted">No workouts imported yet.</li>
        ) : (
          workouts.map((w) => (
            <li key={w.id}>
              <Link
                href={`/workouts/${w.id}`}
                className="flex items-center justify-between gap-4 px-5 py-4 transition-colors hover:bg-surface-raised"
              >
                <div>
                  <p className="font-medium">{w.name ?? "Workout"}</p>
                  <p className="text-xs text-muted">
                    {w.start_time
                      ? new Date(w.start_time).toLocaleString("en-US", {
                          month: "short",
                          day: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                        })
                      : "--"}
                    {w.location ? ` · ${w.location}` : ""}
                  </p>
                </div>
                <div className="text-right text-sm tabular-nums">
                  <p>{fmt(w.duration_min)} min</p>
                  <p className="text-xs text-muted">
                    {w.distance_km != null ? `${fmt(w.distance_km, 1)} km · ` : ""}
                    {w.active_energy_kj != null ? `${fmt(kjToKcal(w.active_energy_kj))} kcal` : ""}
                  </p>
                </div>
              </Link>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
