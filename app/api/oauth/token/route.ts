import {
  consumeAuthorizationCode,
  getClient,
  issueTokens,
  rotateRefreshToken,
  verifyClientSecret,
  verifyPkceS256,
  type OAuthClient,
} from "@/lib/oauth";

// OAuth 2.1 token endpoint. Exchanges an authorization code (with PKCE) or a
// refresh token for an access token bound to this MCP server (RFC 8707).
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
} as const;

function tokenError(error: string, description: string, status = 400) {
  return Response.json(
    { error, error_description: description },
    { status, headers: { ...CORS, "Cache-Control": "no-store" } },
  );
}

function success(body: unknown) {
  return Response.json(body, { headers: { ...CORS, "Cache-Control": "no-store" } });
}

// Client credentials may arrive via client_secret_post (body) or HTTP Basic.
function parseClientAuth(
  req: Request,
  form: FormData,
): { clientId: string | null; clientSecret: string | undefined } {
  const header = req.headers.get("authorization");
  if (header?.toLowerCase().startsWith("basic ")) {
    try {
      const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf-8");
      const sep = decoded.indexOf(":");
      if (sep !== -1) {
        return {
          clientId: decodeURIComponent(decoded.slice(0, sep)),
          clientSecret: decodeURIComponent(decoded.slice(sep + 1)),
        };
      }
    } catch {
      // fall through to body-based auth
    }
  }
  const bodyId = form.get("client_id");
  const bodySecret = form.get("client_secret");
  return {
    clientId: typeof bodyId === "string" ? bodyId : null,
    clientSecret: typeof bodySecret === "string" ? bodySecret : undefined,
  };
}

async function authenticateClient(
  req: Request,
  form: FormData,
): Promise<{ client: OAuthClient } | { response: Response }> {
  const { clientId, clientSecret } = parseClientAuth(req, form);
  if (!clientId) return { response: tokenError("invalid_client", "Missing client_id.", 401) };
  const client = await getClient(clientId);
  if (!client) return { response: tokenError("invalid_client", "Unknown client.", 401) };
  if (!verifyClientSecret(client, clientSecret)) {
    return { response: tokenError("invalid_client", "Invalid client credentials.", 401) };
  }
  return { client };
}

function sameResourceOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return tokenError("invalid_request", "Body must be application/x-www-form-urlencoded.");
  }

  const grantType = form.get("grant_type");
  if (typeof grantType !== "string") {
    return tokenError("invalid_request", "Missing grant_type.");
  }

  const auth = await authenticateClient(req, form);
  if ("response" in auth) return auth.response;
  const { client } = auth;

  if (grantType === "authorization_code") {
    const code = form.get("code");
    const codeVerifier = form.get("code_verifier");
    const redirectUri = form.get("redirect_uri");
    const resource = form.get("resource");
    if (typeof code !== "string") return tokenError("invalid_request", "Missing code.");
    if (typeof codeVerifier !== "string") return tokenError("invalid_request", "Missing code_verifier (PKCE).");

    const stored = await consumeAuthorizationCode(code);
    if (!stored) return tokenError("invalid_grant", "Authorization code is invalid or already used.");
    if (stored.expiresAt.getTime() < Date.now()) {
      return tokenError("invalid_grant", "Authorization code has expired.");
    }
    if (stored.clientId !== client.clientId) {
      return tokenError("invalid_grant", "Authorization code was issued to a different client.");
    }
    if (typeof redirectUri === "string" && redirectUri !== stored.redirectUri) {
      return tokenError("invalid_grant", "redirect_uri does not match the authorization request.");
    }
    if (typeof resource === "string" && stored.resource && !sameResourceOrigin(resource, stored.resource)) {
      return tokenError("invalid_target", "resource does not match the authorization request.");
    }
    if (!verifyPkceS256(codeVerifier, stored.codeChallenge)) {
      return tokenError("invalid_grant", "PKCE verification failed.");
    }

    const tokens = await issueTokens({
      clientId: client.clientId,
      scope: stored.scope,
      resource: stored.resource,
    });
    return success(tokens);
  }

  if (grantType === "refresh_token") {
    const refreshToken = form.get("refresh_token");
    if (typeof refreshToken !== "string") return tokenError("invalid_request", "Missing refresh_token.");
    const tokens = await rotateRefreshToken(refreshToken, client.clientId);
    if (!tokens) return tokenError("invalid_grant", "Refresh token is invalid or already used.");
    return success(tokens);
  }

  return tokenError("unsupported_grant_type", `Unsupported grant_type: ${grantType}.`);
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}
