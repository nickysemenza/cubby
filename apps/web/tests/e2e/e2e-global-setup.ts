import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  IntegreSQLClient,
  type IntegreSQLDatabaseConfig,
} from "@devoxa/integresql-client";
import { chromium, type FullConfig } from "@playwright/test";
import { pushSchema } from "drizzle-kit/api";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../../src/server/db/schema";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const authFile = path.join(__dirname, "../../playwright/.auth/user.json");

const integreSQL = new IntegreSQLClient({ url: "http://localhost:5000" });

const remapDBConfig = (
  databaseConfig: IntegreSQLDatabaseConfig,
): IntegreSQLDatabaseConfig => {
  databaseConfig.host = "localhost";
  databaseConfig.port = 5432;
  return databaseConfig;
};

async function waitForServer(url: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url, { method: "HEAD" });
      if (response.ok || response.status < 500) {
        return true;
      }
    } catch {
      // Server not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `Server at ${url} did not become ready within ${timeoutMs}ms`,
  );
}

async function globalSetup(config: FullConfig): Promise<void> {
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
    // pushSchema doesn't manage extensions; pg_trgm is needed for the GIN
    // trigram indexes, so create it before pushing.
    await db.execute(sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
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

  // 2. Start wrangler dev against the CF Workers build
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
  writeFileSync(
    path.join(webRoot, "dist/server/wrangler.e2e.json"),
    JSON.stringify(e2eConfig),
  );

  console.log("[E2E Setup] Starting wrangler dev on port 3001");
  const serverProcess = spawn(
    "npx",
    [
      "wrangler",
      "dev",
      "--config",
      "dist/server/wrangler.e2e.json",
      "--port",
      "3001",
      "--var",
      `BETTER_AUTH_SECRET:${process.env.BETTER_AUTH_SECRET || "e2e-test-secret"}`,
      // Signup is disabled by default; global setup creates the test user
      // via /api/auth/sign-up/email, so open it for E2E.
      "--var",
      "ALLOW_SIGNUP:true",
      "--var",
      `DATABASE_URL:${databaseUrl}`,
      "--var",
      "R2_ACCESS_KEY_ID:dummy",
      "--var",
      "R2_SECRET_ACCESS_KEY:dummy",
      // Dead port so USDA enrichment fails instantly (the client degrades to
      // empty results). E2E must not depend on remote services for combobox
      // searches, or parallel workers can blow the 30s test budget.
      "--var",
      "USDA_API_URL:http://127.0.0.1:9/",
    ],
    {
      env: {
        ...process.env,
        WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: databaseUrl,
      },
      stdio: "pipe",
      cwd: webRoot,
    },
  );

  // Capture server output for debugging
  serverProcess.stdout?.on("data", (data: Buffer) => {
    if (process.env.DEBUG) {
      console.log(`[Server] ${data.toString().trim()}`);
    }
  });

  serverProcess.stderr?.on("data", (data: Buffer) => {
    console.error(`[Server Error] ${data.toString().trim()}`);
  });

  // Store for teardown
  (globalThis as Record<string, unknown>).__E2E_SERVER__ = serverProcess;
  (globalThis as Record<string, unknown>).__E2E_DB_URL__ = databaseUrl;

  // 3. Wait for server to be ready
  const baseURL = config.projects[0]?.use?.baseURL || "http://localhost:3001";
  console.log(`[E2E Setup] Waiting for server at ${baseURL}...`);
  await waitForServer(baseURL, 60_000);
  console.log("[E2E Setup] Server is ready");

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

  // Navigate to home page first
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

  // Navigate to establish session in browser context
  await page.goto(baseURL);
  await page.waitForLoadState("networkidle");

  // Navigate to a protected page to verify authentication
  await page.goto(`${baseURL}/dashboard`);
  await page.waitForLoadState("networkidle");

  // Save the authentication state
  await context.storageState({ path: authFile });

  await browser.close();

  console.log("[E2E Setup] Authentication complete");
  console.log(`  - User: ${testEmail}`);
  console.log(`  - Auth state saved to: ${authFile}`);
}

export default globalSetup;
