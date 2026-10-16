import { spawn } from "node:child_process";

export type TestServer = { base: string; stop: () => void };

// Each suite runs in its own process (node --test), so each serves the built app
// on its own port.
export async function startTestServer(port: number, timeoutMs = 60_000): Promise<TestServer> {
  const base = `http://localhost:${port}`;
  const child = spawn("npx", ["next", "start", "-p", String(port)], {
    stdio: "ignore",
    env: process.env,
  });
  const stop = () => {
    child.kill("SIGTERM");
  };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${base}/`, { method: "GET" })).ok) return { base, stop };
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  stop();
  throw new Error(`Server did not start on ${base} within ${timeoutMs}ms`);
}
