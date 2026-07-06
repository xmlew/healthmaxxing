import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const PORT = 3130;
const BASE = `http://localhost:${PORT}`;
const SECRET = process.env.MCP_SECRET;

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

test("tools/list exposes the four new analysis tools", async () => {
  const { body } = await rpc("tools/list", {});
  const names: string[] = body.result.tools.map((t: { name: string }) => t.name);
  for (const expected of ["get_recovery", "get_tdee", "get_correlation", "get_anomalies"]) {
    assert.ok(names.includes(expected), `tools/list missing ${expected}; got ${names.join(", ")}`);
  }
  assert.equal(body.result.tools.length, 16, "expected 16 tools total (15 prior + get_macro_summary)");
});

test("get_macro_summary returns per-day macros and targets", async () => {
  const data = await callTool("get_macro_summary", { days: 7 });
  assert.equal(data.days, 7);
  assert.ok("proteinTargetG" in data, "proteinTargetG present");
  assert.ok("calorieTarget" in data, "calorieTarget present");
  assert.ok(Array.isArray(data.series), "series is an array");
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
