import Link from "next/link";
import { notFound } from "next/navigation";
import { StatTile } from "@/components/stat-tile";
import { getWorkoutById } from "@/lib/queries";
import { kjToKcal } from "@/lib/time";

export const dynamic = "force-dynamic";

function fmt(n: number | null | undefined, digits = 0) {
  if (n == null) return "--";
  return Number(n).toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

export default async function WorkoutDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const workout = await getWorkoutById(id);
  if (!workout) notFound();

  const activeKcal = workout.active_energy_kj != null ? kjToKcal(Number(workout.active_energy_kj)) : null;
  const basalKcal = workout.basal_energy_kj != null ? kjToKcal(Number(workout.basal_energy_kj)) : null;

  return (
    <div className="flex flex-col gap-8">
      <div>
        <Link href="/workouts" className="text-sm text-muted transition-colors hover:text-foreground">
          &larr; Workouts
        </Link>
        <h1 className="mt-2 font-display text-3xl tracking-tight md:text-4xl">{workout.name ?? "Workout"}</h1>
        <p className="mt-1 text-sm text-muted">
          {workout.start_time
            ? new Date(workout.start_time).toLocaleString("en-US", {
                weekday: "long",
                month: "long",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })
            : "--"}
          {workout.location ? ` · ${workout.location}` : ""}
        </p>
      </div>

      <section className="grid grid-cols-2 gap-x-6 divide-y divide-border rounded-3xl border border-border bg-surface px-6 sm:grid-cols-4 sm:divide-y-0">
        <StatTile label="Duration" value={fmt(workout.duration_min)} unit="min" />
        <StatTile label="Distance" value={fmt(workout.distance_km, 2)} unit="km" />
        <StatTile label="Active energy" value={fmt(activeKcal)} unit="kcal" />
        <StatTile label="Basal energy" value={fmt(basalKcal)} unit="kcal" />
        <StatTile label="Avg heart rate" value={fmt(workout.avg_heart_rate)} unit="bpm" />
        <StatTile label="Max heart rate" value={fmt(workout.max_heart_rate)} unit="bpm" />
        <StatTile label="Steps" value={fmt(workout.step_count)} />
        <StatTile label="Indoor" value={workout.is_indoor ? "Yes" : "No"} />
      </section>
    </div>
  );
}
