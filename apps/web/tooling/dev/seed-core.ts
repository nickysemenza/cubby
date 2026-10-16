import { Buffer } from "node:buffer";
import type { Pool } from "pg";

import boots from "../../tests/e2e/fixtures/synthetic-wardrobe-boots.png?inline";
import label from "../../tests/e2e/fixtures/synthetic-wardrobe-label.png?inline";
import shirt from "../../tests/e2e/fixtures/synthetic-wardrobe-shirt.png?inline";
import { seedCorpus, type FixtureImageReader } from "../scenarios/corpus";
import { ensureDevUser, seedFixturePack, type AuthPost } from "./fixture-pack";

const images = { boots, label, shirt };

// workerd has no checkout files; Vite inlines the PNGs as data URLs.
const readBundledImage: FixtureImageReader = async (name) => {
  const dataUrl = images[name];
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
};

/** One synthetic barcode answer so the lookup path is exercised without upstream calls. */
async function seedUpcLookupFixture(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO "UpcLookupCache" (upc, name, manufacturer, brand, category, description, "priceDollars", source, status, "fetchedAt")
     VALUES ('012345678905', 'Synthetic cotton shirt', 'Synthetic Works', 'Synthetic', 'Clothing', 'Local synthetic barcode fixture', 18, 'manual', 'ready', now())
     ON CONFLICT (upc) DO NOTHING`,
  );
}

/**
 * Seed the core corpus inside the dev Worker. Here the background queue is
 * bound, so each write publishes to the local queue instead of running its
 * tasks inline (Node seeding spent ~100 ms per record awaiting them), and the
 * server modules are the ones Vite already compiled.
 */
export async function seedCoreFixtures(options: {
  databaseUrl: string;
  origin: string;
  bucket: string;
  keyPrefix: string;
  post: AuthPost;
}): Promise<void> {
  await seedFixturePack(options.databaseUrl, "core", async (pool) => {
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
