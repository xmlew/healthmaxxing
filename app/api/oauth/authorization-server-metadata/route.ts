import { getPublicOrigin } from "mcp-handler";
import { authorizationServerMetadata } from "@/lib/oauth";

// RFC 8414 OAuth 2.0 Authorization Server Metadata. Served at
// /.well-known/oauth-authorization-server via a rewrite in next.config.ts.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
} as const;

export async function GET(req: Request) {
  const metadata = authorizationServerMetadata(getPublicOrigin(req));
  return Response.json(metadata, {
    headers: { ...CORS, "Cache-Control": "max-age=3600" },
  });
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}
