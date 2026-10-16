import { sql } from "./db";
import { listExpenses, summarizeBudget, type BudgetSummary } from "./expenses";
import { SPORTS, type Sport } from "./sports";
import { daysBetween, shiftDayKey } from "./time";

const KM_PER_MILE = 1.609344;

// Nominal course distances; a race's own course may differ, so these only fill
// in what was not given.
export const RACE_FORMATS = {
  "70.3": { swimKm: 1.2 * KM_PER_MILE, bikeKm: 56 * KM_PER_MILE, runKm: 13.1 * KM_PER_MILE },
} as const;
export type RaceFormat = keyof typeof RACE_FORMATS;

// Training milestones look at this recent window: fitness from months ago is
// not what will carry the race.
export const MILESTONE_WINDOW_DAYS = 84;
const VOLUME_WINDOW_DAYS = 28;

export type Race = {
  id: number;
  name: string;
  raceDate: string;
  location: string | null;
  swimKm: number | null;
  bikeKm: number | null;
  runKm: number | null;
  goal: string | null;
  budgetUsd: number | null;
  notes: string | null;
};

export type RacePatch = {
  raceDate?: string;
  location?: string | null;
  swimKm?: number | null;
  bikeKm?: number | null;
  runKm?: number | null;
  goal?: string | null;
  budgetUsd?: number | null;
  notes?: string | null;
};

function toRace(r: Record<string, unknown>): Race {
  const num = (v: unknown) => (v == null ? null : Number(v));
  return {
    id: Number(r.id),
    name: r.name as string,
    raceDate: r.race_date as string,
    location: (r.location as string | null) ?? null,
    swimKm: num(r.swim_km),
    bikeKm: num(r.bike_km),
    runKm: num(r.run_km),
    goal: (r.goal as string | null) ?? null,
    budgetUsd: num(r.budget_usd),
    notes: (r.notes as string | null) ?? null,
  };
}

const RACE_COLUMNS = sql`
  id, name, to_char(race_date, 'YYYY-MM-DD') as race_date, location, swim_km, bike_km, run_km,
  goal, budget_usd, notes
`;

// Upserts by case-insensitive name; a new race needs its date.
export async function setRace(
  name: string,
  patch: RacePatch,
): Promise<{ race: Race; created: boolean } | { error: string }> {
  const [existing] = await sql`select id from races where lower(name) = lower(${name})`;
  if (!existing) {
    if (!patch.raceDate) return { error: `"${name}" is new; give it a race_date.` };
    const [row] = await sql`
      insert into races (name, race_date, location, swim_km, bike_km, run_km, goal, budget_usd, notes)
      values (
        ${name}, ${patch.raceDate}::date, ${patch.location ?? null}, ${patch.swimKm ?? null},
        ${patch.bikeKm ?? null}, ${patch.runKm ?? null}, ${patch.goal ?? null},
        ${patch.budgetUsd ?? null}, ${patch.notes ?? null}
      )
      returning ${RACE_COLUMNS}
    `;
    return { race: toRace(row), created: true };
  }
  const keep = (value: unknown, column: string) =>
    value === undefined ? sql(column) : sql`${value as string | number | null}`;
  const [row] = await sql`
    update races set
      race_date = coalesce(${patch.raceDate ?? null}::date, race_date),
      location = ${keep(patch.location, "location")},
      swim_km = ${keep(patch.swimKm, "swim_km")},
      bike_km = ${keep(patch.bikeKm, "bike_km")},
      run_km = ${keep(patch.runKm, "run_km")},
      goal = ${keep(patch.goal, "goal")},
      budget_usd = ${keep(patch.budgetUsd, "budget_usd")},
      notes = ${keep(patch.notes, "notes")},
      updated_at = now()
    where id = ${existing.id}
    returning ${RACE_COLUMNS}
  `;
  return { race: toRace(row), created: false };
}

// A named race, or else the next one on the calendar, or else the latest past
// one - the race being prepared for when nothing more specific is asked.
export async function findRace(today: string, name?: string): Promise<Race | null> {
  const [row] = name
    ? await sql`select ${RACE_COLUMNS} from races where lower(name) = lower(${name.trim()})`
    : await sql`
        select ${RACE_COLUMNS} from races
        order by (race_date >= ${today}::date) desc,
          case when race_date >= ${today}::date then race_date end asc,
          race_date desc
        limit 1
      `;
  return row ? toRace(row) : null;
}

export async function listRaces(): Promise<Race[]> {
  const rows = await sql`select ${RACE_COLUMNS} from races order by race_date`;
  return rows.map(toRace);
}

export type SportMilestone = {
  sport: Sport;
  raceKm: number | null;
  // Longest single completed leg of this sport in the milestone window,
  // including a brick's legs.
  longestRecentKm: number | null;
  shareOfRace: number | null;
  weeklyHoursRecent: number;
};

export async function sportMilestones(race: Race, today: string): Promise<SportMilestone[]> {
  const rows = await sql`
    select
      seg.sport,
      max(seg.distance_km) filter (where ts.session_date > ${shiftDayKey(today, -MILESTONE_WINDOW_DAYS)}::date)
        as longest_km,
      coalesce(sum(seg.duration_min) filter (
        where ts.session_date > ${shiftDayKey(today, -VOLUME_WINDOW_DAYS)}::date
      ), 0) as recent_minutes
    from training_segments seg
    join training_sessions ts on ts.id = seg.session_id
    where ts.status = 'completed' and ts.deleted_at is null and ts.session_date <= ${today}::date
    group by seg.sport
  `;
  const bySport = new Map(rows.map((r) => [r.sport as Sport, r]));
  const raceKm: Record<Sport, number | null> = { swim: race.swimKm, bike: race.bikeKm, run: race.runKm };
  return SPORTS.map((sport) => {
    const row = bySport.get(sport);
    const longest = row?.longest_km == null ? null : Number(row.longest_km);
    const target = raceKm[sport];
    return {
      sport,
      raceKm: target,
      longestRecentKm: longest,
      shareOfRace: longest != null && target ? longest / target : null,
      weeklyHoursRecent: row ? Number(row.recent_minutes) / 60 / (VOLUME_WINDOW_DAYS / 7) : 0,
    };
  });
}

export type RaceBudget = BudgetSummary & {
  budgetUsd: number | null;
  // Allowance left after money already spent, and after money committed too.
  remainingAfterPaidUsd: number | null;
  remainingAfterCommittedUsd: number | null;
};

export async function raceBudget(race: Race): Promise<RaceBudget> {
  const summary = summarizeBudget(await listExpenses({ raceId: race.id }));
  const budgetCents = race.budgetUsd == null ? null : Math.round(race.budgetUsd * 100);
  const paidCents = Math.round(summary.paidUsd * 100);
  const plannedCents = Math.round(summary.plannedUsd * 100);
  return {
    ...summary,
    budgetUsd: race.budgetUsd,
    remainingAfterPaidUsd: budgetCents == null ? null : (budgetCents - paidCents) / 100,
    remainingAfterCommittedUsd: budgetCents == null ? null : (budgetCents - paidCents - plannedCents) / 100,
  };
}

export const GEAR_STATES = ["missing", "acquired", "tested", "ready"] as const;
export type GearState = (typeof GEAR_STATES)[number];

const IN_HAND = ["owned", "rented", "borrowed"];

export type RaceGearItem = {
  label: string;
  equipment: string | null;
  equipmentStatus: string | null;
  state: GearState;
  // What the state rests on, so it can be checked rather than trusted.
  evidence: string;
  readyOn: string | null;
  notes: string | null;
};

export async function listRaceGear(raceId: number): Promise<RaceGearItem[]> {
  const rows = await sql`
    select
      g.label, g.notes, to_char(g.ready_on, 'YYYY-MM-DD') as ready_on,
      e.name as equipment, e.status as equipment_status,
      count(distinct ts.id) as sessions,
      to_char(max(ts.session_date), 'YYYY-MM-DD') as last_used
    from race_gear g
    left join equipment e on e.id = g.equipment_id
    left join training_segment_equipment tse on tse.equipment_id = e.id
    left join training_segments seg on seg.id = tse.segment_id
    left join training_sessions ts
      on ts.id = seg.session_id and ts.status = 'completed' and ts.deleted_at is null
    where g.race_id = ${raceId}
    group by g.id, e.id
    order by g.label
  `;
  return rows.map((r) => {
    const equipment = (r.equipment as string | null) ?? null;
    const status = (r.equipment_status as string | null) ?? null;
    const sessions = Number(r.sessions);
    const readyOn = (r.ready_on as string | null) ?? null;
    const inHand = status != null && IN_HAND.includes(status);
    const usage = sessions > 0 ? `used in ${sessions} completed session(s), last ${r.last_used}` : "never used in a logged session";

    let state: GearState;
    let evidence: string;
    if (!equipment) {
      state = "missing";
      evidence = "no inventory item assigned";
    } else if (!inHand) {
      state = "missing";
      evidence = `${equipment} is ${status}`;
    } else if (readyOn) {
      state = "ready";
      evidence = `confirmed ready on ${readyOn}; ${usage}`;
    } else if (sessions > 0) {
      state = "tested";
      evidence = usage;
    } else {
      state = "acquired";
      evidence = `${equipment} is ${status}; ${usage}`;
    }
    return { label: r.label as string, equipment, equipmentStatus: status, state, evidence, readyOn, notes: (r.notes as string | null) ?? null };
  });
}

// Upserts a requirement by label. Pointing it at a different item clears any
// readiness confirmation, which was about the item it replaced, and an item
// can only be confirmed ready while it is in hand.
export async function setRaceGear(
  raceId: number,
  label: string,
  patch: { equipmentId?: number | null; readyOn?: string | null; notes?: string | null },
): Promise<{ error: string } | null> {
  return sql.begin(async (tx) => {
    const [existing] = await tx`
      select id, equipment_id from race_gear where race_id = ${raceId} and lower(label) = lower(${label})
    `;
    const currentEquipmentId = existing?.equipment_id == null ? null : Number(existing.equipment_id);
    const equipmentId = patch.equipmentId !== undefined ? patch.equipmentId : currentEquipmentId;

    if (patch.readyOn) {
      const [item] = equipmentId == null ? [] : await tx`select name, status from equipment where id = ${equipmentId}`;
      if (!item) return { error: `Cannot confirm "${label}" ready: no inventory item assigned.` };
      if (!IN_HAND.includes(item.status as string)) {
        return { error: `Cannot confirm "${label}" ready: ${item.name} is ${item.status}.` };
      }
    }

    if (!existing) {
      await tx`
        insert into race_gear (race_id, label, equipment_id, ready_on, notes)
        values (${raceId}, ${label}, ${equipmentId}, ${patch.readyOn ?? null}::date, ${patch.notes ?? null})
      `;
      return null;
    }
    const readyOn =
      patch.readyOn !== undefined ? patch.readyOn : equipmentId !== currentEquipmentId ? null : undefined;
    await tx`
      update race_gear set
        equipment_id = ${equipmentId},
        ready_on = ${readyOn === undefined ? tx`ready_on` : tx`${readyOn}::date`},
        notes = ${patch.notes === undefined ? tx`notes` : patch.notes},
        updated_at = now()
      where id = ${existing.id}
    `;
    return null;
  });
}

export async function removeRaceGear(raceId: number, label: string): Promise<boolean> {
  const rows = await sql`
    delete from race_gear where race_id = ${raceId} and lower(label) = lower(${label}) returning id
  `;
  return rows.length > 0;
}

// Far enough ahead to act on a booking before it becomes a scramble.
export const TASK_DUE_SOON_DAYS = 14;

export type TaskState = "done" | "overdue" | "due_soon" | "open";

export type RaceTask = {
  id: number;
  title: string;
  category: string;
  dueOn: string | null;
  doneOn: string | null;
  state: TaskState;
  daysUntilDue: number | null;
  confirmation: string | null;
  expense: { id: number; description: string; amount: number; currency: string; status: string } | null;
  notes: string | null;
};

export async function listRaceTasks(raceId: number, today: string): Promise<RaceTask[]> {
  const rows = await sql`
    select
      t.id, t.title, t.category, to_char(t.due_on, 'YYYY-MM-DD') as due_on,
      to_char(t.done_on, 'YYYY-MM-DD') as done_on, t.confirmation, t.notes,
      x.id as expense_id, x.description as expense_description, x.amount, x.currency, x.status
    from race_tasks t
    left join expenses x on x.id = t.expense_id and x.deleted_at is null
    where t.race_id = ${raceId}
    order by t.done_on is not null, t.due_on nulls last, t.title
  `;
  return rows.map((r) => {
    const dueOn = (r.due_on as string | null) ?? null;
    const doneOn = (r.done_on as string | null) ?? null;
    const daysUntilDue = dueOn ? daysBetween(today, dueOn) : null;
    const state: TaskState = doneOn
      ? "done"
      : daysUntilDue == null
        ? "open"
        : daysUntilDue < 0
          ? "overdue"
          : daysUntilDue <= TASK_DUE_SOON_DAYS
            ? "due_soon"
            : "open";
    return {
      id: Number(r.id),
      title: r.title as string,
      category: r.category as string,
      dueOn,
      doneOn,
      state,
      daysUntilDue,
      confirmation: (r.confirmation as string | null) ?? null,
      expense:
        r.expense_id == null
          ? null
          : {
              id: Number(r.expense_id),
              description: r.expense_description as string,
              amount: Number(r.amount),
              currency: r.currency as string,
              status: r.status as string,
            },
      notes: (r.notes as string | null) ?? null,
    };
  });
}

// Upserts a task by title. Linking an expense attributes it to this race in the
// same transaction, so a booking's cost cannot sit outside the race budget; an
// expense already attributed to another race is refused rather than moved.
export async function setRaceTask(
  raceId: number,
  title: string,
  patch: {
    category?: string;
    dueOn?: string | null;
    doneOn?: string | null;
    confirmation?: string | null;
    expenseId?: number | null;
    notes?: string | null;
  },
): Promise<{ error: string } | null> {
  return sql.begin(async (tx) => {
    if (patch.expenseId != null) {
      const [expense] = await tx`
        select race_id from expenses where id = ${patch.expenseId} and deleted_at is null for update
      `;
      if (!expense) return { error: `No expense with id ${patch.expenseId}.` };
      if (expense.race_id != null && Number(expense.race_id) !== raceId) {
        return { error: `Expense ${patch.expenseId} is attributed to another race.` };
      }
      await tx`update expenses set race_id = ${raceId}, updated_at = now() where id = ${patch.expenseId}`;
    }
    const keep = (value: unknown, column: string) =>
      value === undefined ? tx(column) : tx`${value as string | number | null}`;
    const keepDate = (value: string | null | undefined, column: string) =>
      value === undefined ? tx(column) : tx`${value}::date`;
    await tx`
      insert into race_tasks (race_id, title, category, due_on, done_on, confirmation, expense_id, notes)
      values (
        ${raceId}, ${title}, ${patch.category?.toLowerCase() ?? "other"}, ${patch.dueOn ?? null}::date,
        ${patch.doneOn ?? null}::date, ${patch.confirmation ?? null}, ${patch.expenseId ?? null},
        ${patch.notes ?? null}
      )
      on conflict (race_id, lower(title)) do update set
        category = ${patch.category === undefined ? tx`race_tasks.category` : patch.category.toLowerCase()},
        due_on = ${keepDate(patch.dueOn, "race_tasks.due_on")},
        done_on = ${keepDate(patch.doneOn, "race_tasks.done_on")},
        confirmation = ${keep(patch.confirmation, "race_tasks.confirmation")},
        expense_id = ${keep(patch.expenseId, "race_tasks.expense_id")},
        notes = ${keep(patch.notes, "race_tasks.notes")},
        updated_at = now()
    `;
    return null;
  });
}

export async function removeRaceTask(raceId: number, title: string): Promise<boolean> {
  const rows = await sql`
    delete from race_tasks where race_id = ${raceId} and lower(title) = lower(${title}) returning id
  `;
  return rows.length > 0;
}
