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
