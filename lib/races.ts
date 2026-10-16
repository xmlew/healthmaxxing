import { sql } from "./db";
import { listExpenses, summarizeBudget, type BudgetSummary } from "./expenses";
import { SPORTS, type Sport } from "./sports";
import { shiftDayKey } from "./time";

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
