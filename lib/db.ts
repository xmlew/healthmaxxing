import postgres, { type Sql, type TransactionSql } from "postgres";

declare global {
  var __healthMaxxingSql: ReturnType<typeof postgres> | undefined;
}

function createClient() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }
  return postgres(connectionString, { max: 5 });
}

// Reuse the connection pool across hot reloads / warm serverless invocations.
export const sql = globalThis.__healthMaxxingSql ?? createClient();
if (process.env.NODE_ENV !== "production") {
  globalThis.__healthMaxxingSql = sql;
}

// A query target: the pool, or a transaction a caller has already opened.
export type Db = Sql | TransactionSql;

// For partial updates: a value left undefined keeps the column as it is, and
// anything else (null included) is written.
export function valueOrKeep(db: Db, value: string | number | null | undefined, column: string) {
  return value === undefined ? db(column) : db`${value}`;
}
