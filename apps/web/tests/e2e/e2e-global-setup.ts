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
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
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

// wrangler's crash log ends with the entry that killed it, but every entry
// carries the whole worker bundle as "contextual data" — hundreds of KB. Keep
// the short error entries; drop the dumps.
function readWranglerCrashEntries(logPath: string | undefined): string[] {
  if (!logPath) {
    return ["(no wrangler log path was printed to stderr)"];
  }
  let contents: string;
  try {
    contents = readFileSync(logPath, "utf8");
  } catch {
    return [`(could not read the wrangler log at ${logPath})`];
  }
  const entries = contents
    .split(/^--- /m)
    .filter((entry) => /Error in \w+Controller/.test(entry))
    .filter((entry) => entry.length < 2_000)
    .map((entry) =>
      entry
        .split("\n")
        // The stack is all wrangler-internal frames; dropping them is what
        // leaves room for the `cause`, which is the part that names the fault.
        .filter((line) => !/^\s*at /.test(line))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 300),
    );
  // wrangler logs the same failure twice (DevEnv's listener and the handler);
  // key on the text without its timestamp so only distinct faults are shown.
  const distinct = new Map<string, string>();
  for (const entry of entries) {
    const key = entry.replace(/^\S+Z \w+ /, "");
    if (!distinct.has(key)) {
      distinct.set(key, entry);
    }
  }
  return [...distinct.values()].slice(-2);
}

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
      // Plain (non-Secure, unprefixed) auth cookies: Linux WebKit refuses
      // `__Secure-`-prefixed cookies over http://localhost (cookie-prefix
      // rule), so the WebKit smoke project could never authenticate in CI.
      "--var",
      "INSECURE_AUTH_COOKIES:true",
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

  // wrangler prints its crash-log path on the way out; remember it so an
  // unexpected exit can quote the real cause. The fatal line wrangler leaves in
  // the job log is an ERROR with an *empty* message (it wraps a non-Error cause
  // in a blank Error), so on its own it explains nothing.
  let wranglerLogPath: string | undefined;

  serverProcess.stderr?.on("data", (data: Buffer) => {
    const text = data.toString().trim();
    wranglerLogPath =
      /Logs were written to "([^"]+)"/.exec(text)?.[1] ?? wranglerLogPath;
    console.error(`[Server Error] ${text}`);
  });

  // `wrangler dev` treats some transient proxy errors as fatal and exits the
  // whole process (see patches/wrangler@4.120.0.patch). When that happens every
  // remaining test fails with a bare ECONNREFUSED against a dead port, which
  // reads as 20 broken tests instead of one dead server — so say so here, once,
  // at the moment it happens.
  serverProcess.on("exit", (code, signal) => {
    const state = globalThis as Record<string, unknown>;
    if (state.__E2E_STOPPING__) {
      return;
    }
    const detail = `code=${code ?? "null"} signal=${signal ?? "null"}`;
    state.__E2E_SERVER_DIED__ = detail;
    const rule = "=".repeat(72);
    console.error(
      [
        "",
        rule,
        `[E2E] wrangler dev exited unexpectedly (${detail}).`,
        "[E2E] Every test after this point fails with ECONNREFUSED on :3001.",
        "[E2E] That is this exit, not a broken app. Last wrangler error:",
        ...readWranglerCrashEntries(wranglerLogPath).map(
          (entry) => `[E2E]   ${entry}`,
        ),
        rule,
        "",
      ].join("\n"),
    );
  });

  // Store for teardown
  (globalThis as Record<string, unknown>).__E2E_SERVER__ = serverProcess;
  (globalThis as Record<string, unknown>).__E2E_DB_URL__ = databaseUrl;
  process.env.E2E_DATABASE_URL = databaseUrl;

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
  await context.storageState({ path: authFile });
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
