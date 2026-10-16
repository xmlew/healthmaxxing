import dotenv from "dotenv";

dotenv.config({ path: ".env.local", quiet: true });

const TEST_SUFFIX = "_test";

// The dev database holds real logged data, so every suite that writes runs
// against a sibling database named after it. Derived rather than configured so
// a missing setting can never fall through to the real one.
export function testDatabaseUrl(): string {
  const devUrl = process.env.DATABASE_URL;
  if (!devUrl) throw new Error("DATABASE_URL is not set (check .env.local)");
  const url = new URL(devUrl);
  const name = url.pathname.slice(1);
  if (!name.endsWith(TEST_SUFFIX)) url.pathname = `/${name}${TEST_SUFFIX}`;
  return url.toString();
}

// Call before anything reads DATABASE_URL: the server each suite spawns inherits
// it, and Next.js lets process.env win over .env.local.
export function selectTestDatabase(): string {
  const url = testDatabaseUrl();
  process.env.DATABASE_URL = url;
  return url;
}
