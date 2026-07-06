export const GOAL_PHASES = ["cut", "bulk", "recomp", "maintenance"] as const;
export type GoalPhase = (typeof GOAL_PHASES)[number];
export const DEFAULT_GOAL_PHASE: GoalPhase = "maintenance";

export function asGoalPhase(value: unknown): GoalPhase {
  return (GOAL_PHASES as readonly string[]).includes(value as string)
    ? (value as GoalPhase)
    : DEFAULT_GOAL_PHASE;
}

// kg/week of loss beyond which a cut risks shedding muscle (the long-standing
// 0.5-1 kg/week guidance). Bulk gain is judged as a % of bodyweight instead,
// since the "mostly fat above here" ceiling scales with size.
const CUT_LOSS_CEILING_KG = 1;
const BULK_GAIN_CEILING_PCT = 0.5;
// % of bodyweight per week that counts as "not actually holding" for a phase
// where weight is meant to stay roughly stable (recomp / maintenance).
const STABLE_DRIFT_PCT = 0.5;

const MS_PER_WEEK = 1000 * 60 * 60 * 24 * 7;

export type PaceStatus = "ok" | "too-fast" | "wrong-direction" | "insufficient-data";

export type PaceCheck = {
  status: PaceStatus;
  // Signed weekly change: positive = gaining, negative = losing. (Note this
  // differs from the old loss-positive convention; see get_goal_status.)
  kgPerWeek: number | null;
  pctPerWeek: number | null;
  note: string | null;
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function evaluatePace(input: {
  phase: GoalPhase;
  startingWeightKg: number | null;
  targetWeightKg: number | null;
  startingDate: string | Date | null;
  targetDate: string | Date | null;
}): PaceCheck {
  const { phase, startingWeightKg, targetWeightKg, startingDate, targetDate } = input;

  if (startingWeightKg == null || targetWeightKg == null || !startingDate || !targetDate) {
    return { status: "insufficient-data", kgPerWeek: null, pctPerWeek: null, note: null };
  }

  const weeks = Math.max(
    1 / 7,
    (new Date(targetDate).getTime() - new Date(startingDate).getTime()) / MS_PER_WEEK,
  );
  const kgPerWeek = (targetWeightKg - startingWeightKg) / weeks;
  const pctPerWeek = startingWeightKg > 0 ? (kgPerWeek / startingWeightKg) * 100 : 0;

  const mk = (status: PaceStatus, note: string): PaceCheck => ({
    status,
    kgPerWeek: round2(kgPerWeek),
    pctPerWeek: round2(pctPerWeek),
    note,
  });

  switch (phase) {
    case "cut": {
      if (kgPerWeek >= 0) {
        return mk("wrong-direction", "Target is at or above your starting weight, but the phase is a cut - lower the target or switch to bulk.");
      }
      const lossKg = -kgPerWeek;
      return lossKg > CUT_LOSS_CEILING_KG
        ? mk("too-fast", `About ${lossKg.toFixed(2)} kg/week of loss - faster than the recommended 0.5-1 kg/week, so you risk losing muscle.`)
        : mk("ok", `About ${lossKg.toFixed(2)} kg/week of loss - within a typically sustainable range.`);
    }
    case "bulk": {
      if (kgPerWeek <= 0) {
        return mk("wrong-direction", "Target is at or below your starting weight, but the phase is a bulk - raise the target or switch to cut.");
      }
      return pctPerWeek > BULK_GAIN_CEILING_PCT
        ? mk("too-fast", `About ${pctPerWeek.toFixed(2)}%/week (${round2(kgPerWeek)} kg/week) of gain - above the ~0.25-0.5%/week ceiling, so more of it will be fat.`)
        : mk("ok", `About ${pctPerWeek.toFixed(2)}%/week (${round2(kgPerWeek)} kg/week) of gain - a lean-gain pace.`);
    }
    case "recomp":
    case "maintenance": {
      return Math.abs(pctPerWeek) > STABLE_DRIFT_PCT
        ? mk("too-fast", `About ${round2(kgPerWeek)} kg/week (${pctPerWeek.toFixed(2)}%/week) - a meaningful trend for a ${phase} goal, where weight should stay roughly stable.`)
        : mk("ok", `About ${round2(kgPerWeek)} kg/week - close enough to stable for a ${phase} goal.`);
    }
  }
}
