import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import dotenv from "dotenv";
import postgres from "postgres";

dotenv.config({ path: ".env.local" });

// Separate port from mcp-tools.test.ts so both suites can spawn their own server;
// node --test runs each test file in its own process.
const PORT = 3131;
const BASE = `http://localhost:${PORT}`;
const SECRET = process.env.MCP_SECRET;
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";

const b64url = (buf: Buffer) => buf.toString("base64url");
const sha256 = (input: string) => createHash("sha256").update(input).digest();

let server: ChildProcess;
const createdClientIds: string[] = [];

async function waitForServer(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/`, { method: "GET" })).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Server did not start on ${BASE} within ${timeoutMs}ms`);
}

function form(fields: Record<string, string>): URLSearchParams {
  return new URLSearchParams(fields);
}

// Registers a fresh public client and returns its id. Recorded for cleanup.
async function registerClient(): Promise<string> {
  const res = await fetch(`${BASE}/api/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
      client_name: "OAuth test",
    }),
  });
  assert.equal(res.status, 201, "registration should return 201");
  const body = await res.json();
  createdClientIds.push(body.client_id);
  return body.client_id;
}

// Drives authorize (POST consent with the owner password) and returns the
// authorization code from the redirect. `overrides` can tweak PKCE etc.
async function authorize(
  clientId: string,
  codeChallenge: string,
  state: string,
): Promise<string> {
  const res = await fetch(`${BASE}/api/oauth/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    redirect: "manual",
    body: form({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
      resource: BASE,
      password: SECRET!,
    }),
  });
  assert.equal(res.status, 302, "correct password should redirect with a code");
  const location = new URL(res.headers.get("location")!);
  assert.equal(location.searchParams.get("state"), state, "state must round-trip");
  const code = location.searchParams.get("code");
  assert.ok(code, "authorization code must be present");
  return code;
}

async function mcpStatus(token: string): Promise<number> {
  const res = await fetch(`${BASE}/api/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  return res.status;
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

// Remove only the clients this suite created; their codes and tokens cascade.
after(async () => {
  if (!process.env.DATABASE_URL || createdClientIds.length === 0) return;
  const sql = postgres(process.env.DATABASE_URL, { max: 1 });
  try {
    await sql`delete from oauth_clients where client_id in ${sql(createdClientIds)}`;
  } finally {
    await sql.end();
  }
});

test("discovery advertises the authorization server (RFC 9728 + RFC 8414)", async () => {
  const prm = await (await fetch(`${BASE}/.well-known/oauth-protected-resource`)).json();
  assert.equal(prm.resource, BASE);
  assert.deepEqual(prm.authorization_servers, [BASE]);

  const asm = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
  assert.equal(asm.issuer, BASE);
  assert.equal(asm.authorization_endpoint, `${BASE}/api/oauth/authorize`);
  assert.equal(asm.token_endpoint, `${BASE}/api/oauth/token`);
  assert.equal(asm.registration_endpoint, `${BASE}/api/oauth/register`);
  assert.ok(asm.code_challenge_methods_supported.includes("S256"));
});

test("unauthenticated MCP request returns 401 with a resource_metadata pointer", async () => {
  const res = await fetch(`${BASE}/api/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate") ?? "", /resource_metadata=/);
});

test("full authorization-code + PKCE flow yields a working access token", async () => {
  const clientId = await registerClient();
  const codeVerifier = b64url(randomBytes(32));
  const codeChallenge = b64url(sha256(codeVerifier));
  const code = await authorize(clientId, codeChallenge, b64url(randomBytes(8)));

  const tokenRes = await fetch(`${BASE}/api/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form({
      grant_type: "authorization_code",
      code,
      code_verifier: codeVerifier,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      resource: BASE,
    }),
  });
  assert.equal(tokenRes.status, 200);
  const tokens = await tokenRes.json();
  assert.equal(tokens.token_type, "Bearer");
  assert.ok(tokens.access_token && tokens.refresh_token);

  assert.equal(await mcpStatus(tokens.access_token), 200, "OAuth token should authorize MCP calls");

  // Refresh rotation: new pair works, old refresh token is invalidated.
  const refreshRes = await fetch(`${BASE}/api/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId }),
  });
  assert.equal(refreshRes.status, 200);
  const rotated = await refreshRes.json();
  assert.notEqual(rotated.access_token, tokens.access_token);
  assert.equal(await mcpStatus(rotated.access_token), 200);

  const reuse = await fetch(`${BASE}/api/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId }),
  });
  assert.equal(reuse.status, 400, "rotated-away refresh token must be rejected");
});

test("authorize rejects a wrong owner password", async () => {
  const clientId = await registerClient();
  const res = await fetch(`${BASE}/api/oauth/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    redirect: "manual",
    body: form({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: b64url(sha256("x")),
      code_challenge_method: "S256",
      password: "wrong-secret",
    }),
  });
  assert.equal(res.status, 401);
});

test("token exchange fails PKCE when the verifier does not match", async () => {
  const clientId = await registerClient();
  const codeChallenge = b64url(sha256(b64url(randomBytes(32))));
  const code = await authorize(clientId, codeChallenge, b64url(randomBytes(8)));

  const res = await fetch(`${BASE}/api/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form({
      grant_type: "authorization_code",
      code,
      code_verifier: b64url(randomBytes(32)), // not the verifier behind the challenge
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
    }),
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "invalid_grant");
});

test("the raw MCP_SECRET bearer still authorizes (Claude Code path)", async () => {
  assert.equal(await mcpStatus(SECRET!), 200);
  assert.equal(await mcpStatus("not-a-real-token"), 401);
});
