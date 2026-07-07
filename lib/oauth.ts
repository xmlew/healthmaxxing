import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { sql } from "./db";

// This app is its own OAuth 2.1 authorization server for the MCP endpoint. The
// flow implemented here is the subset the MCP authorization spec mandates:
// RFC 9728 protected-resource metadata, RFC 8414 AS metadata, RFC 7591 dynamic
// client registration, the authorization-code grant with mandatory PKCE (S256),
// refresh-token rotation, and RFC 8707 resource (audience) binding.

const CODE_TTL_MS = 5 * 60 * 1000; // authorization codes are single-use + short-lived
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour; refresh keeps the connector alive

export const OAUTH_PATHS = {
  authorize: "/api/oauth/authorize",
  token: "/api/oauth/token",
  register: "/api/oauth/register",
} as const;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

// Constant-time string comparison via fixed-length digests, so callers can
// compare values of differing lengths (timingSafeEqual itself throws on those).
export function timingSafeEqualStr(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

// The owner gate. MCP_SECRET is the single credential proving ownership: a raw
// bearer for programmatic clients, and the login password for the browser OAuth
// flow. Both grant the same access, so there is no second secret to manage.
export function ownerSecret(): string | undefined {
  return process.env.MCP_SECRET || undefined;
}

export function verifyOwnerPassword(input: string): boolean {
  const secret = ownerSecret();
  return secret != null && timingSafeEqualStr(input, secret);
}

// --- RFC 8414 / RFC 9728 discovery metadata ---------------------------------

export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}${OAUTH_PATHS.authorize}`,
    token_endpoint: `${origin}${OAUTH_PATHS.token}`,
    registration_endpoint: `${origin}${OAUTH_PATHS.register}`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
  };
}

// --- Dynamic client registration (RFC 7591) ---------------------------------

export type OAuthClient = {
  clientId: string;
  clientSecretHash: string | null;
  clientName: string | null;
  redirectUris: string[];
  tokenEndpointAuthMethod: string;
  scope: string | null;
};

export type RegisteredClient = {
  client: OAuthClient;
  clientSecret: string | null; // plaintext, returned to the registrant exactly once
};

// A redirect URI is a phishing vector, so the spec restricts it to https or a
// loopback host; we reject anything else at registration rather than at redirect.
export function isAllowedRedirectUri(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash) return false;
  const isLoopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  return url.protocol === "https:" || (url.protocol === "http:" && isLoopback);
}

export async function registerClient(input: {
  redirectUris: string[];
  clientName?: string;
  tokenEndpointAuthMethod?: string;
  scope?: string;
}): Promise<RegisteredClient> {
  const clientId = randomUUID();
  // Default to a public client (PKCE-secured, no secret). MCP clients are
  // PKCE-first, and defaulting to confidential would issue a secret the client
  // may never echo back at the token endpoint, breaking the exchange. A client
  // that wants client_secret_post must ask for it explicitly.
  const tokenEndpointAuthMethod = input.tokenEndpointAuthMethod ?? "none";
  const isPublic = tokenEndpointAuthMethod === "none";
  const clientSecret = isPublic ? null : randomToken();
  const clientSecretHash = clientSecret ? sha256(clientSecret) : null;

  await sql`
    insert into oauth_clients
      (client_id, client_secret_hash, client_name, redirect_uris, token_endpoint_auth_method, scope)
    values (
      ${clientId}, ${clientSecretHash}, ${input.clientName ?? null},
      ${input.redirectUris}, ${tokenEndpointAuthMethod}, ${input.scope ?? null}
    )
  `;

  return {
    client: {
      clientId,
      clientSecretHash,
      clientName: input.clientName ?? null,
      redirectUris: input.redirectUris,
      tokenEndpointAuthMethod,
      scope: input.scope ?? null,
    },
    clientSecret,
  };
}

export async function getClient(clientId: string): Promise<OAuthClient | null> {
  const rows = await sql`
    select client_id, client_secret_hash, client_name, redirect_uris,
           token_endpoint_auth_method, scope
    from oauth_clients
    where client_id = ${clientId}
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    clientId: row.client_id,
    clientSecretHash: row.client_secret_hash,
    clientName: row.client_name,
    redirectUris: row.redirect_uris,
    tokenEndpointAuthMethod: row.token_endpoint_auth_method,
    scope: row.scope,
  };
}

// Public clients (token_endpoint_auth_method "none") are secured by PKCE alone;
// confidential clients must present the secret they were issued at registration.
export function verifyClientSecret(client: OAuthClient, presented: string | undefined): boolean {
  if (!client.clientSecretHash) return true;
  return presented != null && timingSafeEqualStr(sha256(presented), client.clientSecretHash);
}

// --- Authorization codes ----------------------------------------------------

export async function createAuthorizationCode(input: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string | null;
  resource: string | null;
}): Promise<string> {
  const code = randomToken();
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);
  await sql`
    insert into oauth_authorization_codes
      (code_hash, client_id, redirect_uri, code_challenge, code_challenge_method, scope, resource, expires_at)
    values (
      ${sha256(code)}, ${input.clientId}, ${input.redirectUri}, ${input.codeChallenge},
      ${input.codeChallengeMethod}, ${input.scope}, ${input.resource}, ${expiresAt}
    )
  `;
  return code;
}

type StoredCode = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string | null;
  resource: string | null;
  expiresAt: Date;
};

// Single-use: the delete...returning consumes the code atomically, so a replayed
// code finds nothing even under concurrent exchange attempts.
export async function consumeAuthorizationCode(code: string): Promise<StoredCode | null> {
  const rows = await sql`
    delete from oauth_authorization_codes
    where code_hash = ${sha256(code)}
    returning client_id, redirect_uri, code_challenge, scope, resource, expires_at
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    clientId: row.client_id,
    redirectUri: row.redirect_uri,
    codeChallenge: row.code_challenge,
    scope: row.scope,
    resource: row.resource,
    expiresAt: row.expires_at,
  };
}

export function verifyPkceS256(codeVerifier: string, codeChallenge: string): boolean {
  return timingSafeEqualStr(sha256(codeVerifier), codeChallenge);
}

// --- Tokens -----------------------------------------------------------------

export type IssuedTokens = {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope?: string;
};

export async function issueTokens(input: {
  clientId: string;
  scope: string | null;
  resource: string | null;
}): Promise<IssuedTokens> {
  const accessToken = randomToken();
  const refreshToken = randomToken();
  const expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_MS);
  await sql`
    insert into oauth_access_tokens
      (access_token_hash, refresh_token_hash, client_id, scope, resource, expires_at)
    values (
      ${sha256(accessToken)}, ${sha256(refreshToken)}, ${input.clientId},
      ${input.scope}, ${input.resource}, ${expiresAt}
    )
  `;
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    refresh_token: refreshToken,
    ...(input.scope ? { scope: input.scope } : {}),
  };
}

// Refresh-token rotation (OAuth 2.1 requires it for public clients): the old
// refresh token is deleted and a fresh access/refresh pair issued in one
// transaction, so a leaked refresh token stops working after its first use.
export async function rotateRefreshToken(
  refreshToken: string,
  clientId: string,
): Promise<IssuedTokens | null> {
  return sql.begin(async (tx) => {
    const rows = await tx`
      delete from oauth_access_tokens
      where refresh_token_hash = ${sha256(refreshToken)}
      returning client_id, scope, resource
    `;
    const row = rows[0];
    if (!row || row.client_id !== clientId) return null;

    const accessToken = randomToken();
    const newRefresh = randomToken();
    const expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_MS);
    await tx`
      insert into oauth_access_tokens
        (access_token_hash, refresh_token_hash, client_id, scope, resource, expires_at)
      values (
        ${sha256(accessToken)}, ${sha256(newRefresh)}, ${row.client_id},
        ${row.scope}, ${row.resource}, ${expiresAt}
      )
    `;
    return {
      access_token: accessToken,
      token_type: "Bearer" as const,
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      refresh_token: newRefresh,
      ...(row.scope ? { scope: row.scope } : {}),
    };
  });
}

// Verifies a bearer against the token store and enforces RFC 8707 audience
// binding: a token issued for another resource server must be rejected here,
// even if the value is otherwise valid. requestOrigin is this MCP server's own
// canonical origin, resolved from the incoming request.
export async function verifyOAuthAccessToken(
  token: string,
  requestOrigin: string,
): Promise<AuthInfo | undefined> {
  const rows = await sql`
    select client_id, scope, resource, expires_at
    from oauth_access_tokens
    where access_token_hash = ${sha256(token)}
  `;
  const row = rows[0];
  if (!row) return undefined;
  if (new Date(row.expires_at).getTime() < Date.now()) return undefined;

  if (row.resource) {
    let audience: string;
    try {
      audience = new URL(row.resource).origin;
    } catch {
      return undefined;
    }
    if (audience !== new URL(requestOrigin).origin) return undefined;
  }

  return {
    token,
    clientId: row.client_id,
    scopes: row.scope ? row.scope.split(" ") : [],
    expiresAt: Math.floor(new Date(row.expires_at).getTime() / 1000),
    resource: row.resource ? new URL(row.resource) : undefined,
  };
}
