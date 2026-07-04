import { sql } from "@/lib/db";
import { ingestHealthExport, type HealthExportPayload } from "@/lib/ingest";

export async function POST(request: Request) {
  const expectedSecret = process.env.INGEST_SECRET;
  if (!expectedSecret) {
    return Response.json({ error: "Server is missing INGEST_SECRET" }, { status: 500 });
  }

  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : "";
  if (token !== expectedSecret) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: HealthExportPayload;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!payload?.data || (!payload.data.metrics && !payload.data.workouts)) {
    return Response.json({ error: "Expected a Health Auto Export payload: { data: { metrics, workouts } }" }, { status: 400 });
  }

  try {
    const result = await ingestHealthExport(sql, payload);
    return Response.json({ ok: true, ...result });
  } catch (err) {
    console.error("Ingest failed:", err);
    return Response.json({ error: "Failed to ingest payload" }, { status: 500 });
  }
}
