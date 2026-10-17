import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterEach, beforeEach, expect, it } from "vitest";
import { captureBackgroundQueue } from "~/server/testing/background-queue";
import { resolveDevProfile } from "../dev-services/dev-profile";
import { prepareDevDatabase } from "../dev/corpus-template";
import { DEV_USER_EMAIL } from "../dev/state";
import { createPostgresPool } from "../postgres-pool";
import { databaseIdentifier } from "../schema-template";
import { testServiceConfig } from "../test-service-config";
import { TEST_USER_ID } from "../test-setup";
import { readHouseholdCoverage, seedCorpus } from "./corpus";
import { seedNativeQa } from "./native-qa";

// Failure modes: a domain silently stays empty; curated links become unrelated
// filler; reseeding duplicates the graph; image records point at unstored bytes;
// fixture work dispatches live providers. PostgreSQL read-back owns these checks.
// Curated chronology must move together with the reference day, and every
// synthetic member must have the same user-backed identity as production.
//
// The household is read from a clone of the dev corpus template, which seeds
// through `seedCorpus` once per template hash; reseeding it here per run cost
// ~50s and duplicated `corpus-template.integration.test.ts`.
let queue: ReturnType<typeof captureBackgroundQueue>;
beforeEach(() => {
  queue = captureBackgroundQueue();
});
afterEach(() => queue.restore());

it("seeds a complete connected household with real stored images and skips a completed seed", async () => {
  const config = testServiceConfig();
  const port = ["localhost", "127.0.0.1"].includes(config.host)
    ? 55432
    : config.port;
  const base = `postgresql://postgres:password@${config.host}:${port}`;
  const checkout = realpathSync(
    mkdtempSync(join(tmpdir(), "cubby-household-contract-")),
  );
  const name = resolveDevProfile(checkout, {}).name;
  const admin = new Client({ connectionString: `${base}/postgres` });
  await admin.connect();
  await prepareDevDatabase(name, checkout, `${base}/${name}`);
  const pool = createPostgresPool({ connectionString: `${base}/${name}` });
  try {
    // The seed and its reseed share the template's storage settings.
    const options = {
      storageOrigin: "http://127.0.0.1:9",
      bucket: "cubby-local",
      keyPrefix: "cubby-local",
    };
    const refusedPool = createPostgresPool({
      connectionString:
        "postgresql://postgres:password@localhost:55432/household",
    });
    try {
      await expect(
        seedCorpus(refusedPool, TEST_USER_ID, options),
      ).rejects.toThrow("guarded dev/native database");
    } finally {
      await refusedPool.end();
    }
    const [seedUser = ""] = (
      await pool.query<{ id: string }>(
        'SELECT id FROM "user" WHERE email = $1',
        [DEV_USER_EMAIL],
      )
    ).rows.map((row) => row.id);
    expect(seedUser).not.toBe("");
    await expect(
      seedCorpus(pool, seedUser, {
        ...options,
        storageOrigin: "https://example.com",
      }),
    ).rejects.toThrow("local test/dev origin");
    const coverage = await readHouseholdCoverage(pool);
    expect(coverage.filter((row) => row.status === "missing")).toEqual([]);
    expect(
      coverage
        .filter((row) => row.status === "external")
        .map((row) => row.entity),
    ).toEqual(["usda-food"]);
    const total = coverage.reduce((sum, row) => sum + row.count, 0);
    expect(total).toBeGreaterThanOrEqual(200);
    expect(total).toBeLessThan(600);
    const linked = await pool.query(`SELECT
      (SELECT count(*)::int FROM "Task" WHERE "projectId" IS NOT NULL AND "subjectProductId" IS NOT NULL) AS tasks,
      (SELECT count(*)::int FROM "Planting" WHERE "sourceProductId" IS NOT NULL AND "locationId" IS NOT NULL AND "taskId" IS NOT NULL) AS plantings,
      (SELECT count(*)::int FROM "Recipe" WHERE "cookbookId" IS NOT NULL) AS book_recipes,
      (SELECT count(*)::int FROM "FinancialTransactionAllocation") AS allocations,
      (SELECT count(*)::int FROM "MealRecipe") AS meal_recipes`);
    for (const value of Object.values(linked.rows[0]))
      expect(value).toBeGreaterThan(0);
    const inconsistent = await pool.query(`SELECT
      (SELECT count(*)::int FROM "Expense" e JOIN "Purchase" p ON p.id = e."purchaseId" WHERE e.date < p.date) AS expense_dates,
      (SELECT count(*)::int FROM "Expense" e JOIN "Project" p ON p.id = e."projectId" WHERE e.date < p."startDate") AS project_dates,
      (SELECT count(*)::int FROM "Planting" p JOIN "Task" t ON t.id = p."taskId" WHERE p."sowedOn" IS NOT NULL AND t."dueDate" > p."sowedOn") AS planting_dates,
      (SELECT count(*)::int FROM "LedgerParty" p LEFT JOIN "user" u ON u.id = p."userId" WHERE p.kind = 'member' AND u.id IS NULL) AS orphan_members`);
    for (const value of Object.values(inconsistent.rows[0]))
      expect(value).toBe(0);
    // Every available Image points at bytes the seed PUT to storage.
    const images = await pool.query<{ key: string; bytes: number | null }>(
      `SELECT i.key, u.bytes FROM "Image" i
         LEFT JOIN cubby_dev_fixture_upload u ON u.path = '/cubby-local/' || i.key
        WHERE i."storageStatus" = 'available'`,
    );
    expect(images.rowCount).toBeGreaterThan(2);
    for (const { bytes } of images.rows) expect(bytes).toBeGreaterThan(0);
    const inventory = await pool.query(
      'SELECT sum("amountValue")::text AS amount FROM "InventoryEntry"',
    );
    await seedCorpus(pool, seedUser, options);
    expect(await readHouseholdCoverage(pool)).toEqual(coverage);
    expect(
      (
        await pool.query(
          'SELECT sum("amountValue")::text AS amount FROM "InventoryEntry"',
        )
      ).rows,
    ).toEqual(inventory.rows);
    expect(
      (
        await pool.query(
          'SELECT count(*)::int AS count FROM "ImageProcessingAttempt"',
        )
      ).rows[0].count,
    ).toBe(0);
    expect(
      (
        await pool.query(
          'SELECT count(*)::int AS count FROM "Image" WHERE "storageStatus" = \'missing\'',
        )
      ).rows[0].count,
    ).toBe(1);
    expect(
      (await pool.query('SELECT count(*)::int AS count FROM "MealFoodEntry"'))
        .rows[0].count,
    ).toBeGreaterThan(0);
    await pool.query("UPDATE cubby_household_fixture SET state = 'failed'");
    await expect(seedCorpus(pool, seedUser, options)).rejects.toThrow(
      "reset the ephemeral database",
    );
    expect(await readHouseholdCoverage(pool)).toEqual(coverage);
    const qaIds = await seedNativeQa(pool, seedUser);
    expect(qaIds.PRODUCT_ID).toBeTruthy();
    expect(qaIds.RECIPE_ID).toBeTruthy();
  } finally {
    await pool.end();
    await admin.query(
      `DROP DATABASE IF EXISTS ${databaseIdentifier(name)} WITH (FORCE)`,
    );
    await admin.end();
    rmSync(checkout, { recursive: true, force: true });
  }
}, 120_000);
