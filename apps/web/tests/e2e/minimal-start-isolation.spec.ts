import { test, expect } from "@playwright/test";
import { Pool } from "pg";

import { createE2EWorkerRuntime } from "./e2e-worker-runtime";

// oxlint-disable-next-line no-empty-pattern -- Playwright requires fixture destructuring.
test("minimal-start database has no corpus products", async ({}, testInfo) => {
  const runtime = await createE2EWorkerRuntime({
    authenticated: true,
    parallelIndex: testInfo.parallelIndex,
  });
  const pool = new Pool({ connectionString: runtime.databaseUrl });
  try {
    const result = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM "Product"',
    );
    expect(Number(result.rows[0]?.count)).toBe(0);
  } finally {
    await pool.end();
    await runtime.close();
  }
});
