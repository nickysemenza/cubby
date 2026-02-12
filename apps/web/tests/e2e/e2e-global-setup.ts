import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  IntegreSQLClient,
  type IntegreSQLDatabaseConfig,
} from "@devoxa/integresql-client";
import { chromium, type FullConfig } from "@playwright/test";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const authFile = path.join(__dirname, "../../playwright/.auth/user.json");

const integreSQL = new IntegreSQLClient({ url: "http://localhost:5000" });

const remapDBConfig = (
  databaseConfig: IntegreSQLDatabaseConfig,
): IntegreSQLDatabaseConfig => {
  const isCI = !!process.env.CI;
  databaseConfig.host = "localhost";
  // In CI, postgres runs on 5432; locally we use 5555 (mapped from container's 5432)
  databaseConfig.port = isCI ? 5432 : 5555;
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
  // Include both schema and migrations journal in hash to detect migration changes
  const hash = await integreSQL.hashFiles([
    "./src/server/db/schema.ts",
    "./drizzle/meta/_journal.json",
  ]);

  // Initialize template if needed
  await integreSQL.initializeTemplate(hash, async (databaseConfig) => {
    const connectionUrl = integreSQL.databaseConfigToConnectionUrl(
      remapDBConfig(databaseConfig),
    );

    console.log("[E2E Setup] Migrating template database...");
    const pool = new Pool({ connectionString: connectionUrl });
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder: "./drizzle" });
    console.log("[E2E Setup] Template database migrated");
    await pool.end();
  });

  // Get test database
  const databaseConfig = await integreSQL.getTestDatabase(hash);
  const databaseUrl = integreSQL.databaseConfigToConnectionUrl(
    remapDBConfig(databaseConfig),
  );

  console.log(`[E2E Setup] Using database: ${databaseConfig.database}`);

  // 2. Start server with this database
  const webRoot = path.join(__dirname, "../..");
  const useBuild = process.env.E2E_USE_BUILD === "true";

  const serverEnv = {
    ...process.env,
    // Use E2E_DATABASE_URL to bypass Vite's .env loading which would override DATABASE_URL
    E2E_DATABASE_URL: databaseUrl,
    // Also set DATABASE_URL as fallback
    DATABASE_URL: databaseUrl,
    // Prevent dotenvx from overriding our DATABASE_URL
    DOTENV_PRIVATE_KEY: "",
  };

  let serverProcess: ChildProcess;

  if (useBuild) {
    // Production builds output to dist/ for CF Workers — use wrangler dev to test them.
    // E2E tests always use the dev server path.
    throw new Error(
      "E2E_USE_BUILD is not supported. Production builds use CF Workers (wrangler dev). Remove E2E_USE_BUILD and use the dev server instead.",
    );
  } else {
    console.log("[E2E Setup] Starting dev server: pnpm run dev --port 3001");
    serverProcess = spawn("pnpm", ["run", "dev", "--port", "3001"], {
      env: serverEnv,
      stdio: "pipe",
      cwd: webRoot,
    });
  }

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
