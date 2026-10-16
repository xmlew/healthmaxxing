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

// Every row this suite writes carries this prefix in a name or note, so cleanup
// matches exactly what the suite created.
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
  totalDistanceKm: number | null;
  totalDurationMin: number | null;
  segments: Segment[];
};
type LoggedSession = { session: Session; equipment: { name: string; usage: Usage }[] };

async function removeTestRows(): Promise<void> {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    await sql`delete from training_sessions where notes like ${`${TAG}%`}`;
    await sql`delete from equipment where name like ${`${TAG}%`}`;
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

async function sessionsOn(date: string, includeDeleted = false): Promise<Session[]> {
  const { sessions } = await callTool<{ sessions: Session[] }>("list_training_sessions", {
    from: date,
    to: date,
    include_deleted: includeDeleted,
  });
  return sessions;
}

before(async () => {
  assert.ok(SECRET, "MCP_SECRET must be set in .env.local for the test");
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

  await callTool("restore_training_session", { id: logged.session.id });
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
