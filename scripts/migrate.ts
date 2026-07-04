import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { config } from "dotenv";

config({ path: join(process.cwd(), ".env.local") });

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set (check .env.local)");
  }

  const schema = readFileSync(join(process.cwd(), "db/schema.sql"), "utf-8");
  const sql = postgres(connectionString, { max: 1 });
  try {
    await sql.unsafe(schema);
    console.log("Schema applied successfully.");
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
