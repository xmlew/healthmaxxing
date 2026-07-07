import {
  createAuthorizationCode,
  getClient,
  ownerSecret,
  verifyOwnerPassword,
  type OAuthClient,
} from "@/lib/oauth";

// OAuth 2.1 authorization endpoint. GET renders the owner login screen; POST
// checks the password (MCP_SECRET) and, on success, issues an authorization
// code and redirects back to the client. PKCE (S256) is mandatory.

type AuthParams = {
  clientId: string;
  redirectUri: string;
  responseType: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string | null;
  state: string | null;
  resource: string | null;
};

function readParams(source: URLSearchParams | FormData): AuthParams {
  const get = (k: string) => {
    const v = source.get(k);
    return typeof v === "string" && v.length > 0 ? v : null;
  };
  return {
    clientId: get("client_id") ?? "",
    redirectUri: get("redirect_uri") ?? "",
    responseType: get("response_type") ?? "",
    codeChallenge: get("code_challenge") ?? "",
    codeChallengeMethod: get("code_challenge_method") ?? "",
    scope: get("scope"),
    state: get("state"),
    resource: get("resource"),
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Pre-redirect failure: the client_id/redirect_uri can't be trusted, so the
// error is shown to the user rather than redirected anywhere (open-redirect risk).
function directError(message: string, status = 400): Response {
  return htmlResponse(errorPage(message), status);
}

// Post-redirect failure: client + redirect_uri are validated, so OAuth errors go
// back to the client per RFC 6749 §4.1.2.1.
function redirectError(
  redirectUri: string,
  error: string,
  description: string,
  state: string | null,
): Response {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  if (state != null) url.searchParams.set("state", state);
  return Response.redirect(url.toString(), 302);
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

// Resolves client + redirect_uri, the two values every later step depends on.
// Returns a Response to short-circuit on failure, or the validated client.
async function resolveClient(
  params: AuthParams,
): Promise<{ client: OAuthClient } | { response: Response }> {
  if (!params.clientId) return { response: directError("Missing client_id.") };
  const client = await getClient(params.clientId);
  if (!client) return { response: directError("Unknown client_id. Re-add the connector to register again.") };
  if (!params.redirectUri) return { response: directError("Missing redirect_uri.") };
  if (!client.redirectUris.includes(params.redirectUri)) {
    return { response: directError("redirect_uri does not match the registered value.") };
  }
  return { client };
}

// Validates the OAuth parameters that can safely be reported back to the client.
function validateOAuthParams(params: AuthParams): string | null {
  if (params.responseType !== "code") return "response_type must be 'code'.";
  if (!params.codeChallenge) return "code_challenge is required (PKCE).";
  if (params.codeChallengeMethod !== "S256") return "code_challenge_method must be 'S256'.";
  return null;
}

export async function GET(req: Request) {
  if (!ownerSecret()) return directError("Server is missing MCP_SECRET; OAuth is not configured.", 500);

  const params = readParams(new URL(req.url).searchParams);
  const resolved = await resolveClient(params);
  if ("response" in resolved) return resolved.response;

  const paramError = validateOAuthParams(params);
  if (paramError) return redirectError(params.redirectUri, "invalid_request", paramError, params.state);

  return htmlResponse(loginPage(params, resolved.client, null));
}

export async function POST(req: Request) {
  if (!ownerSecret()) return directError("Server is missing MCP_SECRET; OAuth is not configured.", 500);

  const form = await req.formData();
  const params = readParams(form);
  const resolved = await resolveClient(params);
  if ("response" in resolved) return resolved.response;

  const paramError = validateOAuthParams(params);
  if (paramError) return redirectError(params.redirectUri, "invalid_request", paramError, params.state);

  const password = form.get("password");
  if (typeof password !== "string" || !verifyOwnerPassword(password)) {
    return htmlResponse(loginPage(params, resolved.client, "Incorrect password."), 401);
  }

  const code = await createAuthorizationCode({
    clientId: params.clientId,
    redirectUri: params.redirectUri,
    codeChallenge: params.codeChallenge,
    codeChallengeMethod: params.codeChallengeMethod,
    scope: params.scope,
    resource: params.resource,
  });

  const url = new URL(params.redirectUri);
  url.searchParams.set("code", code);
  if (params.state != null) url.searchParams.set("state", params.state);
  return Response.redirect(url.toString(), 302);
}

// --- HTML -------------------------------------------------------------------

const PAGE_STYLE = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
    background: #131110; color: #f5f1ea;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  .card {
    width: 100%; max-width: 380px; background: #1c1916; border: 1px solid #2f2a24;
    border-radius: 16px; padding: 32px; box-shadow: 0 24px 60px -30px rgba(0,0,0,0.8);
  }
  .brand { font-size: 13px; letter-spacing: 0.14em; text-transform: uppercase; color: #ff6a3d; margin: 0 0 6px; }
  h1 { font-family: Georgia, "Times New Roman", serif; font-weight: 600; font-size: 26px; margin: 0 0 8px; }
  p.sub { color: #a89e8f; font-size: 14px; line-height: 1.5; margin: 0 0 24px; }
  label { display: block; font-size: 13px; color: #a89e8f; margin: 0 0 8px; }
  input[type=password] {
    width: 100%; padding: 12px 14px; font-size: 15px; color: #f5f1ea;
    background: #242019; border: 1px solid #2f2a24; border-radius: 10px; outline: none;
  }
  input[type=password]:focus { border-color: #ff6a3d; }
  button {
    width: 100%; margin-top: 20px; padding: 12px 14px; font-size: 15px; font-weight: 600;
    color: #16110c; background: #ff6a3d; border: none; border-radius: 10px; cursor: pointer;
  }
  button:hover { background: #ff7d54; }
  .error {
    margin: 0 0 20px; padding: 10px 14px; font-size: 13px; border-radius: 10px;
    background: rgba(226,87,76,0.14); border: 1px solid rgba(226,87,76,0.4); color: #f0a49d;
  }
  .who { margin-top: 22px; font-size: 12px; color: #756a5c; text-align: center; word-break: break-word; }
`;

function hiddenInputs(params: AuthParams): string {
  const fields: Array<[string, string | null]> = [
    ["client_id", params.clientId],
    ["redirect_uri", params.redirectUri],
    ["response_type", params.responseType],
    ["code_challenge", params.codeChallenge],
    ["code_challenge_method", params.codeChallengeMethod],
    ["scope", params.scope],
    ["state", params.state],
    ["resource", params.resource],
  ];
  return fields
    .filter(([, v]) => v != null)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v as string)}">`)
    .join("");
}

function loginPage(params: AuthParams, client: OAuthClient, error: string | null): string {
  const appName = client.clientName ? escapeHtml(client.clientName) : "An application";
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect to Health Maxxing</title>
<style>${PAGE_STYLE}</style>
</head><body>
  <form class="card" method="post" action="/api/oauth/authorize">
    <p class="brand">Health Maxxing</p>
    <h1>Authorize connection</h1>
    <p class="sub">${appName} wants to connect to your health data. Enter your access secret to allow it.</p>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
    <label for="password">Access secret</label>
    <input id="password" name="password" type="password" autocomplete="current-password" autofocus required>
    ${hiddenInputs(params)}
    <button type="submit">Allow access</button>
    <p class="who">Only allow connections you started yourself.</p>
  </form>
</body></html>`;
}

function errorPage(message: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorization error</title>
<style>${PAGE_STYLE}</style>
</head><body>
  <div class="card">
    <p class="brand">Health Maxxing</p>
    <h1>Can't authorize</h1>
    <p class="sub">${escapeHtml(message)}</p>
  </div>
</body></html>`;
}
