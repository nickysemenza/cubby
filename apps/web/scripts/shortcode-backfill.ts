/**
 * Shortcode cutover runner — UUIDs become private, shortcodes become the public id.
 *
 * Runs against the live Neon DB (`DATABASE_URL`), so every stage is a separate
 * explicit subcommand and nothing writes without being asked for by name:
 *
 *   audit      — read-only. Report nulls, duplicates, legacy prefixes, and what
 *                each later stage would do. Safe to run any time.
 *   addcolumns — ALTER TABLE ... ADD COLUMN "shortcode" text (NULLABLE) on the
 *                nine tables gaining one, and DROP NOT NULL nowhere. Idempotent.
 *   backfill   — the three data steps, in order (see below). Idempotent.
 *   fixindexes — rebuild the three pre-existing shortcode indexes without their
 *                partial `WHERE "deletedAt" IS NULL` clause, which `db:push`
 *                will not do for you. Idempotent.
 *   verify     — the invariant checks. Exits non-zero on any failure.
 *
 * ORDER OF OPERATIONS — this matters, and it is why `addcolumns` exists at all:
 *
 *   1. tsx scripts/shortcode-backfill.ts audit
 *   2. tsx scripts/shortcode-backfill.ts addcolumns
 *   3. tsx scripts/shortcode-backfill.ts backfill
 *   4. tsx scripts/shortcode-backfill.ts verify
 *   5. pnpm db:push          ← applies NOT NULL + creates the nine NEW indexes
 *   6. tsx scripts/shortcode-backfill.ts fixindexes
 *   7. tsx scripts/shortcode-backfill.ts verify
 *
 * schema.ts declares the FINAL state (`text().notNull()` + a non-partial unique
 * index), which drizzle-kit cannot reach in one shot on a populated table — it
 * would have to invent a default for 5,493 rows. So this script adds the columns
 * nullable, fills them, and `db:push` then only has to tighten the constraint.
 * There is no intermediate schema.ts state and no throwaway commit.
 *
 * Step 6 is not optional and not a belt-and-braces re-run: push does not diff an
 * index's WHERE clause, so it leaves an already-partial index partial forever.
 * See `fixindexes` for the evidence.
 *
 * The three backfill steps:
 *
 *   1. RETIRE LEGACY PREFIXES. `P-4K7M` → `PRD-4K7M`, `R-` → `RCP-`, `L-` → `LOC-`.
 *      A pure prefix swap: the 4-char body is preserved, which is what lets the
 *      old single-letter codes stay resolvable forever through a 3-entry inbound
 *      alias map instead of an alias TABLE. Printed QR labels never need
 *      reprinting.
 *
 *   2. BREAK EXISTING DUPLICATES. 269 codes were already held by two rows —
 *      always a soft-deleted row plus a live one, because the old unique indexes
 *      were partial on `deletedAt IS NULL` and so let a code be handed out again
 *      once its first owner was deleted. The LIVE row keeps the code (its label
 *      is physically stuck to something); the deleted row is re-minted. Where
 *      both rows are deleted, the older one keeps it, arbitrarily but stably.
 *
 *   3. MINT THE MISSING. Every row of the nine new tables, plus any straggler
 *      null in Recipe (whose column was nullable before the cutover).
 *
 * Usage: `tsx scripts/shortcode-backfill.ts <audit|addcolumns|backfill|verify>`
 */

import "dotenv/config";
import {
  LEGACY_SHORTCODE_PREFIX,
  SHORTCODE_CHARS,
  SHORTCODE_PREFIX,
  type ShortcodeType,
} from "@cubby/shared";
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

/** Entity → table name. Mirrors SHORTCODE_TABLE in repo/shortcode-utils.ts. */
const TABLE: Record<ShortcodeType, string> = {
  cookbook: "Cookbook",
  expense: "Expense",
  ingredient: "Ingredient",
  inventory: "InventoryEntry",
  location: "Location",
  meal: "Meal",
  product: "Product",
  project: "Project",
  purchase: "Purchase",
  recipe: "Recipe",
  task: "Task",
  vendor: "Vendor",
};

const ENTITIES = Object.keys(TABLE) as ShortcodeType[];

/** The nine tables gaining a column; the other three have had one for a while. */
const NEW_COLUMN_ENTITIES: ShortcodeType[] = [
  "cookbook",
  "expense",
  "ingredient",
  "inventory",
  "meal",
  "project",
  "purchase",
  "task",
  "vendor",
];

const bodyPattern = `[${SHORTCODE_CHARS}]{4}`;
const canonicalPattern = (entity: ShortcodeType) =>
  `^${SHORTCODE_PREFIX[entity]}${bodyPattern}$`;

const randomBody = () => {
  let out = "";
  for (let i = 0; i < 4; i++) {
    out += SHORTCODE_CHARS[Math.floor(Math.random() * SHORTCODE_CHARS.length)];
  }
  return out;
};

/**
 * Mint codes against an in-memory set of everything already taken in that table.
 * One pass, no per-row query — 5,493 rows against a 923,521-wide namespace, so
 * collisions are rare and retrying in memory is free. `taken` is mutated so
 * codes minted in this pass can't collide with each other either.
 */
const mintCodes = (
  entity: ShortcodeType,
  count: number,
  taken: Set<string>,
): string[] => {
  const minted: string[] = [];
  for (let i = 0; i < count; i++) {
    let code: string;
    do {
      code = `${SHORTCODE_PREFIX[entity]}${randomBody()}`;
    } while (taken.has(code));
    taken.add(code);
    minted.push(code);
  }
  return minted;
};

const takenCodes = async (entity: ShortcodeType): Promise<Set<string>> => {
  const rows = await q<{ shortcode: string | null }>(
    `SELECT shortcode FROM "${TABLE[entity]}" WHERE shortcode IS NOT NULL`,
  );
  return new Set(rows.map((r) => r.shortcode as string));
};

/** Apply id → shortcode in one statement rather than N round trips. */
const applyCodes = async (
  entity: ShortcodeType,
  updates: { id: string; shortcode: string }[],
): Promise<void> => {
  if (updates.length === 0) return;
  const CHUNK = 500;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const chunk = updates.slice(i, i + CHUNK);
    const values = chunk
      .map((_, n) => `($${n * 2 + 1}::uuid, $${n * 2 + 2}::text)`)
      .join(", ");
    await q(
      `UPDATE "${TABLE[entity]}" AS t SET shortcode = v.code
       FROM (VALUES ${values}) AS v(id, code)
       WHERE t.id = v.id`,
      chunk.flatMap((u) => [u.id, u.shortcode]),
    );
  }
};

const columnExists = async (table: string): Promise<boolean> => {
  const rows = await q<{ n: string }>(
    `SELECT count(*) n FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'shortcode'`,
    [table],
  );
  return Number(rows[0]?.n ?? 0) > 0;
};

// ---------------------------------------------------------------------------
// audit
// ---------------------------------------------------------------------------

const audit = async (): Promise<void> => {
  console.log("entity          rows   coded   dupes  legacy  malformed");
  for (const entity of ENTITIES) {
    const table = TABLE[entity];
    if (!(await columnExists(table))) {
      const [countRow] = await q<{ n: string }>(
        `SELECT count(*) n FROM "${table}"`,
      );
      const n = countRow?.n ?? "0";
      console.log(
        `${entity.padEnd(14)} ${String(n).padStart(5)}       — (no shortcode column yet)`,
      );
      continue;
    }
    const legacyPrefix = Object.entries(LEGACY_SHORTCODE_PREFIX).find(
      ([, e]) => e === entity,
    )?.[0];
    const [row] = await q<{
      rows: string;
      coded: string;
      dupes: string;
      legacy: string;
      malformed: string;
    }>(
      `SELECT count(*) rows,
              count(shortcode) coded,
              count(*) - count(DISTINCT shortcode) dupes,
              count(*) FILTER (WHERE shortcode LIKE $1) legacy,
              count(*) FILTER (WHERE shortcode IS NOT NULL
                                 AND shortcode !~ $2
                                 AND shortcode NOT LIKE $1) malformed
       FROM "${table}"`,
      [legacyPrefix ? `${legacyPrefix}%` : " %", canonicalPattern(entity)],
    );
    console.log(
      `${entity.padEnd(14)} ${String(row?.rows).padStart(5)} ${String(row?.coded).padStart(7)} ${String(row?.dupes).padStart(7)} ${String(row?.legacy).padStart(7)} ${String(row?.malformed).padStart(10)}`,
    );
  }
};

// ---------------------------------------------------------------------------
// addcolumns
// ---------------------------------------------------------------------------

const addcolumns = async (): Promise<void> => {
  for (const entity of NEW_COLUMN_ENTITIES) {
    const table = TABLE[entity];
    // Nullable on purpose — `backfill` fills it and `db:push` then adds the
    // NOT NULL. Adding it NOT NULL here would need a bogus default.
    await q(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS shortcode text`);
    console.log(`${table}: shortcode column present`);
  }
};

// ---------------------------------------------------------------------------
// backfill
// ---------------------------------------------------------------------------

const retireLegacyPrefixes = async (): Promise<void> => {
  for (const [legacy, entity] of Object.entries(LEGACY_SHORTCODE_PREFIX) as [
    string,
    ShortcodeType,
  ][]) {
    const canonical = SHORTCODE_PREFIX[entity];
    const rows = await q(
      `UPDATE "${TABLE[entity]}"
         SET shortcode = $1 || substring(shortcode from ${legacy.length + 1})
       WHERE shortcode LIKE $2
       RETURNING id`,
      [canonical, `${legacy}%`],
    );
    console.log(
      `${TABLE[entity]}: rewrote ${rows.length} ${legacy} → ${canonical}`,
    );
  }
};

const breakDuplicates = async (): Promise<void> => {
  for (const entity of ENTITIES) {
    const table = TABLE[entity];
    // Everything except the winner of each duplicate group. Winner = the live
    // row (its code may be on a physical label); ties and all-deleted groups
    // fall back to the oldest row, so a re-run picks the same winner.
    const losers = await q<{ id: string }>(
      `SELECT id FROM (
         SELECT id, row_number() OVER (
           PARTITION BY shortcode
           ORDER BY ("deletedAt" IS NULL) DESC, "createdAt" ASC, id ASC
         ) AS rn
         FROM "${table}"
         WHERE shortcode IS NOT NULL
           AND shortcode IN (
             SELECT shortcode FROM "${table}"
             WHERE shortcode IS NOT NULL
             GROUP BY shortcode HAVING count(*) > 1
           )
       ) ranked WHERE rn > 1`,
    );
    if (losers.length === 0) continue;

    const taken = await takenCodes(entity);
    const codes = mintCodes(entity, losers.length, taken);
    await applyCodes(
      entity,
      losers.map((row, i) => ({ id: row.id, shortcode: codes[i] as string })),
    );
    console.log(`${table}: re-minted ${losers.length} duplicate code(s)`);
  }
};

const mintMissing = async (): Promise<void> => {
  for (const entity of ENTITIES) {
    const table = TABLE[entity];
    const missing = await q<{ id: string }>(
      `SELECT id FROM "${table}" WHERE shortcode IS NULL ORDER BY "createdAt", id`,
    );
    if (missing.length === 0) continue;

    const taken = await takenCodes(entity);
    const codes = mintCodes(entity, missing.length, taken);
    await applyCodes(
      entity,
      missing.map((row, i) => ({ id: row.id, shortcode: codes[i] as string })),
    );
    console.log(`${table}: minted ${missing.length} new code(s)`);
  }
};

/**
 * Rebuild the three PRE-EXISTING shortcode indexes without their partial
 * `WHERE "deletedAt" IS NULL` clause.
 *
 * Done here in SQL rather than by `db:push` because **push does not detect the
 * removal of an index's WHERE clause**. Verified against this database: with
 * schema.ts already declaring all twelve indexes non-partial, push happily
 * created the nine missing ones and left Product/Recipe/Location partial, with
 * no statement emitted and no warning. Silently keeping the partial index would
 * defeat the entire cutover — a partial unique index is precisely what let 269
 * codes get reissued after a soft delete.
 *
 * Safe to run before or after push, and safe to re-run: it only touches indexes
 * whose definition still contains a WHERE.
 */
const fixindexes = async (): Promise<void> => {
  const partial = await q<{ indexname: string; tablename: string }>(
    `SELECT indexname, tablename FROM pg_indexes
     WHERE schemaname = 'public'
       AND indexname LIKE '%_shortcode_unique'
       AND indexdef LIKE '%WHERE%'`,
  );
  if (partial.length === 0) {
    console.log("no partial shortcode indexes remain");
    return;
  }
  for (const { indexname, tablename } of partial) {
    // Duplicate-free data is a precondition — `backfill` guarantees it, and the
    // CREATE below would fail loudly rather than silently if it didn't.
    await q(`DROP INDEX "${indexname}"`);
    await q(
      `CREATE UNIQUE INDEX "${indexname}" ON "${tablename}" USING btree ("shortcode")`,
    );
    console.log(`${indexname}: rebuilt over the whole table`);
  }
};

const backfill = async (): Promise<void> => {
  for (const entity of NEW_COLUMN_ENTITIES) {
    if (!(await columnExists(TABLE[entity]))) {
      throw new Error(
        `${TABLE[entity]}.shortcode does not exist — run \`addcolumns\` first`,
      );
    }
  }
  await retireLegacyPrefixes();
  await breakDuplicates();
  await mintMissing();
};

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

const verify = async (): Promise<boolean> => {
  let ok = true;
  const fail = (msg: string) => {
    console.error(`FAIL  ${msg}`);
    ok = false;
  };

  for (const entity of ENTITIES) {
    const table = TABLE[entity];
    const [row] = await q<{
      nulls: string;
      dupes: string;
      malformed: string;
    }>(
      `SELECT count(*) FILTER (WHERE shortcode IS NULL) nulls,
              count(*) - count(DISTINCT shortcode) dupes,
              count(*) FILTER (WHERE shortcode IS NOT NULL AND shortcode !~ $1) malformed
       FROM "${table}"`,
      [canonicalPattern(entity)],
    );
    const nulls = Number(row?.nulls ?? 0);
    const dupes = Number(row?.dupes ?? 0);
    const malformed = Number(row?.malformed ?? 0);
    if (nulls > 0) fail(`${table}: ${nulls} row(s) with a null shortcode`);
    // `dupes` counts duplicates ACROSS soft-deleted rows too — that is the
    // invariant: a retired code is a tombstone, never reissued.
    if (dupes > 0) fail(`${table}: ${dupes} duplicate shortcode(s)`);
    if (malformed > 0)
      fail(
        `${table}: ${malformed} shortcode(s) not matching the canonical form`,
      );
    if (nulls === 0 && dupes === 0 && malformed === 0) {
      console.log(`ok    ${table}`);
    }
  }

  // Post-`db:push` only: the index must cover the whole table, or a code could
  // still be reissued after a soft delete — the exact hole this cutover closed.
  const partial = await q<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes
     WHERE schemaname = 'public'
       AND indexname LIKE '%_shortcode_unique'
       AND indexdef LIKE '%WHERE%'`,
  );
  for (const idx of partial) {
    fail(`${idx.indexname} is still a PARTIAL index — run \`pnpm db:push\``);
  }

  const [indexRow] = await q<{ n: string }>(
    `SELECT count(*) n FROM pg_indexes
     WHERE schemaname = 'public' AND indexname LIKE '%_shortcode_unique'`,
  );
  const indexCount = Number(indexRow?.n ?? 0);
  if (indexCount !== ENTITIES.length) {
    console.warn(
      `warn  ${indexCount}/${ENTITIES.length} shortcode unique indexes exist — run \`pnpm db:push\``,
    );
  }

  return ok;
};

// ---------------------------------------------------------------------------

const main = async (): Promise<void> => {
  const command = process.argv[2];
  switch (command) {
    case "audit":
      await audit();
      break;
    case "addcolumns":
      await addcolumns();
      break;
    case "backfill":
      await backfill();
      break;
    case "fixindexes":
      await fixindexes();
      break;
    case "verify":
      if (!(await verify())) process.exitCode = 1;
      break;
    default:
      console.error(
        "Usage: tsx scripts/shortcode-backfill.ts <audit|addcolumns|backfill|fixindexes|verify>",
      );
      process.exitCode = 1;
  }
};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
