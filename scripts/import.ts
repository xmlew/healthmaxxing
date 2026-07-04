import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { config } from "dotenv";
import { ingestHealthExport, type HealthExportPayload } from "../lib/ingest";

config({ path: join(process.cwd(), ".env.local") });

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Usage: npm run db:import -- <path-to-health-export.json>");
    process.exit(1);
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set (check .env.local, or export it for a prod import)");
  }

  const payload: HealthExportPayload = JSON.parse(readFileSync(filePath, "utf-8"));
  const sql = postgres(connectionString, { max: 1 });
  try {
    console.log(`Importing ${filePath} into ${connectionString.replace(/:[^:@]*@/, ":***@")}...`);
    const result = await ingestHealthExport(sql, payload);
    console.log(`Done. Metrics processed: ${result.metricsProcessed}, workouts processed: ${result.workoutsProcessed}`);
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
