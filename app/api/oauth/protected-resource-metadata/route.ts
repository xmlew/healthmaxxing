import { generateProtectedResourceMetadata, getPublicOrigin } from "mcp-handler";

// RFC 9728 OAuth 2.0 Protected Resource Metadata. Served at
// /.well-known/oauth-protected-resource via a rewrite in next.config.ts, and
// pointed to by the WWW-Authenticate header withMcpAuth emits on a 401. The
// resource identifier and the authorization server are both this app's origin.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
} as const;

export async function GET(req: Request) {
  const origin = getPublicOrigin(req);
  const metadata = generateProtectedResourceMetadata({
    authServerUrls: [origin],
    resourceUrl: origin,
  });
  return Response.json(metadata, {
    headers: { ...CORS, "Cache-Control": "max-age=3600" },
  });
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}
