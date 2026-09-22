import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { faker } from "@faker-js/faker";
import { request } from "@playwright/test";
import dotenv from "dotenv";
import { Pool } from "pg";
import { z } from "zod";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(__dirname, "..");

// Match playwright.config.ts: this script statically imports server modules
// (`~/server/entity-kernel` via ./scenarios/corpus) whose `~/env` schema
// validates at import time, before `main()` ever sets DATABASE_URL below. A
// developer's local `.env` supplies real values; process.env (DATABASE_URL,
// set by scripts/dev-db.ts before spawning this script) always wins.
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

const { createE2EObjectStorage } =
  await import("../tests/e2e/e2e-object-storage");
const { createHarness, installDatabaseEnvironment } =
  await import("../tests/e2e/e2e-worker-runtime");
const { ensureHarnessServiceBundles } =
  await import("../tests/e2e/harness-services/bundle");
const { assertDevDatabaseUrl } = await import("./dev-db-guard");
const { seedCorpus } = await import("./scenarios/corpus");

/** Synthetic, local-only account — never used against the shared deployment. */
export const DEV_USER_EMAIL = "dev@cubby.localhost";
export const DEV_USER_PASSWORD = "cubby-dev-local-only";
export const DEV_USER_NAME = "Cubby Dev";

/** Same transform e2e-global-setup.ts applies, duplicated here so this script
 * doesn't depend on Playwright global setup having run first. */
function writeE2ECompatibleWranglerConfig(): void {
  const wranglerJsonPath = path.join(webRoot, "dist/server/wrangler.json");
  if (!existsSync(wranglerJsonPath)) {
    throw new Error(
      "dist/server/wrangler.json is missing. Run `pnpm --dir apps/web run build:cf` once before `pnpm db:dev:seed`.",
    );
  }
  const config = z
    .object({
      compatibility_date: z.string(),
      ai: z.json().optional(),
      vectorize: z.json().optional(),
      queues: z
        .object({ consumers: z.array(z.json()).optional() })
        .loose()
        .optional(),
    })
    .loose()
    .parse(JSON.parse(readFileSync(wranglerJsonPath, "utf8")));
  delete config.ai;
  delete config.vectorize;
  if (config.queues) config.queues.consumers = [];
  writeFileSync(
    path.join(webRoot, "dist/server/wrangler.e2e.json"),
    JSON.stringify(config),
  );
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

  // A short-lived harness only to run the real sign-up flow (so the local dev
  // user's password hash and session model exactly match production). It is
  // pointed at the persistent dev database, not a throwaway IntegreSQL one.
  writeE2ECompatibleWranglerConfig();
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
