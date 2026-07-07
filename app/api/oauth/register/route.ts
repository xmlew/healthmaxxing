import { isAllowedRedirectUri, registerClient } from "@/lib/oauth";

// RFC 7591 Dynamic Client Registration. Claude.ai leaves the OAuth Client
// ID/Secret fields blank, so it registers itself here before authorizing.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
} as const;

function error(code: string, description: string, status = 400) {
  return Response.json(
    { error: code, error_description: description },
    { status, headers: { ...CORS, "Cache-Control": "no-store" } },
  );
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return error("invalid_client_metadata", "Request body must be JSON.");
  }

  const meta = body as {
    redirect_uris?: unknown;
    client_name?: unknown;
    token_endpoint_auth_method?: unknown;
    scope?: unknown;
  };

  if (!Array.isArray(meta.redirect_uris) || meta.redirect_uris.length === 0) {
    return error("invalid_client_metadata", "redirect_uris is required and must be a non-empty array.");
  }
  const redirectUris = meta.redirect_uris.map(String);
  const invalid = redirectUris.find((uri) => !isAllowedRedirectUri(uri));
  if (invalid) {
    return error("invalid_redirect_uri", `redirect_uri must be https or a loopback address: ${invalid}`);
  }

  const registered = await registerClient({
    redirectUris,
    clientName: typeof meta.client_name === "string" ? meta.client_name : undefined,
    tokenEndpointAuthMethod:
      typeof meta.token_endpoint_auth_method === "string" ? meta.token_endpoint_auth_method : undefined,
    scope: typeof meta.scope === "string" ? meta.scope : undefined,
  });

  const { client, clientSecret } = registered;
  return Response.json(
    {
      client_id: client.clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      ...(clientSecret
        ? { client_secret: clientSecret, client_secret_expires_at: 0 }
        : {}),
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: client.tokenEndpointAuthMethod,
      ...(client.clientName ? { client_name: client.clientName } : {}),
      ...(client.scope ? { scope: client.scope } : {}),
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
    { status: 201, headers: { ...CORS, "Cache-Control": "no-store" } },
  );
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}
