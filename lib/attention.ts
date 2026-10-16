import { sql } from "./db";
import { listExpenses, summarizeBudget } from "./expenses";
import { listConsumables } from "./fuel";
import { listMaintenance } from "./maintenance";
import { listRaceGear, listRaces, listRaceTasks, raceBudget, type Race } from "./races";
import { daysBetween } from "./time";

// Untested gear only matters once the race is close enough that there are few
// sessions left to try it in; before that it is noise.
export const UNTESTED_GEAR_WINDOW_DAYS = 56;
// Inside this window, gear still missing for the race is a blocker.
export const MISSING_GEAR_BLOCKER_DAYS = 28;

export const SEVERITIES = ["blocker", "warning", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];

export type AttentionItem = {
  // Stable for as long as the situation is unchanged - it embeds the state or
  // figure the item reports - so a dismissal lapses once that changes.
  key: string;
  severity: Severity;
  area: "maintenance" | "fuel" | "race gear" | "race task" | "budget" | "training";
  reason: string;
  nextAction: string;
};

async function maintenanceItems(today: string): Promise<AttentionItem[]> {
  return (await listMaintenance(today))
    .filter((r) => r.state !== "ok")
    .map((r) => ({
      key: `maintenance:${r.id}:${r.since}:${r.state}`,
      severity: r.state === "due" ? "warning" : "info",
      area: "maintenance",
      reason: `${r.equipment}: ${r.name} ${r.state === "due" ? "is due" : "is approaching"} (${r.reasons.join("; ")} since ${r.since}).`,
      nextAction: `Do the ${r.name} and log it with log_service.`,
    }));
}

const servings = (n: number) => Math.round(n * 10) / 10;

async function fuelItems(today: string): Promise<AttentionItem[]> {
  const items: AttentionItem[] = [];
  for (const c of await listConsumables(today)) {
    if (c.onHand < 0) {
      items.push({
        key: `fuel-negative:${c.id}:${servings(c.onHand)}`,
        severity: "warning",
        area: "fuel",
        reason: `${c.name}: more logged as used than ever stocked (${servings(c.onHand)} on hand).`,
        nextAction: "Record the missing starting count or purchase with adjust_stock or log_expense.",
      });
    } else if (c.shortfall > 0) {
      items.push({
        key: `fuel-shortfall:${c.id}:${servings(c.shortfall)}`,
        severity: "warning",
        area: "fuel",
        reason: `${c.name}: ${servings(c.plannedNeed + c.raceNeed)} ${c.servingUnit}(s) planned (sessions ${servings(c.plannedNeed)}, races ${servings(c.raceNeed)}) but ${servings(c.onHand)} on hand.`,
        nextAction: `Buy at least ${servings(c.shortfall)} more and log it with log_expense.`,
      });
    } else if (c.lowStock) {
      items.push({
        key: `fuel-low:${c.id}`,
        severity: "info",
        area: "fuel",
        reason: `${c.name}: ${servings(c.onHand)} on hand, at or below your low-stock level of ${c.lowStockServings}.`,
        nextAction: "Restock when convenient.",
      });
    }
    if (c.expiry.expiredServings > 0) {
      items.push({
        key: `fuel-expired:${c.id}:${servings(c.expiry.expiredServings)}`,
        severity: "warning",
        area: "fuel",
        reason: `${c.name}: about ${servings(c.expiry.expiredServings)} serving(s) past expiry, assuming the oldest were used first.`,
        nextAction: "Check the packets; bin expired ones with a negative adjust_stock.",
      });
    }
  }
  return items;
}

async function raceItems(today: string): Promise<AttentionItem[]> {
  const upcoming = (await listRaces()).filter((r) => r.raceDate >= today);
  return (await Promise.all(upcoming.map((race) => itemsForRace(race, today)))).flat();
}

async function itemsForRace(race: Race, today: string): Promise<AttentionItem[]> {
  const items: AttentionItem[] = [];
  const daysToGo = daysBetween(today, race.raceDate);
  const [gear, tasks, budget] = await Promise.all([
    listRaceGear(race.id),
    listRaceTasks(race.id, today),
    raceBudget(race),
  ]);
  for (const g of gear) {
    if (g.state === "missing") {
      items.push({
        key: `gear:${race.id}:${g.label.toLowerCase()}:missing`,
        severity: daysToGo <= MISSING_GEAR_BLOCKER_DAYS ? "blocker" : "warning",
        area: "race gear",
        reason: `${race.name} (${daysToGo} days): ${g.label} is missing - ${g.evidence}.`,
        nextAction: g.equipment
          ? `Get ${g.equipment} and log the purchase with log_expense.`
          : `Assign an item with set_race_gear (add it with set_equipment first).`,
      });
    } else if (g.state === "acquired" && daysToGo <= UNTESTED_GEAR_WINDOW_DAYS) {
      items.push({
        key: `gear:${race.id}:${g.label.toLowerCase()}:untested`,
        severity: "warning",
        area: "race gear",
        reason: `${race.name} (${daysToGo} days): ${g.label} (${g.equipment}) has never been used in a logged session.`,
        nextAction: `Use it in training and log it on that session.`,
      });
    }
  }
  for (const t of tasks) {
    if (t.state === "overdue" || t.state === "due_soon") {
      items.push({
        key: `task:${t.id}:${t.state}`,
        severity: t.state === "overdue" ? "blocker" : "warning",
        area: "race task",
        reason:
          t.state === "overdue"
            ? `${race.name}: "${t.title}" was due ${t.dueOn} (${-(t.daysUntilDue ?? 0)} days ago).`
            : `${race.name}: "${t.title}" is due ${t.dueOn} (in ${t.daysUntilDue} days).`,
        nextAction: `Do it, then mark it with set_race_task done: true.`,
      });
    }
  }
  if (budget.remainingAfterCommittedUsd != null && budget.remainingAfterCommittedUsd < 0) {
    items.push({
      key: `budget-over:${race.id}:${Math.round(-budget.remainingAfterCommittedUsd)}`,
      severity: "warning",
      area: "budget",
      reason: `${race.name}: paid and committed spend is $${-budget.remainingAfterCommittedUsd} over the $${budget.budgetUsd} budget.`,
      nextAction: "Raise the budget with set_race or drop planned expenses.",
    });
  }
  return items;
}

async function budgetItems(): Promise<AttentionItem[]> {
  const { unconverted } = summarizeBudget(await listExpenses({}));
  return unconverted.map((u) => ({
    key: `budget-unconverted:${u.currency}:${u.expenseIds.join(",")}`,
    severity: "info",
    area: "budget",
    reason: `${u.amount} ${u.currency} of ${u.status} spend has no USD rate, so totals leave it out.`,
    nextAction: `Add usd_per_unit with update_expense (ids ${u.expenseIds.join(", ")}).`,
  }));
}

async function trainingItems(today: string): Promise<AttentionItem[]> {
  const stale = await sql`
    select id, to_char(session_date, 'YYYY-MM-DD') as date
    from training_sessions
    where status = 'planned' and deleted_at is null and session_date < ${today}::date
    order by session_date
  `;
  return stale.map((s) => ({
    key: `stale-plan:${s.id}`,
    severity: "info",
    area: "training",
    reason: `Session ${s.id} planned for ${s.date} is still marked planned.`,
    nextAction: "Mark it completed with update_training_session, or delete it if it was skipped.",
  }));
}

export async function getAttention(
  today: string,
  { includeDismissed = false }: { includeDismissed?: boolean } = {},
): Promise<{ items: (AttentionItem & { dismissed?: { until: string | null } })[]; hidden: number }> {
  const groups = await Promise.all([
    raceItems(today),
    maintenanceItems(today),
    fuelItems(today),
    budgetItems(),
    trainingItems(today),
  ]);
  const all = groups.flat().sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));

  const dismissals = await sql`
    select key, to_char(until, 'YYYY-MM-DD') as until from attention_dismissals
    where until is null or until > ${today}::date
  `;
  const active = new Map(dismissals.map((d) => [d.key as string, (d.until as string | null) ?? null]));
  const visible = all.filter((item) => !active.has(item.key));
  return {
    items: includeDismissed
      ? all.map((item) => (active.has(item.key) ? { ...item, dismissed: { until: active.get(item.key)! } } : item))
      : visible,
    hidden: all.length - visible.length,
  };
}

// Dismiss (no date) or snooze until a date; undo removes either.
export async function setDismissal(key: string, change: { until: string | null } | "undo"): Promise<void> {
  if (change === "undo") {
    await sql`delete from attention_dismissals where key = ${key}`;
    return;
  }
  await sql`
    insert into attention_dismissals (key, until) values (${key}, ${change.until}::date)
    on conflict (key) do update set until = excluded.until, created_at = now()
  `;
}
