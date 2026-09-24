import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { request } from "@playwright/test";
import { drizzle } from "drizzle-orm/node-postgres";
import dotenv from "dotenv";
import { Pool } from "pg";
import { z } from "zod";

import { assertSimulatorAdminUrl } from "./sim-db-guard";

const webRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repoRoot = path.resolve(webRoot, "../..");
const kitRoot = path.join(repoRoot, "apps/apple/CubbyKit");
const headless = process.argv.slice(2).includes("--headless");
const watch = process.argv.slice(2).includes("--watch");
if (
  (watch && !headless) ||
  process.argv
    .slice(2)
    .some((argument) => !["--headless", "--watch"].includes(argument))
)
  throw new Error("Usage: sim-e2e.ts [--headless [--watch]]");
const lane = headless ? "headless-e2e" : "sim-e2e";
dotenv.config({ path: path.join(webRoot, ".env") });
for (const [key, value] of Object.entries({
  R2_ACCESS_KEY_ID: "cubby-sim",
  R2_SECRET_ACCESS_KEY: "cubby-sim",
  R2_ENDPOINT: "http://127.0.0.1:9",
  R2_BUCKET_NAME: "cubby-sim",
  R2_PUBLIC_URL: "http://127.0.0.1:9",
  UPC_LOOKUP_API_URL: "http://127.0.0.1:9/",
  BETTER_AUTH_SECRET: "cubby-sim-local-secret",
}))
  process.env[key] ??= value;

const adminURL = "postgresql://postgres:password@localhost:55432/postgres";
const simName = `cubby_sim_${randomBytes(8).toString("hex")}`;
const databaseURL = adminURL.replace(/\/postgres$/u, `/${simName}`);
process.env.DATABASE_URL = databaseURL;
const artifacts = path.join(repoRoot, "artifacts", lane, simName);
mkdirSync(artifacts, { recursive: true });
let interrupted: NodeJS.Signals | undefined;
let activeChild: ReturnType<typeof spawn> | undefined;
let stopWatch: (() => void) | undefined;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    interrupted = signal;
    activeChild?.kill("SIGTERM");
    stopWatch?.();
  });
}

function swiftSourceVersion(): string {
  const sourceRoot = path.join(kitRoot, "Sources");
  const files = readdirSync(sourceRoot, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".swift"))
    .map((entry) => path.join(sourceRoot, entry));
  files.push(path.join(kitRoot, "Package.swift"));
  return files
    .sort()
    .map((file) => {
      const stat = statSync(file);
      return `${file}:${stat.mtimeMs}:${stat.size}`;
    })
    .join("|");
}

async function assertNativeEdit(
  productId: string,
  expectedName?: string,
): Promise<void> {
  const checkPool = new Pool({ connectionString: databaseURL });
  try {
    const { SIM_PRODUCT_UPDATED_NAME } = await import("./scenarios/simulator");
    const result = await checkPool.query<{ name: string }>(
      'SELECT name FROM "Product" WHERE shortcode = $1',
      [productId],
    );
    if (result.rows[0]?.name !== (expectedName ?? SIM_PRODUCT_UPDATED_NAME)) {
      throw new Error(
        `Native edit did not reach ${simName}: ${JSON.stringify(result.rows)}`,
      );
    }
    console.log(`[${lane}] Native edit verified in ${simName}`);
  } finally {
    await checkPool.end();
  }
}

async function run(
  command: string,
  args: string[],
  cwd = repoRoot,
  stdoutFile?: string,
): Promise<void> {
  if (interrupted) throw new Error(`${lane} interrupted by ${interrupted}`);
  appendFileSync(
    path.join(artifacts, "commands.log"),
    `${command} ${args.join(" ")}\n`,
  );
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeChild = child;
    const log = path.join(artifacts, "runner.log");
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk: Buffer) => {
        appendFileSync(log, chunk);
        if (stdoutFile && stream === child.stdout)
          appendFileSync(stdoutFile, chunk);
        if (!stdoutFile || stream === child.stderr)
          (stream === child.stdout ? process.stdout : process.stderr).write(
            chunk,
          );
      });
    }
    child.once("error", reject);
    child.once("close", (code) => {
      activeChild = undefined;
      if (code === 0 && !interrupted) resolve();
      else
        reject(
          new Error(
            `${command} exited ${code}${interrupted ? ` after ${interrupted}` : ""}`,
          ),
        );
    });
  });
}

async function simulator(): Promise<{
  udid: string;
  name: string;
  state: string;
}> {
  const deviceType = "com.apple.CoreSimulator.SimDeviceType.iPhone-17";
  const raw = await new Promise<string>((resolve, reject) => {
    const child = spawn("xcrun", [
      "simctl",
      "list",
      "devices",
      "available",
      "-j",
    ]);
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
    });
    child.once("close", (code) =>
      code === 0 ? resolve(output) : reject(new Error("simctl list failed")),
    );
    child.once("error", reject);
  });
  const parsed = z
    .object({
      devices: z.record(
        z.string(),
        z.array(
          z
            .object({
              name: z.string(),
              udid: z.string(),
              state: z.string(),
              deviceTypeIdentifier: z.string(),
            })
            .loose(),
        ),
      ),
    })
    .parse(JSON.parse(raw));
  const phones = Object.entries(parsed.devices)
    .filter(([runtime]) => runtime.includes(".iOS-"))
    .flatMap(([, devices]) => devices)
    .filter((device) => device.name.includes("iPhone"));
  const preferred = process.env.CUBBY_SIM_DEVICE;
  const selected = preferred
    ? phones.find(
        (device) =>
          device.deviceTypeIdentifier === deviceType &&
          (device.name === preferred || device.udid === preferred),
      )
    : (phones.find(
        (device) =>
          device.deviceTypeIdentifier === deviceType &&
          device.state === "Booted",
      ) ?? phones.find((device) => device.deviceTypeIdentifier === deviceType));
  if (!selected && !preferred) {
    await run("xcrun", ["simctl", "create", "cubby-e2e-iPhone17", deviceType]);
    return simulator();
  }
  if (!selected)
    throw new Error(
      `No iPhone 17 simulator found${preferred ? ` matching ${preferred}` : ""}`,
    );
  return selected;
}

async function main(): Promise<void> {
  assertSimulatorAdminUrl(adminURL);
  if (process.env.CUBBY_SIM_DB_EXTERNAL !== "1")
    await run("node", ["scripts/dev-db.ts", "up"]);
  const admin = new Pool({ connectionString: adminURL });
  let created = false;
  let harness:
    | Awaited<
        ReturnType<
          (typeof import("../tests/e2e/e2e-worker-runtime"))["createHarness"]
        >
      >
    | undefined;
  let objectStorage:
    | Awaited<
        ReturnType<
          (typeof import("../tests/e2e/e2e-object-storage"))["createE2EObjectStorage"]
        >
      >
    | undefined;
  let restoreEnvironment = () => {};
  let productId = "";
  let failure: Error | undefined;
  const cleanup = async (): Promise<Error[]> => {
    const errors: Error[] = [];
    try {
      await harness?.close();
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
    try {
      await objectStorage?.close();
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
    restoreEnvironment();
    if (created) {
      try {
        await admin.query(`DROP DATABASE "${simName}" WITH (FORCE)`);
        const remaining = await admin.query<{ exists: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists",
          [simName],
        );
        if (remaining.rows[0]?.exists)
          errors.push(new Error(`Cleanup failed for ${simName}`));
        else console.log(`[${lane}] Dropped ${simName}`);
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    try {
      await admin.end();
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
    return errors;
  };
  try {
    await admin.query(`CREATE DATABASE "${simName}"`);
    created = true;
    console.log(`[${lane}] Disposable database ${simName}`);
    if (watch) {
      const watchdog = spawn(
        process.execPath,
        [
          path.join(webRoot, "tooling/e2e-db-watchdog.mjs"),
          adminURL,
          simName,
          String(process.pid),
          path.join(artifacts, "watchdog.log"),
        ],
        { cwd: webRoot, detached: true, stdio: "ignore" },
      );
      if (!watchdog.pid)
        throw new Error("Could not start headless DB watchdog");
      watchdog.unref();
    }
    const pool = new Pool({ connectionString: databaseURL });
    try {
      const { ensureDbExtensions } = await import("./db-extensions");
      const { installEntityIdentityTriggers } =
        await import("../src/server/db/entity-identity-schema");
      const { toPushSchemaDatabase } = await import("./drizzle-kit-interop");
      const schema = await import("../src/server/db/schema");
      const { pushSchema } = await import("drizzle-kit/api");
      const db = drizzle(pool);
      await ensureDbExtensions(db);
      const { apply } = await pushSchema(schema, toPushSchemaDatabase(db), [
        "public",
      ]);
      await apply();
      await installEntityIdentityTriggers(db);
    } finally {
      await pool.end();
    }

    await run("pnpm", ["run", "build:cf"], webRoot);
    const { writeE2ECompatibleWranglerConfig } =
      await import("./e2e-worker-config");
    writeE2ECompatibleWranglerConfig(webRoot);
    const runtime = await import("../tests/e2e/e2e-worker-runtime");
    const { createE2EObjectStorage } =
      await import("../tests/e2e/e2e-object-storage");
    const { ensureHarnessServiceBundles } =
      await import("../tests/e2e/harness-services/bundle");
    restoreEnvironment = runtime.installDatabaseEnvironment(databaseURL);
    objectStorage = await createE2EObjectStorage();
    harness = runtime.createHarness(
      databaseURL,
      objectStorage.url,
      await ensureHarnessServiceBundles(),
    );
    const { url } = await harness.listen();
    const context = await request.newContext({
      baseURL: url.origin,
      extraHTTPHeaders: { Origin: url.origin },
    });
    let userId: string;
    try {
      const response = await context.post("/api/auth/sign-up/email", {
        data: {
          email: "sim@cubby.localhost",
          password: "cubby-sim-local-only",
          name: "Simulator Test User",
        },
      });
      if (!response.ok())
        throw new Error(
          `Simulator signup failed: ${response.status()} ${await response.text()}`,
        );
      userId = z
        .object({ user: z.object({ id: z.string().min(1) }) })
        .parse(await response.json()).user.id;
    } finally {
      await context.dispose();
    }
    const seedPool = new Pool({ connectionString: databaseURL });
    try {
      const { seedSimulatorScenario } = await import("./scenarios/simulator");
      productId = await seedSimulatorScenario(seedPool, userId);
    } finally {
      await seedPool.end();
    }
    console.log(
      `[${lane}] Workerd at ${url.origin}; seeded product ${productId}`,
    );

    if (headless) {
      const { SIM_PRODUCT_NAME, SIM_PRODUCT_UPDATED_NAME } =
        await import("./scenarios/simulator");
      let builtVersion: string | undefined;
      const runNative = async (
        id: string,
        originalName: string,
        updatedName: string,
      ) => {
        const started = performance.now();
        const args = [
          "headless-product-edit",
          "--base-url",
          url.origin,
          "--product-id",
          id,
          "--original-name",
          originalName,
          "--updated-name",
          updatedName,
        ];
        const sourceVersion = swiftSourceVersion();
        if (sourceVersion === builtVersion) {
          await run(path.join(kitRoot, ".build/debug/cubby"), args);
        } else {
          await run("pnpm", ["apple", "cli", ...args]);
          builtVersion = sourceVersion;
        }
        await assertNativeEdit(id, updatedName);
        console.log(
          `[${lane}] Native scenario ${(performance.now() - started).toFixed(0)}ms`,
        );
      };
      await runNative(productId, SIM_PRODUCT_NAME, SIM_PRODUCT_UPDATED_NAME);
      if (watch) {
        const input = createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        input.on("SIGINT", () => {
          interrupted = "SIGINT";
          input.close();
        });
        stopWatch = () => input.close();
        let iteration = 0;
        console.log(
          `[${lane}] Press Enter to seed a fresh product and rerun; Ctrl-C drops ${simName}`,
        );
        try {
          for await (const _ of input) {
            if (interrupted) break;
            iteration += 1;
            const originalName = `${SIM_PRODUCT_NAME} ${iteration}`;
            const updatedName = `${SIM_PRODUCT_UPDATED_NAME} ${iteration}`;
            const nextPool = new Pool({ connectionString: databaseURL });
            let nextID: string;
            try {
              const { seedSimulatorScenario } =
                await import("./scenarios/simulator");
              nextID = await seedSimulatorScenario(
                nextPool,
                userId,
                originalName,
              );
            } finally {
              await nextPool.end();
            }
            await runNative(nextID, originalName, updatedName);
            console.log(
              `[${lane}] Press Enter to rerun; Ctrl-C drops ${simName}`,
            );
          }
        } finally {
          stopWatch = undefined;
          input.close();
        }
      }
    } else {
      const device = await simulator();
      if (device.state !== "Booted")
        await run("xcrun", ["simctl", "boot", device.udid]);
      await run("xcrun", ["simctl", "bootstatus", device.udid, "-b"]);
      await run("pnpm", ["apple", "gen"]);
      await run("xcodebuild", [
        "-project",
        "apps/apple/Cubby.xcodeproj",
        "-scheme",
        "Cubby-iOS",
        "-configuration",
        "Debug",
        "-destination",
        `platform=iOS Simulator,id=${device.udid}`,
        "-derivedDataPath",
        "apps/apple/DerivedData",
        "CODE_SIGNING_ALLOWED=NO",
        "COMPILER_INDEX_STORE_ENABLE=NO",
        "build",
      ]);
      const appPath = path.join(
        repoRoot,
        "apps/apple/DerivedData/Build/Products/Debug-iphonesimulator/Cubby.app",
      );
      const common = ["--platform", "ios", "--udid", device.udid];
      await run("pnpm", [
        "exec",
        "agent-device",
        "reinstall",
        "com.nickysemenza.cubby",
        appPath,
        ...common,
      ]);
      await run("pnpm", [
        "exec",
        "agent-device",
        "prepare",
        "ios-runner",
        ...common,
        "--timeout",
        "240000",
      ]);
      await run("xcrun", [
        "simctl",
        "launch",
        "--terminate-running-process",
        device.udid,
        "com.nickysemenza.cubby",
        "--cubby-e2e-server",
        url.origin,
      ]);
      try {
        await run("pnpm", [
          "exec",
          "agent-device",
          "test",
          "apps/apple/e2e/product-edit.ad",
          ...common,
          "--artifacts-dir",
          artifacts,
          "--reporter",
          "default",
          "--reporter",
          `junit:${path.join(artifacts, "junit.xml")}`,
          "-e",
          `PRODUCT_ID=${productId}`,
        ]);
      } catch (error) {
        await run("xcrun", [
          "simctl",
          "io",
          device.udid,
          "screenshot",
          path.join(artifacts, "failure.png"),
        ]).catch(console.error);
        const diagnosticSession = `cubby-sim-diagnostic-${simName}`;
        try {
          await run("pnpm", [
            "exec",
            "agent-device",
            "open",
            "com.nickysemenza.cubby",
            ...common,
            "--session",
            diagnosticSession,
          ]);
          await run(
            "pnpm",
            [
              "exec",
              "agent-device",
              "snapshot",
              "--raw",
              ...common,
              "--session",
              diagnosticSession,
            ],
            repoRoot,
            path.join(artifacts, "failure-ui-tree.ndjson"),
          );
        } catch (diagnosticError) {
          appendFileSync(
            path.join(artifacts, "diagnostic-error.txt"),
            String(diagnosticError),
          );
        } finally {
          await run("pnpm", [
            "exec",
            "agent-device",
            "close",
            ...common,
            "--session",
            diagnosticSession,
          ]).catch(console.error);
        }
        throw error;
      }
      await assertNativeEdit(productId);
    }
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
    writeFileSync(path.join(artifacts, "failure.txt"), String(error));
    console.error(`[${lane}] Failure artifacts: ${artifacts}`);
  } finally {
    const cleanupErrors = await cleanup();
    if (cleanupErrors.length > 0)
      failure = new AggregateError(
        failure === undefined ? cleanupErrors : [failure, ...cleanupErrors],
        `${lane} failed with cleanup errors for ${simName}`,
      );
  }
  if (failure !== undefined) throw failure;
}

await main();
