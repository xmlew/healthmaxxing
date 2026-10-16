import assert from "node:assert/strict";

export type RpcFrame = {
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

export function mcpClient(base: string, secret: string | undefined) {
  async function rpc(
    method: string,
    params: unknown,
    { auth = true }: { auth?: boolean } = {},
  ): Promise<{ status: number; body: RpcFrame }> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (auth) headers.Authorization = `Bearer ${secret}`;
    const res = await fetch(`${base}/api/mcp`, {
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
    assert.ok(!body.result?.isError, `tool ${name} failed: ${text}`);
    return JSON.parse(text) as T;
  }

  // For calls expected to be refused: returns the error text, failing the test if
  // the tool succeeded instead.
  async function callToolError(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const { body } = await rpc("tools/call", { name, arguments: args });
    const text = body.error?.message ?? body.result?.content?.[0]?.text ?? "";
    assert.ok(
      body.error != null || body.result?.isError === true,
      `tool ${name} was expected to fail but returned: ${text.slice(0, 300)}`,
    );
    return text;
  }

  return { rpc, callTool, callToolError };
}
