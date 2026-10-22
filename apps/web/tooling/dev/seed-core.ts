import { backgroundTaskMessageSchema } from "@cubby/schemas/queue-messages";
import { getBackgroundQueue } from "../../src/server/cf-env";
import { createPostgresPool } from "../postgres-pool";
import { buildScenarioDatabase } from "../scenarios/context";
import { createSystemUserFixture } from "../../src/server/testing/repo.fixtures";
import { Buffer } from "node:buffer";
import { seedUpcLookupFixture } from "./upc-fixture";
import { assertDevDatabaseUrl } from "./state";

import boots from "../../tests/e2e/fixtures/synthetic-wardrobe-boots.png?inline";
import label from "../../tests/e2e/fixtures/synthetic-wardrobe-label.png?inline";
import shirt from "../../tests/e2e/fixtures/synthetic-wardrobe-shirt.png?inline";
import type { FixtureImageReader } from "../scenarios/corpus";
import { ensureDevUser, seedFixturePack, type AuthPost } from "./fixture-pack";

const images = { boots, label, shirt };

// workerd has no checkout files; Vite inlines the PNGs as data URLs.
const readBundledImage: FixtureImageReader = async (name) => {
  const dataUrl = images[name];
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
};

/** Seed absent core fixtures; cloned rows only need their checkout's R2 bytes. */
export async function seedCoreFixtures(options: {
  databaseUrl: string;
  origin: string;
  bucket: string;
  keyPrefix: string;
  post: AuthPost;
}): Promise<void> {
  assertDevDatabaseUrl(options.databaseUrl);
  // The pre-Worker template accepts publications into a local outbox. Delete
  // only after queue acceptance; a crash may redeliver, and handlers are idempotent.
  const pool = createPostgresPool({ connectionString: options.databaseUrl });
  try {
    await createSystemUserFixture(buildScenarioDatabase(pool));
    if (
      (
        await pool.query(
          "SELECT to_regclass('cubby_dev_background_task') AS name",
        )
      ).rows[0]?.name
    ) {
      const queue = getBackgroundQueue();
      if (!queue)
        throw new Error("Core fixture handoff requires BACKGROUND_QUEUE");
      for (;;) {
        const rows = await pool.query<{ id: string; body: unknown }>(
          "SELECT id, body FROM cubby_dev_background_task ORDER BY id LIMIT 100",
        );
        if (rows.rows.length === 0) break;
        await queue.sendBatch(
          rows.rows.map((row) => ({
            body: backgroundTaskMessageSchema.parse(row.body),
          })),
        );
        await pool.query(
          "DELETE FROM cubby_dev_background_task WHERE id = ANY($1::bigint[])",
          [rows.rows.map((row) => row.id)],
        );
      }
    }
  } finally {
    await pool.end();
  }
  // A database clone contains Image rows, while R2 belongs to this checkout.
  for (const name of ["shirt", "boots", "label"] as const) {
    const url = `${options.origin}/__local-storage/s3/${options.bucket}/${options.keyPrefix}/household/${name}.png`;
    const present = await fetch(url, { method: "HEAD" });
    if (present.status === 404) {
      const restored = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "image/png" },
        body: new Uint8Array(await readBundledImage(name)),
      });
      if (!restored.ok)
        throw new Error(
          `Restoring fixture image failed: ${restored.status} ${await restored.text()}`,
        );
    } else if (!present.ok)
      throw new Error(
        `Reading fixture image failed: ${present.status} ${await present.text()}`,
      );
  }
  await seedFixturePack(options.databaseUrl, "core", async (pool) => {
    const { seedCorpus } = await import("../scenarios/corpus");
    const userId = await ensureDevUser(options.post);
    await seedCorpus(
      pool,
      userId,
      {
        storageOrigin: `${options.origin}/__local-storage/s3`,
        bucket: options.bucket,
        keyPrefix: options.keyPrefix,
      },
      readBundledImage,
    );
    await seedUpcLookupFixture(pool);
  });
}
