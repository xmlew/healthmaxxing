import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import dotenv from "dotenv";
import postgres from "postgres";

dotenv.config({ path: ".env.local" });

const PORT = 3130;
const BASE = `http://localhost:${PORT}`;
const SECRET = process.env.MCP_SECRET;

// Sentinel exercise the strength round-trip test writes; cleaned up in after().
const STRENGTH_TEST_EXERCISE = "__mcp_test_lift__";
let strengthTestSessionId: number | null = null;

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

// mcp-handler replies as SSE: one `data: <json>` line carrying the JSON-RPC frame.
function parseSse(text: string): any {
  const line = text.split("\n").find((l) => l.startsWith("data:"));
  if (!line) throw new Error(`No SSE data line in response: ${text.slice(0, 200)}`);
  return JSON.parse(line.slice("data:".length).trim());
}

async function rpc(
  method: string,
  params: unknown,
  { auth = true }: { auth?: boolean } = {},
): Promise<{ status: number; body: any }> {
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
  return { status: res.status, body: res.ok ? parseSse(raw) : raw };
}

// Unwrap a tools/call result whose payload is JSON serialized inside content[0].text.
async function callTool(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const { body } = await rpc("tools/call", { name, arguments: args });
  const text = body?.result?.content?.[0]?.text;
  assert.ok(text, `tool ${name} returned no content text: ${JSON.stringify(body)}`);
  return JSON.parse(text);
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
    await sql`delete from strength_sets where exercise_id in (select id from exercises where name = ${STRENGTH_TEST_EXERCISE})`;
    await sql`delete from exercises where name = ${STRENGTH_TEST_EXERCISE}`;
    // Only the exact session this test created, and only if it's now empty -
    // never other empty manual sessions on the shared DB.
    if (strengthTestSessionId != null) {
      await sql`
        delete from strength_sessions
        where id = ${strengthTestSessionId}
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
  const names: string[] = body.result.tools.map((t: { name: string }) => t.name);
  for (const expected of ["get_recovery", "get_tdee", "get_correlation", "get_anomalies"]) {
    assert.ok(names.includes(expected), `tools/list missing ${expected}; got ${names.join(", ")}`);
  }
  assert.equal(body.result.tools.length, 19, "expected 19 tools total (15 prior + 3 strength + get_macro_summary)");
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
  const names: string[] = body.result.tools.map((t: { name: string }) => t.name);
  for (const expected of ["log_set", "get_exercise_history", "get_1rm_estimate"]) {
    assert.ok(names.includes(expected), `tools/list missing ${expected}`);
  }

  const logged = await callTool("log_set", {
    exercise: STRENGTH_TEST_EXERCISE,
    reps: 5,
    weight: 100,
    muscle_group: "push",
  });
  assert.equal(logged.ok, true, "log_set should succeed");
  assert.ok(logged.setId, "log_set returns a setId");
  strengthTestSessionId = logged.sessionId;
  // Epley: 100 * (1 + 5/30) = 116.7
  assert.equal(logged.estimated1RM, 116.7, "log_set echoes the estimated 1RM");

  const history = await callTool("get_exercise_history", { exercise: STRENGTH_TEST_EXERCISE });
  assert.ok(Array.isArray(history.sessions) && history.sessions.length >= 1, "history has a session");
  assert.equal(history.sessions[0].volume, 500, "session volume is weight*reps (100*5)");

  const oneRm = await callTool("get_1rm_estimate", { exercise: STRENGTH_TEST_EXERCISE, formula: "brzycki" });
  // Brzycki: 100 * 36/(37-5) = 112.5
  assert.equal(oneRm.current, 112.5, "get_1rm_estimate uses the requested formula");
});

test("get_recovery returns a recovery analysis shape", async () => {
  const data = await callTool("get_recovery", { days: 30 });
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
  const data = await callTool("get_correlation", {
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
  const data = await callTool("get_anomalies");
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
