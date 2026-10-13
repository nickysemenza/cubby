import { request } from "@playwright/test";
import { z } from "zod";
import { createPostgresPool } from "../../tooling/postgres-pool";
import { seedCorpus } from "../../tooling/scenarios/corpus";
import type { E2EWorkerRuntime } from "./e2e-worker-runtime";

/** The exploration project keeps this rich world outside regression shards. */
export async function seedHouseholdRuntime(runtime: E2EWorkerRuntime) {
  const client = await request.newContext({
    baseURL: runtime.baseURL,
    storageState: runtime.storageState,
  });
  const pool = createPostgresPool({ connectionString: runtime.databaseUrl });
  try {
    const response = await client.get("/api/auth/get-session");
    if (!response.ok())
      throw new Error(
        `Household fixture authentication failed: ${response.status()} ${await response.text()}`,
      );
    const session = z
      .object({ user: z.object({ id: z.string().min(1) }) })
      .parse(await response.json());
    await seedCorpus(pool, session.user.id, {
      storageOrigin: runtime.objectStorageUrl,
      bucket: "e2e-bucket",
      keyPrefix: "e2e",
    });
  } finally {
    await client.dispose();
    await pool.end();
  }
}
