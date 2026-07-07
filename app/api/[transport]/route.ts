import { createMcpHandler, getPublicOrigin, withMcpAuth } from "mcp-handler";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { timingSafeEqualStr, verifyOAuthAccessToken } from "@/lib/oauth";
import { z } from "zod";
import {
  addFoodLog,
  addWeightLog,
  deleteFoodLog,
  deleteWeightLog,
  getEnergyOutDailyTotals,
  getFoodDailyTotals,
  getGoal,
  getLatestMetric,
  getMacroDailyTotals,
  getLatestWeight,
  getMetricSeries,
  getRecentFoodLogs,
  getRecentWeightLogs,
  getRecentWorkouts,
  getPairingCorrelation,
  getTodayFoodTotal,
  getTodayMetricSum,
  getWeightSeries,
  getWorkoutById,
  upsertGoal,
} from "@/lib/queries";
import { getRecoveryAnalysis } from "@/lib/recovery";
import { getTdeeAnalysis } from "@/lib/tdee";
import { asGoalPhase, evaluatePace, GOAL_PHASES } from "@/lib/goals";
import { evaluateAnomalies } from "@/lib/anomalies";
import { PAIRINGS, type PairingKey } from "@/lib/correlation";
import {
  addSet,
  computeOverloadStatus,
  deleteSet,
  estimate1RM,
  getExerciseHistory,
  listExercises,
  nextSetNumber,
  oneRepMaxSeries,
  resolveManualSession,
  upsertExercise,
  ONE_RM_FORMULAS,
  type StrengthSetRow,
} from "@/lib/strength";
import { dayKeyInZone, kjToKcal, TIME_ZONE } from "@/lib/time";

const PAIRING_KEYS = PAIRINGS.map((p) => p.key) as [PairingKey, ...PairingKey[]];

const round1 = (n: number) => Math.round(n * 10) / 10;
const numOrNull = (v: unknown) => (v == null ? null : Number(v));
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

// goals.starting_date / target_date are `date` columns; mirror the dashboard's
// own normalization (app/goals/page.tsx toDateInputValue) to a YYYY-MM-DD string.
const dateStr = (v: unknown): string | null =>
  v == null ? null : new Date(v as string).toISOString().slice(0, 10);

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

// date omitted -> now; an unparseable string is a hard error rather than a
// silent fallback to "now", which would log data against the wrong day.
function resolveLoggedAt(date?: string): { iso: string } | { error: string } {
  if (date === undefined) return { iso: new Date().toISOString() };
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) {
    return { error: `Invalid date: "${date}". Provide an ISO date or datetime string.` };
  }
  return { iso: d.toISOString() };
}

const TREND_METRICS = {
  steps: { name: "step_count", unit: "steps" },
  sleep: { name: "sleep_analysis", unit: "hr" },
  hrv: { name: "heart_rate_variability", unit: "ms" },
  resting_hr: { name: "resting_heart_rate", unit: "bpm" },
} as const;

const handler = createMcpHandler(
  (server) => {
    server.registerTool(
      "get_today_summary",
      {
        title: "Today's summary",
        description:
          "Today's health snapshot (dashboard home): steps, distance, sleep, resting heart rate, calories in vs. out, current weight, and goal progress. 'Today' is the America/Los_Angeles calendar day. Energy is in kcal.",
      },
      async () => {
        const [steps, activeKj, basalKj, distanceKm, restingHr, sleep, food, weight, goal] =
          await Promise.all([
            getTodayMetricSum("step_count"),
            getTodayMetricSum("active_energy"),
            getTodayMetricSum("basal_energy_burned"),
            getTodayMetricSum("walking_running_distance"),
            getLatestMetric("resting_heart_rate"),
            getLatestMetric("sleep_analysis"),
            getTodayFoodTotal(),
            getLatestWeight(),
            getGoal(),
          ]);

        const caloriesOut = kjToKcal(activeKj + basalKj);
        const caloriesIn = food.calories;
        const weightKg = weight ? Number(weight.weight_kg) : null;
        const startWeight = goal?.starting_weight_kg != null ? Number(goal.starting_weight_kg) : null;
        const targetWeight = goal?.target_weight_kg != null ? Number(goal.target_weight_kg) : null;
        const progress =
          weightKg != null && startWeight != null && targetWeight != null && startWeight !== targetWeight
            ? clamp01((startWeight - weightKg) / (startWeight - targetWeight))
            : null;

        return ok({
          timeZone: TIME_ZONE,
          steps: Math.round(steps),
          distanceKm: round1(distanceKm),
          sleepHours: sleep?.qty != null ? round1(Number(sleep.qty)) : null,
          restingHeartRate: restingHr?.qty != null ? Math.round(Number(restingHr.qty)) : null,
          caloriesIn: Math.round(caloriesIn),
          caloriesOut: Math.round(caloriesOut),
          calorieBalance: Math.round(caloriesIn - caloriesOut),
          weightKg,
          targetWeightKg: targetWeight,
          goalProgressPct: progress != null ? Math.round(progress * 100) : null,
        });
      }
    );

    server.registerTool(
      "get_trends",
      {
        title: "Metric trends",
        description:
          "Daily/sample time series for a metric over N days, for charting or trend analysis. Metrics: steps, sleep, hrv, resting_hr, weight, calories. 'calories' returns in-vs-out per day (kcal). 'weight' includes the goal target for context.",
        inputSchema: {
          metric: z.enum(["steps", "sleep", "hrv", "resting_hr", "weight", "calories"]),
          days: z.number().int().positive().max(365).default(30),
        },
      },
      async ({ metric, days }) => {
        if (metric === "weight") {
          const [series, goal] = await Promise.all([getWeightSeries(days), getGoal()]);
          return ok({
            metric,
            days,
            unit: "kg",
            targetWeightKg: goal?.target_weight_kg != null ? Number(goal.target_weight_kg) : null,
            series: series.map((w) => ({ date: w.date.toISOString(), value: round1(w.weightKg) })),
          });
        }

        if (metric === "calories") {
          const [food, energy] = await Promise.all([
            getFoodDailyTotals(days),
            getEnergyOutDailyTotals(days),
          ]);
          const byDay = new Map<string, { in: number; out: number }>();
          for (const f of food) {
            const key = f.date.toISOString().slice(0, 10);
            byDay.set(key, { in: f.calories, out: byDay.get(key)?.out ?? 0 });
          }
          for (const e of energy) {
            const key = e.date.toISOString().slice(0, 10);
            byDay.set(key, { in: byDay.get(key)?.in ?? 0, out: kjToKcal(e.kj) });
          }
          const series = Array.from(byDay.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([date, v]) => ({ date, caloriesIn: Math.round(v.in), caloriesOut: Math.round(v.out) }));
          return ok({ metric, days, unit: "kcal", series });
        }

        const { name, unit } = TREND_METRICS[metric];
        const series = await getMetricSeries(name, days);
        return ok({
          metric,
          days,
          unit,
          series: series.map((s) => ({ date: s.date.toISOString(), value: round1(s.qty) })),
        });
      }
    );

    server.registerTool(
      "get_goal_status",
      {
        title: "Goal status",
        description:
          "Current goal with its training phase, progress toward it (using the latest logged weight), and a phase-aware pace check. A cut flags loss faster than 0.5-1 kg/week; a bulk flags gain faster than ~0.5% bodyweight/week; recomp/maintenance flag notable drift from stable. kgPerWeek is signed: positive = gaining, negative = losing.",
      },
      async () => {
        const [goal, latestWeight] = await Promise.all([getGoal(), getLatestWeight()]);
        if (!goal) return ok({ goalSet: false, message: "No goal has been set yet." });

        const startingWeight = goal.starting_weight_kg != null ? Number(goal.starting_weight_kg) : null;
        const targetWeight = goal.target_weight_kg != null ? Number(goal.target_weight_kg) : null;
        const latest = latestWeight ? Number(latestWeight.weight_kg) : null;
        const phase = asGoalPhase(goal.phase);
        const progress =
          latest != null && startingWeight != null && targetWeight != null && startingWeight !== targetWeight
            ? clamp01((startingWeight - latest) / (startingWeight - targetWeight))
            : null;

        const pace = evaluatePace({
          phase,
          startingWeightKg: startingWeight,
          targetWeightKg: targetWeight,
          startingDate: goal.starting_date,
          targetDate: goal.target_date,
        });

        return ok({
          goalSet: true,
          phase,
          startingWeightKg: startingWeight,
          startingDate: dateStr(goal.starting_date),
          targetWeightKg: targetWeight,
          targetDate: dateStr(goal.target_date),
          dailyCalorieTarget: goal.daily_calorie_target != null ? Number(goal.daily_calorie_target) : null,
          dailyProteinTarget: goal.daily_protein_target != null ? Number(goal.daily_protein_target) : null,
          latestWeightKg: latest,
          progressPct: progress != null ? Math.round(progress * 100) : null,
          paceStatus: pace.status,
          kgPerWeek: pace.kgPerWeek,
          pctPerWeek: pace.pctPerWeek,
          paceNote: pace.note,
        });
      }
    );

    server.registerTool(
      "list_workouts",
      {
        title: "List workouts",
        description:
          "Recent workouts, most recent first. Optional `type` filters by workout name (case-insensitive substring, e.g. 'run', 'walk'). Energy is in kcal.",
        inputSchema: {
          limit: z.number().int().positive().max(200).default(60),
          type: z.string().optional(),
        },
      },
      async ({ limit, type }) => {
        const rows = await getRecentWorkouts(limit);
        const filtered = type
          ? rows.filter((w) => String(w.name ?? "").toLowerCase().includes(type.toLowerCase()))
          : rows;
        return ok(
          filtered.map((w) => ({
            id: w.id,
            name: w.name,
            location: w.location,
            startTime: w.start_time,
            endTime: w.end_time,
            durationMin: numOrNull(w.duration_min),
            distanceKm: numOrNull(w.distance_km),
            energyKcal: w.active_energy_kj != null ? Math.round(kjToKcal(Number(w.active_energy_kj))) : null,
            avgHeartRate: numOrNull(w.avg_heart_rate),
            maxHeartRate: numOrNull(w.max_heart_rate),
          }))
        );
      }
    );

    server.registerTool(
      "get_workout_detail",
      {
        title: "Workout detail",
        description:
          "Full detail for one workout by id (from list_workouts): duration, distance, active/basal energy in kcal, heart rate, steps, indoor flag. The raw import payload is omitted.",
        inputSchema: { id: z.string() },
      },
      async ({ id }) => {
        const w = await getWorkoutById(id);
        if (!w) return fail(`No workout found with id ${id}.`);
        return ok({
          id: w.id,
          name: w.name,
          location: w.location,
          isIndoor: w.is_indoor,
          startTime: w.start_time,
          endTime: w.end_time,
          durationMin: numOrNull(w.duration_min),
          distanceKm: numOrNull(w.distance_km),
          activeEnergyKcal: w.active_energy_kj != null ? Math.round(kjToKcal(Number(w.active_energy_kj))) : null,
          basalEnergyKcal: w.basal_energy_kj != null ? Math.round(kjToKcal(Number(w.basal_energy_kj))) : null,
          avgHeartRate: numOrNull(w.avg_heart_rate),
          maxHeartRate: numOrNull(w.max_heart_rate),
          stepCount: numOrNull(w.step_count),
        });
      }
    );

    server.registerTool(
      "get_recent_logs",
      {
        title: "Recent manual logs",
        description:
          "Recent manual weight or food entries, most recent first. Returns each entry's id, which is required to delete it.",
        inputSchema: {
          kind: z.enum(["weight", "food"]),
          limit: z.number().int().positive().max(100).default(8),
        },
      },
      async ({ kind, limit }) => {
        if (kind === "weight") {
          const rows = await getRecentWeightLogs(limit);
          return ok(
            rows.map((r) => ({
              id: String(r.id),
              loggedAt: r.logged_at,
              weightKg: numOrNull(r.weight_kg),
              bodyFatPct: numOrNull(r.body_fat_pct),
              skeletalMuscleMassKg: numOrNull(r.skeletal_muscle_mass_kg),
              waistCm: numOrNull(r.waist_cm),
              note: r.note,
            }))
          );
        }
        const rows = await getRecentFoodLogs(limit);
        return ok(
          rows.map((r) => ({
            id: String(r.id),
            loggedAt: r.logged_at,
            description: r.description,
            calories: numOrNull(r.calories),
            proteinG: numOrNull(r.protein_g),
            carbsG: numOrNull(r.carbs_g),
            fatG: numOrNull(r.fat_g),
            meal: r.meal,
          }))
        );
      }
    );

    server.registerTool(
      "log_weight",
      {
        title: "Log weight",
        description:
          "Record a manual weight / body-composition entry. `kg` required; `body_fat_pct`, `skeletal_muscle_mass_kg`, and `waist_cm` are optional (a smart-scale reading logs them together). `date` (ISO string) defaults to now. Re-logging the same timestamp updates that entry.",
        inputSchema: {
          kg: z.number().finite().positive().max(500),
          date: z.string().optional(),
          body_fat_pct: z.number().finite().nonnegative().max(100).optional(),
          skeletal_muscle_mass_kg: z.number().finite().nonnegative().max(500).optional(),
          waist_cm: z.number().finite().positive().max(500).optional(),
          note: z.string().optional(),
        },
      },
      async ({ kg, date, body_fat_pct, skeletal_muscle_mass_kg, waist_cm, note }) => {
        const at = resolveLoggedAt(date);
        if ("error" in at) return fail(at.error);
        await addWeightLog({
          loggedAt: at.iso,
          weightKg: kg,
          bodyFatPct: body_fat_pct ?? null,
          skeletalMuscleMassKg: skeletal_muscle_mass_kg ?? null,
          waistCm: waist_cm ?? null,
          note: note ?? null,
        });
        return ok({
          ok: true,
          loggedAt: at.iso,
          weightKg: kg,
          bodyFatPct: body_fat_pct ?? null,
          skeletalMuscleMassKg: skeletal_muscle_mass_kg ?? null,
          waistCm: waist_cm ?? null,
          note: note ?? null,
        });
      }
    );

    server.registerTool(
      "log_food",
      {
        title: "Log food",
        description:
          "Record a manual food entry. `calories` required; `protein_g`, `carbs_g`, `fat_g`, `meal` optional. `date` (ISO string) defaults to now.",
        inputSchema: {
          description: z.string().min(1),
          calories: z.number().finite().nonnegative(),
          date: z.string().optional(),
          protein_g: z.number().finite().nonnegative().optional(),
          carbs_g: z.number().finite().nonnegative().optional(),
          fat_g: z.number().finite().nonnegative().optional(),
          meal: z.string().optional(),
        },
      },
      async ({ description, calories, date, protein_g, carbs_g, fat_g, meal }) => {
        const at = resolveLoggedAt(date);
        if ("error" in at) return fail(at.error);
        await addFoodLog({
          loggedAt: at.iso,
          description: description.trim(),
          calories,
          proteinG: protein_g ?? null,
          carbsG: carbs_g ?? null,
          fatG: fat_g ?? null,
          meal: meal ?? null,
        });
        return ok({ ok: true, loggedAt: at.iso, description: description.trim(), calories });
      }
    );

    server.registerTool(
      "set_goal",
      {
        title: "Set goal",
        description:
          "Update the goal. Only the fields you provide change; omitted fields keep their current values. Dates are YYYY-MM-DD. `phase` is the training phase (cut/bulk/recomp/maintenance) and drives the pace check's direction.",
        inputSchema: {
          startingWeightKg: z.number().finite().positive().optional(),
          startingDate: z.string().optional(),
          targetWeightKg: z.number().finite().positive().optional(),
          targetDate: z.string().optional(),
          dailyCalorieTarget: z.number().finite().nonnegative().optional(),
          dailyProteinTarget: z.number().finite().nonnegative().optional(),
          phase: z.enum(GOAL_PHASES).optional(),
        },
      },
      async (input) => {
        for (const [key, value] of [
          ["startingDate", input.startingDate],
          ["targetDate", input.targetDate],
        ] as const) {
          if (value !== undefined && Number.isNaN(new Date(value).getTime())) {
            return fail(`Invalid ${key}: "${value}". Use a YYYY-MM-DD date.`);
          }
        }

        // Merge onto the existing single-row goal so a partial update doesn't
        // null out fields the caller didn't mention (upsertGoal overwrites all).
        const existing = await getGoal();
        const merged = {
          startingWeightKg:
            input.startingWeightKg ?? (existing?.starting_weight_kg != null ? Number(existing.starting_weight_kg) : null),
          startingDate: input.startingDate ?? dateStr(existing?.starting_date),
          targetWeightKg:
            input.targetWeightKg ?? (existing?.target_weight_kg != null ? Number(existing.target_weight_kg) : null),
          targetDate: input.targetDate ?? dateStr(existing?.target_date),
          dailyCalorieTarget:
            input.dailyCalorieTarget ??
            (existing?.daily_calorie_target != null ? Number(existing.daily_calorie_target) : null),
          dailyProteinTarget:
            input.dailyProteinTarget ??
            (existing?.daily_protein_target != null ? Number(existing.daily_protein_target) : null),
          phase: input.phase ?? asGoalPhase(existing?.phase),
        };
        await upsertGoal(merged);
        return ok({ ok: true, goal: merged });
      }
    );

    server.registerTool(
      "get_recovery",
      {
        title: "Recovery vs training load",
        description:
          "Recovery analysis over N days (dashboard /recovery): resting heart rate and HRV overlaid on daily training load, plus an overtraining flag comparing recent days against an earlier baseline. Also returns weekly strength volume per muscle group (muscleGroupVolume) and an overreaching list flagging muscle groups whose volume has stayed above baseline for 2+ weeks while HRV trends down. Load energy is in kcal. Use to judge whether recent training is outpacing recovery.",
        inputSchema: {
          days: z.number().int().positive().max(365).default(30),
        },
      },
      async ({ days }) => ok(await getRecoveryAnalysis(days)),
    );

    server.registerTool(
      "get_tdee",
      {
        title: "TDEE vs logged intake",
        description:
          "Total daily energy expenditure vs logged calories over N days (dashboard /tdee). Returns per-day TDEE/intake/net, a rolling-window average, cumulative net balance, and implied weight change (kcal and kg). Days missing basal energy are flagged. Use for self-correcting the calorie goal against measured burn.",
        inputSchema: {
          days: z.number().int().positive().max(365).default(30),
          rollingWindow: z.number().int().positive().max(90).optional(),
        },
      },
      async ({ days, rollingWindow }) =>
        ok(await getTdeeAnalysis(days, rollingWindow)),
    );

    server.registerTool(
      "get_correlation",
      {
        title: "Metric correlation",
        description:
          "Pearson correlation for one curated daily-series pairing over N days (dashboard /correlations). Pairings: 'sleep-vs-next-day-rhr' (sleep against the following day's resting HR) and 'steps-vs-weight-loss-rate' (daily steps against weight-loss rate). Returns r, the paired-point count n, and a status ('ok', 'insufficient-data' when n is too low to be meaningful, or 'zero-variance'). Correlation is not causation.",
        inputSchema: {
          pairing: z.enum(PAIRING_KEYS),
          days: z.number().int().positive().max(365).default(90),
        },
      },
      async ({ pairing, days }) => ok(await getPairingCorrelation(pairing, days)),
    );

    server.registerTool(
      "get_anomalies",
      {
        title: "Anomaly signals",
        description:
          "Evaluates each health anomaly signal against its trailing 30-day baseline (dashboard home banner). Returns every signal with its status ('flagged', 'within_baseline', 'insufficient_data', or 'degenerate_baseline'); a flagged signal includes current value, baseline mean, and deviation %. Currently covers resting heart rate. Use to proactively surface early illness/overtraining signs.",
      },
      async () => {
        const evaluations = await evaluateAnomalies();
        // deviationPct/thresholdPct are fractions in lib/anomalies.ts; scale to
        // percent for the response, the same way app/page.tsx does at render, so
        // the "deviation %" the tool promises matches the number a human sees.
        return ok(
          evaluations.map((e) => ({
            ...e,
            anomaly: e.anomaly && {
              ...e.anomaly,
              deviationPct: round1(e.anomaly.deviationPct * 100),
              thresholdPct: round1(e.anomaly.thresholdPct * 100),
            },
          })),
        );
      },
    );

    server.registerTool(
      "get_macro_summary",
      {
        title: "Macro summary",
        description:
          "Daily protein/carbs/fat/calorie totals from logged food over N days, plus the goal's daily protein and calorie targets. For each day, proteinMet is whether that day reached the protein target. Protein is the macro that matters most for muscle building.",
        inputSchema: {
          days: z.number().int().positive().max(365).default(7),
        },
      },
      async ({ days }) => {
        const [daily, goal] = await Promise.all([getMacroDailyTotals(days), getGoal()]);
        const proteinTarget = goal?.daily_protein_target != null ? Number(goal.daily_protein_target) : null;
        const calorieTarget = goal?.daily_calorie_target != null ? Number(goal.daily_calorie_target) : null;
        return ok({
          days,
          proteinTargetG: proteinTarget,
          calorieTarget,
          series: daily.map((d) => ({
            date: d.date.toISOString().slice(0, 10),
            calories: Math.round(d.calories),
            proteinG: d.proteinG != null ? round1(d.proteinG) : null,
            carbsG: d.carbsG != null ? round1(d.carbsG) : null,
            fatG: d.fatG != null ? round1(d.fatG) : null,
            proteinMet: proteinTarget != null && d.proteinG != null ? d.proteinG >= proteinTarget : null,
          })),
        });
      }
    );

    server.registerTool(
      "log_set",
      {
        title: "Log a strength set",
        description:
          "Record one working set of a strength exercise. `exercise` and `reps` required; `weight` in kg (0 for bodyweight), `rpe`/`rir` optional. `muscle_group` (e.g. push/pull/legs or a specific muscle) is stored on the exercise the first time you name it. `set_number` auto-increments within the day's session if omitted. `date` (ISO) defaults to now; all sets on one calendar day share one session.",
        inputSchema: {
          exercise: z.string().min(1),
          reps: z.number().int().positive(),
          weight: z.number().finite().nonnegative().default(0),
          rpe: z.number().finite().min(0).max(10).optional(),
          rir: z.number().finite().min(0).max(10).optional(),
          muscle_group: z.string().optional(),
          set_number: z.number().int().positive().optional(),
          date: z.string().optional(),
        },
      },
      async ({ exercise, reps, weight, rpe, rir, muscle_group, set_number, date }) => {
        const at = resolveLoggedAt(date);
        if ("error" in at) return fail(at.error);
        const sessionDate = dayKeyInZone(new Date(at.iso));
        const exerciseId = await upsertExercise({ name: exercise.trim(), muscleGroup: muscle_group ?? null });
        const sessionId = await resolveManualSession(sessionDate);
        const setNumber = set_number ?? (await nextSetNumber(sessionId, exerciseId));
        const setId = await addSet({
          sessionId,
          exerciseId,
          setNumber,
          weight,
          reps,
          rpe: rpe ?? null,
          rir: rir ?? null,
        });
        return ok({
          ok: true,
          setId,
          sessionId,
          sessionDate,
          exercise: exercise.trim(),
          setNumber,
          weight,
          reps,
          estimated1RM: round1(estimate1RM(weight, reps)),
        });
      }
    );

    server.registerTool(
      "get_exercise_history",
      {
        title: "Exercise history",
        description:
          "Sets for one exercise over N days, grouped by session, with each set's `setId` (required to delete it via delete_set), estimated 1RM, per-session total volume (sum of weight x reps), and each session's best estimated 1RM. `formula` selects the 1RM estimator (epley or brzycki).",
        inputSchema: {
          exercise: z.string().min(1),
          days: z.number().int().positive().max(365).default(90),
          formula: z.enum(ONE_RM_FORMULAS).default("epley"),
        },
      },
      async ({ exercise, days, formula }) => {
        const sets = await getExerciseHistory(exercise, days);
        if (sets.length === 0) {
          return ok({ exercise, days, formula, sessions: [], message: "No sets logged for this exercise in range." });
        }
        const bySession = new Map<string, StrengthSetRow[]>();
        for (const s of sets) {
          const list = bySession.get(s.sessionDate) ?? [];
          list.push(s);
          bySession.set(s.sessionDate, list);
        }
        const sessions = [...bySession.entries()].map(([date, rows]) => {
          const setsOut = rows.map((r) => ({
            setId: r.setId,
            setNumber: r.setNumber,
            weight: r.weight,
            reps: r.reps,
            rpe: r.rpe,
            rir: r.rir,
            estimated1RM:
              r.weight != null && r.reps != null ? round1(estimate1RM(r.weight, r.reps, formula)) : null,
          }));
          const volume = rows.reduce((sum, r) => sum + (r.weight ?? 0) * (r.reps ?? 0), 0);
          const bestEstimated1RM = setsOut.reduce<number | null>(
            (best, s) => (s.estimated1RM != null && (best == null || s.estimated1RM > best) ? s.estimated1RM : best),
            null,
          );
          return { date, muscleGroup: rows[0].muscleGroup, sets: setsOut, volume: Math.round(volume), bestEstimated1RM };
        });
        return ok({ exercise, days, formula, sessions });
      }
    );

    server.registerTool(
      "get_1rm_estimate",
      {
        title: "Estimated 1RM",
        description:
          "Estimated one-rep max for an exercise: the current (most recent session's best) and all-time best over N days, plus a per-session series for charting. `formula` is epley or brzycki.",
        inputSchema: {
          exercise: z.string().min(1),
          days: z.number().int().positive().max(365).default(365),
          formula: z.enum(ONE_RM_FORMULAS).default("epley"),
        },
      },
      async ({ exercise, days, formula }) => {
        const sets = await getExerciseHistory(exercise, days);
        const series = oneRepMaxSeries(sets, formula);
        if (series.length === 0) {
          return ok({ exercise, days, formula, current: null, best: null, series: [], message: "No sets logged for this exercise in range." });
        }
        const best = series.reduce((m, p) => Math.max(m, p.oneRepMax), 0);
        return ok({ exercise, days, formula, current: series[series.length - 1].oneRepMax, best, series });
      }
    );

    server.registerTool(
      "get_progressive_overload_status",
      {
        title: "Progressive overload status",
        description:
          "Whether an exercise is still progressing or has stalled. For each exercise: per-session total volume and best-set volume (heaviest set's weight x reps), sessions since the last best-set-volume PR, and a stall flag (no new best-set PR in 3+ sessions). Omit `exercise` to get every exercise's status plus the list of stalled ones. This is the real muscle-building signal, not just weight going up.",
        inputSchema: {
          exercise: z.string().optional(),
          days: z.number().int().positive().max(365).default(180),
        },
      },
      async ({ exercise, days }) => {
        if (exercise) {
          const sets = await getExerciseHistory(exercise, days);
          if (sets.length === 0) {
            return ok({ exercise, days, message: "No sets logged for this exercise in range." });
          }
          return ok({ days, ...computeOverloadStatus(exercise, sets[0].muscleGroup, sets) });
        }
        const exercises = await listExercises();
        const statuses = (
          await Promise.all(
            exercises.map(async (ex) => {
              const sets = await getExerciseHistory(ex.name, days);
              return sets.length > 0 ? computeOverloadStatus(ex.name, ex.muscleGroup, sets) : null;
            }),
          )
        ).filter((s): s is NonNullable<typeof s> => s != null);
        return ok({
          days,
          exercises: statuses.map((s) => ({
            exercise: s.exercise,
            muscleGroup: s.muscleGroup,
            latestSessionVolume: s.latestSessionVolume,
            bestSetVolumeAllTime: s.bestSetVolumeAllTime,
            sessionsSinceImprovement: s.sessionsSinceImprovement,
            stalled: s.stalled,
          })),
          stalled: statuses.filter((s) => s.stalled).map((s) => s.exercise),
        });
      }
    );

    server.registerTool(
      "list_exercises",
      {
        title: "List exercises",
        description:
          "The strength exercise catalog - every exercise you've logged a set for, with its muscle group and default unit. Use to discover exercise names for get_exercise_history / get_1rm_estimate.",
      },
      async () => ok(await listExercises()),
    );

    server.registerTool(
      "delete_weight_log",
      {
        title: "Delete weight log",
        description: "Delete a manual weight entry by id (from get_recent_logs).",
        inputSchema: { id: z.string() },
      },
      async ({ id }) => {
        const removed = await deleteWeightLog(id);
        return removed ? ok({ ok: true, deletedId: id }) : fail(`No weight log found with id ${id}.`);
      }
    );

    server.registerTool(
      "delete_food_log",
      {
        title: "Delete food log",
        description: "Delete a manual food entry by id (from get_recent_logs).",
        inputSchema: { id: z.string() },
      },
      async ({ id }) => {
        const removed = await deleteFoodLog(id);
        return removed ? ok({ ok: true, deletedId: id }) : fail(`No food log found with id ${id}.`);
      }
    );

    server.registerTool(
      "delete_set",
      {
        title: "Delete a strength set",
        description: "Delete a strength set by its `setId` (from get_exercise_history).",
        inputSchema: { id: z.string() },
      },
      async ({ id }) => {
        const removed = await deleteSet(id);
        return removed ? ok({ ok: true, deletedId: id }) : fail(`No strength set found with id ${id}.`);
      }
    );
  },
  {},
  { basePath: "/api" }
);

// Two accepted bearers: the raw MCP_SECRET (programmatic clients, CLI, tests -
// same convention as INGEST_SECRET) and OAuth access tokens issued by this app's
// authorization server for the Claude.ai connector (see lib/oauth.ts). OAuth
// tokens are audience-bound to this server's origin.
const verifyToken = async (req: Request, bearerToken?: string): Promise<AuthInfo | undefined> => {
  if (!bearerToken) return undefined;
  const secret = process.env.MCP_SECRET;
  if (secret && timingSafeEqualStr(bearerToken, secret)) {
    return { token: bearerToken, clientId: "health-maxxing", scopes: [] };
  }
  return verifyOAuthAccessToken(bearerToken, getPublicOrigin(req));
};

const authHandler = withMcpAuth(handler, verifyToken, { required: true });

export { authHandler as GET, authHandler as POST, authHandler as DELETE };
