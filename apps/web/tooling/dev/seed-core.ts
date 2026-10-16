import { Buffer } from "node:buffer";
import { seedUpcLookupFixture } from "./upc-fixture";

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
