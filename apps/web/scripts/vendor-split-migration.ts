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
 *   websites — seed `Vendor.website` from the curated brand-domain list that used
 *              to live in `scripts/vendor-domains.ts`. Fills NULLs only.
 *
 * `drizzle-kit push` does the DDL for the new tables in between `rename` and
 * `backfill` — see the PR description for the ordering. The rename is done HERE
 * in SQL rather than by push because push's rename detection is an interactive
 * prompt, and `db:push` runs non-interactively (`push --verbose < /dev/null`):
 * fed EOF, the diff becomes create-plus-drop and destroys all 1121 ledger rows.
 *
 * Usage: `tsx scripts/vendor-split-migration.ts <backup|rename|backfill|verify|drop|websites>`
 */

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
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

type Baseline = {
  path: string;
  total: number;
  count: number;
  byProject: Map<string, number>;
};

/**
 * Recompute pre-migration spend from the newest `backup` dump.
 *
 * This is the only baseline in the process that is genuinely independent of the
 * migration: it is a file written before anything changed, so comparing live
 * numbers against it can actually fail. Querying the live DB twice cannot —
 * see the note on the checks that use this.
 *
 * Reads whichever ledger key the dump has (`Purchase` pre-rename, `Expense`
 * after), and counts only live rows, matching every check it feeds.
 */
const loadBaseline = (): Baseline | null => {
  const dir = process.env.MIGRATION_BACKUP_DIR ?? "/tmp";
  let newest: { path: string; mtime: number } | null = null;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith("vendor-split-backup-") || !name.endsWith(".json")) {
        continue;
      }
      const full = resolve(dir, name);
      const mtime = statSync(full).mtimeMs;
      if (!newest || mtime > newest.mtime) newest = { path: full, mtime };
    }
  } catch {
    return null;
  }
  if (!newest) return null;

  try {
    const parsed = JSON.parse(readFileSync(newest.path, "utf8")) as {
      tables?: Record<string, Array<Record<string, unknown>>>;
    };
    const rows = parsed.tables?.Purchase ?? parsed.tables?.Expense;
    if (!rows) return null;

    const live = rows.filter((r) => r.deletedAt === null);
    const byProject = new Map<string, number>();
    let total = 0;
    for (const r of live) {
      const cost = typeof r.cost === "number" ? r.cost : 0;
      total += cost;
      const key =
        typeof r.projectId === "string" ? r.projectId : "~unassigned~";
      byProject.set(key, (byProject.get(key) ?? 0) + cost);
    }
    return { path: newest.path, total, count: live.length, byProject };
  } catch {
    return null;
  }
};

type Check = { name: string; pass: boolean; detail: string };

/** Whether the legacy `Expense.vendor` / `orderId` columns are still present. */
const hasLegacyColumns = async (): Promise<boolean> => {
  const rows = await q<{ n: number }>(
    `SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'Expense'
        AND column_name IN ('vendor', 'orderId')`,
  );
  return (rows[0]?.n ?? 0) === 2;
};

const verify = async (): Promise<Check[]> => {
  const checks: Check[] = [];

  // Six of the checks below compare the new join against the OLD columns, so they
  // can only run before `drop`. After it they're not "passing", they're
  // inapplicable — reporting them as passes would be exactly the vacuous-gate
  // problem the baseline checks were written to fix, so they're skipped out loud
  // instead. The baseline comparisons still run in both phases.
  const legacy = await hasLegacyColumns();
  if (!legacy) {
    console.log(
      "NOTE: Expense.vendor/orderId are already dropped — the six " +
        "old-vs-new column comparisons are inapplicable and are SKIPPED, not " +
        "passed. The backup-baseline checks below still apply.\n",
    );
  }

  if (legacy) {
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
    const optionDrift = await q<{
      name: string;
      before: number;
      after: number;
    }>(
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
    const siblingDrift = await q<{
      key: string;
      before: string;
      after: string;
    }>(
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
  }

  // ⚠️ Compared against the BACKUP FILE, not against another query of the live DB.
  //
  // This check previously asserted `sum(x FILTER p) + sum(x FILTER NOT p) =
  // sum(x)`, which is a tautology for any boolean partition — it holds by
  // construction whether or not the backfill was correct, and could never fail.
  // A gate that cannot fail is worse than no gate, because it reports PASS.
  //
  // The only genuinely independent baseline is one captured BEFORE anything
  // changed, which is what `backup` writes. Recomputing spend from those rows and
  // comparing it to the live table is a real assertion: it fails if the backfill
  // dropped, duplicated or altered a row.
  const baseline = loadBaseline();
  if (!baseline) {
    checks.push({
      name: "spend matches the pre-migration backup",
      pass: false,
      detail:
        "NO BASELINE FOUND — run `backup` first (or set MIGRATION_BACKUP_DIR). " +
        "Refusing to report a pass on a check that could not run.",
    });
  } else {
    const live = await q<{ total: number; n: number }>(
      `SELECT COALESCE(sum(cost), 0)::numeric AS total, count(*)::int AS n
         FROM "Expense" WHERE "deletedAt" IS NULL`,
    );
    const liveTotal = Number(live[0]?.total ?? 0);
    const liveCount = Number(live[0]?.n ?? 0);
    checks.push({
      name: "spend matches the pre-migration backup",
      pass:
        Math.abs(liveTotal - baseline.total) < 0.005 &&
        liveCount === baseline.count,
      detail: `backup ${baseline.total.toFixed(2)} / ${baseline.count} rows vs live ${liveTotal.toFixed(2)} / ${liveCount} rows (from ${baseline.path})`,
    });

    // Per-project too, since `projectRollups` groups by it — a backfill that
    // moved spend BETWEEN projects would leave the grand total untouched.
    const liveByProject = await q<{ k: string; s: number }>(
      `SELECT COALESCE("projectId"::text, '~unassigned~') AS k,
              COALESCE(sum(cost), 0)::numeric AS s
         FROM "Expense" WHERE "deletedAt" IS NULL GROUP BY 1`,
    );
    const drifted = liveByProject.filter((r) => {
      const was = baseline.byProject.get(r.k) ?? 0;
      return Math.abs(Number(r.s) - was) >= 0.005;
    });
    const vanished = [...baseline.byProject.keys()].filter(
      (k) => !liveByProject.some((r) => r.k === k),
    );
    checks.push({
      name: "per-project spend matches the pre-migration backup",
      pass: drifted.length === 0 && vanished.length === 0,
      detail:
        drifted.length === 0 && vanished.length === 0
          ? `${baseline.byProject.size} project buckets agree`
          : `drifted: ${drifted.map((d) => d.k).join(", ")}; vanished: ${vanished.join(", ")}`,
    });
  }

  // Sanity counts, reported not asserted.
  const shape = await q(
    `SELECT
       (SELECT count(*)::int FROM "Vendor" WHERE "deletedAt" IS NULL) AS vendors,
       (SELECT count(*)::int FROM "Purchase" WHERE "deletedAt" IS NULL) AS purchases,
       (SELECT count(*)::int FROM "Expense" WHERE "deletedAt" IS NULL) AS expenses,
       (SELECT count(*)::int FROM "Purchase" WHERE "deletedAt" IS NULL AND "orderId" IS NOT NULL) AS with_order,
       (SELECT count(*)::int FROM "Purchase" WHERE "statedTotal" IS NOT NULL) AS with_stated_total`,
  );
  // Reported for eyeballing, not asserted — the assertions are the
  // backup-baseline comparisons above.
  const totals = await q<{
    all_rows: number;
    actual: number;
    committed: number;
    credits: number;
    n: number;
  }>(
    `SELECT
       COALESCE(sum(cost), 0)::numeric AS all_rows,
       COALESCE(sum(cost) FILTER (WHERE future = false), 0)::numeric AS actual,
       COALESCE(sum(cost) FILTER (WHERE future = true), 0)::numeric AS committed,
       COALESCE(sum(cost) FILTER (WHERE cost < 0), 0)::numeric AS credits,
       count(*)::int AS n
     FROM "Expense" WHERE "deletedAt" IS NULL`,
  );
  console.log("\nShape:", JSON.stringify(shape[0]));
  console.log("Totals:", JSON.stringify(totals[0]));

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

/**
 * The curated vendor → brand-domain list, inlined from the deleted
 * `scripts/vendor-domains.ts`. Read as `[exact Vendor.name, bare domain]`.
 *
 * **Deliberately incomplete, and it should stay that way.** A wrong domain yields
 * a confidently-wrong logo, which is far worse than no logo — so vendors whose
 * domain isn't certain (small local Bay Area suppliers, ambiguous names like
 * "Muller" or "Casson") are simply absent, and fall through to the monogram tile.
 * Nothing here was inferred from a vendor's name; each was looked up and eyeballed.
 *
 * Names must match `Vendor.name` byte-for-byte ("Home depot" silently matches
 * nothing), which is exactly why this list is a one-shot backfill of a column
 * rather than a permanent lookup table: after this runs, the domain lives on the
 * row and a rename carries it along.
 */
const VENDOR_DOMAINS: [name: string, domain: string][] = [
  ["Amazon", "amazon.com"],
  ["Home Depot", "homedepot.com"],
  ["eBay", "ebay.com"],
  ["Lowe's", "lowes.com"],
  ["SupplyHouse", "supplyhouse.com"],
  ["Direct Tools Outlet", "directtoolsoutlet.com"],
  ["Woodworker Express", "woodworkerexpress.com"],
  ["Harbor Freight", "harborfreight.com"],
  ["Golden State Lumber", "goldenstatelumber.com"],
  ["Sloat Garden Center", "sloatgardens.com"],
  ["Zoro", "zoro.com"],
  ["Rockler", "rockler.com"],
  ["Walmart", "walmart.com"],
  ["Residence Supply", "residencesupply.com"],
  ["B&H", "bhphotovideo.com"],
  ["Rain Bird", "rainbird.com"],
  ["SendCutSend", "sendcutsend.com"],
  ["Woodcraft", "woodcraft.com"],
  ["Color Atelier", "coloratelier.com"],
  ["Four Winds Growers", "fourwindsgrowers.com"],
  ["Urban Farmer", "ufseeds.com"],
  ["DK Hardware", "dkhardware.com"],
  ["Overstock", "overstock.com"],
  ["DigiKey", "digikey.com"],
  ["Etsy", "etsy.com"],
  ["Architectural Depot", "architecturaldepot.com"],
  ["Bambu Lab", "bambulab.com"],
  ["The Growers Exchange", "thegrowers-exchange.com"],
  ["CabinetParts", "cabinetparts.com"],
  ["Botanical Interests", "botanicalinterests.com"],
  ["ToolsToday", "toolstoday.com"],
  ["Flexfire LEDs", "flexfireleds.com"],
  ["SuperBrightLEDs", "superbrightleds.com"],
  ["Mountain Valley Growers", "mountainvalleygrowers.com"],
  ["Tool Nut", "toolnut.com"],
  ["TSO Products", "tsoproducts.com"],
  ["One Green World", "onegreenworld.com"],
  ["Acme Tools", "acmetools.com"],
  ["Flora Grubb Gardens", "floragrubb.com"],
  ["Veradek", "veradek.com"],
  ["Center Hardware", "centerhardware.com"],
  ["Häfele", "hafele.com"],
  ["Sherwin-Williams", "sherwin-williams.com"],
  ["Target", "target.com"],
  ["McMaster-Carr", "mcmaster.com"],
  ["Penn State Industries", "pennstateind.com"],
  ["Festool", "festoolusa.com"],
  ["Festool Recon", "festoolusa.com"],
  ["Northern Tool", "northerntool.com"],
  ["Ewing Irrigation", "ewingoutdoorsupply.com"],
  ["Sprinkler Supply Store", "sprinklersupplystore.com"],
  ["The Evergreen Nursery", "evergreennursery.com"],
];

/**
 * Seed `Vendor.website` from {@link VENDOR_DOMAINS}, matched on exact
 * `Vendor.name`.
 *
 * Stored WITH the `https://` scheme, not as a bare domain: the vendor list
 * renders the value straight into `href={website}`, and a scheme-less href is a
 * relative path. `seed-vendor-logos.ts` normalizes back down to a bare hostname,
 * so it accepts either — the UI is the side with the requirement.
 *
 * Only fills rows where `website IS NULL`. A value someone typed is never
 * overwritten, even when it disagrees with the curated domain — the disagreement
 * is reported instead, since the human-entered one is the more recent judgement.
 * Idempotent: a second run reports every pair as already-set and writes nothing.
 */
const websites = async () => {
  const rows = await q<{ name: string; website: string | null }>(
    `SELECT "name", "website" FROM "Vendor" WHERE "deletedAt" IS NULL`,
  );
  const existing = new Map(rows.map((r) => [r.name, r.website]));

  const set: string[] = [];
  const kept: string[] = [];
  const conflicting: string[] = [];
  const noVendor: string[] = [];

  for (const [name, domain] of VENDOR_DOMAINS) {
    if (!existing.has(name)) {
      noVendor.push(name);
      continue;
    }
    const current = existing.get(name) ?? null;
    const url = `https://${domain}`;
    if (current !== null) {
      if (current === url) kept.push(`${name} = ${current}`);
      else conflicting.push(`${name}: kept ${current}, curated ${url}`);
      continue;
    }
    const res = await pool.query(
      `UPDATE "Vendor"
          SET "website" = $2, "updatedAt" = now()
        WHERE "name" = $1 AND "deletedAt" IS NULL AND "website" IS NULL`,
      [name, url],
    );
    if (res.rowCount === 1) set.push(`${name} → ${url}`);
    else {
      // The row was read as website IS NULL a moment ago, so 0 rows here means
      // something else wrote it in between. Report rather than retry.
      conflicting.push(
        `${name}: UPDATE matched ${res.rowCount} rows, expected 1`,
      );
    }
  }

  for (const line of set) console.log(`  set   ${line}`);
  for (const line of kept) console.log(`  keep  ${line}`);
  for (const line of conflicting) console.log(`  ⚠ differs ${line}`);
  for (const name of noVendor) console.log(`  ⚠ no vendor named "${name}"`);

  const stillNull = await q<{ n: number }>(
    `SELECT count(*)::int AS n FROM "Vendor"
      WHERE "deletedAt" IS NULL AND "website" IS NULL`,
  );
  console.log(
    `\n${set.length} set, ${kept.length} already correct, ${conflicting.length} left alone, ` +
      `${noVendor.length} unmatched (of ${VENDOR_DOMAINS.length} curated pairs).`,
  );
  console.log(
    `${stillNull[0]?.n ?? "?"} live vendor(s) still have no website — monogram tile only.`,
  );
};

/**
 * Drop `Vendor.kind`.
 *
 * The column shipped with the split as a nullable descriptor, then came straight
 * back out: nothing branched on it — every reference was a badge, a hovercard, or
 * a filter — and it was null on 111 of 114 rows. It can return as a plain additive
 * migration if contractor metadata (license, COI expiry) ever needs a
 * discriminator.
 *
 * Explicit SQL rather than `drizzle-kit push --force`, for the same reason as
 * `drop`: push needs a TTY to confirm a data-loss statement, and `--force` would
 * apply whatever else a diff decided. Reports the values being discarded first, so
 * the three rows classified by hand aren't lost silently.
 */
const dropVendorKind = async () => {
  const present = await q<{ n: number }>(
    `SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'Vendor'
        AND column_name = 'kind'`,
  );
  if ((present[0]?.n ?? 0) === 0) {
    console.log("  Vendor.kind is already gone — nothing to do");
    return;
  }

  const classified = await q<{ kind: string; n: number }>(
    `SELECT "kind", count(*)::int AS n FROM "Vendor"
      WHERE "deletedAt" IS NULL AND "kind" IS NOT NULL GROUP BY 1 ORDER BY 1`,
  );
  console.log(
    classified.length === 0
      ? "  no vendor carried a kind"
      : `  discarding: ${classified.map((c) => `${c.kind} (${c.n})`).join(", ")}`,
  );

  const before = await q<{ n: number }>(
    `SELECT count(*)::int AS n FROM "Vendor"`,
  );
  await q(`ALTER TABLE "Vendor" DROP COLUMN "kind"`);
  const after = await q<{ n: number }>(
    `SELECT count(*)::int AS n FROM "Vendor"`,
  );
  if (before[0]?.n !== after[0]?.n) {
    throw new Error(
      `Vendor row count changed across the drop: ${before[0]?.n} → ${after[0]?.n}`,
    );
  }
  console.log(`  dropped "Vendor"."kind"; ${after[0]?.n} vendors intact`);
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
    } else if (cmd === "drop-vendor-kind") {
      await dropVendorKind();
    } else if (cmd === "drop") {
      await drop();
    } else if (cmd === "websites") {
      await websites();
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
      console.error("usage: <backup|rename|backfill|verify|drop|websites>");
      process.exitCode = 2;
    }
  } finally {
    await pool.end();
  }
};

void main();
