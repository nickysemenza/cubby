import "dotenv/config";
import { Client } from "pg";

/**
 * Create the `Household` project and move the spend that is life rather than
 * project work onto it.
 *
 * `Expense.projectId IS NULL` means two things at once — "not project work"
 * (groceries, shampoo, dog treats) and "not yet triaged" — so the Unassigned
 * saved view can never reach zero. Giving the first meaning a real project is
 * what makes the second one a worklist. The view needs no code change: once a
 * row carries a non-null projectId it drops out of `projectId IS NULL` by
 * construction.
 *
 * Usage:
 *   # 1. Review. This is the default — no flag writes anything.
 *   pnpm --filter @cubby/web db:backfill-household-project
 *
 *   # 2. Write, naming the count you reviewed. A mismatch aborts.
 *   pnpm --filter @cubby/web db:backfill-household-project -- --write --confirm-count=5304
 *
 * Three deliberate choices:
 *
 * 1. **Audit rows are written.** This is a 5,300-row change to money
 *    attribution on an accounting table; the ledger should record that it
 *    happened and that a script did it. `AuditLog.source` accepts an
 *    open-ended `script:<slug>` precisely for one-off maintenance like this.
 *
 * 2. **Chunked, not one statement.** The UPDATE itself would be fine in one go,
 *    but the audit insert is one row per expense, and a single 5,300-row
 *    transaction holding both is a long lock on the busiest table in the
 *    schema for no benefit. Each chunk is its own transaction, which also
 *    makes a partial run safe to resume — the cohort query only ever returns
 *    rows that still need moving.
 *
 * 3. **The cohort is computed fresh on every run**, never read from a constant.
 *    `--confirm-count` is checked against what the query returns *now*, so a
 *    stale number from an earlier review aborts instead of writing a different
 *    set than the one that was reviewed.
 *
 * Two tiers, disjoint by category so they cannot overlap:
 *   1. every food-linked line (the bulk of it);
 *   2. household/supplies products bought three or more times — the shampoo and
 *      dog-treat class. Deliberately a one-time backfill and NOT a rule in
 *      `createExpense`: it is a retrospective aggregate over a product's whole
 *      history, so encoding it per-insert would triage the third bottle of
 *      shampoo while leaving the first two behind.
 */

const HOUSEHOLD_SHORTCODE = "PRJ-HSHD";
const CHUNK_SIZE = 250;

/** Matches `resolveDefaultProjectId`'s food rule plus the repurchase tier. */
const COHORT_CTE = `
  WITH repurchased AS (
    SELECT "productId"
    FROM "Expense"
    WHERE "deletedAt" IS NULL AND "productId" IS NOT NULL
    GROUP BY "productId"
    HAVING count(*) >= 3
  )
  SELECT e.id
  FROM "Expense" e
  JOIN "Product" p ON p.id = e."productId"
  WHERE e."deletedAt" IS NULL
    AND p."deletedAt" IS NULL
    AND e."projectId" IS NULL
    AND (
      p.category = 'food'
      OR (p.category IN ('household','supplies') AND p.id IN (SELECT "productId" FROM repurchased))
    )
`;

async function main() {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const confirmArg = args.find((a) => a.startsWith("--confirm-count="));
  const confirmCount = confirmArg
    ? Number(confirmArg.split("=")[1])
    : undefined;

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const client = new Client({ connectionString: url });
  await client.connect();

  try {
    const { rows: cohort } = await client.query<{ id: string }>(COHORT_CTE);
    const ids = cohort.map((r) => r.id);
    console.log(`Expense lines awaiting Household: ${ids.length}`);

    const { rows: existing } = await client.query<{ id: string }>(
      `SELECT id FROM "Project" WHERE shortcode = $1 AND "deletedAt" IS NULL`,
      [HOUSEHOLD_SHORTCODE],
    );
    console.log(
      existing[0]
        ? `Household project exists: ${existing[0].id}`
        : `Household project does not exist yet — it will be created.`,
    );

    if (!write) {
      console.log(
        `\nReview only. To write:\n  pnpm --filter @cubby/web db:backfill-household-project -- --write --confirm-count=${ids.length}`,
      );
      return;
    }
    if (confirmCount !== ids.length) {
      throw new Error(
        `Refusing to write: --confirm-count=${confirmArg ? confirmCount : "(absent)"} does not match the ${ids.length} rows found now. Re-review and re-run.`,
      );
    }

    const { rows: users } = await client.query<{ id: string }>(
      `SELECT id FROM "user" LIMIT 1`,
    );
    const userId = users[0]?.id;
    if (!userId) throw new Error("No user row to attribute the audit log to");

    // Create the project if absent. Its shortcode is a literal the application
    // resolves by (see HOUSEHOLD_PROJECT_SHORTCODE), so it cannot be minted by
    // the usual nanoid path.
    let projectId = existing[0]?.id;
    if (!projectId) {
      const { rows: created } = await client.query<{ id: string }>(
        `INSERT INTO "Project" (id, shortcode, name, notes, kind, status, "createdAt", "updatedAt")
         VALUES (gen_random_uuid(), $1, 'Household', $2, 'household', 'in_progress', now(), now())
         RETURNING id`,
        [
          HOUSEHOLD_SHORTCODE,
          "Life, not project work — groceries, household supplies, pet and personal care. Exists so an unassigned expense means exactly one thing: not yet triaged.",
        ],
      );
      projectId = created[0]?.id;
      if (!projectId) throw new Error("Failed to create the Household project");
      console.log(`Created Household project ${projectId}`);
    }

    let moved = 0;
    for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
      const chunk = ids.slice(i, i + CHUNK_SIZE);
      await client.query("BEGIN");
      // RETURNING drives the audit insert, so a re-run that updates nothing
      // also writes nothing. Auditing the whole chunk instead would mint a
      // duplicate "changed projectId" row for every already-moved expense.
      const updated = await client.query<{ id: string }>(
        `UPDATE "Expense" SET "projectId" = $1
         WHERE id = ANY($2::uuid[]) AND "projectId" IS NULL
         RETURNING id`,
        [projectId, chunk],
      );
      const changedIds = updated.rows.map((r) => r.id);
      if (changedIds.length > 0) {
        await client.query(
          `INSERT INTO "AuditLog" (id, "entityType", "entityId", action, changes, "userId", source, "createdAt")
           SELECT gen_random_uuid(), 'expense', x.id, 'update',
                  jsonb_build_object('projectId', jsonb_build_object('from', NULL, 'to', $1::text)),
                  $2, 'script:backfill-household-project', now()
           FROM unnest($3::uuid[]) AS x(id)`,
          [projectId, userId, changedIds],
        );
      }
      await client.query("COMMIT");
      moved += changedIds.length;
      console.log(`  ${moved}/${ids.length}`);
    }

    const { rows: verify } = await client.query(
      `SELECT
         (SELECT count(*)::int FROM "Expense" WHERE "deletedAt" IS NULL AND "projectId" IS NULL) AS unassigned_remaining,
         (SELECT count(*)::int FROM "Expense" WHERE "deletedAt" IS NULL AND "projectId" = $1) AS on_household`,
      [projectId],
    );
    console.log("\nVerification:");
    console.table(verify);

    const { rows: leftover } = await client.query<{ id: string }>(COHORT_CTE);
    if (leftover.length > 0) {
      throw new Error(
        `${leftover.length} cohort rows still unassigned after the write — investigate.`,
      );
    }
    console.log("Cohort is empty. Done.");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
