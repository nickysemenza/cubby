import "dotenv/config";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "pg";

/**
 * List — and, only when asked twice, delete — stored files that no edge still
 * reaches: `Image` rows with `status = 'UPLOADED'` and `deletedAt IS NULL` that
 * nothing points at. R2 bills for every one and no page can render them.
 *
 * These are the residue of removal paths that used to drop an association
 * without taking the file with it — a detach (`detachImagesFromEntity`) and an
 * entity delete (`removeEntity`) both reap now, so this is a backfill for what
 * accumulated before, not an ongoing sweep. Settings → Maintenance → "Delete
 * unreferenced files" does the same thing from the app; this script exists so
 * the list can be reviewed offline before anything is destroyed.
 *
 * Usage:
 *   # 1. Review. This is the default — no flag deletes anything.
 *   pnpm --filter @cubby/web db:cleanup-unreferenced-images
 *
 *   # 2. Delete, naming the count you reviewed. A mismatch aborts.
 *   pnpm --filter @cubby/web db:cleanup-unreferenced-images -- --delete --confirm-count=132
 *
 *   # Optional: skip the R2 half (rows only), then sweep the printed keys by hand.
 *   ... -- --delete --confirm-count=132 --skip-r2
 *
 * There is no restore. Deleting is permanent, for the row and the object both.
 */

const GRACE_INTERVAL = "1 hour";

/**
 * The SQL twin of `findUnreferencedImages` (apps/web/src/server/repo/image.ts).
 * Keep the two in step — the app-side version is the one the Problems detector
 * and the maintenance sweep read.
 *
 * The five join-table probes filter `deletedAt IS NULL`: a tombstoned join row
 * is not a reference, because its owning entity is already gone. The Cookbook
 * probe deliberately does NOT, because `deleteCookbook` tombstones the row
 * without nulling `coverImageId` — a soft-deleted cookbook still holds a live
 * cover FK, and leaking a cover's bytes beats destroying a cover.
 */
const UNREFERENCED_SQL = `
  SELECT i.id, i.key, i.filename, i."contentType", i.size, i."createdAt",
         i."targetType", i."targetId"
  FROM "Image" i
  WHERE i.status = 'UPLOADED'
    AND i."deletedAt" IS NULL
    AND i."createdAt" < now() - interval '${GRACE_INTERVAL}'
    AND NOT EXISTS (SELECT 1 FROM "ProductImage" x
                    WHERE x."imageId" = i.id AND x."deletedAt" IS NULL)
    AND NOT EXISTS (SELECT 1 FROM "LocationImage" x
                    WHERE x."imageId" = i.id AND x."deletedAt" IS NULL)
    AND NOT EXISTS (SELECT 1 FROM "RecipeImage" x
                    WHERE x."imageId" = i.id AND x."deletedAt" IS NULL)
    AND NOT EXISTS (SELECT 1 FROM "ProjectImage" x
                    WHERE x."imageId" = i.id AND x."deletedAt" IS NULL)
    AND NOT EXISTS (SELECT 1 FROM "PurchaseImage" x
                    WHERE x."imageId" = i.id AND x."deletedAt" IS NULL)
    -- includes-deleted: deleteCookbook tombstones the cookbook without nulling
    -- coverImageId, so a soft-deleted cookbook still protects its cover.
    AND NOT EXISTS (SELECT 1 FROM "Cookbook" c WHERE c."coverImageId" = i.id)
  ORDER BY i."createdAt"
`;

type Row = {
  id: string;
  key: string;
  filename: string;
  contentType: string;
  size: number;
  createdAt: Date;
  targetType: string | null;
  targetId: string | null;
};

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

const argv = process.argv.slice(2);
const shouldDelete = argv.includes("--delete");
const skipR2 = argv.includes("--skip-r2");
const confirmArg = argv.find((a) => a.startsWith("--confirm-count="));
const confirmCount = confirmArg
  ? Number.parseInt(confirmArg.slice("--confirm-count=".length), 10)
  : null;

if (
  shouldDelete &&
  (confirmCount === null || !Number.isInteger(confirmCount))
) {
  console.error(
    "--delete requires --confirm-count=<N>, the count you reviewed in the listing.",
  );
  process.exit(1);
}

const bytes = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

const report = (rows: Row[]) => {
  const byTarget = new Map<string, { count: number; size: number }>();
  for (const row of rows) {
    const key = row.targetType ?? "(no attach provenance — UI or import)";
    const acc = byTarget.get(key) ?? { count: 0, size: 0 };
    byTarget.set(key, { count: acc.count + 1, size: acc.size + row.size });
  }

  for (const row of rows) {
    const from = row.targetType
      ? `${row.targetType} ${row.targetId?.slice(0, 8) ?? "?"}`
      : "—";
    console.log(
      `  ${row.createdAt.toISOString().slice(0, 10)}  ${String(Math.round(row.size / 1024)).padStart(6)} KB  ${from.padEnd(20)}  ${row.filename}`,
    );
  }
  console.log("");
  console.log("  By origin:");
  for (const [target, { count, size }] of byTarget) {
    console.log(`    ${target.padEnd(40)} ${count} files, ${bytes(size)}`);
  }
  console.log("");
  console.log(
    `  TOTAL: ${rows.length} files, ${bytes(rows.reduce((sum, r) => sum + r.size, 0))}`,
  );
};

const execFileAsync = promisify(execFile);

/** Best-effort per key: a failed object delete only strands bytes. */
const deleteR2Objects = async (keys: string[]): Promise<string[]> => {
  const bucket = process.env.R2_BUCKET_NAME;
  if (!bucket) {
    console.warn("R2_BUCKET_NAME is unset — skipping the R2 half.");
    return keys;
  }
  const failed: string[] = [];
  for (const key of keys) {
    try {
      await execFileAsync("pnpm", [
        "exec",
        "wrangler",
        "r2",
        "object",
        "delete",
        `${bucket}/${key}`,
        "--remote",
      ]);
    } catch (error) {
      console.error(`  ! ${key}: ${(error as Error).message}`);
      failed.push(key);
    }
  }
  return failed;
};

const client = new Client({ connectionString: databaseUrl });

try {
  await client.connect();

  if (!shouldDelete) {
    await client.query("BEGIN READ ONLY");
    const { rows } = await client.query<Row>(UNREFERENCED_SQL);
    if (rows.length === 0) {
      console.log("No unreferenced files. Nothing to do.");
    } else {
      console.log(`Unreferenced files (older than ${GRACE_INTERVAL}):\n`);
      report(rows);
      console.log("");
      console.log(
        `Review the list above, then delete with:\n  pnpm --filter @cubby/web db:cleanup-unreferenced-images -- --delete --confirm-count=${rows.length}`,
      );
    }
    await client.query("ROLLBACK");
    process.exit(0);
  }

  // Re-run the SAME select inside the write transaction. The count check is
  // what makes "review, then delete" safe: if a file was attached (or another
  // sweep ran) between the two commands, the number moves and we stop rather
  // than deleting a set nobody looked at.
  await client.query("BEGIN");
  const { rows } = await client.query<Row>(UNREFERENCED_SQL);
  if (rows.length !== confirmCount) {
    await client.query("ROLLBACK");
    console.error(
      `Aborted: --confirm-count=${confirmCount} but ${rows.length} unreferenced files exist now.`,
    );
    console.error("The set changed since you reviewed it. Current listing:\n");
    report(rows);
    process.exit(1);
  }

  const ids = rows.map((r) => r.id);
  // Tombstoned join rows still FK the image, so they have to go first —
  // mirroring IMAGE_HARD_DELETE's cascade in repo/image.ts.
  for (const table of [
    "ProductImage",
    "LocationImage",
    "RecipeImage",
    "ProjectImage",
    "PurchaseImage",
  ]) {
    await client.query(`DELETE FROM "${table}" WHERE "imageId" = ANY($1)`, [
      ids,
    ]);
  }
  // A no-op by construction (the select excluded cookbook covers); kept for
  // symmetry with the cascade so a future probe change can't strand an FK.
  await client.query(
    `UPDATE "Cookbook" SET "coverImageId" = NULL WHERE "coverImageId" = ANY($1)`,
    [ids],
  );
  await client.query(`DELETE FROM "Image" WHERE id = ANY($1)`, [ids]);
  await client.query("COMMIT");
  console.log(`Deleted ${ids.length} Image rows.`);

  if (skipR2) {
    console.log("\n--skip-r2: these objects are still in the bucket:");
    for (const row of rows) console.log(`  ${row.key}`);
  } else {
    console.log("\nDeleting R2 objects…");
    const failed = await deleteR2Objects(rows.map((r) => r.key));
    if (failed.length > 0) {
      console.log(
        `\n${failed.length} object(s) failed — sweep these by hand (the rows are already gone):`,
      );
      for (const key of failed) console.log(`  ${key}`);
    } else {
      console.log(`Deleted ${rows.length} R2 objects.`);
    }
  }
} finally {
  await client.end();
}
