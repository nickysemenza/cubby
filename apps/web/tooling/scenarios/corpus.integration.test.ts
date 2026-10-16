import { captureBackgroundQueue } from "~/server/testing/background-queue";
import { createServer } from "node:http";
import { once } from "node:events";
import { afterAll, beforeAll, beforeEach, afterEach, expect, it } from "vitest";
import { createPostgresPool } from "../postgres-pool";
import { TEST_USER_ID, withTestDb } from "../test-setup";
import { readHouseholdCoverage, seedCorpus } from "./corpus";
import { seedNativeQa } from "./native-qa";

// Failure modes: a domain silently stays empty; curated links become unrelated
// filler; reseeding duplicates the graph; image records point at unstored bytes;
// fixture work dispatches live providers. PostgreSQL read-back owns these checks.
// Curated chronology must move together with the reference day, and every
// synthetic member must have the same user-backed identity as production.
const ctx = withTestDb();
let queue: ReturnType<typeof captureBackgroundQueue>;
beforeEach(() => {
  queue = captureBackgroundQueue();
});
afterEach(() => queue.restore());
const objects = new Map<string, Buffer>();
const storage = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (request.method === "PUT")
    objects.set(request.url ?? "", Buffer.concat(chunks));
  response.end();
});
let storageOrigin = "";
beforeAll(async () => {
  storage.listen(0, "127.0.0.1");
  await once(storage, "listening");
  const address = storage.address();
  if (!address || typeof address === "string")
    throw new Error("Storage did not listen");
  storageOrigin = `http://127.0.0.1:${address.port}`;
});
afterAll(
  () =>
    new Promise<void>((resolve, reject) =>
      storage.close((error) => (error ? reject(error) : resolve())),
    ),
);

it("seeds a complete connected household with real stored images and skips a completed seed", async () => {
  const pool = createPostgresPool({ connectionString: ctx.databaseUrl });
  try {
    const options = {
      storageOrigin,
      bucket: "household-test",
      keyPrefix: "household",
      referenceDate: "2026-10-12",
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
    await expect(
      seedCorpus(pool, TEST_USER_ID, {
        ...options,
        storageOrigin: "https://example.com",
      }),
    ).rejects.toThrow("local test/dev origin");
    await seedCorpus(pool, TEST_USER_ID, options);
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
    const images = await pool.query(
      'SELECT key FROM "Image" WHERE "storageStatus" = \'available\'',
    );
    expect(images.rowCount).toBeGreaterThan(2);
    for (const { key } of images.rows)
      expect(objects.get(`/household-test/${key}`)?.length).toBeGreaterThan(0);
    const inventory = await pool.query(
      'SELECT sum("amountValue")::text AS amount FROM "InventoryEntry"',
    );
    await seedCorpus(pool, TEST_USER_ID, options);
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
    await expect(seedCorpus(pool, TEST_USER_ID, options)).rejects.toThrow(
      "reset the ephemeral database",
    );
    expect(await readHouseholdCoverage(pool)).toEqual(coverage);
    const qaIds = await seedNativeQa(pool, TEST_USER_ID);
    expect(qaIds.PRODUCT_ID).toBeTruthy();
    expect(qaIds.RECIPE_ID).toBeTruthy();
  } finally {
    await pool.end();
  }
}, 120_000);
