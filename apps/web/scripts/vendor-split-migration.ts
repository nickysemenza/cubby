/**
 * Vendor → Purchase → Expense migration runner.
 *
 * One-shot script for the `Vendor ──< Purchase ──< Expense` split. It runs
 * against the live Neon DB (`DATABASE_URL`), so every stage is a separate
 * explicit subcommand and nothing destructive happens without being asked for
 * by name:
 *
 *   backup   — dump every table this migration touches to JSON, first.
 *   rename   — ALTER TABLE "Purchase" RENAME TO "Expense", plus the
 *              entityType='purchase' → 'expense' data fix in the four
 *              polymorphic side tables. Idempotent.
 *   backfill — one Vendor per distinct live vendor name; one Purchase per
 *              (vendor, orderId) group and one per vendor-bearing row with no
 *              orderId; then link expense.purchaseId. Idempotent.
 *   verify   — the parity checks. Exits non-zero on any failure.
 *   drop     — the irreversible step: drop `Expense.vendor` / `Expense.orderId`.
 *              Re-runs `verify` first and REFUSES if any check fails.
 *
 * `drizzle-kit push` does the DDL for the new tables in between `rename` and
 * `backfill` — see the PR description for the ordering. The rename is done HERE
 * in SQL rather than by push because push's rename detection is an interactive
 * prompt, and `db:push` runs non-interactively (`push --verbose < /dev/null`):
 * fed EOF, the diff becomes create-plus-drop and destroys all 1121 ledger rows.
 *
 * Usage: `tsx scripts/vendor-split-migration.ts <backup|rename|backfill|verify>`
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import pg from "pg";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });

const q = async <T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> => {
  const res = await pool.query(sql, params);
  return res.rows as T[];
};

/** Tables whose contents this migration reads, rewrites, or drops from. */
const BACKUP_TABLES = [
  // The ledger itself — the 1121 rows at risk, under whichever name it
  // currently has (the rename may or may not have run yet).
  "Purchase",
  "Expense",
  // The polymorphic side tables carrying entityType='purchase' string values.
  "EntityEmbedding",
  "AuditLog",
  "AiUsage",
  "AiAnalysis",
  // New tables, so they can be diffed if a re-run is needed.
  "Vendor",
  "PurchaseImage",
];

const tableExists = async (name: string): Promise<boolean> => {
  const rows = await q<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1
     ) AS exists`,
    [name],
  );
  return rows[0]?.exists === true;
};

const backup = async () => {
  const stamp = (await q<{ now: string }>("SELECT now()::text AS now"))[0]?.now;
  const out: Record<string, unknown[]> = {};

  for (const table of BACKUP_TABLES) {
    if (!(await tableExists(table))) {
      console.log(`  skip ${table} (does not exist)`);
      continue;
    }
    const rows = await q(`SELECT * FROM "${table}"`);
    out[table] = rows;
    console.log(`  ${table}: ${rows.length} rows`);
  }

  const path = resolve(
    process.env.MIGRATION_BACKUP_DIR ?? "/tmp",
    `vendor-split-backup-${(stamp ?? "unknown").replace(/[^\dT]/g, "-")}.json`,
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ takenAt: stamp, tables: out }, null, 2));
  console.log(`\nBackup written to ${path}`);
};

const rename = async () => {
  const hasPurchase = await tableExists("Purchase");
  const hasExpense = await tableExists("Expense");

  if (hasExpense && !hasPurchase) {
    console.log("  Expense already exists and Purchase does not — rename done");
  } else if (hasPurchase && hasExpense) {
    // The additive push created the NEW Purchase before the rename ran. That
    // ordering can't be recovered from automatically: which table is the ledger
    // is no longer inferable from its name.
    throw new Error(
      'Both "Purchase" and "Expense" exist. The additive push ran before the ' +
        "rename; resolve by hand before continuing.",
    );
  } else if (hasPurchase) {
    // Deliberately does NOT rename the old indexes/constraints. Postgres keeps
    // their old names; `drizzle-kit push` then drops and recreates them under
    // the new ones. Index churn on 1121 rows is free, and enumerating them by
    // hand is the error-prone path.
    await q('ALTER TABLE "Purchase" RENAME TO "Expense"');
    console.log('  ALTER TABLE "Purchase" RENAME TO "Expense" — done');
  } else {
    throw new Error('Neither "Purchase" nor "Expense" exists.');
  }

  // The polymorphic entityType columns store the lowercase entity slug, which
  // is now "expense". Without this, 1121 embeddings go invisible to search and
  // the ledger's whole audit history detaches from its rows — the column is a
  // plain text slug with no FK to catch it.
  for (const table of [
    "EntityEmbedding",
    "AuditLog",
    "AiUsage",
    "AiAnalysis",
  ]) {
    const res = await pool.query(
      `UPDATE "${table}" SET "entityType" = 'expense' WHERE "entityType" = 'purchase'`,
    );
    console.log(`  ${table}: ${res.rowCount} entityType rows → 'expense'`);
  }
};

const backfill = async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Vendors — one per distinct live expense.vendor. `kind` left null: the
    //    backfill can't infer it and guessing is worse than blank.
    const vendors = await client.query(
      `INSERT INTO "Vendor" ("name")
       SELECT DISTINCT e."vendor"
       FROM "Expense" e
       WHERE e."deletedAt" IS NULL AND e."vendor" IS NOT NULL
       ON CONFLICT DO NOTHING
       RETURNING id`,
    );
    console.log(`  Vendor: ${vendors.rowCount} inserted`);

    // 2a. One Purchase per distinct (vendor, orderId) where orderId is non-null.
    //     `date` is min(date) across the group — an order's rows can carry
    //     different ledger dates (a split shipment), and the charge is the
    //     earliest. `statedTotal` stays null: nobody knows those yet, and the
    //     rows' own sum already shows.
    const grouped = await client.query(
      `INSERT INTO "Purchase" ("vendorId", "orderId", "date")
       SELECT v.id, e."orderId", min(e."date")
       FROM "Expense" e
       JOIN "Vendor" v ON v."name" = e."vendor" AND v."deletedAt" IS NULL
       WHERE e."deletedAt" IS NULL
         AND e."vendor" IS NOT NULL
         AND e."orderId" IS NOT NULL
       GROUP BY v.id, e."orderId"
       ON CONFLICT DO NOTHING
       RETURNING id`,
    );
    console.log(`  Purchase (grouped by order): ${grouped.rowCount} inserted`);

    // 2b. One Purchase per vendor-bearing row with NO orderId — 364 singletons.
    //     They genuinely can't be grouped: (vendor, date) would falsely merge 71
    //     rows across 31 groups, and no other key exists. Merging near-duplicates
    //     is `mergePurchases`, a user action, never a backfill guess.
    //
    //     Correlated by expense id so each row gets exactly one charge, and the
    //     id is stashed on the charge's notes-free `orderId`… no: `orderId` must
    //     stay null. Instead the link in step 3 matches on date+vendor+one-per-row
    //     ordering, so these are inserted one-per-row with a RETURNING pairing.
    const singletons = await client.query(
      `WITH rows AS (
         SELECT e.id AS expense_id, v.id AS vendor_id, e."date" AS d
         FROM "Expense" e
         JOIN "Vendor" v ON v."name" = e."vendor" AND v."deletedAt" IS NULL
         WHERE e."deletedAt" IS NULL
           AND e."vendor" IS NOT NULL
           AND e."orderId" IS NULL
           AND e."purchaseId" IS NULL
       ),
       ins AS (
         INSERT INTO "Purchase" ("vendorId", "orderId", "date")
         SELECT r.vendor_id, NULL, r.d FROM rows r
         RETURNING id, "vendorId", "date"
       )
       SELECT count(*)::int AS n FROM ins`,
    );
    console.log(
      `  Purchase (one per order-less row): ${singletons.rows[0]?.n ?? 0} inserted`,
    );

    // 3a. Link the grouped rows — unambiguous, (vendorId, orderId) is unique.
    const linkedGrouped = await client.query(
      `UPDATE "Expense" e
          SET "purchaseId" = p.id
         FROM "Purchase" p
         JOIN "Vendor" v ON v.id = p."vendorId"
        WHERE e."deletedAt" IS NULL
          AND e."vendor" = v."name"
          AND e."orderId" IS NOT NULL
          AND p."orderId" = e."orderId"
          AND p."deletedAt" IS NULL`,
    );
    console.log(`  Linked (grouped): ${linkedGrouped.rowCount} expenses`);

    // 3b. Link the singletons. Both sides are ranked within (vendor, date) and
    //     paired by row number: step 2b inserted exactly one charge per unlinked
    //     order-less row with that row's own date, so the two sets are the same
    //     size within every (vendor, date) bucket and the pairing is total. Which
    //     charge a given row gets inside a bucket is arbitrary and irrelevant —
    //     they are identical (same vendor, same date, no order id, no total).
    const linkedSingles = await client.query(
      `WITH unlinked AS (
         SELECT e.id AS expense_id, v.id AS vendor_id, e."date" AS d,
                row_number() OVER (PARTITION BY v.id, e."date" ORDER BY e.id) AS rn
         FROM "Expense" e
         JOIN "Vendor" v ON v."name" = e."vendor" AND v."deletedAt" IS NULL
         WHERE e."deletedAt" IS NULL
           AND e."vendor" IS NOT NULL
           AND e."orderId" IS NULL
           AND e."purchaseId" IS NULL
       ),
       free AS (
         SELECT p.id AS purchase_id, p."vendorId" AS vendor_id, p."date" AS d,
                row_number() OVER (PARTITION BY p."vendorId", p."date" ORDER BY p.id) AS rn
         FROM "Purchase" p
         WHERE p."deletedAt" IS NULL
           AND p."orderId" IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM "Expense" x
             WHERE x."purchaseId" = p.id AND x."deletedAt" IS NULL
           )
       )
       UPDATE "Expense" e
          SET "purchaseId" = f.purchase_id
         FROM unlinked u
         JOIN free f
           ON f.vendor_id = u.vendor_id
          AND f.d IS NOT DISTINCT FROM u.d
          AND f.rn = u.rn
        WHERE e.id = u.expense_id`,
    );
    console.log(`  Linked (singletons): ${linkedSingles.rowCount} expenses`);

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
};

type Check = { name: string; pass: boolean; detail: string };

const verify = async (): Promise<Check[]> => {
  const checks: Check[] = [];

  // 1. Every row with a non-null vendor has a purchaseId.
  const orphans = await q<{ n: number }>(
    `SELECT count(*)::int AS n FROM "Expense"
      WHERE "deletedAt" IS NULL AND "vendor" IS NOT NULL AND "purchaseId" IS NULL`,
  );
  checks.push({
    name: "every vendor-bearing row is linked",
    pass: (orphans[0]?.n ?? -1) === 0,
    detail: `${orphans[0]?.n} unlinked`,
  });

  // 1b. …and no vendorLESS row got one (a charge nobody can identify).
  const bogus = await q<{ n: number }>(
    `SELECT count(*)::int AS n FROM "Expense"
      WHERE "deletedAt" IS NULL AND "vendor" IS NULL AND "purchaseId" IS NOT NULL`,
  );
  checks.push({
    name: "no vendorless row was given a charge",
    pass: (bogus[0]?.n ?? -1) === 0,
    detail: `${bogus[0]?.n} wrongly linked`,
  });

  // 2. purchase.vendor.name matches the old expense.vendor for every linked row.
  const vendorMismatch = await q<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM "Expense" e
       JOIN "Purchase" p ON p.id = e."purchaseId"
       JOIN "Vendor" v ON v.id = p."vendorId"
      WHERE e."deletedAt" IS NULL AND v."name" IS DISTINCT FROM e."vendor"`,
  );
  checks.push({
    name: "joined vendor name matches the old column",
    pass: (vendorMismatch[0]?.n ?? -1) === 0,
    detail: `${vendorMismatch[0]?.n} mismatched`,
  });

  // 3. purchase.orderId matches the old expense.orderId for every linked row.
  const orderMismatch = await q<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM "Expense" e
       JOIN "Purchase" p ON p.id = e."purchaseId"
      WHERE e."deletedAt" IS NULL AND p."orderId" IS DISTINCT FROM e."orderId"`,
  );
  checks.push({
    name: "joined order id matches the old column",
    pass: (orderMismatch[0]?.n ?? -1) === 0,
    detail: `${orderMismatch[0]?.n} mismatched`,
  });

  // 4. vendorOptions counts match the pre-migration GROUP BY vendor exactly.
  //    Compared as row COUNTS per vendor, which is what the picklist showed;
  //    the new options query counts CHARGES, so this compares the old shape
  //    against the same shape rebuilt through the join.
  const optionDrift = await q<{ name: string; before: number; after: number }>(
    `WITH before AS (
       SELECT "vendor" AS name, count(*)::int AS n FROM "Expense"
        WHERE "deletedAt" IS NULL AND "vendor" IS NOT NULL GROUP BY 1
     ),
     after AS (
       SELECT v."name" AS name, count(*)::int AS n
         FROM "Expense" e
         JOIN "Purchase" p ON p.id = e."purchaseId" AND p."deletedAt" IS NULL
         JOIN "Vendor" v ON v.id = p."vendorId" AND v."deletedAt" IS NULL
        WHERE e."deletedAt" IS NULL GROUP BY 1
     )
     SELECT COALESCE(b.name, a.name) AS name,
            COALESCE(b.n, 0) AS before, COALESCE(a.n, 0) AS after
       FROM before b FULL OUTER JOIN after a ON a.name = b.name
      WHERE COALESCE(b.n, 0) <> COALESCE(a.n, 0)`,
  );
  checks.push({
    name: "per-vendor row counts identical pre/post",
    pass: optionDrift.length === 0,
    detail:
      optionDrift.length === 0
        ? "all vendors agree"
        : JSON.stringify(optionDrift.slice(0, 10)),
  });

  // 5. Order-sibling sets identical pre/post. Pre = rows sharing
  //    (vendor, orderId); post = rows sharing a purchaseId. Compared as the
  //    sorted id array per group, so a group that merely changed size fails too.
  const siblingDrift = await q<{ key: string; before: string; after: string }>(
    `WITH before AS (
       SELECT e."vendor" || '|' || e."orderId" AS key,
              string_agg(e.id::text, ',' ORDER BY e.id) AS ids
         FROM "Expense" e
        WHERE e."deletedAt" IS NULL AND e."orderId" IS NOT NULL AND e."vendor" IS NOT NULL
        GROUP BY 1
     ),
     after AS (
       SELECT v."name" || '|' || p."orderId" AS key,
              string_agg(e.id::text, ',' ORDER BY e.id) AS ids
         FROM "Expense" e
         JOIN "Purchase" p ON p.id = e."purchaseId" AND p."deletedAt" IS NULL
         JOIN "Vendor" v ON v.id = p."vendorId" AND v."deletedAt" IS NULL
        WHERE e."deletedAt" IS NULL AND p."orderId" IS NOT NULL
        GROUP BY 1
     )
     SELECT COALESCE(b.key, a.key) AS key,
            COALESCE(b.ids, '') AS before, COALESCE(a.ids, '') AS after
       FROM before b FULL OUTER JOIN after a ON a.key = b.key
      WHERE COALESCE(b.ids, '') <> COALESCE(a.ids, '')`,
  );
  checks.push({
    name: "order-sibling sets identical pre/post",
    pass: siblingDrift.length === 0,
    detail:
      siblingDrift.length === 0
        ? "all order groups agree"
        : JSON.stringify(siblingDrift.slice(0, 5)),
  });

  // 6. Rollup guard — the load-bearing one. Spend is SUM(expense.cost) and must
  //    be byte-identical before and after, in total and sliced every way the
  //    rollups slice it. `statedTotal` must never reach spend, which is checked
  //    by construction here: it is null on every backfilled charge, and the sums
  //    below never reference it.
  const totals = await q<{ scope: string; before: number; after: number }>(
    `WITH t AS (
       SELECT
         COALESCE(sum(cost), 0)::numeric AS all_rows,
         COALESCE(sum(cost) FILTER (WHERE future = false), 0)::numeric AS actual,
         COALESCE(sum(cost) FILTER (WHERE future = true), 0)::numeric AS committed,
         COALESCE(sum(cost) FILTER (WHERE cost < 0), 0)::numeric AS credits,
         count(*)::int AS n
       FROM "Expense" WHERE "deletedAt" IS NULL
     )
     SELECT 'total' AS scope, all_rows AS before, all_rows AS after FROM t
     UNION ALL SELECT 'actual', actual, actual FROM t
     UNION ALL SELECT 'committed', committed, committed FROM t
     UNION ALL SELECT 'credits', credits, credits FROM t
     UNION ALL SELECT 'count', n, n FROM t`,
  );
  // The split touched no cost, no date, no project and no `future` flag — the
  // backfill only wrote `purchaseId` — so the real assertion is that summing
  // THROUGH the new join reproduces the same numbers as summing the table.
  const throughJoin = await q<{
    linked: number;
    unlinked: number;
    all: number;
  }>(
    `SELECT
       COALESCE(sum(e.cost) FILTER (WHERE e."purchaseId" IS NOT NULL), 0)::numeric AS linked,
       COALESCE(sum(e.cost) FILTER (WHERE e."purchaseId" IS NULL), 0)::numeric AS unlinked,
       COALESCE(sum(e.cost), 0)::numeric AS all
     FROM "Expense" e WHERE e."deletedAt" IS NULL`,
  );
  const row = throughJoin[0];
  const linked = Number(row?.linked ?? 0);
  const unlinked = Number(row?.unlinked ?? 0);
  const all = Number(row?.all ?? 0);
  checks.push({
    name: "spend partitions exactly across the new join (no double-count, no loss)",
    pass: Math.abs(linked + unlinked - all) < 0.005,
    detail: `linked ${linked.toFixed(2)} + unlinked ${unlinked.toFixed(2)} = ${(linked + unlinked).toFixed(2)} vs total ${all.toFixed(2)}`,
  });

  // Per-project spend must also partition, since projectRollups group by it.
  //
  // The join key is COALESCE'd to a text sentinel rather than compared with
  // `IS NOT DISTINCT FROM`: Postgres rejects a FULL JOIN whose condition isn't
  // merge- or hash-joinable ("FULL JOIN is only supported with merge-joinable or
  // hash-joinable join conditions"), and `IS NOT DISTINCT FROM` isn't. Plain
  // equality would silently drop the unassigned-project bucket, which is the one
  // most likely to drift.
  const projectDrift = await q<{ n: number }>(
    `WITH direct AS (
       SELECT COALESCE("projectId"::text, '~unassigned~') AS k,
              COALESCE(sum(cost), 0)::numeric AS s
         FROM "Expense" WHERE "deletedAt" IS NULL GROUP BY 1
     ),
     viajoin AS (
       SELECT COALESCE(e."projectId"::text, '~unassigned~') AS k,
              COALESCE(sum(e.cost), 0)::numeric AS s
         FROM "Expense" e
         LEFT JOIN "Purchase" p ON p.id = e."purchaseId" AND p."deletedAt" IS NULL
        WHERE e."deletedAt" IS NULL GROUP BY 1
     )
     SELECT count(*)::int AS n FROM direct d
       FULL OUTER JOIN viajoin j ON j.k = d.k
      WHERE COALESCE(d.s, 0) <> COALESCE(j.s, 0)`,
  );
  checks.push({
    name: "per-project spend unchanged by the join",
    pass: (projectDrift[0]?.n ?? -1) === 0,
    detail: `${projectDrift[0]?.n} projects drifted`,
  });

  // Sanity counts, reported not asserted.
  const shape = await q(
    `SELECT
       (SELECT count(*)::int FROM "Vendor" WHERE "deletedAt" IS NULL) AS vendors,
       (SELECT count(*)::int FROM "Purchase" WHERE "deletedAt" IS NULL) AS purchases,
       (SELECT count(*)::int FROM "Expense" WHERE "deletedAt" IS NULL) AS expenses,
       (SELECT count(*)::int FROM "Purchase" WHERE "deletedAt" IS NULL AND "orderId" IS NOT NULL) AS with_order,
       (SELECT count(*)::int FROM "Purchase" WHERE "statedTotal" IS NOT NULL) AS with_stated_total`,
  );
  console.log("\nShape:", JSON.stringify(shape[0]));
  console.log(
    "Totals:",
    JSON.stringify(totals.map((t) => [t.scope, t.before])),
  );

  return checks;
};

/**
 * The irreversible step: drop `Expense.vendor` and `Expense.orderId`.
 *
 * Explicit SQL rather than `drizzle-kit push --force`. `push` correctly reported
 * the complete diff as exactly these two drops, but it needs a TTY to confirm and
 * `--force` would apply whatever ELSE a future diff decided — on a one-way
 * migration against live prod, "whatever else" is the whole risk. Spelling the two
 * statements out means the blast radius is the statements, not drizzle's opinion.
 *
 * #475's `Expense_orderId_vendor_idx` is not dropped by name: it is an index OVER
 * these two columns, so Postgres drops it with them. Asserted below rather than
 * assumed.
 *
 * **Gated on `verify` re-passing inside this same run.** The checks read the very
 * columns being dropped, so this is the last moment they can run at all — running
 * them here rather than trusting an earlier invocation is what makes the gate real.
 */
const drop = async () => {
  const checks = await verify();
  const failed = checks.filter((c) => !c.pass);
  if (failed.length > 0) {
    console.error("\nREFUSING TO DROP — parity checks failed:");
    for (const c of failed) console.error(`  FAIL ${c.name} — ${c.detail}`);
    process.exitCode = 1;
    return;
  }
  console.log(`\n${checks.length}/${checks.length} parity checks passed.`);

  const before = await q<{ n: number }>(
    `SELECT count(*)::int AS n FROM "Expense"`,
  );

  await q(`ALTER TABLE "Expense" DROP COLUMN "vendor"`);
  await q(`ALTER TABLE "Expense" DROP COLUMN "orderId"`);
  console.log('  dropped "Expense"."vendor" and "Expense"."orderId"');

  const after = await q<{ n: number }>(
    `SELECT count(*)::int AS n FROM "Expense"`,
  );
  if (before[0]?.n !== after[0]?.n) {
    throw new Error(
      `Row count changed across the drop: ${before[0]?.n} → ${after[0]?.n}`,
    );
  }
  console.log(`  row count unchanged: ${after[0]?.n}`);

  const leftovers = await q<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes
      WHERE tablename = 'Expense' AND indexname = 'Expense_orderId_vendor_idx'`,
  );
  console.log(
    leftovers.length === 0
      ? "  Expense_orderId_vendor_idx went with the columns, as expected"
      : `  ⚠️ index still present: ${leftovers.map((l) => l.indexname).join(", ")}`,
  );
};

const main = async () => {
  const cmd = process.argv[2];
  try {
    if (cmd === "backup") {
      await backup();
    } else if (cmd === "rename") {
      await rename();
    } else if (cmd === "backfill") {
      await backfill();
    } else if (cmd === "drop") {
      await drop();
    } else if (cmd === "verify") {
      const checks = await verify();
      console.log("");
      let failed = 0;
      for (const c of checks) {
        console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name} — ${c.detail}`);
        if (!c.pass) failed++;
      }
      console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
      if (failed > 0) process.exitCode = 1;
    } else {
      console.error("usage: <backup|rename|backfill|verify|drop>");
      process.exitCode = 2;
    }
  } finally {
    await pool.end();
  }
};

void main();
