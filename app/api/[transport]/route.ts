import { createMcpHandler, getPublicOrigin, withMcpAuth } from "mcp-handler";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { timingSafeEqualStr, verifyOAuthAccessToken } from "@/lib/oauth";
import { z } from "zod";
import { sql } from "@/lib/db";
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
  addSets,
  computeOverloadStatus,
  deleteSet,
  estimate1RM,
  getExerciseHistory,
  listExercises,
  nextSetNumber,
  oneRepMaxSeries,
  resolveManualSession,
  setSessionNotes,
  upsertExercise,
  ONE_RM_FORMULAS,
  type StrengthSetRow,
} from "@/lib/strength";
import { isWorkingSet, SET_TYPES } from "@/lib/set-types";
import {
  getRoutine,
  getRoutineDay,
  getRoutinePlan,
  getRoutineTargets,
  listRoutineDays,
  setSessionRoutineDay,
  upsertRoutineTarget,
  type RoutineDay,
} from "@/lib/routines";
import {
  createTrainingSession,
  getTrainingSession,
  listTrainingSessions,
  setTrainingSessionDeleted,
  updateTrainingSession,
  type TrainingSession,
} from "@/lib/training";
import type { SegmentInput } from "@/lib/training-segments";
import { SESSION_STATUSES, SPORTS } from "@/lib/sports";
import {
  EQUIPMENT_STATUSES,
  listEquipment,
  resolveUsableEquipment,
  setEquipment,
  type Equipment,
} from "@/lib/equipment";
import { dayKeyInZone, kjToKcal, shiftDayKey, TIME_ZONE } from "@/lib/time";
import { displayLb, displayVolumeLb, kgToLb, lbToKg } from "@/lib/units";

const PAIRING_KEYS = PAIRINGS.map((p) => p.key) as [PairingKey, ...PairingKey[]];

const round1 = (n: number) => Math.round(n * 10) / 10;
const numOrNull = (v: unknown) => (v == null ? null : Number(v));
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

// How far back log_workout looks to decide whether a set beat a previous best.
const PR_LOOKBACK_DAYS = 365;

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

const loggedDateSchema = z.union([
  z.string().date(),
  z.string().datetime({ offset: true, local: true }),
]);

async function resolveLoggedAt(date?: string): Promise<{ iso: string } | { error: string }> {
  if (date === undefined) return { iso: new Date().toISOString() };
  if (!loggedDateSchema.safeParse(date).success) {
    return { error: `Invalid date: "${date}". Provide YYYY-MM-DD or an ISO datetime.` };
  }
  if (/Z$|[+-]\d{2}:?\d{2}$/.test(date)) {
    return { iso: new Date(date).toISOString() };
  }
  // Cast through text: a parameter Postgres infers as `timestamp` is serialized
  // by postgres.js via new Date(), which reads a zoneless string in the host's
  // zone and shifts it before TIME_ZONE is applied.
  const [row] = await sql`
    select ${date}::text::timestamp at time zone ${TIME_ZONE} as logged_at
  `;
  return { iso: row.logged_at.toISOString() };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// Distances are stored in km; swims also read out in metres, the unit a swim
// is actually counted in.
function presentSession(session: TrainingSession) {
  return {
    ...session,
    totalDistanceKm: session.totalDistanceKm != null ? round2(session.totalDistanceKm) : null,
    segments: session.segments.map((seg) => ({
      ...seg,
      distanceKm: seg.distanceKm != null ? round2(seg.distanceKm) : null,
      ...(seg.sport === "swim" && seg.distanceKm != null
        ? { distanceM: Math.round(seg.distanceKm * 1000) }
        : {}),
    })),
  };
}

function presentEquipment(item: Equipment) {
  return {
    ...item,
    usage: {
      ...item.usage,
      distanceKm: round2(item.usage.distanceKm),
      durationMin: Math.round(item.usage.durationMin),
    },
  };
}

const segmentSchema = z
  .object({
    sport: z.enum(SPORTS),
    duration_min: z.number().finite().positive().optional(),
    distance_km: z.number().finite().nonnegative().optional(),
    distance_m: z.number().finite().nonnegative().optional(),
    equipment: z
      .array(z.string().min(1))
      .describe("Equipment names used on this leg (see list_equipment), e.g. the bike on a bike leg.")
      .optional(),
  })
  .refine((s) => s.distance_km === undefined || s.distance_m === undefined, {
    message: "Give distance_km or distance_m, not both.",
  });

type SegmentArg = z.infer<typeof segmentSchema>;

// Completed legs need a duration: it is the one measure every sport has, and a
// completed session without it cannot be compared against anything.
async function resolveSegments(
  segments: SegmentArg[],
  status: "planned" | "completed",
): Promise<{ segments: SegmentInput[] } | { error: string }> {
  if (status === "completed") {
    const missing = segments.findIndex((s) => s.duration_min === undefined);
    if (missing !== -1) return { error: `Segment ${missing + 1} is completed but has no duration_min.` };
  }
  const resolved = await resolveUsableEquipment(segments.flatMap((s) => s.equipment ?? []));
  if ("error" in resolved) return resolved;
  return {
    segments: segments.map((s) => ({
      sport: s.sport,
      durationMin: s.duration_min ?? null,
      distanceKm: s.distance_km ?? (s.distance_m !== undefined ? s.distance_m / 1000 : null),
      equipmentIds: (s.equipment ?? []).map((name) => resolved.ids.get(name.trim().toLowerCase())!),
    })),
  };
}

async function equipmentUsageFor(...sessions: TrainingSession[]) {
  const ids = [
    ...new Set(sessions.flatMap((s) => s.segments.flatMap((seg) => seg.equipment.map((e) => e.id)))),
  ];
  if (ids.length === 0) return [];
  return (await listEquipment({ ids })).map((item) => ({
    name: item.name,
    usage: presentEquipment(item).usage,
  }));
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
          date: z.string().describe("Defaults to now. YYYY-MM-DD means midnight in America/Los_Angeles; datetimes without an offset also use America/Los_Angeles. Include Z or an offset for an exact instant.").optional(),
          body_fat_pct: z.number().finite().nonnegative().max(100).optional(),
          skeletal_muscle_mass_kg: z.number().finite().nonnegative().max(500).optional(),
          waist_cm: z.number().finite().positive().max(500).optional(),
          note: z.string().optional(),
        },
      },
      async ({ kg, date, body_fat_pct, skeletal_muscle_mass_kg, waist_cm, note }) => {
        const at = await resolveLoggedAt(date);
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
          date: z.string().describe("Defaults to now. YYYY-MM-DD means midnight in America/Los_Angeles; datetimes without an offset also use America/Los_Angeles. Include Z or an offset for an exact instant.").optional(),
          protein_g: z.number().finite().nonnegative().optional(),
          carbs_g: z.number().finite().nonnegative().optional(),
          fat_g: z.number().finite().nonnegative().optional(),
          meal: z.string().optional(),
        },
      },
      async ({ description, calories, date, protein_g, carbs_g, fat_g, meal }) => {
        const at = await resolveLoggedAt(date);
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
          "Record one set of a strength exercise. To record a whole session, prefer log_workout - it takes every exercise in a single call. `exercise` and `reps` required; `weight_lb` in pounds (0 for bodyweight), `rpe`/`rir` optional. `type` marks the set's role: only 'working' sets count toward 1RM estimates, PRs, and volume - use 'warmup', 'dropset', or 'burnout' so they are recorded without distorting progress. `muscle_group` (e.g. push/pull/legs or a specific muscle) is stored on the exercise the first time you name it. `set_number` auto-increments within the day's session if omitted. `date` (ISO) defaults to now; all sets on one calendar day share one session.",
        inputSchema: {
          exercise: z.string().min(1),
          reps: z.number().int().positive(),
          weight_lb: z.number().finite().nonnegative().default(0),
          type: z.enum(SET_TYPES).default("working"),
          rpe: z.number().finite().min(0).max(10).optional(),
          rir: z.number().finite().min(0).max(10).optional(),
          muscle_group: z.string().optional(),
          set_number: z.number().int().positive().optional(),
          date: z.string().describe("Defaults to now. YYYY-MM-DD means midnight in America/Los_Angeles; datetimes without an offset also use America/Los_Angeles. Include Z or an offset for an exact instant.").optional(),
        },
      },
      async ({ exercise, reps, weight_lb, type, rpe, rir, muscle_group, set_number, date }) => {
        const at = await resolveLoggedAt(date);
        if ("error" in at) return fail(at.error);
        const sessionDate = dayKeyInZone(new Date(at.iso));
        const exerciseId = await upsertExercise({ name: exercise.trim(), muscleGroup: muscle_group ?? null });
        const sessionId = await resolveManualSession(sessionDate);
        const setNumber = set_number ?? (await nextSetNumber(sessionId, exerciseId));
        const setId = await addSet({
          sessionId,
          exerciseId,
          setNumber,
          setType: type,
          weightKg: lbToKg(weight_lb),
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
          setType: type,
          weightLb: weight_lb,
          reps,
          estimated1RMLb: type === "working" ? round1(estimate1RM(weight_lb, reps)) : null,
        });
      }
    );

    server.registerTool(
      "get_routine",
      {
        title: "Today's routine",
        description:
          "What to train and what to hit. Returns a routine day's exercises in order with their target sets/reps/weight (pounds), what was actually logged for each one last time, and a per-exercise suggestion: advance the weight when the last session met the target on every working set, otherwise repeat it. Omit `day` to get the next day in the rotation, chosen from what was logged most recently. Omit `routine` to use the current plan. Call this before training, then pass the same `day` to log_workout.",
        inputSchema: {
          day: z.string().optional(),
          routine: z.string().optional(),
        },
      },
      async ({ day, routine }) => {
        const plan = await getRoutinePlan({ routine, day });
        if ("message" in plan) return fail(plan.message);

        return ok({
          routine: plan.routineName,
          day: plan.dayName,
          dayChosenBy: plan.dayWasRequested ? "requested" : "next in rotation",
          lastTrained: plan.lastTrained,
          exercises: plan.exercises.map((e) => ({
            exercise: e.exerciseName,
            muscleGroup: e.muscleGroup,
            targetSets: e.targetSets,
            targetReps: e.targetReps,
            targetWeightLb: e.targetWeightKg != null ? displayLb(e.targetWeightKg) : null,
            notes: e.notes,
            lastSession: e.last
              ? {
                  date: e.last.date,
                  sets: e.last.sets.map((s) => ({
                    setNumber: s.setNumber,
                    setType: s.setType,
                    weightLb: s.weightKg != null ? displayLb(s.weightKg) : null,
                    reps: s.reps,
                  })),
                }
              : null,
            suggestion: e.progression,
          })),
        });
      }
    );

    server.registerTool(
      "set_routine_target",
      {
        title: "Update a routine target",
        description:
          "Change what an exercise in a routine day aims for - the weight after a successful progression, a different rep target, or a note. Weights are pounds. Only the fields you pass change; the rest keep their stored values. Adds the exercise to the day if it is not already in it.",
        inputSchema: {
          day: z.string().min(1),
          exercise: z.string().min(1),
          target_sets: z.number().int().positive().optional(),
          target_reps: z.number().int().positive().optional(),
          target_weight_lb: z.number().finite().nonnegative().optional(),
          notes: z.string().optional(),
          routine: z.string().optional(),
        },
      },
      async ({ day, exercise, target_sets, target_reps, target_weight_lb, notes, routine }) => {
        const found = await getRoutine(routine);
        if (!found) return fail("No routine configured yet.");
        const resolvedDay = await getRoutineDay(found.id, day);
        if (!resolvedDay) {
          const days = await listRoutineDays(found.id);
          return fail(
            `No day "${day}" in routine "${found.name}". Days: ${days.map((d) => d.name).join(", ") || "none"}.`,
          );
        }

        const name = exercise.trim();
        const exerciseId = await upsertExercise({ name });
        await upsertRoutineTarget({
          dayId: resolvedDay.id,
          exerciseId,
          targetSets: target_sets ?? null,
          targetReps: target_reps ?? null,
          targetWeightKg: target_weight_lb != null ? lbToKg(target_weight_lb) : null,
          notes: notes ?? null,
        });

        const updated = (await getRoutineTargets(resolvedDay.id)).find(
          (t) => t.exerciseId === exerciseId,
        );
        return ok({
          ok: true,
          routine: found.name,
          day: resolvedDay.name,
          exercise: name,
          targetSets: updated?.targetSets ?? null,
          targetReps: updated?.targetReps ?? null,
          targetWeightLb:
            updated?.targetWeightKg != null ? displayLb(updated.targetWeightKg) : null,
          notes: updated?.notes ?? null,
        });
      }
    );

    server.registerTool(
      "log_workout",
      {
        title: "Log a whole workout",
        description:
          "Record an entire training session in one call - every exercise, every set. Prefer this over repeated log_set calls: a 5-exercise push day is one call instead of fifteen, and all its sets are written together so a failure cannot leave half a session logged. Weights are pounds (0 for bodyweight). Each set's `type` defaults to 'working'; mark warm-ups, drop sets, and burnouts so they are recorded without distorting PRs or volume. Pass `day` (e.g. push/pull/legs) to tag the session with the routine day you trained - that is what lets get_routine advance the rotation. `date` (ISO) defaults to now; sets join the existing session if that calendar day already has one. Returns per-exercise working volume, top set, estimated 1RM, and whether each beat its previous best.",
        inputSchema: {
          exercises: z
            .array(
              z.object({
                name: z.string().min(1),
                muscle_group: z.string().optional(),
                sets: z
                  .array(
                    z.object({
                      reps: z.number().int().positive(),
                      weight_lb: z.number().finite().nonnegative().default(0),
                      type: z.enum(SET_TYPES).default("working"),
                      rpe: z.number().finite().min(0).max(10).optional(),
                      rir: z.number().finite().min(0).max(10).optional(),
                    }),
                  )
                  .min(1),
              }),
            )
            .min(1),
          day: z.string().optional(),
          routine: z.string().optional(),
          notes: z.string().optional(),
          date: z.string().describe("Defaults to now. YYYY-MM-DD means midnight in America/Los_Angeles; datetimes without an offset also use America/Los_Angeles. Include Z or an offset for an exact instant.").optional(),
        },
      },
      async ({ exercises, day, routine, notes, date }) => {
        const at = await resolveLoggedAt(date);
        if ("error" in at) return fail(at.error);
        const sessionDate = dayKeyInZone(new Date(at.iso));

        // Resolved before writing anything: naming a day that does not exist is
        // a mistake worth reporting, not a session quietly logged untagged.
        let routineDay: RoutineDay | null = null;
        if (day) {
          const found = await getRoutine(routine);
          if (!found) return fail("No routine configured yet, so `day` cannot be resolved.");
          routineDay = await getRoutineDay(found.id, day);
          if (!routineDay) {
            const days = await listRoutineDays(found.id);
            return fail(
              `No day "${day}" in routine "${found.name}". Days: ${days.map((d) => d.name).join(", ") || "none"}.`,
            );
          }
        }

        const sessionId = await resolveManualSession(sessionDate);

        // Resolved before any write so "previous best" means before today, even
        // when this call adds to a session already started earlier in the day.
        const resolved = await Promise.all(
          exercises.map(async (ex) => {
            const name = ex.name.trim();
            const exerciseId = await upsertExercise({
              name,
              muscleGroup: ex.muscle_group ?? null,
            });
            const [history, startNumber] = await Promise.all([
              getExerciseHistory(name, PR_LOOKBACK_DAYS),
              nextSetNumber(sessionId, exerciseId),
            ]);
            // Strictly earlier sessions: sets added later the same day belong to
            // this workout, and a back-dated entry must not be judged against
            // sessions that came after it.
            const priorBest1RMLb = history
              .filter((s) => s.sessionDate < sessionDate)
              .filter(isWorkingSet)
              .reduce<number | null>((best, s) => {
                if (s.weightKg == null || s.reps == null) return best;
                const est = kgToLb(estimate1RM(s.weightKg, s.reps));
                return best == null || est > best ? est : best;
              }, null);
            return { ...ex, name, exerciseId, startNumber, priorBest1RMLb };
          }),
        );

        const setIds = await addSets(
          resolved.flatMap((ex) =>
            ex.sets.map((s, i) => ({
              sessionId,
              exerciseId: ex.exerciseId,
              setNumber: ex.startNumber + i,
              setType: s.type,
              weightKg: lbToKg(s.weight_lb),
              reps: s.reps,
              rpe: s.rpe ?? null,
              rir: s.rir ?? null,
            })),
          ),
        );
        if (notes) await setSessionNotes(sessionId, notes);
        if (routineDay) await setSessionRoutineDay(sessionId, routineDay.id);

        const summary = resolved.map((ex) => {
          const working = ex.sets.filter((s) => s.type === "working");
          const topSet = working.reduce<(typeof working)[number] | null>(
            (best, s) => (best == null || s.weight_lb > best.weight_lb ? s : best),
            null,
          );
          const best1RMLb = working.reduce<number | null>((best, s) => {
            const est = estimate1RM(s.weight_lb, s.reps);
            return best == null || est > best ? est : best;
          }, null);
          return {
            exercise: ex.name,
            setsLogged: ex.sets.length,
            workingVolumeLb: Math.round(
              working.reduce((sum, s) => sum + s.weight_lb * s.reps, 0),
            ),
            topSetLb: topSet?.weight_lb ?? null,
            topSetReps: topSet?.reps ?? null,
            estimated1RMLb: best1RMLb != null ? round1(best1RMLb) : null,
            previousBestEstimated1RMLb:
              ex.priorBest1RMLb != null ? round1(ex.priorBest1RMLb) : null,
            newPr:
              best1RMLb != null && (ex.priorBest1RMLb == null || best1RMLb > ex.priorBest1RMLb),
          };
        });

        return ok({
          ok: true,
          sessionId,
          sessionDate,
          day: routineDay?.name ?? null,
          setsLogged: setIds.length,
          exercises: summary,
        });
      }
    );

    server.registerTool(
      "get_exercise_history",
      {
        title: "Exercise history",
        description:
          "Sets for one exercise over N days, grouped by session, with each set's `setId` (required to delete it via delete_set), `setType`, estimated 1RM, per-session working volume (sum of weight x reps), and each session's best estimated 1RM. All weights and volumes are in pounds. Warm-up, drop, and burnout sets are listed but excluded from volume and 1RM. `formula` selects the 1RM estimator (epley or brzycki).",
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
            setType: r.setType,
            weightLb: r.weightKg != null ? displayLb(r.weightKg) : null,
            reps: r.reps,
            rpe: r.rpe,
            rir: r.rir,
            estimated1RMLb:
              isWorkingSet(r) && r.weightKg != null && r.reps != null
                ? round1(kgToLb(estimate1RM(r.weightKg, r.reps, formula)))
                : null,
          }));
          const volumeKg = rows
            .filter(isWorkingSet)
            .reduce((sum, r) => sum + (r.weightKg ?? 0) * (r.reps ?? 0), 0);
          const bestEstimated1RMLb = setsOut.reduce<number | null>(
            (best, s) =>
              s.estimated1RMLb != null && (best == null || s.estimated1RMLb > best) ? s.estimated1RMLb : best,
            null,
          );
          return {
            date,
            muscleGroup: rows[0].muscleGroup,
            sets: setsOut,
            volumeLb: displayVolumeLb(volumeKg),
            bestEstimated1RMLb,
          };
        });
        return ok({ exercise, days, formula, sessions });
      }
    );

    server.registerTool(
      "get_1rm_estimate",
      {
        title: "Estimated 1RM",
        description:
          "Estimated one-rep max for an exercise, in pounds: the current (most recent session's best) and all-time best over N days, plus a per-session series for charting. `formula` is epley or brzycki.",
        inputSchema: {
          exercise: z.string().min(1),
          days: z.number().int().positive().max(365).default(365),
          formula: z.enum(ONE_RM_FORMULAS).default("epley"),
        },
      },
      async ({ exercise, days, formula }) => {
        const sets = await getExerciseHistory(exercise, days);
        const series = oneRepMaxSeries(sets, formula).map((p) => ({
          date: p.date,
          oneRepMaxLb: displayLb(p.oneRepMax),
        }));
        if (series.length === 0) {
          return ok({ exercise, days, formula, currentLb: null, bestLb: null, series: [], message: "No sets logged for this exercise in range." });
        }
        const bestLb = series.reduce((m, p) => Math.max(m, p.oneRepMaxLb), 0);
        return ok({
          exercise,
          days,
          formula,
          currentLb: series[series.length - 1].oneRepMaxLb,
          bestLb,
          series,
        });
      }
    );

    server.registerTool(
      "get_progressive_overload_status",
      {
        title: "Progressive overload status",
        description:
          "Whether an exercise is still progressing or has stalled. For each exercise: per-session total volume and best-set volume (heaviest set's weight x reps), sessions since the last best-set-volume PR, and a stall flag (no new best-set PR in 3+ sessions). Volumes are in pounds. Omit `exercise` to get every exercise's status plus the list of stalled ones. This is the real muscle-building signal, not just weight going up.",
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
            latestSessionVolumeLb: s.latestSessionVolumeLb,
            bestSetVolumeAllTimeLb: s.bestSetVolumeAllTimeLb,
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
          "The strength exercise catalog - every exercise you've logged a set for, with its muscle group. Use to discover exercise names for get_exercise_history / get_1rm_estimate.",
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

    server.registerTool(
      "log_training_session",
      {
        title: "Log a swim, ride, run, or brick",
        description:
          "Record one endurance session, planned or completed. A single-sport session has one segment; a brick lists its legs in order (e.g. bike then run). Each segment takes the sport, duration_min (required when completed), distance in distance_km or distance_m (swims usually metres), and the equipment used on that leg by name - equipment must already exist and be in hand (see list_equipment / set_equipment). `date` is the calendar day (YYYY-MM-DD, America/Los_Angeles), defaulting to today. `possibleDuplicates` lists other sessions that day with a leg of the same sport - if one is the same effort, delete this one and use update_training_session on that instead. Returns the stored session and the updated usage of every linked item.",
        inputSchema: {
          segments: z.array(segmentSchema).min(1),
          status: z.enum(SESSION_STATUSES).default("completed"),
          date: z.string().date().optional(),
          rpe: z.number().finite().min(0).max(10).optional(),
          notes: z.string().optional(),
        },
      },
      async ({ segments, status, date, rpe, notes }) => {
        const resolved = await resolveSegments(segments, status);
        if ("error" in resolved) return fail(resolved.error);
        const sessionDate = date ?? dayKeyInZone(new Date());
        const sports = new Set(segments.map((s) => s.sport));
        const sameDay = await listTrainingSessions({ from: sessionDate, to: sessionDate });

        const id = await createTrainingSession({
          sessionDate,
          status,
          rpe: rpe ?? null,
          notes: notes ?? null,
          segments: resolved.segments,
        });
        const session = (await getTrainingSession(id))!;
        return ok({
          ok: true,
          session: presentSession(session),
          equipment: await equipmentUsageFor(session),
          possibleDuplicates: sameDay
            .filter((s) => s.segments.some((seg) => sports.has(seg.sport)))
            .map((s) => ({ id: s.id, kind: s.kind, status: s.status })),
        });
      }
    );

    server.registerTool(
      "update_training_session",
      {
        title: "Edit a training session",
        description:
          "Change a session by `id` (from list_training_sessions): mark a planned session completed, fix its date, RPE, or notes, or replace its segments. Fields left out are unchanged; `notes: null` / `rpe: null` clear them. `segments`, when given, replaces the whole ordered list - pass every leg, including the ones not changing. Equipment usage is derived from the sessions, so an edit never double counts. Returns the stored session and the updated usage of every linked item.",
        inputSchema: {
          id: z.number().int().positive(),
          status: z.enum(SESSION_STATUSES).optional(),
          date: z.string().date().optional(),
          rpe: z.number().finite().min(0).max(10).nullable().optional(),
          notes: z.string().nullable().optional(),
          segments: z.array(segmentSchema).min(1).optional(),
        },
      },
      async ({ id, status, date, rpe, notes, segments }) => {
        const current = await getTrainingSession(id);
        if (!current) return fail(`No training session with id ${id}.`);
        const nextStatus = status ?? current.status;

        let resolvedSegments: SegmentInput[] | undefined;
        if (segments) {
          const resolved = await resolveSegments(segments, nextStatus);
          if ("error" in resolved) return fail(resolved.error);
          resolvedSegments = resolved.segments;
        } else if (nextStatus === "completed") {
          const missing = current.segments.findIndex((s) => s.durationMin == null);
          if (missing !== -1) {
            return fail(`Segment ${missing + 1} has no duration; pass segments with duration_min to complete it.`);
          }
        }

        await updateTrainingSession(id, {
          sessionDate: date,
          status,
          rpe,
          notes,
          segments: resolvedSegments,
        });
        const session = (await getTrainingSession(id))!;
        // Gear dropped by the edit is reported too: its usage just went down.
        return ok({
          ok: true,
          session: presentSession(session),
          equipment: await equipmentUsageFor(current, session),
        });
      }
    );

    server.registerTool(
      "delete_training_session",
      {
        title: "Delete a training session",
        description:
          "Move a session to the recycle bin by `id`. It stops counting toward equipment usage immediately and can be brought back with restore_training_session.",
        inputSchema: { id: z.number().int().positive() },
      },
      async ({ id }) => {
        const removed = await setTrainingSessionDeleted(id, true);
        return removed ? ok({ ok: true, deletedId: id }) : fail(`No active training session with id ${id}.`);
      }
    );

    server.registerTool(
      "restore_training_session",
      {
        title: "Restore a deleted training session",
        description:
          "Bring back a session deleted with delete_training_session (find its id with list_training_sessions include_deleted=true).",
        inputSchema: { id: z.number().int().positive() },
      },
      async ({ id }) => {
        const restored = await setTrainingSessionDeleted(id, false);
        if (!restored) return fail(`No deleted training session with id ${id}.`);
        return ok({ ok: true, session: presentSession((await getTrainingSession(id))!) });
      }
    );

    server.registerTool(
      "list_training_sessions",
      {
        title: "List training sessions",
        description:
          "Swim, bike, run, and brick sessions between `from` and `to` (YYYY-MM-DD, inclusive; default the last 28 days through 28 days ahead, so upcoming planned sessions are included), newest first. Each carries its `id`, status (planned/completed), kind, per-leg duration/distance/equipment, and totals. A total is null when any leg lacks that measure. Strength sessions are separate (get_exercise_history).",
        inputSchema: {
          from: z.string().date().optional(),
          to: z.string().date().optional(),
          status: z.enum(SESSION_STATUSES).optional(),
          sport: z.enum(SPORTS).optional().describe("Only sessions with a leg of this sport."),
          include_deleted: z.boolean().default(false),
        },
      },
      async ({ from, to, status, sport, include_deleted }) => {
        const today = dayKeyInZone(new Date());
        const range = { from: from ?? shiftDayKey(today, -28), to: to ?? shiftDayKey(today, 28) };
        const sessions = (
          await listTrainingSessions({ ...range, status, includeDeleted: include_deleted })
        ).filter((s) => !sport || s.segments.some((seg) => seg.sport === sport));
        return ok({ ...range, sessions: sessions.map(presentSession) });
      }
    );

    server.registerTool(
      "set_equipment",
      {
        title: "Add or update equipment",
        description:
          "Create or update a gear item by `name` (case-insensitive). A new item needs a `category` (bike, wetsuit, shoes, helmet, ...). `status` is needed / owned / rented / borrowed / retired - only owned, rented, or borrowed gear can be logged on a session. Fields left out keep their value; null clears an optional field. Cost is not stored here: record what an item cost as an expense linked to it.",
        inputSchema: {
          name: z.string().min(1),
          category: z.string().min(1).optional(),
          status: z.enum(EQUIPMENT_STATUSES).optional(),
          quantity: z.number().int().nonnegative().optional(),
          location: z.string().nullable().optional(),
          acquired_on: z.string().date().nullable().optional(),
          fit_notes: z.string().nullable().optional().describe("Size and fit, e.g. '56cm frame, saddle 72cm'."),
          notes: z.string().nullable().optional(),
        },
      },
      async ({ name, category, status, quantity, location, acquired_on, fit_notes, notes }) => {
        const result = await setEquipment(name.trim(), {
          category,
          status,
          quantity,
          location,
          acquiredOn: acquired_on,
          fitNotes: fit_notes,
          notes,
        });
        if ("error" in result) return fail(result.error);
        const [item] = await listEquipment({ ids: [result.id] });
        return ok({ ok: true, created: result.created, equipment: presentEquipment(item) });
      }
    );

    server.registerTool(
      "list_equipment",
      {
        title: "List equipment",
        description:
          "Every gear item with its status, details, and usage derived from completed, undeleted sessions it was linked to: session count, total distance (km), total duration (min), and last used date. `segmentsWithoutDistance` counts linked legs that recorded no distance, so distanceKm is a floor while it is above zero.",
        inputSchema: {
          status: z.enum(EQUIPMENT_STATUSES).optional(),
          category: z.string().optional(),
        },
      },
      async ({ status, category }) => {
        const items = (await listEquipment()).filter(
          (item) =>
            (!status || item.status === status) &&
            (!category || item.category === category.toLowerCase()),
        );
        return ok({ equipment: items.map(presentEquipment) });
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
