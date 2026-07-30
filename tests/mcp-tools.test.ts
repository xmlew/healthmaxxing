import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import dotenv from "dotenv";
import postgres from "postgres";

dotenv.config({ path: ".env.local" });

const PORT = 3130;
const BASE = `http://localhost:${PORT}`;
const SECRET = process.env.MCP_SECRET;

// Sentinel exercises the strength tests write; cleaned up in after().
const STRENGTH_TEST_EXERCISE = "__mcp_test_lift__";
const WORKOUT_TEST_EXERCISE = "__mcp_test_press__";
const WORKOUT_TEST_ACCESSORY = "__mcp_test_raise__";
const TEST_EXERCISES = [STRENGTH_TEST_EXERCISE, WORKOUT_TEST_EXERCISE, WORKOUT_TEST_ACCESSORY];
let strengthTestSessionId: number | null = null;
const workoutTestSessionIds: number[] = [];

// log_workout back-dates its sessions so PR comparison spans real days.
function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

let server: ChildProcess;

async function waitForServer(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/`, { method: "GET" });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Server did not start on ${BASE} within ${timeoutMs}ms`);
}

type RpcFrame = {
  result?: {
    tools?: { name: string }[];
    content?: { text?: string }[];
    isError?: boolean;
  };
  error?: { message?: string } | null;
};

// mcp-handler replies as SSE: one `data: <json>` line carrying the JSON-RPC frame.
function parseSse(text: string): RpcFrame {
  const line = text.split("\n").find((l) => l.startsWith("data:"));
  if (!line) throw new Error(`No SSE data line in response: ${text.slice(0, 200)}`);
  return JSON.parse(line.slice("data:".length).trim()) as RpcFrame;
}

async function rpc(
  method: string,
  params: unknown,
  { auth = true }: { auth?: boolean } = {},
): Promise<{ status: number; body: RpcFrame }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (auth) headers.Authorization = `Bearer ${SECRET}`;
  const res = await fetch(`${BASE}/api/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const raw = await res.text();
  return { status: res.status, body: res.ok ? parseSse(raw) : { error: { message: raw } } };
}

// Unwrap a tools/call result whose payload is JSON serialized inside content[0].text.
// The payload shape varies per tool, so each caller passes the shape it asserts on.
async function callTool<T = Record<string, unknown>>(
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const { body } = await rpc("tools/call", { name, arguments: args });
  const text = body.result?.content?.[0]?.text;
  assert.ok(text, `tool ${name} returned no content text: ${JSON.stringify(body)}`);
  return JSON.parse(text) as T;
}

before(async () => {
  assert.ok(SECRET, "MCP_SECRET must be set in .env.local for the test");
  server = spawn("npx", ["next", "start", "-p", String(PORT)], {
    stdio: "ignore",
    env: process.env,
  });
  await waitForServer();
});

after(() => {
  server?.kill("SIGTERM");
});

// Remove the sentinel exercise/set/session the strength round-trip test wrote,
// by exact match, so the shared dev DB is left as it was found.
after(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) return;
  const sql = postgres(url, { max: 1 });
  try {
    await sql`delete from strength_sets where exercise_id in (select id from exercises where name = any(${TEST_EXERCISES}))`;
    await sql`delete from exercises where name = any(${TEST_EXERCISES})`;
    // Only the exact sessions these tests created, and only if now empty -
    // never other empty manual sessions on the shared DB.
    const sessionIds = [strengthTestSessionId, ...workoutTestSessionIds].filter(
      (id): id is number => id != null,
    );
    if (sessionIds.length > 0) {
      await sql`
        delete from strength_sessions
        where id = any(${sessionIds})
          and workout_id is null
          and id not in (select session_id from strength_sets)
      `;
    }
  } finally {
    await sql.end();
  }
});

test("tools/list exposes the four new analysis tools", async () => {
  const { body } = await rpc("tools/list", {});
  const tools = body.result?.tools ?? [];
  const names = tools.map((t) => t.name);
  for (const expected of ["get_recovery", "get_tdee", "get_correlation", "get_anomalies"]) {
    assert.ok(names.includes(expected), `tools/list missing ${expected}; got ${names.join(", ")}`);
  }
  assert.equal(tools.length, 23, "expected 23 tools total (22 prior + log_workout)");
});

test("get_macro_summary returns per-day macros and targets", async () => {
  const data = await callTool("get_macro_summary", { days: 7 });
  assert.equal(data.days, 7);
  assert.ok("proteinTargetG" in data, "proteinTargetG present");
  assert.ok("calorieTarget" in data, "calorieTarget present");
  assert.ok(Array.isArray(data.series), "series is an array");
});

test("strength tools are registered and round-trip a logged set", async () => {
  const { body } = await rpc("tools/list", {});
  const names = (body.result?.tools ?? []).map((t) => t.name);
  for (const expected of ["log_set", "get_exercise_history", "get_1rm_estimate"]) {
    assert.ok(names.includes(expected), `tools/list missing ${expected}`);
  }

  const logged = await callTool<{ ok: boolean; setId: number; sessionId: number; estimated1RMLb: number }>("log_set", {
    exercise: STRENGTH_TEST_EXERCISE,
    reps: 5,
    weight_lb: 100,
    muscle_group: "push",
  });
  assert.equal(logged.ok, true, "log_set should succeed");
  assert.ok(logged.setId, "log_set returns a setId");
  strengthTestSessionId = logged.sessionId;
  // Epley: 100 * (1 + 5/30) = 116.7
  assert.equal(logged.estimated1RMLb, 116.7, "log_set echoes the estimated 1RM");

  const history = await callTool<{
    sessions: { volumeLb: number; sets: { setId: number; weightLb: number }[] }[];
  }>("get_exercise_history", { exercise: STRENGTH_TEST_EXERCISE });
  assert.ok(Array.isArray(history.sessions) && history.sessions.length >= 1, "history has a session");
  // Logged in pounds, stored in kilograms, read back in pounds without drift.
  assert.equal(history.sessions[0].sets[0].weightLb, 100, "weight round-trips through kg storage");
  assert.equal(history.sessions[0].volumeLb, 500, "session volume is weight*reps (100*5)");
  assert.ok(history.sessions[0].sets[0].setId, "each set carries a setId");

  const oneRm = await callTool("get_1rm_estimate", { exercise: STRENGTH_TEST_EXERCISE, formula: "brzycki" });
  // Brzycki: 100 * 36/(37-5) = 112.5
  assert.equal(oneRm.currentLb, 112.5, "get_1rm_estimate uses the requested formula");

  const overload = await callTool("get_progressive_overload_status", { exercise: STRENGTH_TEST_EXERCISE });
  assert.ok("stalled" in overload, "overload status has a stalled flag");
  assert.ok(Array.isArray(overload.sessions), "overload status has a sessions array");
  assert.equal(overload.latestSessionVolumeLb, 500, "latest session volume is 100*5");

  const exercises = await callTool<Array<{ name: string }>>("list_exercises");
  assert.ok(exercises.some((e) => e.name === STRENGTH_TEST_EXERCISE), "list_exercises includes the logged exercise");

  // delete_set removes the logged set (done last so the assertions above still see it)
  const del = await callTool<{ ok: boolean }>("delete_set", { id: String(history.sessions[0].sets[0].setId) });
  assert.equal(del.ok, true, "delete_set removes the set");
});

test("non-working sets are recorded but excluded from volume and 1RM", async () => {
  // Warm-up deliberately heavier than the working set: if it leaked into the
  // derived numbers it would dominate both of them.
  await callTool("log_set", {
    exercise: STRENGTH_TEST_EXERCISE,
    reps: 5,
    weight_lb: 200,
    type: "warmup",
    muscle_group: "push",
  });
  await callTool("log_set", {
    exercise: STRENGTH_TEST_EXERCISE,
    reps: 5,
    weight_lb: 100,
    muscle_group: "push",
  });

  const history = await callTool<{
    sessions: { volumeLb: number; sets: { setType: string; estimated1RMLb: number | null }[] }[];
  }>("get_exercise_history", { exercise: STRENGTH_TEST_EXERCISE });
  const session = history.sessions[history.sessions.length - 1];

  assert.equal(session.sets.length, 2, "both sets are listed");
  const warmup = session.sets.find((s) => s.setType === "warmup");
  assert.ok(warmup, "the warm-up is still recorded");
  assert.equal(warmup.estimated1RMLb, null, "a warm-up carries no 1RM estimate");
  assert.equal(session.volumeLb, 500, "volume counts the working set only (100*5)");

  const oneRm = await callTool<{ currentLb: number }>("get_1rm_estimate", {
    exercise: STRENGTH_TEST_EXERCISE,
  });
  // Epley on the 100 lb working set, not the 200 lb warm-up (which would be 233.3).
  assert.equal(oneRm.currentLb, 116.7, "1RM comes from the working set");
});

test("log_workout records a whole session in one call", async () => {
  const logged = await callTool<{
    ok: boolean;
    sessionId: number;
    setsLogged: number;
    exercises: {
      exercise: string;
      setsLogged: number;
      workingVolumeLb: number;
      topSetLb: number | null;
      estimated1RMLb: number | null;
      previousBestEstimated1RMLb: number | null;
      newPr: boolean;
    }[];
  }>("log_workout", {
    date: daysAgoIso(9),
    exercises: [
      {
        name: WORKOUT_TEST_EXERCISE,
        muscle_group: "push",
        sets: [
          { reps: 12, weight_lb: 95, type: "warmup" },
          { reps: 8, weight_lb: 135 },
          { reps: 8, weight_lb: 135 },
        ],
      },
      {
        name: WORKOUT_TEST_ACCESSORY,
        muscle_group: "push",
        sets: [{ reps: 10, weight_lb: 40 }],
      },
    ],
    notes: "mcp round-trip",
  });

  assert.equal(logged.ok, true, "log_workout should succeed");
  workoutTestSessionIds.push(logged.sessionId);
  assert.equal(logged.setsLogged, 4, "every set across both exercises is written");
  assert.equal(logged.exercises.length, 2, "each exercise is summarized");

  const [first, second] = logged.exercises;
  assert.equal(first.setsLogged, 3, "the warm-up is logged alongside the working sets");
  assert.equal(first.workingVolumeLb, 2160, "working volume excludes the warm-up (135*8*2)");
  assert.equal(first.topSetLb, 135, "top set is the heaviest working set");
  assert.equal(second.workingVolumeLb, 400, "the second exercise is summarized independently");
  assert.equal(first.previousBestEstimated1RMLb, null, "a brand new exercise has no previous best");
  assert.equal(first.newPr, true, "a first-ever set counts as a PR");

  // A later session is judged against the earlier one, not against itself.
  const heavier = await callTool<{
    sessionId: number;
    exercises: { previousBestEstimated1RMLb: number | null; newPr: boolean }[];
  }>("log_workout", {
    date: daysAgoIso(2),
    exercises: [
      { name: WORKOUT_TEST_EXERCISE, sets: [{ reps: 8, weight_lb: 145 }] },
    ],
  });
  workoutTestSessionIds.push(heavier.sessionId);
  // Epley on the earlier top set: 135 * (1 + 8/30) = 171.
  assert.equal(
    heavier.exercises[0].previousBestEstimated1RMLb,
    171,
    "previous best comes from the earlier session",
  );
  assert.equal(heavier.exercises[0].newPr, true, "145 x 8 beats it");

  // Back-dating between the two must not credit the session that came after.
  const backdated = await callTool<{
    sessionId: number;
    exercises: { previousBestEstimated1RMLb: number | null }[];
  }>("log_workout", {
    date: daysAgoIso(5),
    exercises: [
      { name: WORKOUT_TEST_EXERCISE, sets: [{ reps: 8, weight_lb: 140 }] },
    ],
  });
  workoutTestSessionIds.push(backdated.sessionId);
  assert.equal(
    backdated.exercises[0].previousBestEstimated1RMLb,
    171,
    "a back-dated session only sees sessions before it",
  );
});

test("get_recovery returns a recovery analysis shape", async () => {
  const data = await callTool<{ days: number; series: unknown[]; flag: { status: string } }>("get_recovery", {
    days: 30,
  });
  assert.equal(data.days, 30);
  assert.ok(Array.isArray(data.series), "series should be an array");
  assert.ok(data.flag && typeof data.flag.status === "string", "flag.status should be present");
  assert.ok(
    ["warning", "steady", "insufficient_data"].includes(data.flag.status),
    `unexpected flag.status: ${data.flag?.status}`,
  );
});

test("get_tdee returns a TDEE analysis shape", async () => {
  const data = await callTool("get_tdee", { days: 30 });
  assert.ok(Array.isArray(data.days), "days should be an array of TdeeDay");
  assert.ok("rollingWindow" in data, "rollingWindow should be present");
  assert.ok("rollingTdee" in data, "rollingTdee should be present");
  assert.ok("impliedWeightChangeKg" in data, "impliedWeightChangeKg should be present");
});

test("get_correlation returns a correlation result for a valid pairing", async () => {
  const data = await callTool<{ n: number; status: string; pairing: { key: string } }>("get_correlation", {
    pairing: "steps-vs-weight-loss-rate",
    days: 90,
  });
  assert.ok("n" in data, "n should be present");
  assert.ok("status" in data, "status should be present");
  assert.ok(data.pairing && data.pairing.key === "steps-vs-weight-loss-rate", "pairing echoed");
});

test("get_correlation rejects an unknown pairing", async () => {
  const { body } = await rpc("tools/call", {
    name: "get_correlation",
    arguments: { pairing: "not-a-real-pairing", days: 30 },
  });
  // zod enum rejection surfaces as a JSON-RPC error or an isError tool result.
  const isError =
    body?.error != null || body?.result?.isError === true;
  assert.ok(isError, `expected an error for unknown pairing, got: ${JSON.stringify(body).slice(0, 300)}`);
});

test("get_anomalies returns every evaluated signal with a status", async () => {
  const data = await callTool<Array<{ key: string; status: string }>>("get_anomalies");
  assert.ok(Array.isArray(data), "get_anomalies should return an array");
  for (const signal of data) {
    assert.ok(typeof signal.key === "string", "each signal has a key");
    assert.ok(typeof signal.status === "string", "each signal has a status");
  }
});

test("unauthenticated requests are rejected with 401", async () => {
  const { status } = await rpc("tools/list", {}, { auth: false });
  assert.equal(status, 401);
});
