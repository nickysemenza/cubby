import type { Pool } from "pg";
import { z } from "zod";

import { createPostgresPool } from "../postgres-pool";
import {
  assertDevDatabaseUrl,
  DEV_USER_EMAIL,
  DEV_USER_NAME,
  DEV_USER_PASSWORD,
  LOCAL_FIXTURE_VERSION,
} from "./state";

const authUserSchema = z.object({
  user: z.object({ id: z.string().min(1) }),
});

/** POST a JSON body to one of the local runtime's auth routes. */
export type AuthPost = (
  path: string,
  body: Readonly<Record<string, string>>,
) => Promise<Response>;

/** Sign up the local dev user through the real better-auth flow, matching
 * production password hashing exactly (see tests/e2e/support/e2e-worker-runtime.ts's
 * `authenticate`). Returns its real, database-backed user id. */
export async function ensureDevUser(post: AuthPost): Promise<string> {
  const signUp = await post("/api/auth/sign-up/email", {
    email: DEV_USER_EMAIL,
    password: DEV_USER_PASSWORD,
    name: DEV_USER_NAME,
  });
  if (signUp.ok) {
    console.log(`[dev-db] Created dev user ${DEV_USER_EMAIL}`);
    return authUserSchema.parse(await signUp.json()).user.id;
  }
  // Already exists from a previous seed run — sign in to get its id instead.
  const signIn = await post("/api/auth/sign-in/email", {
    email: DEV_USER_EMAIL,
    password: DEV_USER_PASSWORD,
  });
  if (!signIn.ok)
    throw new Error(
      `Failed to sign up or sign in the dev user: ${signIn.status} - ${await signIn.text()}`,
    );
  console.log(`[dev-db] Reusing existing dev user ${DEV_USER_EMAIL}`);
  return authUserSchema.parse(await signIn.json()).user.id;
}

/** Seed one pack into the guarded dev database under its version marker.
 * An interrupted pack refuses a retry rather than duplicating its partial graph. */
export async function seedFixturePack(
  databaseUrl: string,
  pack: string,
  seed: (pool: Pool) => Promise<void>,
): Promise<void> {
  assertDevDatabaseUrl(databaseUrl);
  const pool = createPostgresPool({ connectionString: databaseUrl });
  let startedPack = false;
  try {
    // This development-only table deliberately has no production migration.
    await pool.query(`CREATE TABLE IF NOT EXISTS cubby_dev_fixture (
      pack text PRIMARY KEY, version integer NOT NULL, state text NOT NULL
    )`);
    const existing = await pool.query<{ version: number; state: string }>(
      "SELECT version, state FROM cubby_dev_fixture WHERE pack = $1",
      [pack],
    );
    const marker = existing.rows[0];
    if (
      marker?.state === "complete" &&
      marker.version === LOCAL_FIXTURE_VERSION
    ) {
      console.log(`[dev-db] Fixture pack ${pack} already complete`);
      return;
    }
    if (marker)
      throw new Error(
        `Local fixture pack ${pack} is partial or outdated; run pnpm dev reset`,
      );
    if (pack === "core") {
      const legacy = await pool.query(`SELECT EXISTS (
        SELECT 1 FROM "Product" UNION ALL SELECT 1 FROM "Task" UNION ALL SELECT 1 FROM "Vendor"
      ) AS present`);
      if (legacy.rows[0]?.present)
        throw new Error(
          "Unversioned or partial local corpus found; run pnpm dev reset",
        );
    } else {
      const core = await pool.query(
        "SELECT 1 FROM cubby_dev_fixture WHERE pack = 'core' AND version = $1 AND state = 'complete'",
        [LOCAL_FIXTURE_VERSION],
      );
      if (!core.rowCount)
        throw new Error("Seed the complete core fixture pack first");
    }
    await pool.query(
      "INSERT INTO cubby_dev_fixture (pack, version, state) VALUES ($1, $2, 'seeding')",
      [pack, LOCAL_FIXTURE_VERSION],
    );
    startedPack = true;
    await seed(pool);
    await pool.query(
      "UPDATE cubby_dev_fixture SET state = 'complete' WHERE pack = $1 AND version = $2",
      [pack, LOCAL_FIXTURE_VERSION],
    );
    console.log(`[dev-db] Fixture pack ${pack} complete`);
  } catch (error) {
    if (startedPack) {
      await pool
        .query(
          "UPDATE cubby_dev_fixture SET state = 'failed' WHERE pack = $1 AND state = 'seeding'",
          [pack],
        )
        .catch(() => {});
    }
    throw error;
  } finally {
    await pool.end();
  }
}
