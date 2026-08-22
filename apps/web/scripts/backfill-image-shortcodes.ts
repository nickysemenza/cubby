/**
 * One-shot backfill: give every Image row an `IMG-XXXX` shortcode.
 *
 * `image` was the last local-table entity addressed by raw uuid, which made it
 * a permanent carve-out in every shape that can name an entity. The column
 * lands nullable so it can be deployed before the codes exist; this fills it,
 * and a follow-up makes it NOT NULL.
 *
 * Batched rather than row-at-a-time: `generateUniqueShortcode` does a SELECT
 * per candidate before inserting, which is right for one insert and wrong for
 * ~5.7k rows. The in-memory `taken` set does the deduping and the unique index
 * is the final arbiter — a row whose code loses a race stays NULL and is picked
 * up next round.
 *
 * Idempotent: only touches `shortcode IS NULL`, so it is safe to re-run.
 */
import "dotenv/config";
import { randomInt } from "node:crypto";
import { SHORTCODE_CHARS, SHORTCODE_PREFIX } from "@cubby/shared";
import { Pool } from "pg";

const BATCH = 500;
const MAX_ROUNDS = 60;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required to backfill image shortcodes.");
  process.exit(1);
}

const pool = new Pool({ connectionString: databaseUrl });

const body = () =>
  Array.from(
    { length: 4 },
    () => SHORTCODE_CHARS[randomInt(SHORTCODE_CHARS.length)],
  ).join("");

try {
  // Seeded from what is already minted so a re-run cannot collide with a
  // previous run's output.
  const existing = await pool.query<{ shortcode: string }>(
    `SELECT shortcode FROM "Image" WHERE shortcode IS NOT NULL`,
  );
  const taken = new Set(existing.rows.map((row) => row.shortcode));
  console.log(`already minted: ${taken.size}`);

  let totalUpdated = 0;
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM "Image" WHERE shortcode IS NULL LIMIT $1`,
      [BATCH],
    );
    if (rows.length === 0) break;

    const pairs: Array<[string, string]> = [];
    for (const { id } of rows) {
      let code = `${SHORTCODE_PREFIX.image}${body()}`;
      while (taken.has(code)) code = `${SHORTCODE_PREFIX.image}${body()}`;
      taken.add(code);
      pairs.push([id, code]);
    }

    const values = pairs
      .map((_, i) => `($${i * 2 + 1}::uuid, $${i * 2 + 2}::text)`)
      .join(",");
    const result = await pool.query(
      `UPDATE "Image" AS img SET shortcode = v.code
         FROM (VALUES ${values}) AS v(id, code)
        WHERE img.id = v.id AND img.shortcode IS NULL`,
      pairs.flat(),
    );
    totalUpdated += result.rowCount ?? 0;
    console.log(`round ${round}: +${result.rowCount} (total ${totalUpdated})`);
  }

  const { rows: check } = await pool.query<{ remaining: number }>(
    `SELECT count(*)::int AS remaining FROM "Image" WHERE shortcode IS NULL`,
  );
  console.log(
    `done. updated=${totalUpdated} remaining_null=${check[0]?.remaining}`,
  );
} finally {
  await pool.end();
}
