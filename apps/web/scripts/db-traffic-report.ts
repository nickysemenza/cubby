import "dotenv/config";
import { getErrorMessage } from "@cubby/shared";
import { Pool } from "pg";

interface StatementRow {
  queryId: string;
  calls: string;
  rows: string;
  meanExecTimeMs: string;
  query: string;
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required to report database traffic.");
  process.exit(1);
}

const requestedLimit = Number.parseInt(process.argv[2] ?? "25", 10);
const limit = Number.isFinite(requestedLimit)
  ? Math.min(100, Math.max(1, requestedLimit))
  : 25;
const pool = new Pool({ connectionString: databaseUrl });

const statementSelect = `
  SELECT
    queryid::text AS "queryId",
    calls::text AS calls,
    rows::text AS rows,
    round(mean_exec_time::numeric, 2)::text AS "meanExecTimeMs",
    query
  FROM pg_stat_statements
  WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
`;

const present = (rows: StatementRow[]) =>
  rows.map((row) => ({
    queryId: row.queryId,
    calls: Number(row.calls),
    rows: Number(row.rows),
    meanExecTimeMs: Number(row.meanExecTimeMs),
    query: row.query.replaceAll(/\s+/g, " ").trim().slice(0, 240),
  }));

try {
  const [byCalls, byRows] = await Promise.all([
    pool.query<StatementRow>(
      `${statementSelect} ORDER BY calls DESC, rows DESC LIMIT $1`,
      [limit],
    ),
    pool.query<StatementRow>(
      `${statementSelect} ORDER BY rows DESC, calls DESC LIMIT $1`,
      [limit],
    ),
  ]);

  console.log(`Top ${limit} normalized statements by calls`);
  console.table(present(byCalls.rows));
  console.log(`Top ${limit} normalized statements by returned rows`);
  console.table(present(byRows.rows));
} catch (error) {
  console.error(`Could not read pg_stat_statements: ${getErrorMessage(error)}`);
  console.error(
    "Run pnpm db:ensure-extensions and confirm pg_stat_statements is preloaded by the database provider.",
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
