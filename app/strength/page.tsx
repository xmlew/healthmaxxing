import { TrendLine } from "@/components/charts/trend-line";
import {
  computeOverloadStatus,
  getExerciseHistory,
  listExercises,
  oneRepMaxSeries,
  type StrengthSetRow,
} from "@/lib/strength";
import { SetForm } from "./set-form";
import { removeSet } from "./actions";

export const dynamic = "force-dynamic";

const HISTORY_DAYS = 180;
const RECENT_SESSIONS = 4;

type SessionSummary = {
  date: string;
  volume: number;
  sets: StrengthSetRow[];
};

function summarizeSessions(sets: StrengthSetRow[]): SessionSummary[] {
  const bySession = new Map<string, StrengthSetRow[]>();
  for (const s of sets) {
    const list = bySession.get(s.sessionDate) ?? [];
    list.push(s);
    bySession.set(s.sessionDate, list);
  }
  return [...bySession.entries()]
    .map(([date, rows]) => ({
      date,
      volume: Math.round(rows.reduce((sum, r) => sum + (r.weight ?? 0) * (r.reps ?? 0), 0)),
      sets: rows,
    }))
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
      return {
        exercise,
        sets,
        oneRm: oneRepMaxSeries(sets, "epley"),
        overload: computeOverloadStatus(exercise.name, exercise.muscleGroup, sets),
      };
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

      <div className="rounded-3xl border border-border bg-surface p-6">
        <h2 className="mb-4 font-display text-xl">Log a set</h2>
        <SetForm />
      </div>

      {active.length === 0 ? (
        <div className="rounded-3xl border border-border bg-surface p-8 text-center text-sm text-muted">
          No strength sets logged yet. Use the form above, the <code>log_set</code> MCP tool (e.g.
          from Claude), or import an Apple Health &ldquo;Traditional Strength Training&rdquo; workout.
        </div>
      ) : (
        active.map(({ exercise, sets, oneRm, overload }) => {
          const sessions = summarizeSessions(sets);
          const current = oneRm.length > 0 ? oneRm[oneRm.length - 1].oneRepMax : null;
          const best = oneRm.reduce((m, p) => Math.max(m, p.oneRepMax), 0);
          return (
            <section key={exercise.id} className="rounded-3xl border border-border bg-surface p-6">
              <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="font-display text-xl capitalize">{exercise.name}</h2>
                    {overload.stalled ? (
                      <span className="rounded-full border border-warn/40 bg-warn/10 px-2 py-0.5 text-[11px] font-medium text-warn">
                        Stalled
                      </span>
                    ) : null}
                  </div>
                  {exercise.muscleGroup ? (
                    <p className="text-xs uppercase tracking-wide text-muted">{exercise.muscleGroup}</p>
                  ) : null}
                  {overload.stalled ? (
                    <p className="mt-1 text-xs text-warn">
                      No best-set PR in {overload.sessionsSinceImprovement} sessions.
                    </p>
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
                <div className="flex flex-col gap-3">
                  {sessions.slice(0, RECENT_SESSIONS).map((s) => (
                    <div key={s.date}>
                      <div className="flex items-baseline justify-between text-xs text-muted">
                        <span>{formatDate(s.date)}</span>
                        <span className="tabular-nums">{s.volume.toLocaleString("en-US")} vol</span>
                      </div>
                      <ul className="mt-1 flex flex-col divide-y divide-border">
                        {s.sets.map((set) => (
                          <li key={set.setId} className="flex items-center justify-between gap-3 py-1.5 text-sm">
                            <span className="tabular-nums">
                              {set.weight != null ? `${set.weight} kg` : "-"}
                              {set.reps != null ? ` x ${set.reps}` : ""}
                              {set.rpe != null ? <span className="ml-2 text-muted">RPE {set.rpe}</span> : null}
                            </span>
                            <form action={removeSet.bind(null, String(set.setId))}>
                              <button
                                type="submit"
                                aria-label="Delete set"
                                className="rounded-full px-2 py-0.5 text-xs text-muted transition-colors hover:text-warn"
                              >
                                Remove
                              </button>
                            </form>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          );
        })
      )}
    </div>
  );
}
