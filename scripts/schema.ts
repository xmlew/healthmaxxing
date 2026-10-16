import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

export async function applySchema(
  connectionString: string,
  { reportNotices = true }: { reportNotices?: boolean } = {},
): Promise<void> {
  const schema = readFileSync(join(process.cwd(), "db/schema.sql"), "utf-8");
  const sql = postgres(connectionString, {
    max: 1,
    ...(reportNotices ? {} : { onnotice: () => {} }),
  });
  try {
    await sql.unsafe(schema);
  } finally {
    await sql.end();
  }
}
