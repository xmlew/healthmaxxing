import postgres from "postgres";
import { testDatabaseUrl } from "../tests/support/test-db";
import { applySchema } from "./schema";

const DUPLICATE_DATABASE = "42P04";

async function main() {
  const testUrl = new URL(testDatabaseUrl());
  const name = testUrl.pathname.slice(1);
  const maintenanceUrl = new URL(testUrl);
  maintenanceUrl.pathname = "/postgres";

  const admin = postgres(maintenanceUrl.toString(), { max: 1 });
  try {
    await admin.unsafe(`create database "${name.replaceAll('"', '""')}"`);
    console.log(`Created test database ${name}.`);
  } catch (err) {
    if ((err as { code?: string }).code !== DUPLICATE_DATABASE) throw err;
  } finally {
    await admin.end();
  }

  // Every re-run reports each idempotent "already exists, skipping" step.
  await applySchema(testUrl.toString(), { reportNotices: false });
  console.log(`Schema applied to ${name}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
