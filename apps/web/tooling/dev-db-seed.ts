import path from "node:path";
import { fileURLToPath } from "node:url";
import { faker } from "@faker-js/faker";
import { request } from "@playwright/test";
import dotenv from "dotenv";
import { Pool } from "pg";
import { z } from "zod";

import { assertDevDatabaseUrl } from "./dev-db-guard";
import {
  DEV_USER_EMAIL,
  DEV_USER_NAME,
  DEV_USER_PASSWORD,
} from "./dev-db-identity";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(__dirname, "..");

// The entity kernel and Worker harness validate server env at import time.
// Load defaults before importing either; process.env from scripts/dev-db.ts wins.
dotenv.config({ path: path.resolve(webRoot, ".env") });
for (const [key, value] of Object.entries({
  R2_ACCESS_KEY_ID: "cubby-dev",
  R2_SECRET_ACCESS_KEY: "cubby-dev",
  R2_ENDPOINT: "http://localhost:9000",
  R2_BUCKET_NAME: "cubby-dev",
  R2_PUBLIC_URL: "http://localhost:9000",
  UPC_LOOKUP_API_URL: "http://127.0.0.1:9/",
  BETTER_AUTH_SECRET: "cubby-dev-local-secret",
})) {
  process.env[key] ??= value;
}

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

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  assertDevDatabaseUrl(databaseUrl);
  if (!databaseUrl) throw new Error("unreachable"); // narrowed by the guard above

  if (process.argv.includes("--if-empty")) {
    const probe = new Pool({ connectionString: databaseUrl });
    try {
      const result = await probe.query<{
        product_count: string;
        marker_exists: boolean;
        dev_user_exists: boolean;
      }>(
        `SELECT (SELECT count(*)::text FROM "Product") AS product_count,
                EXISTS (SELECT 1 FROM "Task" WHERE name = 'Restock cleaning supplies') AS marker_exists,
                EXISTS (SELECT 1 FROM "user" WHERE email = $1) AS dev_user_exists`,
        [DEV_USER_EMAIL],
      );
      const state = result.rows[0];
      if (
        Number(state?.product_count) > 0 &&
        state?.marker_exists &&
        state.dev_user_exists
      ) {
        console.log("[dev-db] Existing synthetic corpus found; seed skipped");
        return;
      }
      if (
        Number(state?.product_count) > 0 ||
        state?.marker_exists ||
        state?.dev_user_exists
      ) {
        throw new Error(
          "Local database contains part of the synthetic corpus; run `pnpm db:dev:reset` for a clean seed",
        );
      }
    } finally {
      await probe.end();
    }
  }

  const { createE2EObjectStorage } =
    await import("../tests/e2e/e2e-object-storage");
  const { createHarness, installDatabaseEnvironment } =
    await import("../tests/e2e/e2e-worker-runtime");
  const { ensureHarnessServiceBundles } =
    await import("../tests/e2e/harness-services/bundle");
  const { seedCorpus } = await import("./scenarios/corpus");
  const { writeE2ECompatibleWranglerConfig } =
    await import("./e2e-worker-config");
  // A short-lived harness only to run the real sign-up flow (so the local dev
  // user's password hash and session model exactly match production). It is
  // pointed at the persistent dev database, not a throwaway IntegreSQL one.
  writeE2ECompatibleWranglerConfig(webRoot);
  const restoreEnvironment = installDatabaseEnvironment(databaseUrl);
  const objectStorage = await createE2EObjectStorage();
  const harnessServiceBundles = await ensureHarnessServiceBundles();
  const harness = createHarness(
    databaseUrl,
    objectStorage.url,
    harnessServiceBundles,
  );
  let userId: string;
  try {
    const { url } = await harness.listen();
    userId = await ensureDevUser(url.origin);
  } finally {
    await harness.close();
    await objectStorage.close();
    restoreEnvironment();
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    faker.seed(1);
    await seedCorpus(pool, userId);
    console.log("[dev-db] Corpus seeded");
  } finally {
    await pool.end();
  }
}

await main();
