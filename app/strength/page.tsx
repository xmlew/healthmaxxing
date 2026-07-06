import { TrendLine } from "@/components/charts/trend-line";
import {
  estimate1RM,
  getExerciseHistory,
  listExercises,
  oneRepMaxSeries,
  type StrengthSetRow,
} from "@/lib/strength";

export const dynamic = "force-dynamic";

const HISTORY_DAYS = 180;
const RECENT_SESSIONS = 4;

type SessionSummary = {
  date: string;
  topWeight: number | null;
  topReps: number | null;
  volume: number;
  bestEstimated1RM: number | null;
};

function summarizeSessions(sets: StrengthSetRow[]): SessionSummary[] {
  const bySession = new Map<string, StrengthSetRow[]>();
  for (const s of sets) {
    const list = bySession.get(s.sessionDate) ?? [];
    list.push(s);
    bySession.set(s.sessionDate, list);
  }
  return [...bySession.entries()]
    .map(([date, rows]) => {
      const top = rows.reduce<StrengthSetRow | null>(
        (best, r) => (r.weight != null && (best == null || r.weight > (best.weight ?? -1)) ? r : best),
        null,
      );
      const volume = rows.reduce((sum, r) => sum + (r.weight ?? 0) * (r.reps ?? 0), 0);
      const best1RM = rows.reduce<number | null>((best, r) => {
        if (r.weight == null || r.reps == null) return best;
        const est = estimate1RM(r.weight, r.reps);
        return best == null || est > best ? est : best;
      }, null);
      return {
        date,
        topWeight: top?.weight ?? null,
        topReps: top?.reps ?? null,
        volume: Math.round(volume),
        bestEstimated1RM: best1RM != null ? Math.round(best1RM * 10) / 10 : null,
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}

function formatDate(date: string) {
  return new Date(`${date}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default async function StrengthPage() {
  const exercises = await listExercises();
  const withHistory = await Promise.all(
    exercises.map(async (exercise) => {
      const sets = await getExerciseHistory(exercise.name, HISTORY_DAYS);
      return { exercise, sets, oneRm: oneRepMaxSeries(sets, "epley") };
    }),
  );
  const active = withHistory.filter((e) => e.sets.length > 0);

  return (
    <div className="flex flex-col gap-8">
      <header>
        <h1 className="font-display text-3xl tracking-tight md:text-4xl">Strength</h1>
        <p className="mt-1 text-sm text-muted">
          Per-exercise history and estimated 1RM (Epley) over the last {HISTORY_DAYS} days.
        </p>
      </header>

      {active.length === 0 ? (
        <div className="rounded-3xl border border-border bg-surface p-8 text-center text-sm text-muted">
          No strength sets logged yet. Log sets with the <code>log_set</code> MCP tool (e.g. from
          Claude), or import an Apple Health &ldquo;Traditional Strength Training&rdquo; workout.
        </div>
      ) : (
        active.map(({ exercise, sets, oneRm }) => {
          const sessions = summarizeSessions(sets);
          const current = oneRm.length > 0 ? oneRm[oneRm.length - 1].oneRepMax : null;
          const best = oneRm.reduce((m, p) => Math.max(m, p.oneRepMax), 0);
          return (
            <section key={exercise.id} className="rounded-3xl border border-border bg-surface p-6">
              <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
                <div>
                  <h2 className="font-display text-xl capitalize">{exercise.name}</h2>
                  {exercise.muscleGroup ? (
                    <p className="text-xs uppercase tracking-wide text-muted">{exercise.muscleGroup}</p>
                  ) : null}
                </div>
                {current != null ? (
                  <div className="text-right">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted">Est. 1RM</p>
                    <p className="font-display text-2xl tabular-nums tracking-tight text-accent">
                      {current}
                      <span className="ml-1 text-sm font-normal text-muted">kg</span>
                    </p>
                    {best > current ? <p className="text-xs text-muted">best {best} kg</p> : null}
                  </div>
                ) : null}
              </div>

              {oneRm.length >= 2 ? (
                <TrendLine
                  data={oneRm.map((p) => ({ date: `${p.date}T12:00:00`, value: p.oneRepMax }))}
                  unit="kg"
                />
              ) : (
                <p className="py-6 text-center text-sm text-muted">
                  Log another session to see a 1RM trend.
                </p>
              )}

              <div className="mt-4">
                <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
                  Recent sessions
                </h3>
                <ul className="flex flex-col divide-y divide-border">
                  {sessions.slice(0, RECENT_SESSIONS).map((s) => (
                    <li key={s.date} className="flex items-center justify-between gap-3 py-2 text-sm">
                      <span className="text-muted">{formatDate(s.date)}</span>
                      <span className="tabular-nums">
                        {s.topWeight != null ? `${s.topWeight} kg` : "-"}
                        {s.topReps != null ? ` x ${s.topReps}` : ""}
                        <span className="ml-3 text-muted">{s.volume.toLocaleString("en-US")} vol</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          );
        })
      )}
    </div>
  );
}
