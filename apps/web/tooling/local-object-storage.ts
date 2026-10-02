import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import type { LocalStorageEnv } from "./dev/storage";

/** Browser/native presigned URLs use the existing local adapter over an isolated R2 bucket. */
export async function createE2EObjectStorage() {
  const harness = createTestHarness({
    workers: [
      {
        config: {
          name: "e2e-object-storage",
          main: fileURLToPath(
            new URL("./local-object-storage.worker.ts", import.meta.url),
          ),
          compatibility_date: "2026-09-01",
          r2_buckets: [
            {
              binding: "LOCAL_DEV_STORAGE",
              bucket_name: `e2e-${randomUUID()}`,
            },
          ],
          vars: { R2_BUCKET_NAME: "e2e-bucket", R2_KEY_PREFIX: "e2e" },
        },
      },
    ],
  });
  try {
    const { url } = await harness.listen();
    const env = await harness.getWorker<LocalStorageEnv>().getEnv();
    return {
      url: url.origin,
      bucket: env.LOCAL_DEV_STORAGE,
      close: () => harness.close(),
    };
  } catch (error) {
    await harness.close();
    throw error;
  }
}
export type E2EObjectStorage = Awaited<
  ReturnType<typeof createE2EObjectStorage>
>;
