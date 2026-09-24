import { Pool } from "pg";

import { test, expect } from "./corpus-test";

test("the opt-in corpus belongs to this test database", async ({
  e2eRuntime,
  page,
}) => {
  const pool = new Pool({ connectionString: e2eRuntime.databaseUrl });
  try {
    const result = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM "Product"',
    );
    expect(Number(result.rows[0]?.count)).toBeGreaterThan(0);
  } finally {
    await pool.end();
  }
  await page.goto("/");
  await expect(page.locator("body")).toBeVisible();
});
