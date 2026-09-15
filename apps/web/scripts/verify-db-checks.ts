import "dotenv/config";

import { Pool } from "pg";

import {
  compareDatabaseChecks,
  REQUIRED_DATABASE_CHECKS,
  type DatabaseCheckConstraint,
} from "./db-check-contract";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required to verify CHECKs.");

const pool = new Pool({ connectionString: databaseUrl });
try {
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const result = await client.query<{
      name: string;
      definition: string;
      validated: boolean;
    }>(`
      SELECT conname AS name,
             pg_get_constraintdef(oid, true) AS definition,
             convalidated AS validated
      FROM pg_constraint
      WHERE contype = 'c'
        AND connamespace = 'public'::regnamespace
      ORDER BY conname
    `);
    const actual: DatabaseCheckConstraint[] = result.rows;
    const violations = compareDatabaseChecks(actual);
    if (violations.length > 0) {
      console.error("Database CHECK firewall does not match its manifest:");
      for (const violation of violations) console.error(violation);
      process.exitCode = 1;
    } else {
      console.log(
        `Verified ${REQUIRED_DATABASE_CHECKS.length} validated database CHECK constraints.`,
      );
    }
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
