import { request } from "@playwright/test";
import { Pool } from "pg";
import { z } from "zod";

import { assertDevDatabaseUrl } from "./state";
import {
  LOCAL_FIXTURE_VERSION,
  DEV_USER_EMAIL,
  DEV_USER_NAME,
  DEV_USER_PASSWORD,
} from "./state";

const signUpResponseSchema = z.object({
  user: z.object({ id: z.string().min(1) }),
});

/** Sign up the local dev user through the real better-auth flow, matching
 * production password hashing exactly (see tests/e2e/e2e-worker-runtime.ts's
 * `authenticate`). Returns its real, database-backed user id. */
async function ensureDevUser(baseURL: string): Promise<string> {
  const context = await request.newContext({
    baseURL,
    extraHTTPHeaders: { Origin: baseURL },
  });
  try {
    const signUp = await context.post("/api/auth/sign-up/email", {
      data: {
        email: DEV_USER_EMAIL,
        password: DEV_USER_PASSWORD,
        name: DEV_USER_NAME,
      },
    });
    if (signUp.ok()) {
      const body = signUpResponseSchema.parse(await signUp.json());
      console.log(`[dev-db] Created dev user ${DEV_USER_EMAIL}`);
      return body.user.id;
    }
    // Already exists from a previous seed run — sign in to get its id instead.
    const signIn = await context.post("/api/auth/sign-in/email", {
      data: { email: DEV_USER_EMAIL, password: DEV_USER_PASSWORD },
    });
    if (!signIn.ok()) {
      throw new Error(
        `Failed to sign up or sign in the dev user: ${signIn.status()} - ${await signIn.text()}`,
      );
    }
    const body = signUpResponseSchema.parse(await signIn.json());
    console.log(`[dev-db] Reusing existing dev user ${DEV_USER_EMAIL}`);
    return body.user.id;
  } finally {
    await context.dispose();
  }
}

export const LOCAL_FIXTURE_PACKS = [
  "core",
  "recipes",
  "images",
  "purchase",
  "garden",
  "calendar",
  "problems",
] as const;
export const devFixturePackSchema = z.enum(LOCAL_FIXTURE_PACKS);
export type LocalFixturePack = (typeof LOCAL_FIXTURE_PACKS)[number];

/** Completion is committed only after all domain writes and real auth succeed.
 * An interrupted pack refuses a retry rather than duplicating its partial graph. */
export async function seedDevDatabase(options: {
  databaseUrl: string;
  baseURL: string;
  pack?: LocalFixturePack;
}): Promise<void> {
  assertDevDatabaseUrl(options.databaseUrl);
  const base = new URL(options.baseURL);
  if (!["localhost", "127.0.0.1"].includes(base.hostname)) {
    throw new Error(
      "Local fixtures require an already-running localhost auth runtime",
    );
  }
  const pack = options.pack ?? "core";
  const pool = new Pool({ connectionString: options.databaseUrl });
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
        `Local fixture pack ${pack} is partial or outdated; run pnpm dev:reset`,
      );
    if (pack === "core") {
      const legacy = await pool.query(`SELECT EXISTS (
        SELECT 1 FROM "Product" UNION ALL SELECT 1 FROM "Task" UNION ALL SELECT 1 FROM "Vendor"
      ) AS present`);
      if (legacy.rows[0]?.present)
        throw new Error(
          "Unversioned or partial local corpus found; run pnpm dev:reset",
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
    const userId = await ensureDevUser(options.baseURL);
    if (pack === "core") {
      const { seedCorpus } = await import("../scenarios/corpus");
      await seedCorpus(pool, userId);
      await seedUpcLookupFixture(pool);
    } else {
      const { seedLocalFixturePack } = await import("./scenarios");
      await seedLocalFixturePack(pool, userId, pack, options.baseURL);
    }
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

/** One synthetic barcode answer so the lookup path is exercised without upstream calls. */
async function seedUpcLookupFixture(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO "UpcLookupCache" (upc, name, manufacturer, brand, category, description, "priceDollars", source, status, "fetchedAt")
     VALUES ('012345678905', 'Synthetic cotton shirt', 'Synthetic Works', 'Synthetic', 'Clothing', 'Local synthetic barcode fixture', 18, 'manual', 'ready', now())
     ON CONFLICT (upc) DO NOTHING`,
  );
}
