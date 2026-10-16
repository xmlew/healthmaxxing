import { join } from "node:path";
import { config } from "dotenv";
import { applySchema } from "./schema";

config({ path: join(process.cwd(), ".env.local") });

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set (check .env.local)");
  }
  await applySchema(connectionString);
  console.log("Schema applied successfully.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
