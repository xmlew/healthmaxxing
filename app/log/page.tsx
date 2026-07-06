import { getRecentFoodLogs, getRecentWeightLogs } from "@/lib/queries";
import { removeFoodLog, removeWeightLog } from "./actions";
import { WeightForm } from "./weight-form";
import { FoodForm } from "./food-form";

export const dynamic = "force-dynamic";

function formatWhen(date: Date) {
  return new Date(date).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default async function LogPage() {
  const [weightLogs, foodLogs] = await Promise.all([getRecentWeightLogs(8), getRecentFoodLogs(8)]);

  return (
    <div className="flex flex-col gap-10">
      <header>
        <h1 className="font-display text-3xl tracking-tight md:text-4xl">Log</h1>
        <p className="mt-1 text-sm text-muted">Track weight and food by hand.</p>
      </header>

      <section className="grid gap-6 md:grid-cols-2">
        <div className="rounded-3xl border border-border bg-surface p-6">
          <h2 className="mb-4 font-display text-xl">Weight</h2>
          <WeightForm />
        </div>
        <div className="rounded-3xl border border-border bg-surface p-6">
          <h2 className="mb-4 font-display text-xl">Food</h2>
          <FoodForm />
        </div>
      </section>

      <section className="grid gap-6 md:grid-cols-2">
        <div>
          <h2 className="mb-3 text-sm font-medium text-muted">Recent weight entries</h2>
          <ul className="flex flex-col divide-y divide-border rounded-3xl border border-border bg-surface">
            {weightLogs.length === 0 ? (
              <li className="px-5 py-4 text-sm text-muted">No entries yet.</li>
            ) : (
              weightLogs.map((log) => (
                <li key={log.id} className="flex items-center justify-between gap-3 px-5 py-3">
                  <div>
                    <p className="tabular-nums">
                      {Number(log.weight_kg).toFixed(1)} kg
                      {log.body_fat_pct != null ? (
                        <span className="ml-2 text-muted">{Number(log.body_fat_pct).toFixed(1)}% BF</span>
                      ) : null}
                      {log.skeletal_muscle_mass_kg != null ? (
                        <span className="ml-2 text-muted">{Number(log.skeletal_muscle_mass_kg).toFixed(1)} kg muscle</span>
                      ) : null}
                      {log.waist_cm != null ? (
                        <span className="ml-2 text-muted">{Number(log.waist_cm).toFixed(1)} cm waist</span>
                      ) : null}
                    </p>
                    <p className="text-xs text-muted">
                      {formatWhen(log.logged_at)}
                      {log.note ? ` · ${log.note}` : ""}
                    </p>
                  </div>
                  <form action={removeWeightLog.bind(null, log.id)}>
                    <button
                      type="submit"
                      aria-label="Delete entry"
                      className="rounded-full px-2 py-1 text-xs text-muted transition-colors hover:text-warn"
                    >
                      Remove
                    </button>
                  </form>
                </li>
              ))
            )}
          </ul>
        </div>

        <div>
          <h2 className="mb-3 text-sm font-medium text-muted">Recent food entries</h2>
          <ul className="flex flex-col divide-y divide-border rounded-3xl border border-border bg-surface">
            {foodLogs.length === 0 ? (
              <li className="px-5 py-4 text-sm text-muted">No entries yet.</li>
            ) : (
              foodLogs.map((log) => (
                <li key={log.id} className="flex items-center justify-between gap-3 px-5 py-3">
                  <div>
                    <p>{log.description}</p>
                    <p className="text-xs text-muted">
                      {formatWhen(log.logged_at)} &middot; {Math.round(Number(log.calories))} kcal
                      {log.protein_g != null ? ` · ${Math.round(Number(log.protein_g))}g protein` : ""}
                      {log.meal ? ` · ${log.meal}` : ""}
                    </p>
                  </div>
                  <form action={removeFoodLog.bind(null, log.id)}>
                    <button
                      type="submit"
                      aria-label="Delete entry"
                      className="rounded-full px-2 py-1 text-xs text-muted transition-colors hover:text-warn"
                    >
                      Remove
                    </button>
                  </form>
                </li>
              ))
            )}
          </ul>
        </div>
      </section>
    </div>
  );
}
