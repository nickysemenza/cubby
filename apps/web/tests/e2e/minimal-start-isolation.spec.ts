import { Pool } from "pg";

import { test, expect } from "./e2e-test";

test("minimal-start database has no corpus products", async ({
  e2eRuntime,
}) => {
  const pool = new Pool({ connectionString: e2eRuntime.databaseUrl });
  try {
    const result = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM "Product"',
    );
    expect(Number(result.rows[0]?.count)).toBe(0);
  } finally {
    await pool.end();
  }
});
