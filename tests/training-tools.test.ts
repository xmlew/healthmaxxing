import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { mcpClient } from "./support/mcp";
import { startTestServer, type TestServer } from "./support/server";
import { selectTestDatabase } from "./support/test-db";

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
type Stock = { name: string; onHand: number; plannedNeed: number; shortfall: number };
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
    await sql`delete from consumables where name like ${`${TAG}%`}`;
    await sql`delete from expenses where description like ${`${TAG}%`}`;
    await sql`delete from equipment where name like ${`${TAG}%`}`;
    await sql`delete from workouts where id like ${`${TAG}%`}`;
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
