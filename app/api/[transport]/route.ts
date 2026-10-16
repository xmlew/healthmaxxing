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
  addStockEvent,
  findConsumableIds,
  listConsumables,
  setConsumable,
  type Consumable,
} from "@/lib/fuel";
import { getAttention, setDismissal } from "@/lib/attention";
import {
  BASE_CURRENCY,
  createExpense,
  EXPENSE_CATEGORIES,
  EXPENSE_STATUSES,
  listExpenses,
  setExpenseDeleted,
  summarizeBudget,
  updateExpense,
  type StockLotInput,
} from "@/lib/expenses";
import {
  deleteMaintenanceRule,
  findEquipmentId,
  findRuleId,
  listMaintenance,
  listServiceLogs,
  logService,
  setMaintenanceRule,
  setServiceLogDeleted,
  type MaintenanceRule,
} from "@/lib/maintenance";
import {
  createTrainingSession,
  getTrainingSession,
  listTrainingSessions,
  setTrainingSessionDeleted,
  updateTrainingSession,
  type FuelInput,
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
import {
  applyChecklist,
  CHECKLIST_TEMPLATES,
  findRace,
  getRaceFuelPlan,
  listRaceGear,
  listRaces,
  listRaceTasks,
  removeRaceGear,
  removeRaceTask,
  setRaceFuel,
  setRaceGear,
  setRaceTask,
  raceBudget,
  RACE_FORMATS,
  setRace,
  sportMilestones,
  type Race,
} from "@/lib/races";
import { dayKeyInZone, daysBetween, kjToKcal, shiftDayKey, TIME_ZONE } from "@/lib/time";
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
    carbsPerHour: session.carbsPerHour != null ? Math.round(session.carbsPerHour) : null,
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

const fuelSchema = z
  .array(
    z.object({
      product: z.string().min(1).describe("A consumable's name (see list_consumables)."),
      servings: z.number().finite().positive(),
    }),
  )
  .refine((f) => new Set(f.map((x) => x.product.trim().toLowerCase())).size === f.length, {
    message: "List each product once, with its total servings.",
  })
  .describe(
    "Fuel taken (completed session) or planned (planned session). Only completed sessions draw down stock.",
  );

async function resolveFuel(
  fuel: z.infer<typeof fuelSchema>,
): Promise<{ fuel: FuelInput[] } | { error: string }> {
  const found = await findConsumableIds(fuel.map((f) => f.product));
  if ("error" in found) return found;
  return {
    fuel: fuel.map((f) => ({
      consumableId: found.ids.get(f.product.trim().toLowerCase())!,
      servings: f.servings,
    })),
  };
}

const round1Servings = (n: number) => Math.round(n * 10) / 10;

function presentConsumable(item: Consumable) {
  return {
    ...item,
    onHand: round1Servings(item.onHand),
    plannedNeed: round1Servings(item.plannedNeed),
    raceNeed: round1Servings(item.raceNeed),
    shortfall: round1Servings(item.shortfall),
  };
}

// Stock of every product a session (before and after an edit) touches, so the
// response shows what the change did to the balance.
async function fuelStockFor(...sessions: TrainingSession[]) {
  const names = [...new Set(sessions.flatMap((s) => s.fuel.map((f) => f.name.toLowerCase())))];
  if (names.length === 0) return [];
  const found = await findConsumableIds(names);
  if ("error" in found) return [];
  const items = await listConsumables(dayKeyInZone(new Date()), { ids: [...found.ids.values()] });
  return items.map((item) => {
    const { name, onHand, plannedNeed, shortfall, servingUnit } = presentConsumable(item);
    return { name, onHand, plannedNeed, shortfall, servingUnit };
  });
}

function presentRule(rule: MaintenanceRule) {
  return {
    ...rule,
    kmSince: round2(rule.kmSince),
    hoursSince: Math.round(rule.hoursSince * 10) / 10,
  };
}

function presentRace(race: Race) {
  return {
    ...race,
    swimKm: race.swimKm != null ? round2(race.swimKm) : null,
    bikeKm: race.bikeKm != null ? round2(race.bikeKm) : null,
    runKm: race.runKm != null ? round2(race.runKm) : null,
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
          "Record one endurance session, planned or completed. A single-sport session has one segment; a brick lists its legs in order (e.g. bike then run). Each segment takes the sport, duration_min (required when completed), distance in distance_km or distance_m (swims usually metres), and the equipment used on that leg by name - equipment must already exist and be in hand (see list_equipment / set_equipment). `fuel` lists products by name and servings - taken on a completed session (drawn from stock), planned on a planned one (counted as upcoming need, never deducted). `date` is the calendar day (YYYY-MM-DD, America/Los_Angeles), defaulting to today. Apple Health swims, rides, and runs are imported automatically and attach to a same-day, same-sport session that has no workout yet, so check `possibleDuplicates` in the response and prefer update_training_session to add gear or notes to a session that already exists. Returns the stored session (with carbsPerHour when every fuel line has a carb figure), the updated usage of every linked item, and the stock left of each fuel used.",
        inputSchema: {
          segments: z.array(segmentSchema).min(1),
          fuel: fuelSchema.optional(),
          status: z.enum(SESSION_STATUSES).default("completed"),
          date: z.string().date().optional(),
          rpe: z.number().finite().min(0).max(10).optional(),
          notes: z.string().optional(),
        },
      },
      async ({ segments, fuel, status, date, rpe, notes }) => {
        const resolved = await resolveSegments(segments, status);
        if ("error" in resolved) return fail(resolved.error);
        const resolvedFuel = await resolveFuel(fuel ?? []);
        if ("error" in resolvedFuel) return fail(resolvedFuel.error);
        const sessionDate = date ?? dayKeyInZone(new Date());
        const sports = new Set(segments.map((s) => s.sport));
        const sameDay = await listTrainingSessions({ from: sessionDate, to: sessionDate });

        const id = await createTrainingSession({
          sessionDate,
          status,
          rpe: rpe ?? null,
          notes: notes ?? null,
          segments: resolved.segments,
          fuel: resolvedFuel.fuel,
        });
        const session = (await getTrainingSession(id))!;
        return ok({
          ok: true,
          session: presentSession(session),
          equipment: await equipmentUsageFor(session),
          fuelStock: await fuelStockFor(session),
          possibleDuplicates: sameDay
            .filter((s) => s.segments.some((seg) => sports.has(seg.sport)))
            .map((s) => ({ id: s.id, kind: s.kind, status: s.status, source: s.source })),
        });
      }
    );

    server.registerTool(
      "update_training_session",
      {
        title: "Edit a training session",
        description:
          "Change a session by `id` (from list_training_sessions): mark a planned session completed, fix its date, RPE, or notes, or replace its segments or fuel. Fields left out are unchanged; `notes: null` / `rpe: null` clear them. `segments` and `fuel`, when given, each replace the whole list - pass every leg or product, including the ones not changing (`fuel: []` clears it). Equipment usage and stock are derived from the sessions, so an edit never double counts. Returns the stored session, the updated usage of every linked item, and the stock of every fuel involved.",
        inputSchema: {
          id: z.number().int().positive(),
          status: z.enum(SESSION_STATUSES).optional(),
          date: z.string().date().optional(),
          rpe: z.number().finite().min(0).max(10).nullable().optional(),
          notes: z.string().nullable().optional(),
          segments: z.array(segmentSchema).min(1).optional(),
          fuel: fuelSchema.optional(),
        },
      },
      async ({ id, status, date, rpe, notes, segments, fuel }) => {
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

        let resolvedFuel: FuelInput[] | undefined;
        if (fuel) {
          const found = await resolveFuel(fuel);
          if ("error" in found) return fail(found.error);
          resolvedFuel = found.fuel;
        }

        await updateTrainingSession(id, {
          sessionDate: date,
          status,
          rpe,
          notes,
          segments: resolvedSegments,
          fuel: resolvedFuel,
        });
        const session = (await getTrainingSession(id))!;
        // Gear and fuel dropped by the edit are reported too: their totals moved.
        return ok({
          ok: true,
          session: presentSession(session),
          equipment: await equipmentUsageFor(current, session),
          fuelStock: await fuelStockFor(current, session),
        });
      }
    );

    server.registerTool(
      "delete_training_session",
      {
        title: "Delete a training session",
        description:
          "Move a session to the recycle bin by `id`. It stops counting toward equipment usage and returns its fuel to stock immediately, and can be brought back with restore_deleted.",
        inputSchema: { id: z.number().int().positive() },
      },
      async ({ id }) => {
        const removed = await setTrainingSessionDeleted(id, true);
        return removed ? ok({ ok: true, deletedId: id }) : fail(`No active training session with id ${id}.`);
      }
    );

    server.registerTool(
      "restore_deleted",
      {
        title: "Restore something deleted",
        description:
          "Bring back a record from the recycle bin by `kind` and `id`; it counts again everywhere it did before. training_session: from delete_training_session (find ids with list_training_sessions include_deleted=true). service_log: from delete_service_log. expense: from delete_expense (list_expenses include_deleted=true).",
        inputSchema: {
          kind: z.enum(["training_session", "service_log", "expense"]),
          id: z.number().int().positive(),
        },
      },
      async ({ kind, id }) => {
        if (kind === "expense") {
          const restored = await setExpenseDeleted(id, false);
          if (!restored) return fail(`No deleted expense with id ${id}.`);
          return ok({ ok: true, expense: (await listExpenses({ ids: [id] }))[0] });
        }
        if (kind === "service_log") {
          const restored = await setServiceLogDeleted(id, false);
          return restored ? ok({ ok: true, restoredId: id }) : fail(`No deleted service log with id ${id}.`);
        }
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
          "Swim, bike, run, and brick sessions between `from` and `to` (YYYY-MM-DD, inclusive; default the last 28 days through 28 days ahead, so upcoming planned sessions are included), newest first. Each carries its `id`, status (planned/completed), kind, source (manual, or imported from Apple Health), per-leg duration/distance/equipment, and totals. A total is null when any leg lacks that measure. Strength sessions are separate (get_exercise_history).",
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

    server.registerTool(
      "set_consumable",
      {
        title: "Add or update a fuel product",
        description:
          "Create or update a consumable (gel, drink mix, electrolyte, bar, ...) by `name` (case-insensitive). Stock is counted in servings of `serving_unit` (gel, scoop, tab); nutrition is per serving and optional - give it where the label says, since carbs per hour is computed from it. `low_stock_servings` sets the balance at or below which it is flagged. A new product needs a `kind`. Fields left out keep their value; null clears an optional one. Stock is changed with adjust_stock, not here.",
        inputSchema: {
          name: z.string().min(1),
          kind: z.string().min(1).optional(),
          serving_unit: z.string().min(1).optional(),
          carbs_g: z.number().finite().nonnegative().nullable().optional(),
          sodium_mg: z.number().finite().nonnegative().nullable().optional(),
          caffeine_mg: z.number().finite().nonnegative().nullable().optional(),
          low_stock_servings: z.number().finite().nonnegative().nullable().optional(),
          notes: z.string().nullable().optional(),
        },
      },
      async ({ name, kind, serving_unit, carbs_g, sodium_mg, caffeine_mg, low_stock_servings, notes }) => {
        const result = await setConsumable(name.trim(), {
          kind,
          servingUnit: serving_unit,
          carbsG: carbs_g,
          sodiumMg: sodium_mg,
          caffeineMg: caffeine_mg,
          lowStockServings: low_stock_servings,
          notes,
        });
        if ("error" in result) return fail(result.error);
        const [item] = await listConsumables(dayKeyInZone(new Date()), { ids: [result.id] });
        return ok({ ok: true, created: result.created, consumable: presentConsumable(item) });
      }
    );

    server.registerTool(
      "adjust_stock",
      {
        title: "Adjust fuel stock",
        description:
          "Add or remove servings of a consumable outside of training: a starting count, a gift, a lost or binned bag. Positive `servings` adds a lot (give `expires_on` from the packet so expiry can be tracked); negative removes. Fuel used in a session is recorded on the session (log_training_session `fuel`), not here. Returns the new balance.",
        inputSchema: {
          product: z.string().min(1),
          servings: z.number().finite().refine((n) => n !== 0, "servings cannot be 0"),
          expires_on: z.string().date().optional(),
          date: z.string().date().optional(),
          note: z.string().optional(),
        },
      },
      async ({ product, servings, expires_on, date, note }) => {
        if (expires_on && servings < 0) return fail("expires_on applies only when adding servings.");
        const found = await findConsumableIds([product]);
        if ("error" in found) return fail(found.error);
        const consumableId = [...found.ids.values()][0];
        const today = dayKeyInZone(new Date());
        await addStockEvent({
          consumableId,
          servings,
          occurredOn: date ?? today,
          expiresOn: expires_on ?? null,
          note: note ?? null,
        });
        const [item] = await listConsumables(today, { ids: [consumableId] });
        return ok({ ok: true, consumable: presentConsumable(item) });
      }
    );

    server.registerTool(
      "list_consumables",
      {
        title: "List fuel stock",
        description:
          "Every consumable with its nutrition per serving and its stock: `onHand` (adjustments minus servings on completed sessions), `plannedNeed` (servings on planned sessions from today on, not yet deducted), `raceNeed` (servings in the fueling plans of upcoming races), `shortfall` (both needs beyond what is on hand), and `lowStock` (at or below its low_stock_servings). `expiry` counts servings already expired and expiring within 30 days, assuming the earliest-expiring servings were used first - lot-level use is not recorded. A negative onHand means more was logged as used than was ever stocked: a starting count is missing.",
      },
      async () => {
        const items = await listConsumables(dayKeyInZone(new Date()));
        return ok({ consumables: items.map(presentConsumable) });
      }
    );

    server.registerTool(
      "set_maintenance_rule",
      {
        title: "Add or update a maintenance rule",
        description:
          "Say how often a gear item should be checked or serviced, by `name` per item (e.g. 'chain check' on the bike): every_days, every_km, and/or every_hours of use - whichever comes first. Usage counts completed sessions the item was used on after the last logged service (log_service), or after `starts_on` (default today) until the first one. Updating keeps fields left out; null clears an interval, but at least one must remain. Intervals are yours to set - due means inspection is due, not that the item is unsafe.",
        inputSchema: {
          equipment: z.string().min(1),
          name: z.string().min(1),
          every_days: z.number().int().positive().nullable().optional(),
          every_km: z.number().finite().positive().nullable().optional(),
          every_hours: z.number().finite().positive().nullable().optional(),
          starts_on: z.string().date().optional(),
          notes: z.string().nullable().optional(),
        },
      },
      async ({ equipment, name, every_days, every_km, every_hours, starts_on, notes }) => {
        const equipmentId = await findEquipmentId(equipment);
        if (equipmentId == null) return fail(`No equipment named "${equipment}" (see list_equipment).`);
        const result = await setMaintenanceRule(equipmentId, name, {
          intervalDays: every_days,
          intervalKm: every_km,
          intervalHours: every_hours,
          startsOn: starts_on,
          notes,
        });
        if ("error" in result) return fail(result.error);
        const rule = (await listMaintenance(dayKeyInZone(new Date()), { equipmentId })).find(
          (r) => r.id === result.id,
        );
        return ok({ ok: true, created: result.created, rule: rule ? presentRule(rule) : null });
      }
    );

    server.registerTool(
      "delete_maintenance_rule",
      {
        title: "Delete a maintenance rule",
        description: "Stop tracking a maintenance rule. Services already logged against it are kept.",
        inputSchema: { equipment: z.string().min(1), name: z.string().min(1) },
      },
      async ({ equipment, name }) => {
        const equipmentId = await findEquipmentId(equipment);
        if (equipmentId == null) return fail(`No equipment named "${equipment}".`);
        const ruleId = await findRuleId(equipmentId, name);
        if (ruleId == null) return fail(`No rule "${name}" on ${equipment}.`);
        await deleteMaintenanceRule(ruleId);
        return ok({ ok: true, deleted: { equipment, rule: name } });
      }
    );

    server.registerTool(
      "log_service",
      {
        title: "Log a service or check",
        description:
          "Record that a gear item was serviced or checked on `date` (YYYY-MM-DD, default today). Name the `rule` it satisfies to restart that rule's interval; leave it out for a one-off service. Returns the item's maintenance status afterwards. A service's cost belongs in an expense.",
        inputSchema: {
          equipment: z.string().min(1),
          rule: z.string().min(1).optional(),
          date: z.string().date().optional(),
          notes: z.string().optional(),
        },
      },
      async ({ equipment, rule, date, notes }) => {
        const equipmentId = await findEquipmentId(equipment);
        if (equipmentId == null) return fail(`No equipment named "${equipment}" (see list_equipment).`);
        let ruleId: number | null = null;
        if (rule) {
          ruleId = await findRuleId(equipmentId, rule);
          if (ruleId == null) return fail(`No rule "${rule}" on ${equipment} (see get_maintenance_status).`);
        }
        const today = dayKeyInZone(new Date());
        const id = await logService({ equipmentId, ruleId, performedOn: date ?? today, notes: notes ?? null });
        const rules = await listMaintenance(today, { equipmentId });
        return ok({ ok: true, serviceLogId: id, rules: rules.map(presentRule) });
      }
    );

    server.registerTool(
      "delete_service_log",
      {
        title: "Delete a service log",
        description:
          "Move a mis-logged service to the recycle bin by its id (from get_maintenance_status). Its rule's interval falls back to the previous service; restore_deleted brings it back.",
        inputSchema: { id: z.number().int().positive() },
      },
      async ({ id }) => {
        const removed = await setServiceLogDeleted(id, true);
        return removed ? ok({ ok: true, deletedId: id }) : fail(`No active service log with id ${id}.`);
      }
    );

    server.registerTool(
      "get_maintenance_status",
      {
        title: "Maintenance status",
        description:
          "Every maintenance rule (or one item's, by `equipment`) with its state - ok, approaching (90% of an interval used), or due - and the reasons as used-of-interval for each measure, plus the date usage is counted from. `legsWithoutDistance` counts linked legs with no distance, so kmSince is a floor while it is above zero. Also lists recent services with their ids. Retired gear is skipped.",
        inputSchema: { equipment: z.string().min(1).optional() },
      },
      async ({ equipment }) => {
        let equipmentId: number | undefined;
        if (equipment) {
          const id = await findEquipmentId(equipment);
          if (id == null) return fail(`No equipment named "${equipment}".`);
          equipmentId = id;
        }
        const [rules, services] = await Promise.all([
          listMaintenance(dayKeyInZone(new Date()), { equipmentId }),
          listServiceLogs({ equipmentId, limit: 20 }),
        ]);
        return ok({
          due: rules.filter((r) => r.state === "due").map((r) => `${r.equipment}: ${r.name}`),
          rules: rules.map(presentRule),
          recentServices: services,
        });
      }
    );

    server.registerTool(
      "log_expense",
      {
        title: "Log an expense",
        description:
          "Record money spent (status paid) or committed but not yet spent (planned): race entry, gear, fuel, servicing, travel, rentals. `amount` is in the `currency` actually charged (ISO code, default USD); for any other currency give `usd_per_unit` (USD per 1 unit, e.g. 0.74 for SGD) so it enters USD totals - without it the expense stays listed as unconverted, never guessed. Link what it bought: `equipment` by name (paying for an item whose status is 'needed' marks it owned, or rented for a rental; the item's cost lives only here), or `stock` lots of a consumable (added to stock while the expense is paid). Category defaults from the link (equipment or consumables). A planned expense becomes paid with update_expense, so it is never counted twice.",
        inputSchema: {
          description: z.string().min(1),
          amount: z.number().finite().positive(),
          currency: z.string().regex(/^[A-Za-z]{3}$/).default(BASE_CURRENCY),
          usd_per_unit: z.number().finite().positive().optional(),
          category: z.enum(EXPENSE_CATEGORIES).optional(),
          status: z.enum(EXPENSE_STATUSES).default("paid"),
          date: z.string().date().optional().describe("Paid on, or expected on when planned. Defaults to today."),
          equipment: z.string().min(1).optional(),
          race: z.string().min(1).optional().describe("Attribute the cost to a race (set_race), counting it against that race's budget."),
          stock: z
            .array(
              z.object({
                product: z.string().min(1),
                servings: z.number().finite().positive(),
                expires_on: z.string().date().optional(),
              }),
            )
            .min(1)
            .optional(),
          notes: z.string().optional(),
        },
      },
      async ({ description, amount, currency, usd_per_unit, category, status, date, equipment, race, stock, notes }) => {
        const code = currency.toUpperCase();
        if (code === BASE_CURRENCY && usd_per_unit !== undefined) {
          return fail(`A ${BASE_CURRENCY} expense takes no usd_per_unit.`);
        }
        if (equipment && stock) return fail("Link an expense to equipment or to stock, not both.");
        const resolvedCategory = category ?? (equipment ? "equipment" : stock ? "consumables" : undefined);
        if (!resolvedCategory) return fail(`Give a category: ${EXPENSE_CATEGORIES.join(", ")}.`);

        let equipmentId: number | null = null;
        if (equipment) {
          equipmentId = await findEquipmentId(equipment);
          if (equipmentId == null) return fail(`No equipment named "${equipment}" (add it with set_equipment).`);
        }
        const today = dayKeyInZone(new Date());
        let raceId: number | null = null;
        if (race) {
          const found = await findRace(today, race);
          if (!found) return fail(`No race named "${race}" (see get_race_status).`);
          raceId = found.id;
        }
        let lots: StockLotInput[] = [];
        if (stock) {
          const found = await findConsumableIds(stock.map((l) => l.product));
          if ("error" in found) return fail(found.error);
          lots = stock.map((l) => ({
            consumableId: found.ids.get(l.product.trim().toLowerCase())!,
            servings: l.servings,
            expiresOn: l.expires_on ?? null,
          }));
        }

        const created = await createExpense({
          description: description.trim(),
          category: resolvedCategory,
          status,
          date: date ?? today,
          amount,
          currency: code,
          usdPerUnit: usd_per_unit ?? null,
          equipmentId,
          raceId,
          stock: lots,
          notes: notes ?? null,
        });
        const [expense] = await listExpenses({ ids: [created.id] });
        return ok({
          ok: true,
          expense,
          ...(equipmentId != null
            ? { equipment: presentEquipment((await listEquipment({ ids: [equipmentId] }))[0]), acquired: created.acquired }
            : {}),
          ...(lots.length > 0
            ? {
                stock: (await listConsumables(today, { ids: lots.map((l) => l.consumableId) })).map(
                  presentConsumable,
                ),
              }
            : {}),
        });
      }
    );

    server.registerTool(
      "update_expense",
      {
        title: "Edit an expense",
        description:
          "Change an expense by `id` (from list_expenses) - most often marking a planned expense paid, or adding the `usd_per_unit` rate to an unconverted one. Fields left out are unchanged. Changing `currency` without a new rate clears the old rate. Marking paid an expense for a 'needed' item marks that item owned (or rented). `race` re-attributes it (null detaches it). The equipment or stock it bought cannot be changed; delete it and log a new one.",
        inputSchema: {
          id: z.number().int().positive(),
          description: z.string().min(1).optional(),
          category: z.enum(EXPENSE_CATEGORIES).optional(),
          status: z.enum(EXPENSE_STATUSES).optional(),
          date: z.string().date().optional(),
          amount: z.number().finite().positive().optional(),
          currency: z.string().regex(/^[A-Za-z]{3}$/).optional(),
          usd_per_unit: z.number().finite().positive().nullable().optional(),
          race: z.string().min(1).nullable().optional(),
          notes: z.string().nullable().optional(),
        },
      },
      async ({ id, description, category, status, date, amount, currency, usd_per_unit, race, notes }) => {
        let raceId: number | null | undefined = race === null ? null : undefined;
        if (race) {
          const found = await findRace(dayKeyInZone(new Date()), race);
          if (!found) return fail(`No race named "${race}" (see get_race_status).`);
          raceId = found.id;
        }
        const result = await updateExpense(id, {
          description,
          category,
          status,
          date,
          amount,
          currency: currency?.toUpperCase(),
          usdPerUnit: usd_per_unit,
          raceId,
          notes,
        });
        if (result == null) return fail(`No expense with id ${id}.`);
        if ("error" in result) return fail(result.error);
        return ok({ ok: true, acquired: result.acquired, expense: (await listExpenses({ ids: [id] }))[0] });
      }
    );

    server.registerTool(
      "delete_expense",
      {
        title: "Delete an expense",
        description:
          "Move an expense to the recycle bin by `id`. It leaves every total, and any stock it bought stops counting; restore_deleted brings it back. An item it marked owned keeps that status - you may still have it.",
        inputSchema: { id: z.number().int().positive() },
      },
      async ({ id }) => {
        const removed = await setExpenseDeleted(id, true);
        return removed ? ok({ ok: true, deletedId: id }) : fail(`No active expense with id ${id}.`);
      }
    );

    server.registerTool(
      "list_expenses",
      {
        title: "List expenses",
        description:
          "Expenses newest first, optionally filtered by date range (YYYY-MM-DD), status, or category. Each shows the original amount and currency, the declared usd_per_unit, amountUsd (null when unconverted), and what it bought.",
        inputSchema: {
          from: z.string().date().optional(),
          to: z.string().date().optional(),
          status: z.enum(EXPENSE_STATUSES).optional(),
          category: z.enum(EXPENSE_CATEGORIES).optional(),
          include_deleted: z.boolean().default(false),
        },
      },
      async ({ from, to, status, category, include_deleted }) =>
        ok({ expenses: await listExpenses({ from, to, status, category, includeDeleted: include_deleted }) }),
    );

    server.registerTool(
      "get_budget_summary",
      {
        title: "Budget summary",
        description:
          "Spending in USD over an optional date range: paid (actual) and planned (committed, not yet paid) in total and by category. Each expense counts once, as paid or as planned. Expenses in another currency without a declared rate are not converted; they are listed under `unconverted` in their own currency with their ids, so the totals are explicitly partial while that list is non-empty.",
        inputSchema: {
          from: z.string().date().optional(),
          to: z.string().date().optional(),
        },
      },
      async ({ from, to }) => ok({ currency: BASE_CURRENCY, from, to, ...summarizeBudget(await listExpenses({ from, to })) }),
    );

    server.registerTool(
      "set_race",
      {
        title: "Add or update a race",
        description:
          "Create or update a race by `name` (case-insensitive): date, location, course distances in km, goal, budget in USD, notes. `format: \"70.3\"` fills any distance not given with the nominal 1.2 mi / 56 mi / 13.1 mi (1.93 / 90.12 / 21.08 km); give the course's actual distances when they differ. A new race needs `race_date`. `checklist: \"70.3\"` adds a generic starting gear checklist and logistics tasks (no deadlines, no race-rule claims) for you to edit - it only adds what the race does not already have. Fields left out keep their value; null clears an optional one. The next upcoming race is the default wherever a race is not named.",
        inputSchema: {
          name: z.string().min(1),
          race_date: z.string().date().optional(),
          format: z.enum(Object.keys(RACE_FORMATS) as [keyof typeof RACE_FORMATS]).optional(),
          location: z.string().nullable().optional(),
          swim_km: z.number().finite().positive().nullable().optional(),
          bike_km: z.number().finite().positive().nullable().optional(),
          run_km: z.number().finite().positive().nullable().optional(),
          goal: z.string().nullable().optional(),
          budget_usd: z.number().finite().nonnegative().nullable().optional(),
          notes: z.string().nullable().optional(),
          checklist: z.enum(Object.keys(CHECKLIST_TEMPLATES) as [keyof typeof CHECKLIST_TEMPLATES]).optional(),
        },
      },
      async ({ name, race_date, format, location, swim_km, bike_km, run_km, goal, budget_usd, notes, checklist }) => {
        const nominal = format ? RACE_FORMATS[format] : undefined;
        const result = await setRace(name.trim(), {
          raceDate: race_date,
          location,
          swimKm: swim_km !== undefined ? swim_km : nominal?.swimKm,
          bikeKm: bike_km !== undefined ? bike_km : nominal?.bikeKm,
          runKm: run_km !== undefined ? run_km : nominal?.runKm,
          goal,
          budgetUsd: budget_usd,
          notes,
        });
        if ("error" in result) return fail(result.error);
        const applied = checklist ? await applyChecklist(result.race.id, checklist) : null;
        return ok({
          ok: true,
          created: result.created,
          race: presentRace(result.race),
          ...(applied ? { checklistItemsAdded: applied.added } : {}),
        });
      }
    );

    server.registerTool(
      "get_race_status",
      {
        title: "Race status",
        description:
          "Where preparation for a race stands (default: the next upcoming race): days to go, course distances, the gear checklist with each requirement's state (missing / acquired / tested / ready) and the evidence it rests on, deadlines and bookings with their state (overdue / due_soon within 14 days / open / done), the race-day fueling plan with its carb/sodium/caffeine totals and any stock shortfall, and per sport the longest completed leg in the last 12 weeks against the race distance plus average weekly hours over the last 4 weeks - informational, not a readiness score. Budget compares the race's budget with the expenses attributed to it: paid, planned (committed), and what is left after each; expenses without a USD rate are listed as unconverted. Also lists every race.",
        inputSchema: { race: z.string().min(1).optional() },
      },
      async ({ race: name }) => {
        const today = dayKeyInZone(new Date());
        const race = await findRace(today, name);
        if (!race) {
          return name
            ? fail(`No race named "${name}".`)
            : ok({ race: null, message: "No race set yet. Add one with set_race." });
        }
        const [milestones, budget, races, gear, tasks, fuelPlan] = await Promise.all([
          sportMilestones(race, today),
          raceBudget(race),
          listRaces(),
          listRaceGear(race.id),
          listRaceTasks(race.id, today),
          getRaceFuelPlan(race.id),
        ]);
        const planned = new Set(fuelPlan.lines.map((l) => l.product.toLowerCase()));
        const stock = (await listConsumables(today)).filter((c) => planned.has(c.name.toLowerCase()));
        return ok({
          race: presentRace(race),
          daysToGo: daysBetween(today, race.raceDate),
          milestones: milestones.map((m) => ({
            ...m,
            raceKm: m.raceKm != null ? round2(m.raceKm) : null,
            longestRecentKm: m.longestRecentKm != null ? round2(m.longestRecentKm) : null,
            shareOfRace: m.shareOfRace != null ? Math.round(m.shareOfRace * 100) / 100 : null,
            weeklyHoursRecent: Math.round(m.weeklyHoursRecent * 10) / 10,
          })),
          gear,
          tasks,
          fuelPlan: {
            ...fuelPlan,
            stock: stock.map((c) => ({
              product: c.name,
              onHand: round1Servings(c.onHand),
              shortfall: round1Servings(c.shortfall),
            })),
          },
          budget,
          races: races.map((r) => ({ name: r.name, raceDate: r.raceDate })),
        });
      }
    );

    server.registerTool(
      "set_race_gear",
      {
        title: "Set a race gear requirement",
        description:
          "Add or update an item a race needs, by `label` (e.g. wetsuit, race belt), and point it at the inventory item that fills it (`equipment` by name; null unassigns). Its state is derived, never set: missing (nothing assigned, or the item is not in hand), acquired (in hand), tested (used in a completed session - log it on one), ready (you confirmed it for race day with `ready: true`; false withdraws that). Owning an item never makes it ready by itself. Assigning a different item clears an earlier confirmation. Race defaults to the next upcoming one.",
        inputSchema: {
          label: z.string().min(1),
          race: z.string().min(1).optional(),
          equipment: z.string().min(1).nullable().optional(),
          ready: z.boolean().optional(),
          notes: z.string().nullable().optional(),
        },
      },
      async ({ label, race: raceName, equipment, ready, notes }) => {
        const today = dayKeyInZone(new Date());
        const race = await findRace(today, raceName);
        if (!race) return fail(raceName ? `No race named "${raceName}".` : "No race set yet (set_race).");
        let equipmentId: number | null | undefined = equipment === null ? null : undefined;
        if (equipment) {
          const id = await findEquipmentId(equipment);
          if (id == null) return fail(`No equipment named "${equipment}" (add it with set_equipment, status needed if not bought yet).`);
          equipmentId = id;
        }
        const refused = await setRaceGear(race.id, label.trim(), {
          equipmentId,
          readyOn: ready === undefined ? undefined : ready ? today : null,
          notes,
        });
        if (refused) return fail(refused.error);
        const gear = await listRaceGear(race.id);
        const item = gear.find((g) => g.label.toLowerCase() === label.trim().toLowerCase())!;
        return ok({
          ok: true,
          race: race.name,
          requirement: item,
          ...(item.state === "ready" && item.evidence.includes("never used")
            ? { warning: `Confirmed ready but ${item.equipment} has never been used in a logged session.` }
            : {}),
        });
      }
    );

    server.registerTool(
      "remove_race_gear",
      {
        title: "Remove a race gear requirement",
        description: "Drop a requirement from a race's gear checklist by `label`. The inventory item is untouched.",
        inputSchema: { label: z.string().min(1), race: z.string().min(1).optional() },
      },
      async ({ label, race: raceName }) => {
        const race = await findRace(dayKeyInZone(new Date()), raceName);
        if (!race) return fail(raceName ? `No race named "${raceName}".` : "No race set yet (set_race).");
        const removed = await removeRaceGear(race.id, label.trim());
        return removed ? ok({ ok: true, race: race.name, removed: label }) : fail(`No "${label}" on ${race.name}.`);
      }
    );

    server.registerTool(
      "set_race_task",
      {
        title: "Set a race deadline or booking",
        description:
          "Add or update a logistics task for a race by `title`: registration, lodging, travel, bike transport, athlete check-in, anything with a deadline. `due_on` is the deadline; `done: true` marks it done today (or on `done_on`), false reopens it. Keep booking references in `confirmation`. `expense_id` (from log_expense) links what the booking cost and attributes that expense to this race's budget. Fields left out keep their value; null clears one. Race defaults to the next upcoming one.",
        inputSchema: {
          title: z.string().min(1),
          race: z.string().min(1).optional(),
          category: z
            .string()
            .min(1)
            .optional()
            .describe("registration, lodging, travel, bike_transport, checkin, or other."),
          due_on: z.string().date().nullable().optional(),
          done: z.boolean().optional(),
          done_on: z.string().date().optional(),
          confirmation: z.string().nullable().optional(),
          expense_id: z.number().int().positive().nullable().optional(),
          notes: z.string().nullable().optional(),
        },
      },
      async ({ title, race: raceName, category, due_on, done, done_on, confirmation, expense_id, notes }) => {
        const today = dayKeyInZone(new Date());
        const race = await findRace(today, raceName);
        if (!race) return fail(raceName ? `No race named "${raceName}".` : "No race set yet (set_race).");
        if (done === false && done_on) return fail("done_on cannot be given with done: false.");
        const refused = await setRaceTask(race.id, title.trim(), {
          category,
          dueOn: due_on,
          doneOn: done === false ? null : done || done_on ? (done_on ?? today) : undefined,
          confirmation,
          expenseId: expense_id,
          notes,
        });
        if (refused) return fail(refused.error);
        const task = (await listRaceTasks(race.id, today)).find(
          (t) => t.title.toLowerCase() === title.trim().toLowerCase(),
        );
        return ok({ ok: true, race: race.name, task });
      }
    );

    server.registerTool(
      "remove_race_task",
      {
        title: "Remove a race task",
        description: "Drop a logistics task from a race by `title`. A linked expense is kept.",
        inputSchema: { title: z.string().min(1), race: z.string().min(1).optional() },
      },
      async ({ title, race: raceName }) => {
        const race = await findRace(dayKeyInZone(new Date()), raceName);
        if (!race) return fail(raceName ? `No race named "${raceName}".` : "No race set yet (set_race).");
        const removed = await removeRaceTask(race.id, title.trim());
        return removed ? ok({ ok: true, race: race.name, removed: title }) : fail(`No "${title}" on ${race.name}.`);
      }
    );

    server.registerTool(
      "set_race_fuel",
      {
        title: "Set the race-day fueling plan",
        description:
          "Set how many servings of a product (by name, from list_consumables) you plan to carry on race day; 0 removes it from the plan. The plan is yours - it is totalled (carbs, sodium, caffeine) and checked against stock together with planned sessions, never prescribed. Race defaults to the next upcoming one. Returns the whole plan.",
        inputSchema: {
          product: z.string().min(1),
          servings: z.number().finite().nonnegative(),
          race: z.string().min(1).optional(),
        },
      },
      async ({ product, servings, race: raceName }) => {
        const race = await findRace(dayKeyInZone(new Date()), raceName);
        if (!race) return fail(raceName ? `No race named "${raceName}".` : "No race set yet (set_race).");
        const found = await findConsumableIds([product]);
        if ("error" in found) return fail(found.error);
        await setRaceFuel(race.id, [...found.ids.values()][0], servings);
        return ok({ ok: true, race: race.name, fuelPlan: await getRaceFuelPlan(race.id) });
      }
    );

    server.registerTool(
      "get_needs_attention",
      {
        title: "Needs attention",
        description:
          "One prioritized list of what needs doing before the next workout or race, across every area: race gear missing or (within 8 weeks) never tested, overdue or due-soon race deadlines, maintenance due or approaching, fuel short of planned and race need, expired, low, or below zero, a race over budget, expenses with no USD rate, and planned sessions left in the past. Each item has a severity (blocker, warning, info), the reason with the figures it rests on, the next action, and a `key` for dismiss_attention. Dismissed and snoozed items are hidden (`hidden` counts them) unless include_dismissed is true. Use this first when asked what to focus on.",
        inputSchema: { include_dismissed: z.boolean().default(false) },
      },
      async ({ include_dismissed }) =>
        ok(await getAttention(dayKeyInZone(new Date()), { includeDismissed: include_dismissed })),
    );

    server.registerTool(
      "dismiss_attention",
      {
        title: "Dismiss or snooze an attention item",
        description:
          "Hide a needs-attention item by its `key`: until it changes (no date), or snoozed until `snooze_until` (YYYY-MM-DD). Keys carry the item's state, so a dismissed warning comes back if it gets worse or a new cycle starts. `undo: true` shows it again. Dismissing hides the reminder; it does not resolve the underlying issue.",
        inputSchema: {
          key: z.string().min(1),
          snooze_until: z.string().date().optional(),
          undo: z.boolean().default(false),
        },
      },
      async ({ key, snooze_until, undo }) => {
        if (undo && snooze_until) return fail("Give snooze_until or undo, not both.");
        const today = dayKeyInZone(new Date());
        if (snooze_until && snooze_until <= today) return fail("snooze_until must be after today.");
        await setDismissal(key, undo ? "undo" : { until: snooze_until ?? null });
        return ok({ ok: true, key, ...(undo ? { restored: true } : { until: snooze_until ?? "dismissed" }) });
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
