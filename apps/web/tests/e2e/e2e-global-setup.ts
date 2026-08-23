import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  IntegreSQLClient,
  type IntegreSQLDatabaseConfig,
} from "@devoxa/integresql-client";
import { chromium, type FullConfig } from "@playwright/test";
import { pushSchema } from "drizzle-kit/api";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createTestHarness } from "wrangler";
import * as schema from "../../src/server/db/schema";
import { ensureDbExtensions } from "../../tooling/db-extensions";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const authFile = path.join(__dirname, "../../playwright/.auth/user.json");
const webkitAuthFile = path.join(
  __dirname,
  "../../playwright/.auth/user-webkit.json",
);

const integreSQL = new IntegreSQLClient({
  url: process.env.INTEGRESQL_URL ?? "http://localhost:5000",
});
const integreSQLDatabaseHost =
  process.env.INTEGRESQL_DATABASE_HOST ?? "localhost";

const remapDBConfig = (
  databaseConfig: IntegreSQLDatabaseConfig,
): IntegreSQLDatabaseConfig => {
  databaseConfig.host = integreSQLDatabaseHost;
  databaseConfig.port = 5432;
  return databaseConfig;
};

async function globalSetup(_config: FullConfig): Promise<void> {
  console.log("[E2E Setup] Getting fresh database from IntegresQL...");

  // 1. Get fresh database from IntegresQL
  // Schema.ts is the single source of truth — the template is pushed from it.
  const hash = await integreSQL.hashFiles(["./src/server/db/schema.ts"]);

  // Initialize template if needed
  await integreSQL.initializeTemplate(hash, async (databaseConfig) => {
    const connectionUrl = integreSQL.databaseConfigToConnectionUrl(
      remapDBConfig(databaseConfig),
    );

    console.log("[E2E Setup] Pushing schema to template database...");
    const pool = new Pool({ connectionString: connectionUrl });
    const db = drizzle(pool);
    // pushSchema doesn't manage extensions; create them before pushing
    // (mirrors db:push and integration setup).
    await ensureDbExtensions(db);
    // See test-setup.ts: bridge the duplicated drizzle-orm PgDatabase types.
    const { apply } = await pushSchema(
      schema,
      db as unknown as Parameters<typeof pushSchema>[1],
      ["public"],
    );
    await apply();
    console.log("[E2E Setup] Template database schema pushed");
    await pool.end();
  });

  // Get test database
  const databaseConfig = await integreSQL.getTestDatabase(hash);
  const databaseUrl = integreSQL.databaseConfigToConnectionUrl(
    remapDBConfig(databaseConfig),
  );

  console.log(`[E2E Setup] Using database: ${databaseConfig.database}`);

  // The application requires one real hierarchy root. IntegreSQL templates are
  // cached by schema hash, so seed the checked-out test database rather than
  // the template: this also repairs databases cloned from an older empty
  // template after the invariant was introduced.
  const seedPool = new Pool({ connectionString: databaseUrl });
  try {
    await drizzle(seedPool).insert(schema.location).values({
      shortcode: "LOC-HM3E",
      name: "Home",
      aliases: [],
      type: "house",
      parentId: null,
    });
  } finally {
    await seedPool.end();
  }

  // 2. Start the Cloudflare test harness against the production build.
  const webRoot = path.join(__dirname, "../..");

  // Strip the `ai` binding for E2E. A Workers AI binding forces `wrangler dev`
  // to establish a remote Cloudflare session at boot (AI has no local runtime),
  // which needs CF credentials the E2E job doesn't have — without them the
  // server never becomes ready. E2E is hermetic and never invokes AI, so we run
  // against a copy of the build config with the binding removed. This also keeps
  // AI features reported unavailable, matching pre-binding E2E behavior.
  const e2eConfig = JSON.parse(
    readFileSync(path.join(webRoot, "dist/server/wrangler.json"), "utf8"),
  ) as Record<string, unknown>;
  delete e2eConfig.ai;
  // The auxiliary Workers are not part of the E2E artifact. Remove their
  // production service bindings so the clients use the hermetic URL fallbacks
  // below, matching the existing local E2E behavior.
  delete e2eConfig.services;
  writeFileSync(
    path.join(webRoot, "dist/server/wrangler.e2e.json"),
    JSON.stringify(e2eConfig),
  );

  process.env.WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE =
    databaseUrl;
  const harness = createTestHarness({
    root: webRoot,
    workers: [
      {
        configPath: "dist/server/wrangler.e2e.json",
        vars: {
          // Signup is disabled by default; global setup creates the test user.
          ALLOW_SIGNUP: "true",
          // Linux WebKit rejects __Secure- cookies over plain localhost.
          INSECURE_AUTH_COOKIES: "true",
          DATABASE_URL: databaseUrl,
          R2_ACCESS_KEY_ID: "dummy",
          R2_SECRET_ACCESS_KEY: "dummy",
          // USDA enrichment must fail locally and immediately in E2E.
          USDA_API_URL: "http://127.0.0.1:9/",
        },
        secrets: {
          BETTER_AUTH_SECRET:
            process.env.BETTER_AUTH_SECRET || "e2e-test-secret",
        },
      },
    ],
  });

  let baseURL: string;
  try {
    console.log("[E2E Setup] Starting Cloudflare test harness...");
    const { url } = await harness.listen();
    baseURL = url.origin;
  } catch (error) {
    harness.debug();
    await harness.close();
    throw error;
  }

  // Store the live harness for the reporter and global teardown.
  (globalThis as Record<string, unknown>).__E2E_HARNESS__ = harness;
  (globalThis as Record<string, unknown>).__E2E_DB_URL__ = databaseUrl;
  process.env.E2E_DATABASE_URL = databaseUrl;
  // Playwright resolves project.use before global setup. Its documented global
  // setup environment handoff lets the shared test fixture supply the harness's
  // intentionally dynamic URL to worker processes.
  process.env.E2E_BASE_URL = baseURL;
  console.log(`[E2E Setup] Test harness is ready at ${baseURL}`);

  // 4. Authenticate test user
  const testEmail = process.env.E2E_TEST_USER_EMAIL;
  const testPassword = process.env.E2E_TEST_USER_PASSWORD;

  if (!testEmail || !testPassword) {
    console.warn(
      "[E2E Setup] No test credentials found. Set E2E_TEST_USER_EMAIL and E2E_TEST_USER_PASSWORD.",
    );
    return;
  }

  console.log("[E2E Setup] Setting up test user authentication...");

  // Use Playwright browser to authenticate
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(baseURL);

  // Try to sign up first
  const signUpResponse = await page.request.post(
    `${baseURL}/api/auth/sign-up/email`,
    {
      headers: { Origin: baseURL },
      data: {
        email: testEmail,
        password: testPassword,
        name: "E2E Test User",
      },
    },
  );

  if (!signUpResponse.ok()) {
    console.log("[E2E Setup] User already exists, signing in instead...");
  }

  // Sign in to get session
  const signInResponse = await page.request.post(
    `${baseURL}/api/auth/sign-in/email`,
    {
      headers: { Origin: baseURL },
      data: {
        email: testEmail,
        password: testPassword,
      },
    },
  );

  if (!signInResponse.ok()) {
    const errorText = await signInResponse.text();
    throw new Error(
      `Failed to sign in: ${signInResponse.status()} - ${errorText}`,
    );
  }

  // Save the authentication state. `page.request` shares the BrowserContext
  // cookie jar, so the better-auth session cookie set by the sign-in POST above
  // is already captured — no extra page navigations needed to "establish" it
  // (two goto + networkidle round-trips here were pure overhead every run).
  const authState = await context.storageState();
  // `session_data` is Better Auth's five-minute cookie cache. Persisting it in
  // a suite-wide storage-state file creates a fixed expiry cliff: a test whose
  // context starts just before that point authenticates initially, then lands
  // on Sign In after a reload. Keep only the durable session token so every
  // browser context obtains its own fresh cache cookie.
  authState.cookies = authState.cookies.filter(
    (cookie) => !cookie.name.endsWith("session_data"),
  );
  mkdirSync(path.dirname(authFile), { recursive: true });
  writeFileSync(authFile, JSON.stringify(authState, null, 2));
  // The server runs with INSECURE_AUTH_COOKIES=true (see the wrangler --var
  // above), so the session cookies are already plain (no Secure attribute, no
  // `__Secure-` prefix) and WebKit — including the strict Linux port in CI —
  // stores and replays them over http. The WebKit state is a straight copy;
  // it exists only because playwright.config.ts points the WebKit project at
  // its own file. (The old secure:false rewrite of `__Secure-` cookies was
  // rejected by Linux WebKit's cookie-prefix enforcement.)
  writeFileSync(webkitAuthFile, readFileSync(authFile, "utf8"));

  await browser.close();

  console.log("[E2E Setup] Authentication complete");
  console.log(`  - User: ${testEmail}`);
  console.log(`  - Auth state saved to: ${authFile}`);
}

export default globalSetup;
