import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { mcpClient } from "./support/mcp";
import { startTestServer, type TestServer } from "./support/server";
import { selectTestDatabase } from "./support/test-db";
import { dayKeyInZone, shiftDayKey } from "../lib/time";

selectTestDatabase();

const PORT = 3132;
const BASE = `http://localhost:${PORT}`;
const SECRET = process.env.MCP_SECRET;
const INGEST_SECRET = process.env.INGEST_SECRET;

// Every row this suite writes carries this prefix in a name, note, or workout
// id, so cleanup matches exactly what the suite created.
const TAG = "__training_test__";
const BIKE = `${TAG}bike`;
const SHOES = `${TAG}shoes`;
const WETSUIT = `${TAG}wetsuit`;

let server: TestServer | undefined;
const { callTool, callToolError } = mcpClient(BASE, SECRET);

type Usage = { sessions: number; distanceKm: number; durationMin: number; segmentsWithoutDistance: number };
type Segment = { sport: string; durationMin: number | null; distanceKm: number | null; distanceM?: number; equipment: { name: string }[] };
type Session = {
  id: number;
  date: string;
  status: string;
  kind: string;
  source: string;
  totalDistanceKm: number | null;
  totalDurationMin: number | null;
  segments: Segment[];
};
type Stock = { name: string; onHand: number; plannedNeed: number; raceNeed: number; shortfall: number };
type LoggedSession = {
  session: Session & { carbsPerHour: number | null };
  equipment: { name: string; usage: Usage }[];
  fuelStock: Stock[];
};
const GEL = `${TAG}gel`;

async function removeTestRows(): Promise<void> {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    await sql`
      delete from training_sessions
      where notes like ${`${TAG}%`} or workout_id like ${`${TAG}%`}
    `;
    await sql`
      delete from stock_events
      where consumable_id in (select id from consumables where name like ${`${TAG}%`})
    `;
    await sql`
      delete from race_fuel
      where consumable_id in (select id from consumables where name like ${`${TAG}%`})
    `;
    await sql`delete from consumables where name like ${`${TAG}%`}`;
    await sql`delete from expenses where description like ${`${TAG}%`}`;
    await sql`delete from races where name like ${`${TAG}%`}`;
    await sql`delete from equipment where name like ${`${TAG}%`}`;
    await sql`delete from workouts where id like ${`${TAG}%`}`;
    // Keys embed row ids, not names; the test database is this suite's own.
    await sql`delete from attention_dismissals`;
  } finally {
    await sql.end();
  }
}

async function usageOf(name: string): Promise<Usage> {
  const { equipment } = await callTool<{ equipment: { name: string; usage: Usage }[] }>("list_equipment");
  const item = equipment.find((e) => e.name === name);
  assert.ok(item, `${name} is listed`);
  return item.usage;
}

async function stockOf(name: string) {
  const { consumables } = await callTool<{
    consumables: (Stock & { expiry: { expiredServings: number } })[];
  }>("list_consumables");
  const item = consumables.find((c) => c.name === name);
  assert.ok(item, `${name} is listed`);
  return item;
}

async function sessionsOn(date: string, includeDeleted = false): Promise<Session[]> {
  const { sessions } = await callTool<{ sessions: Session[] }>("list_training_sessions", {
    from: date,
    to: date,
    include_deleted: includeDeleted,
  });
  return sessions;
}

async function ingest(workouts: Record<string, unknown>[]): Promise<void> {
  const res = await fetch(`${BASE}/api/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${INGEST_SECRET}` },
    body: JSON.stringify({ data: { workouts } }),
  });
  assert.equal(res.status, 200, `ingest failed: ${await res.text()}`);
}

before(async () => {
  assert.ok(SECRET, "MCP_SECRET must be set in .env.local for the test");
  assert.ok(INGEST_SECRET, "INGEST_SECRET must be set in .env.local for the test");
  await removeTestRows();
  server = await startTestServer(PORT);
  await callTool("set_equipment", { name: BIKE, category: "bike" });
  await callTool("set_equipment", { name: SHOES, category: "shoes" });
});

after(() => {
  server?.stop();
});

after(removeTestRows);

test("a completed ride adds exactly its distance to the bike, and edits replace it", async () => {
  const before = await usageOf(BIKE);

  const logged = await callTool<LoggedSession>("log_training_session", {
    date: "2020-03-01",
    segments: [{ sport: "bike", duration_min: 120, distance_km: 60, equipment: [BIKE] }],
    notes: TAG,
  });
  assert.equal(logged.session.kind, "bike");
  assert.equal(logged.session.source, "manual");
  assert.equal(logged.equipment[0].usage.distanceKm, before.distanceKm + 60, "the ride adds 60 km");

  const edit = {
    id: logged.session.id,
    segments: [{ sport: "bike", duration_min: 100, distance_km: 50, equipment: [BIKE] }],
  };
  await callTool("update_training_session", edit);
  // A retried edit is the same edit: usage is derived, not incremented.
  await callTool("update_training_session", edit);
  assert.equal((await usageOf(BIKE)).distanceKm, before.distanceKm + 50, "the edit replaces 60 with 50");

  await callTool("delete_training_session", { id: logged.session.id });
  assert.equal((await usageOf(BIKE)).distanceKm, before.distanceKm, "a deleted ride stops counting");
  assert.equal((await sessionsOn("2020-03-01")).length, 0, "a deleted session is hidden by default");
  assert.equal((await sessionsOn("2020-03-01", true)).length, 1, "but kept in the recycle bin");

  await callTool("restore_deleted", { kind: "training_session", id: logged.session.id });
  assert.equal((await usageOf(BIKE)).distanceKm, before.distanceKm + 50, "a restored ride counts again");
});

test("a brick credits each leg's distance only to the gear used on that leg", async () => {
  const [bikeBefore, shoesBefore] = [await usageOf(BIKE), await usageOf(SHOES)];

  const logged = await callTool<LoggedSession>("log_training_session", {
    date: "2020-03-02",
    segments: [
      { sport: "bike", duration_min: 75, distance_km: 40, equipment: [BIKE] },
      { sport: "run", duration_min: 30, distance_km: 6, equipment: [SHOES] },
    ],
    notes: TAG,
  });
  assert.equal(logged.session.kind, "brick");
  assert.deepEqual(logged.session.segments.map((s) => s.sport), ["bike", "run"], "legs keep their order");
  assert.equal(logged.session.totalDistanceKm, 46);
  assert.equal(logged.session.totalDurationMin, 105);
  assert.equal((await usageOf(BIKE)).distanceKm, bikeBefore.distanceKm + 40, "bike gets the bike leg only");
  assert.equal((await usageOf(SHOES)).distanceKm, shoesBefore.distanceKm + 6, "shoes get the run leg only");
});

test("a planned session counts toward usage only once it is completed", async () => {
  const before = await usageOf(SHOES);

  const planned = await callTool<LoggedSession>("log_training_session", {
    date: "2020-03-03",
    status: "planned",
    segments: [{ sport: "run", distance_km: 8, equipment: [SHOES] }],
    notes: TAG,
  });
  assert.equal(planned.session.status, "planned");
  assert.equal(planned.session.totalDurationMin, null, "a total is null when a leg lacks it");
  assert.equal((await usageOf(SHOES)).distanceKm, before.distanceKm, "planned distance is not usage");

  const raceWheels = `${TAG}race wheels`;
  await callTool("set_equipment", { name: raceWheels, category: "bike" });
  await callTool("log_training_session", {
    date: "2020-03-03",
    status: "planned",
    segments: [{ sport: "bike", distance_km: 30, equipment: [raceWheels] }],
    notes: TAG,
  });
  assert.equal((await usageOf(raceWheels)).sessions, 0, "gear only on planned sessions is listed, unused");

  const refused = await callToolError("update_training_session", { id: planned.session.id, status: "completed" });
  assert.match(refused, /no duration/i, "completing needs the duration that was run");

  await callTool("update_training_session", {
    id: planned.session.id,
    status: "completed",
    segments: [{ sport: "run", duration_min: 44, distance_km: 8.2, equipment: [SHOES] }],
  });
  assert.equal((await usageOf(SHOES)).distanceKm, before.distanceKm + 8.2);
});

test("swims take metres and read back in both units", async () => {
  await callTool("set_equipment", { name: WETSUIT, category: "wetsuit" });
  const logged = await callTool<LoggedSession>("log_training_session", {
    date: "2020-03-04",
    segments: [{ sport: "swim", duration_min: 42, distance_m: 1900, equipment: [WETSUIT] }],
    notes: TAG,
  });
  assert.equal(logged.session.segments[0].distanceKm, 1.9);
  assert.equal(logged.session.segments[0].distanceM, 1900);
});

test("invalid sessions are refused without writing anything", async () => {
  const date = "2020-03-05";
  await callTool("set_equipment", { name: `${TAG}tri suit`, category: "apparel", status: "needed" });

  const cases: [Record<string, unknown>, RegExp][] = [
    [{ segments: [{ sport: "run", distance_km: 5 }] }, /no duration_min/],
    [{ segments: [{ sport: "bike", duration_min: 60, equipment: [`${TAG}nope`] }] }, /Unknown equipment/],
    [{ segments: [{ sport: "run", duration_min: 60, equipment: [`${TAG}tri suit`] }] }, /Not in hand/],
    [{ segments: [{ sport: "swim", duration_min: 30, distance_km: 1, distance_m: 1000 }] }, /not both/],
  ];
  for (const [args, message] of cases) {
    const error = await callToolError("log_training_session", { date, notes: TAG, ...args });
    assert.match(error, message);
  }
  assert.equal((await sessionsOn(date, true)).length, 0, "no refused call left a session behind");
});

test("Apple Health swims, rides, and runs become sessions without duplicating logged ones", async () => {
  // A ride with nothing logged that day becomes its own imported session, once.
  const ride = {
    id: `${TAG}ride`,
    name: "Outdoor Cycling",
    start: "2020-03-10 07:00:00 -0700",
    end: "2020-03-10 09:00:00 -0700",
    duration: 7200,
    distance: { qty: 55.5, units: "km" },
  };
  await ingest([ride]);
  await ingest([ride]);
  const rides = await sessionsOn("2020-03-10");
  assert.equal(rides.length, 1, "re-ingesting the same workout does not duplicate it");
  assert.equal(rides[0].source, "imported");
  assert.equal(rides[0].status, "completed");
  assert.equal(rides[0].segments[0].durationMin, 120);
  assert.equal(rides[0].segments[0].distanceKm, 55.5);

  // A planned run is completed by the watch, with the measured values.
  await callTool("log_training_session", {
    date: "2020-03-11",
    status: "planned",
    segments: [{ sport: "run", duration_min: 60, distance_km: 10 }],
    notes: TAG,
  });
  await ingest([
    {
      id: `${TAG}run`,
      name: "Outdoor Run",
      start: "2020-03-11 18:00:00 -0700",
      duration: 3000,
      distance: { qty: 6.2, units: "mi" },
    },
  ]);
  const runs = await sessionsOn("2020-03-11");
  assert.equal(runs.length, 1, "the run attached to the planned session");
  assert.equal(runs[0].status, "completed");
  assert.equal(runs[0].source, "imported");
  assert.equal(runs[0].segments[0].durationMin, 50);
  assert.equal(runs[0].segments[0].distanceKm, 9.98, "miles are converted to km");

  // A swim already logged by hand keeps what was entered and gains the link.
  await callTool("log_training_session", {
    date: "2020-03-12",
    segments: [{ sport: "swim", duration_min: 30, distance_m: 1500 }],
    notes: TAG,
  });
  await ingest([
    {
      id: `${TAG}swim`,
      name: "Pool Swim",
      start: "2020-03-12 06:30:00 -0700",
      duration: 1920,
      distance: { qty: 1600, units: "m" },
    },
  ]);
  const swims = await sessionsOn("2020-03-12");
  assert.equal(swims.length, 1, "the swim attached to the logged session");
  assert.equal(swims[0].source, "imported");
  assert.equal(swims[0].segments[0].distanceM, 1500, "asserted values outrank the watch");

  // Unknown distance units are dropped rather than guessed; walks are not sessions.
  await ingest([
    {
      id: `${TAG}odd-unit`,
      name: "Indoor Cycling",
      start: "2020-03-13 07:00:00 -0700",
      duration: 1800,
      distance: { qty: 12, units: "furlong" },
    },
    {
      id: `${TAG}walk`,
      name: "Outdoor Walk",
      start: "2020-03-13 12:00:00 -0700",
      duration: 1800,
      distance: { qty: 3, units: "km" },
    },
  ]);
  const day = await sessionsOn("2020-03-13");
  assert.equal(day.length, 1, "only the ride became a session");
  assert.equal(day[0].segments[0].distanceKm, null);
});

test("fuel used on a session draws down stock exactly once, through edits and deletes", async () => {
  await callTool("set_consumable", { name: GEL, kind: "gel", serving_unit: "gel", carbs_g: 22 });
  await callTool("adjust_stock", { product: GEL, servings: 6, note: "starting count" });
  assert.equal((await stockOf(GEL)).onHand, 6);

  const logged = await callTool<LoggedSession>("log_training_session", {
    date: "2020-03-20",
    segments: [{ sport: "bike", duration_min: 60, distance_km: 30 }],
    fuel: [{ product: GEL, servings: 2 }],
    notes: TAG,
  });
  assert.deepEqual(logged.fuelStock.map((f) => [f.name, f.onHand]), [[GEL, 4]], "the response shows 4 left");
  assert.equal(logged.session.carbsPerHour, 44, "2 x 22 g over one hour");

  const edited = await callTool<LoggedSession>("update_training_session", {
    id: logged.session.id,
    fuel: [{ product: GEL, servings: 1 }],
  });
  assert.equal(edited.fuelStock[0].onHand, 5, "editing 2 down to 1 leaves 5, not 3");

  await callTool("delete_training_session", { id: logged.session.id });
  assert.equal((await stockOf(GEL)).onHand, 6, "a deleted session gives its fuel back");
  await callTool("restore_deleted", { kind: "training_session", id: logged.session.id });
  assert.equal((await stockOf(GEL)).onHand, 5);
});

test("planned fuel is a need, never a deduction", async () => {
  const before = await stockOf(GEL);
  const planned = await callTool<LoggedSession>("log_training_session", {
    date: "2099-01-01",
    status: "planned",
    segments: [{ sport: "bike", distance_km: 90 }],
    fuel: [{ product: GEL, servings: before.onHand + 3 }],
    notes: TAG,
  });
  const after = await stockOf(GEL);
  assert.equal(after.onHand, before.onHand, "nothing is deducted for a planned session");
  assert.equal(after.plannedNeed, before.plannedNeed + before.onHand + 3);
  assert.equal(after.shortfall, after.plannedNeed - after.onHand, "the gap to the plan is reported");

  await callTool("delete_training_session", { id: planned.session.id });
  assert.equal((await stockOf(GEL)).plannedNeed, before.plannedNeed, "a deleted plan is no longer a need");
});

test("expired lots are flagged and fuel inputs are validated", async () => {
  const salt = `${TAG}salt tabs`;
  await callTool("set_consumable", { name: salt, kind: "electrolyte", serving_unit: "tab" });
  await callTool("adjust_stock", { product: salt, servings: 4, expires_on: "2020-01-01" });
  await callTool("adjust_stock", { product: salt, servings: 10, expires_on: "2099-01-01" });
  assert.equal((await stockOf(salt)).expiry.expiredServings, 4);

  const unknown = await callToolError("log_training_session", {
    date: "2020-03-21",
    segments: [{ sport: "run", duration_min: 30 }],
    fuel: [{ product: `${TAG}nope`, servings: 1 }],
    notes: TAG,
  });
  assert.match(unknown, /Unknown fuel/);
  const twice = await callToolError("log_training_session", {
    date: "2020-03-21",
    segments: [{ sport: "run", duration_min: 30 }],
    fuel: [
      { product: salt, servings: 1 },
      { product: salt.toUpperCase(), servings: 1 },
    ],
    notes: TAG,
  });
  assert.match(twice, /each product once/);
  assert.equal((await sessionsOn("2020-03-21", true)).length, 0, "refused calls wrote nothing");
});

type Rule = { equipment: string; name: string; state: string; kmSince: number; reasons: string[] };
type MaintenanceStatus = { due: string[]; rules: Rule[]; recentServices: { id: number; rule: string | null }[] };

test("a maintenance rule comes due from usage and a logged service resolves it", async () => {
  const roadBike = `${TAG}road bike`;
  await callTool("set_equipment", { name: roadBike, category: "bike" });
  await callTool("set_maintenance_rule", {
    equipment: roadBike,
    name: "chain check",
    every_km: 100,
    starts_on: "2020-04-01",
  });
  const status = () => callTool<MaintenanceStatus>("get_maintenance_status", { equipment: roadBike });
  const chain = async () => (await status()).rules.find((r) => r.name === "chain check")!;

  await callTool("log_training_session", {
    date: "2020-04-02",
    segments: [{ sport: "bike", duration_min: 180, distance_km: 95, equipment: [roadBike] }],
    notes: TAG,
  });
  assert.equal((await chain()).state, "approaching", "95 of 100 km");

  const second = await callTool<LoggedSession>("log_training_session", {
    date: "2020-04-03",
    segments: [{ sport: "bike", duration_min: 30, distance_km: 10, equipment: [roadBike] }],
    notes: TAG,
  });
  const due = await status();
  assert.deepEqual(due.due, [`${roadBike}: chain check`], "exactly one actionable warning");
  assert.deepEqual(due.rules[0].reasons, ["105 km of every 100 km"]);

  await callTool("delete_training_session", { id: second.session.id });
  assert.equal((await chain()).state, "approaching", "status follows edits to the training it counts");
  await callTool("restore_deleted", { kind: "training_session", id: second.session.id });

  await callTool("log_service", { equipment: roadBike, rule: "chain check", date: "2020-04-03" });
  const serviced = await status();
  assert.deepEqual(serviced.due, [], "the service resolves the warning");
  assert.equal(serviced.rules[0].kmSince, 0, "a ride on the service day counts toward the old interval");

  await callTool("delete_service_log", { id: serviced.recentServices[0].id });
  assert.equal((await chain()).state, "due", "deleting the service brings the warning back");
  await callTool("restore_deleted", { kind: "service_log", id: serviced.recentServices[0].id });
  assert.equal((await chain()).state, "ok");
});

test("time-based rules come due by the calendar, and every rule needs an interval", async () => {
  const helmet = `${TAG}helmet`;
  await callTool("set_equipment", { name: helmet, category: "helmet" });
  await callTool("set_maintenance_rule", {
    equipment: helmet,
    name: "strap inspection",
    every_days: 30,
    starts_on: "2020-01-01",
  });
  const { rules } = await callTool<MaintenanceStatus>("get_maintenance_status", { equipment: helmet });
  assert.equal(rules[0].state, "due", "years past a 30-day interval");

  const none = await callToolError("set_maintenance_rule", { equipment: helmet, name: "visor" });
  assert.match(none, /at least one/);
  const cleared = await callToolError("set_maintenance_rule", {
    equipment: helmet,
    name: "strap inspection",
    every_days: null,
  });
  assert.match(cleared, /at least one/, "clearing the only interval is refused");
});

type Expense = { id: number; status: string; amount: number; currency: string; amountUsd: number | null };
type Budget = {
  paidUsd: number;
  plannedUsd: number;
  byCategory: Record<string, { paidUsd: number; plannedUsd: number }>;
  unconverted: { currency: string; amount: number; expenseIds: number[] }[];
};

const budgetOn = (date: string) => callTool<Budget>("get_budget_summary", { from: date, to: date });

test("buying needed gear posts one expense and puts it in hand, not race-ready", async () => {
  const wetsuit = `${TAG}race wetsuit`;
  await callTool("set_equipment", { name: wetsuit, category: "wetsuit", status: "needed" });

  const bought = await callTool<{
    expense: Expense;
    acquired: boolean;
    equipment: { status: string; acquiredOn: string };
  }>("log_expense", { description: `${TAG}wetsuit`, amount: 200, equipment: wetsuit, date: "2020-05-01" });
  assert.equal(bought.expense.amountUsd, 200);
  assert.equal(bought.acquired, true);
  assert.equal(bought.equipment.status, "owned", "acquired - and nothing more");
  assert.equal(bought.equipment.acquiredOn, "2020-05-01");

  const budget = await budgetOn("2020-05-01");
  assert.equal(budget.paidUsd, 200, "the purchase counts once in actual spend");
  assert.deepEqual(budget.byCategory, { equipment: { paidUsd: 200, plannedUsd: 0 } });

  await callTool("delete_expense", { id: bought.expense.id });
  assert.equal((await budgetOn("2020-05-01")).paidUsd, 0, "a deleted expense leaves the totals");
  await callTool("restore_deleted", { kind: "expense", id: bought.expense.id });
  assert.equal((await budgetOn("2020-05-01")).paidUsd, 200);
});

test("a planned expense moves to paid in place instead of counting twice", async () => {
  const { expense } = await callTool<{ expense: Expense }>("log_expense", {
    description: `${TAG}race entry`,
    amount: 350,
    category: "registration",
    status: "planned",
    date: "2020-05-02",
  });
  assert.deepEqual(
    [(await budgetOn("2020-05-02")).paidUsd, (await budgetOn("2020-05-02")).plannedUsd],
    [0, 350],
  );
  await callTool("update_expense", { id: expense.id, status: "paid" });
  const after = await budgetOn("2020-05-02");
  assert.deepEqual([after.paidUsd, after.plannedUsd], [350, 0]);
});

test("foreign-currency spend stays unconverted until a rate is declared", async () => {
  const { expense } = await callTool<{ expense: Expense }>("log_expense", {
    description: `${TAG}physio`,
    amount: 100,
    currency: "sgd",
    category: "other",
    date: "2020-05-03",
  });
  assert.equal(expense.currency, "SGD");
  assert.equal(expense.amountUsd, null);
  const unconverted = await budgetOn("2020-05-03");
  assert.equal(unconverted.paidUsd, 0, "no guessed conversion");
  assert.deepEqual(unconverted.unconverted, [
    { currency: "SGD", status: "paid", amount: 100, expenseIds: [expense.id] },
  ]);

  const rated = await callTool<{ expense: Expense & { usdPerUnit: number } }>("update_expense", {
    id: expense.id,
    usd_per_unit: 0.74,
  });
  assert.equal(rated.expense.amount, 100, "the original amount is kept for audit");
  assert.equal(rated.expense.amountUsd, 74);
  const converted = await budgetOn("2020-05-03");
  assert.equal(converted.paidUsd, 74);
  assert.deepEqual(converted.unconverted, []);

  const refused = await callToolError("log_expense", {
    description: `${TAG}bad`,
    amount: 5,
    usd_per_unit: 1.2,
    category: "other",
  });
  assert.match(refused, /takes no usd_per_unit/);
});

test("bought fuel is stock only once the purchase is paid", async () => {
  const mix = `${TAG}drink mix`;
  await callTool("set_consumable", { name: mix, kind: "drink mix", serving_unit: "scoop", carbs_g: 40 });

  const { expense } = await callTool<{ expense: Expense }>("log_expense", {
    description: `${TAG}drink mix tub`,
    amount: 30,
    status: "planned",
    date: "2020-05-04",
    stock: [{ product: mix, servings: 20, expires_on: "2099-01-01" }],
  });
  assert.equal((await stockOf(mix)).onHand, 0, "a planned purchase is not on the shelf");
  await callTool("update_expense", { id: expense.id, status: "paid" });
  assert.equal((await stockOf(mix)).onHand, 20);
  await callTool("delete_expense", { id: expense.id });
  assert.equal((await stockOf(mix)).onHand, 0, "deleting the purchase removes its stock");
});

test("totals are exact to the cent", async () => {
  for (const amount of [0.1, 0.2]) {
    await callTool("log_expense", { description: `${TAG}cents`, amount, category: "other", date: "2020-05-05" });
  }
  assert.equal((await budgetOn("2020-05-05")).paidUsd, 0.3);
});

test("a race reports days to go, recent milestones, and its own budget", async () => {
  const today = dayKeyInZone(new Date());
  const race = `${TAG}santa cruz`;
  const created = await callTool<{ race: { swimKm: number; bikeKm: number; runKm: number } }>("set_race", {
    name: race,
    race_date: shiftDayKey(today, 100),
    format: "70.3",
    location: "Santa Cruz, CA",
    budget_usd: 1000,
  });
  assert.deepEqual(
    [created.race.swimKm, created.race.bikeKm, created.race.runKm],
    [1.93, 90.12, 21.08],
    "nominal 1.2 / 56 / 13.1 mi",
  );
  await callTool("set_race", { name: `${TAG}tune-up`, race_date: shiftDayKey(today, 160), format: "70.3" });
  await callTool("set_race", { name: `${TAG}last season`, race_date: shiftDayKey(today, -300), format: "70.3" });

  const log = (daysAgo: number, segments: unknown[]) =>
    callTool("log_training_session", { date: shiftDayKey(today, -daysAgo), segments, notes: TAG });
  await log(3, [{ sport: "bike", duration_min: 120, distance_km: 60 }]);
  await log(10, [
    { sport: "bike", duration_min: 150, distance_km: 70 },
    { sport: "run", duration_min: 30, distance_km: 6 },
  ]);
  await log(5, [{ sport: "run", duration_min: 75, distance_km: 15 }]);
  await log(100, [{ sport: "swim", duration_min: 45, distance_m: 2000 }]);

  for (const description of ["entry", "hotel", "unrelated"]) {
    await callTool("log_expense", {
      description: `${TAG}${description}`,
      amount: description === "entry" ? 400 : 300,
      category: description === "unrelated" ? "other" : description === "entry" ? "registration" : "travel",
      status: description === "hotel" ? "planned" : "paid",
      ...(description === "unrelated" ? {} : { race }),
    });
  }

  type Milestone = { sport: string; longestRecentKm: number | null; shareOfRace: number | null; weeklyHoursRecent: number };
  const status = await callTool<{
    race: { name: string };
    daysToGo: number;
    milestones: Milestone[];
    budget: { paidUsd: number; plannedUsd: number; remainingAfterPaidUsd: number; remainingAfterCommittedUsd: number };
  }>("get_race_status");
  assert.equal(status.race.name, race, "the next upcoming race is the default");
  assert.equal(status.daysToGo, 100);

  const bySport = Object.fromEntries(status.milestones.map((m) => [m.sport, m]));
  assert.equal(bySport.bike.longestRecentKm, 70, "a brick's bike leg counts as a ride");
  assert.equal(bySport.bike.shareOfRace, 0.78);
  assert.equal(bySport.bike.weeklyHoursRecent, 1.1, "270 min over 4 weeks");
  assert.equal(bySport.run.longestRecentKm, 15);
  assert.equal(bySport.swim.longestRecentKm, null, "a swim 100 days ago is outside the 12-week window");

  assert.deepEqual(
    [status.budget.paidUsd, status.budget.plannedUsd],
    [400, 300],
    "only expenses attributed to the race count",
  );
  assert.equal(status.budget.remainingAfterPaidUsd, 600);
  assert.equal(status.budget.remainingAfterCommittedUsd, 300);
});

type GearItem = { label: string; state: string; evidence: string };

test("a race checklist shows missing, acquired, tested, and ready gear from one inventory", async () => {
  const today = dayKeyInZone(new Date());
  const race = `${TAG}gear race`;
  await callTool("set_race", { name: race, race_date: shiftDayKey(today, 400) });
  const suit = `${TAG}open water wetsuit`;
  const belt = `${TAG}race belt`;
  await callTool("set_equipment", { name: suit, category: "wetsuit", status: "needed" });
  await callTool("set_equipment", { name: belt, category: "apparel" });

  const gear = async () => {
    const status = await callTool<{ gear: GearItem[] }>("get_race_status", { race });
    return Object.fromEntries(status.gear.map((g) => [g.label, g]));
  };
  await callTool("set_race_gear", { race, label: "wetsuit", equipment: suit });
  await callTool("set_race_gear", { race, label: "race belt", equipment: belt });
  await callTool("set_race_gear", { race, label: "helmet" });

  let state = await gear();
  assert.equal(state.wetsuit.state, "missing", "a needed item is missing");
  assert.equal(state.helmet.state, "missing");
  assert.match(state.helmet.evidence, /no inventory item/);
  assert.equal(state["race belt"].state, "acquired", "owned but never used");

  const refused = await callToolError("set_race_gear", { race, label: "wetsuit", ready: true });
  assert.match(refused, /is needed/, "a missing item cannot be confirmed ready");

  await callTool("log_expense", { description: `${TAG}wetsuit buy`, amount: 200, equipment: suit, race });
  assert.equal((await gear()).wetsuit.state, "acquired", "buying it is acquisition, not readiness");

  await callTool("log_training_session", {
    date: "2020-06-01",
    segments: [{ sport: "swim", duration_min: 40, distance_m: 1800, equipment: [suit] }],
    notes: TAG,
  });
  state = await gear();
  assert.equal(state.wetsuit.state, "tested");
  assert.match(state.wetsuit.evidence, /used in 1 completed session/);

  await callTool("set_race_gear", { race, label: "wetsuit", ready: true });
  assert.equal((await gear()).wetsuit.state, "ready");

  const unused = await callTool<{ warning?: string }>("set_race_gear", { race, label: "race belt", ready: true });
  assert.match(unused.warning ?? "", /never been used/, "confirming untested gear is allowed but called out");

  const spare = `${TAG}spare wetsuit`;
  await callTool("set_equipment", { name: spare, category: "wetsuit" });
  await callTool("set_race_gear", { race, label: "wetsuit", equipment: spare });
  assert.equal((await gear()).wetsuit.state, "acquired", "a different item needs its own confirmation");
});

type Task = { title: string; state: string; daysUntilDue: number | null; confirmation: string | null; expense: { id: number } | null };

test("race deadlines flag overdue and due-soon bookings, and a booking's cost joins the race budget", async () => {
  const today = dayKeyInZone(new Date());
  const race = `${TAG}logistics race`;
  await callTool("set_race", { name: race, race_date: shiftDayKey(today, 200), budget_usd: 2000 });

  await callTool("set_race_task", { race, title: "Register", category: "registration", due_on: shiftDayKey(today, -1) });
  await callTool("set_race_task", { race, title: "Book lodging", category: "lodging", due_on: shiftDayKey(today, 10) });
  await callTool("set_race_task", { race, title: "Ship bike", category: "bike_transport", due_on: shiftDayKey(today, 60) });
  await callTool("set_race_task", { race, title: "Pack transition bags", category: "checkin" });

  const tasks = async () => {
    const status = await callTool<{ tasks: Task[]; budget: { paidUsd: number } }>("get_race_status", { race });
    return { byTitle: Object.fromEntries(status.tasks.map((t) => [t.title, t])), budget: status.budget };
  };
  let { byTitle } = await tasks();
  assert.equal(byTitle.Register.state, "overdue");
  assert.equal(byTitle["Book lodging"].state, "due_soon");
  assert.equal(byTitle["Ship bike"].state, "open");
  assert.equal(byTitle["Pack transition bags"].state, "open", "no deadline, never overdue");

  const { expense } = await callTool<{ expense: { id: number } }>("log_expense", {
    description: `${TAG}motel`,
    amount: 450,
    category: "travel",
  });
  await callTool("set_race_task", {
    race,
    title: "book LODGING",
    done: true,
    confirmation: "HX-2231",
    expense_id: expense.id,
  });
  const after = await tasks();
  byTitle = after.byTitle;
  assert.equal(byTitle["Book lodging"].state, "done", "titles match case-insensitively");
  assert.equal(byTitle["Book lodging"].confirmation, "HX-2231");
  assert.equal(after.budget.paidUsd, 450, "linking the booking's expense attributes it to the race");

  await callTool("set_race", { name: `${TAG}other race`, race_date: shiftDayKey(today, 300) });
  const refused = await callToolError("set_race_task", {
    race: `${TAG}other race`,
    title: "Hotel",
    expense_id: expense.id,
  });
  assert.match(refused, /another race/);
});

test("a race fueling plan totals its nutrition and counts toward the stock shortfall", async () => {
  const today = dayKeyInZone(new Date());
  const race = `${TAG}fuel race`;
  await callTool("set_race", { name: race, race_date: shiftDayKey(today, 500) });
  const gel = `${TAG}race gel`;
  const chews = `${TAG}chews`;
  await callTool("set_consumable", { name: gel, kind: "gel", carbs_g: 25, sodium_mg: 50, caffeine_mg: 0 });
  await callTool("set_consumable", { name: chews, kind: "chew", carbs_g: 24 });
  await callTool("adjust_stock", { product: gel, servings: 4 });

  await callTool("set_race_fuel", { race, product: gel, servings: 6 });
  const plan = await callTool<{
    fuelPlan: { totalCarbsG: number | null; totalSodiumMg: number | null };
  }>("set_race_fuel", { race, product: chews, servings: 2 });
  assert.equal(plan.fuelPlan.totalCarbsG, 198, "6 x 25 + 2 x 24");
  assert.equal(plan.fuelPlan.totalSodiumMg, null, "chews have no sodium figure, so no total is claimed");

  const gelStock = await stockOf(gel);
  assert.equal(gelStock.raceNeed, 6);
  assert.equal(gelStock.shortfall, 2, "6 planned for the race, 4 on hand");

  const status = await callTool<{ fuelPlan: { stock: { product: string; shortfall: number }[] } }>(
    "get_race_status",
    { race },
  );
  assert.deepEqual(
    status.fuelPlan.stock.map((s) => [s.product, s.shortfall]).sort(),
    [[chews, 2], [gel, 2]],
  );

  await callTool("set_race_fuel", { race, product: chews, servings: 0 });
  assert.equal((await stockOf(chews)).shortfall, 0, "removing it from the plan removes the need");
});

type Attention = {
  items: {
    key: string;
    severity: string;
    area: string;
    reason: string;
    nextAction: string;
    dismissed?: { until: string | null };
  }[];
  hidden: number;
};

test("the needs-attention feed surfaces blockers once, with reasons, and honours dismiss and snooze", async () => {
  const today = dayKeyInZone(new Date());
  const race = `${TAG}close race`;
  await callTool("set_race", { name: race, race_date: shiftDayKey(today, 20) });
  const goggles = `${TAG}goggles`;
  const trainer = `${TAG}trainer bike`;
  await callTool("set_equipment", { name: goggles, category: "goggles" });
  await callTool("set_equipment", { name: trainer, category: "bike" });
  await callTool("set_race_gear", { race, label: "goggles", equipment: goggles });
  await callTool("set_race_gear", { race, label: "bike" });
  await callTool("set_maintenance_rule", { equipment: trainer, name: "tyre check", every_km: 50, starts_on: "2020-07-01" });
  const ride = await callTool<LoggedSession>("log_training_session", {
    date: "2020-07-02",
    segments: [{ sport: "bike", duration_min: 90, distance_km: 46, equipment: [trainer] }],
    notes: TAG,
  });
  const stale = await callTool<LoggedSession>("log_training_session", {
    date: "2020-07-03",
    status: "planned",
    segments: [{ sport: "run", distance_km: 10 }],
    notes: TAG,
  });

  const feed = () => callTool<Attention>("get_needs_attention");
  const mine = (a: Attention, text: string) => a.items.filter((i) => i.reason.includes(text));

  let attention = await feed();
  const [missingBike] = mine(attention, `${race} (20 days): bike is missing`);
  assert.equal(missingBike.severity, "blocker", "missing gear 20 days out blocks");
  assert.match(missingBike.nextAction, /set_race_gear/);
  const [untested] = mine(attention, `goggles (${goggles}) has never been used`);
  assert.equal(untested.severity, "warning");
  const tyre = mine(attention, `${trainer}: tyre check`);
  assert.equal(tyre.length, 1, "one item per rule");
  assert.match(tyre[0].reason, /is approaching \(46 km of every 50 km since 2020-07-01\)/);
  assert.equal(mine(attention, `Session ${stale.session.id} planned for 2020-07-03`).length, 1);
  assert.equal(
    attention.items.findIndex((i) => i.severity !== "blocker") >
      attention.items.findLastIndex((i) => i.severity === "blocker"),
    true,
    "blockers come first",
  );

  await callTool("dismiss_attention", { key: tyre[0].key });
  attention = await feed();
  assert.equal(mine(attention, `${trainer}: tyre check`).length, 0, "dismissed items are hidden");
  assert.ok(attention.hidden >= 1);

  await callTool("update_training_session", {
    id: ride.session.id,
    segments: [{ sport: "bike", duration_min: 100, distance_km: 52, equipment: [trainer] }],
  });
  const due = mine(await feed(), `${trainer}: tyre check`);
  assert.equal(due.length, 1, "getting worse brings a dismissed item back");
  assert.match(due[0].reason, /is due/);

  await callTool("dismiss_attention", { key: missingBike.key, snooze_until: shiftDayKey(today, 3) });
  assert.equal(mine(await feed(), `${race} (20 days): bike is missing`).length, 0, "snoozed");
  const withDismissed = await callTool<Attention>("get_needs_attention", { include_dismissed: true });
  assert.equal(
    withDismissed.items.find((i) => i.key === missingBike.key)?.dismissed?.until,
    shiftDayKey(today, 3),
  );
  await callTool("dismiss_attention", { key: missingBike.key, undo: true });
  assert.equal(mine(await feed(), `${race} (20 days): bike is missing`).length, 1, "undo shows it again");

  await callTool("log_service", { equipment: trainer, rule: "tyre check", date: "2020-07-04" });
  assert.equal(mine(await feed(), `${trainer}: tyre check`).length, 0, "the service resolves it");
});
