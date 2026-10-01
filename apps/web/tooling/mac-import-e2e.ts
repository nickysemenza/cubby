import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import { request } from "@playwright/test";
import { z } from "zod";
import {
  acquireMacFixtureLease,
  assertMacFixturesIdle,
  macFixtureBundleID,
  macFixturePaths,
  macFixtureSigningIdentity,
  nativeBundleFingerprint,
  prepareMacFixtureApp,
} from "./mac-fixture-identity";
import { createMacRetailerFixture } from "./mac-retailer-fixture";
import { macImportOrder } from "./mac-import-orders";
import type { createMacComposedScenario } from "./mac-import-composed-scenario";
import type { createMacBrowserScenario } from "./mac-browser-import-scenario";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { scrubErrorMessage } from "../src/lib/error-diagnostics";
import { writeE2ERunBundle } from "./e2e-run-bundle";
import { MacImportDriver } from "./mac-import-driver";
import {
  stopOwnedMacProcess,
  waitForOwnedMacProcess,
  type MacProcessExpectation,
  type OwnedMacProcess,
} from "./mac-owned-process";
import { assertSimulatorAdminUrl } from "./sim-db-guard";
import { ensureWebBuild, readWebBuildProvenance } from "./web-build-provenance";
import {
  rustFingerprint,
  sourceDigest,
} from "../../../scripts/rust-fingerprint";

const webRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repoRoot = path.resolve(webRoot, "../..");
const flags = process.argv.slice(2).filter((arg) => arg !== "--");
const order =
  flags.length === 2 && flags[0] === "--order"
    ? macImportOrder.parse(flags[1]!.split(","))
    : undefined;
const browserMode =
  Boolean(order) || (flags.length === 1 && flags[0] === "--browser");
if ((flags.length && !browserMode) || process.platform !== "darwin")
  throw new Error(
    "Usage on macOS: pnpm --dir apps/web exec tsx tooling/mac-import-e2e.ts [--browser | --order csv,photo,receipt]",
  );
const replayFlags = order
  ? ["--order", order.join(",")]
  : browserMode
    ? ["--browser"]
    : [];
const scenarioTitle = order
  ? `Actual Mac composed evidence arrival: ${order.join(" → ")}`
  : browserMode
    ? "Actual Mac CSV import and isolated HTTPS retailer browser capture/resume"
    : "Actual sandboxed macOS app statement CSV file import";
const fixtureVersion = order ? 2 : 1;
const nonce = randomBytes(8).toString("hex");
const databaseName = `cubby_sim_${nonce}`;
const adminURL = "postgresql://postgres:password@localhost:55432/postgres";
assertSimulatorAdminUrl(adminURL);
const databaseURL = adminURL.replace(/\/postgres$/u, `/${databaseName}`);
const artifacts = path.join(repoRoot, "artifacts/mac-import-e2e", databaseName);
mkdirSync(artifacts, { recursive: true });
// Stable fixture identity is distinct from the installed app; DEBUG launch configuration resets run state.
const bundleID = macFixtureBundleID;
const fixturePaths = macFixturePaths();
const derivedData = path.join(
  repoRoot,
  "apps/apple/DerivedData/mac-import-e2e",
);
let appPath = path.join(derivedData, "Build/Products/Debug/Cubby.app");
const driver = new MacImportDriver(repoRoot, artifacts, `cubby-mac-${nonce}`);
const started = performance.now();
let phase = "setup";
let binaryFingerprint: string | null = null;
let cacheBinaryFingerprint: string | null = null;
let sourceFingerprint: string | undefined;
let signingTeam: string | undefined;
let failure: Error | undefined;
const cleanupFailures: Array<{ stage: string; message: string }> = [];
let interrupted = false;
const milestones = {
  built: false,
  signed: false,
  launched: false,
  fixtureUIObserved: false,
  previewObserved: false,
  savedObserved: false,
  databaseVerified: false,
  browserFixturePrepared: false,
  browserCaptureVerified: false,
  nativeBookingReviewed: false,
  nativePhotoApproved: false,
  retailerCommitted: false,
  composedGraphVerified: false,
};
let verifiedLaunchedPID: number | undefined;
let nativeProcessExpectation: MacProcessExpectation | undefined;
let ownedNativeProcess: OwnedMacProcess | undefined;
let ownedProcessCleanupFailed = false;
let activeChild: ReturnType<typeof spawn> | undefined;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    interrupted = true;
    failure = new Error(`Mac import E2E interrupted by ${signal}`);
    activeChild?.kill("SIGTERM");
    driver.interrupt();
  });
}

async function holdFailedFixture(): Promise<void> {
  if (
    !milestones.launched ||
    verifiedLaunchedPID === undefined ||
    interrupted ||
    process.env.CUBBY_E2E_DIAGNOSTIC_HOLD !== "1"
  )
    return;
  const release = path.join(artifacts, "diagnostic-release");
  const state = path.join(artifacts, "diagnostic-state.json");
  writeFileSync(
    state,
    JSON.stringify(
      {
        bundleID,
        appPath,
        ownedPID: verifiedLaunchedPID,
        session: driver.session,
        ownedFixture: true,
        timeoutSeconds: 180,
      },
      null,
      2,
    ) + "\n",
  );
  driver.evidence.push(state);
  saveArtifact();
  console.log(
    `[mac-import-e2e] Failed fixture held for at most 180 seconds: ${state}; create ${release} to clean up early`,
  );
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (interrupted || existsSync(release)) break;
    await setTimeout(1000);
  }
}

async function run(
  program: string,
  args: string[],
  environment = process.env,
): Promise<void> {
  console.log(`[mac-import-e2e] ${program} ${args.join(" ")}`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(program, args, {
      cwd: repoRoot,
      stdio: "inherit",
      env: environment,
    });
    activeChild = child;
    child.once("error", reject);
    child.once("close", (code) => {
      activeChild = undefined;
      if (code === 0) resolve();
      else reject(new Error(`${program} exited ${code}`));
    });
  });
}

function installScenarioEnvironment(storageURL: string): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries({
    NODE_ENV: "test",
    R2_ACCESS_KEY_ID: "dummy",
    R2_SECRET_ACCESS_KEY: "dummy",
    R2_ENDPOINT: storageURL,
    R2_BUCKET_NAME: "e2e-bucket",
    R2_PUBLIC_URL: storageURL,
    R2_KEY_PREFIX: "e2e",
    UPC_LOOKUP_API_URL: "http://127.0.0.1:9/",
    USDA_API_URL: "http://127.0.0.1:9/",
    AI_GATEWAY_API_KEY: "",
  })) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function nativeSourceFingerprint(): string {
  const hash = createHash("sha256");
  hash.update("native-inputs-v2\0fixture-build:ENABLE_DEBUG_DYLIB=NO\0");
  for (const root of [
    "App",
    "CubbyKit/Sources",
    "CubbyKit/Frameworks",
    "scripts",
  ]) {
    hash.update(
      `${root}\0${sourceDigest(path.join(repoRoot, "apps/apple", root))}\0`,
    );
  }
  for (const relative of [
    "project.yml",
    "CubbyKit/Package.swift",
    "CubbyKit/Package.resolved",
    "Cubby.xcodeproj/project.pbxproj",
    "Cubby.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved",
  ]) {
    const file = path.join(repoRoot, "apps/apple", relative);
    hash.update(`${relative}\0`);
    hash.update(existsSync(file) ? readFileSync(file) : "absent");
    hash.update("\0");
  }
  hash.update(
    rustFingerprint(path.join(repoRoot, "cubby-ffi/Cargo.toml"), [
      execFileSync("xcodebuild", ["-version"], { encoding: "utf8" }),
      process.arch,
      `profile=${process.env.CUBBY_FFI_PROFILE ?? "release"}`,
      `targets=${process.env.CUBBY_FFI_TARGETS ?? "all"}`,
    ]),
  );
  return hash.digest("hex");
}

async function reuseNativeBuild(reuseManifest: string): Promise<void> {
  const previous = z
    .object({
      source: z.object({ commit: z.string() }),
      build: z.object({
        fingerprint: z.string(),
        matchesSource: z.literal(true),
        details: z.object({
          sourceFingerprintVersion: z.literal(2),
          sourceFingerprint: z.string(),
          binaryFingerprintFormat: z.literal("app-bundle-v1"),
          cacheBinaryFingerprint: z.string(),
        }),
      }),
    })
    .parse(JSON.parse(readFileSync(reuseManifest, "utf8")));
  const fingerprint = nativeBundleFingerprint(appPath);
  if (
    previous.build.details.sourceFingerprint !== sourceFingerprint ||
    previous.build.details.cacheBinaryFingerprint !== fingerprint
  )
    throw new Error(
      "Cached native app differs from the verified manifest or current native source",
    );
  const evidence = path.join(artifacts, "native-build-reuse.json");
  writeFileSync(
    evidence,
    JSON.stringify(
      {
        sourceCommit: previous.source.commit,
        sourceFingerprint,
        fingerprint,
      },
      null,
      2,
    ) + "\n",
  );
  driver.evidence.push(evidence);
}

function composedCases() {
  if (!order) return [];
  return [
    {
      name: "Native reviewed Expense booking or settlement link",
      milestone: milestones.nativeBookingReviewed,
    },
    {
      name: "Native original photo intake, supplied external analysis and native approval",
      milestone: milestones.nativePhotoApproved,
    },
    {
      name: "Actual captured retailer prepare/commit and native replacement approval",
      milestone: milestones.retailerCommitted,
    },
    {
      name: "Exact canonical Product/Expense/Purchase/source/image/inventory graph",
      milestone: milestones.composedGraphVerified,
    },
  ].map(({ name, milestone }) => ({
    name,
    status: milestone ? "passed" : "not-run",
  }));
}

function saveArtifact(): void {
  const webBuild = readWebBuildProvenance(repoRoot);
  const actions = path.join(artifacts, "actions.jsonl");
  const results = path.join(artifacts, "run-results.json");
  writeFileSync(
    results,
    JSON.stringify(
      {
        status: failure ? "failed" : "passed",
        phase,
        durationMs: Math.round(performance.now() - started),
        milestones,
        failure: failure ? scrubErrorMessage(failure.message) : null,
        cleanupFailures,
      },
      null,
      2,
    ) + "\n",
  );
  const runnerLog = path.join(
    artifacts,
    "agent-device-state",
    "sessions",
    driver.session,
    "runner.log",
  );
  const manifest = writeE2ERunBundle({
    repoRoot,
    outputDir: artifacts,
    kind: "native",
    status: failure ? "failed" : "passed",
    phase,
    command: [
      "pnpm",
      "--dir",
      "apps/web",
      "exec",
      "tsx",
      "tooling/mac-import-e2e.ts",
      ...replayFlags,
    ],
    scenario: scenarioTitle,
    fixture: "synthetic-monarch-wardrobe",
    fixtureVersion,
    cases: [
      {
        name: "Mac file selection, review, commit and database readback",
        status: milestones.databaseVerified
          ? "passed"
          : milestones.fixtureUIObserved
            ? "failed"
            : "not-run",
        durationMs: Math.round(performance.now() - started),
      },
      ...(browserMode
        ? [
            {
              name: "Actual Mac HTTPS retailer capture, sign-in and original run resume",
              status: milestones.browserCaptureVerified
                ? "passed"
                : phase === "native-browser-capture-resume"
                  ? "failed"
                  : "not-run",
            },
          ]
        : []),
      ...composedCases(),
    ],
    evidence: [
      results,
      ...driver.evidence,
      ...(existsSync(actions) ? [actions] : []),
      ...(existsSync(runnerLog) ? [runnerLog] : []),
    ],
    runtime: {
      nativeHelperSHA256: driver.helperFingerprint(),
      uiBackend: "agent-device-native-macos",
      agentDevice: execFileSync("pnpm", ["exec", "agent-device", "--version"], {
        cwd: repoRoot,
        encoding: "utf8",
      }).trim(),
      xcode: execFileSync("xcodebuild", ["-version"], { encoding: "utf8" })
        .trim()
        .replaceAll("\n", "; "),
    },
    build: {
      fingerprint: binaryFingerprint,
      matchesSource: Boolean(
        binaryFingerprint &&
        sourceFingerprint === nativeSourceFingerprint() &&
        webBuild.matchesSource,
      ),
      details: {
        app: "Cubby.app",
        bundleID,
        sandboxed: true,
        signingTeam: signingTeam ?? "unselected",
        certificateKind: "Developer ID Application",
        debugDylib: false,
        sourceFingerprint: sourceFingerprint ?? "unbuilt",
        sourceFingerprintVersion: 2,
        binaryFingerprintFormat: "app-bundle-v1",
        cacheBinaryFingerprint: cacheBinaryFingerprint ?? "unbuilt",
        webFingerprint: webBuild.fingerprint ?? "unbuilt",
      },
    },
  });
  console.log(`[mac-import-e2e] Artifact: ${manifest}`);
}

async function cleanupNativeProcess(): Promise<void> {
  if (!nativeProcessExpectation) return;
  const evidence = path.join(artifacts, "native-process-cleanup.json");
  let result;
  let cleanupError: string | null = null;
  try {
    result = await stopOwnedMacProcess(
      nativeProcessExpectation,
      ownedNativeProcess,
    );
  } catch (error) {
    ownedProcessCleanupFailed = true;
    cleanupError = retainCleanupFailure(error, "native process cleanup");
  }
  writeFileSync(
    evidence,
    JSON.stringify(
      {
        verifiedPID: verifiedLaunchedPID ?? null,
        exited: !ownedProcessCleanupFailed,
        result: result ?? null,
        error: cleanupError,
      },
      null,
      2,
    ) + "\n",
  );
  driver.evidence.push(evidence);
}
function finishFixtureLease(
  lease: ReturnType<typeof acquireMacFixtureLease> | undefined,
  cleanupSucceeded: boolean,
): void {
  if (!lease) return;
  try {
    assertMacFixturesIdle();
    if (!cleanupSucceeded || ownedProcessCleanupFailed)
      throw new Error(
        "Mac fixture cleanup failed; host lease retained for diagnosis",
      );
    lease.release();
  } catch (error) {
    const cleanupError = retainCleanupFailure(error, "fixture lease cleanup");
    const evidence = path.join(artifacts, "fixture-lease-retained.json");
    writeFileSync(
      evidence,
      JSON.stringify(
        {
          retained: true,
          cleanupSucceeded,
          ownedProcessCleanupFailed,
          error: cleanupError,
        },
        null,
        2,
      ) + "\n",
    );
    driver.evidence.push(evidence);
  }
}

async function cleanupResources(input: {
  opened: boolean;
  browserScenario:
    | Awaited<ReturnType<typeof createMacBrowserScenario>>
    | undefined;
  retailer: Awaited<ReturnType<typeof createMacRetailerFixture>> | undefined;
  harness:
    | ReturnType<
        (typeof import("./local-workerd-harness"))["createLocalWorkerdHarness"]
      >
    | undefined;
  storage:
    | Awaited<
        ReturnType<
          (typeof import("./local-object-storage"))["createE2EObjectStorage"]
        >
      >
    | undefined;
  restoreEnvironment: () => void;
  created: boolean;
  admin: Pool;
}): Promise<void> {
  const {
    opened,
    browserScenario,
    retailer,
    harness,
    storage,
    restoreEnvironment,
    created,
    admin,
  } = input;
  if (opened)
    await driver.close().catch((error) => {
      retainCleanupFailure(error, "native adapter cleanup");
    });
  await cleanupNativeProcess();
  await browserScenario?.close().catch((error) => {
    retainCleanupFailure(error, "browser scenario cleanup");
  });
  if (browserScenario) driver.evidence.push(...browserScenario.evidence);
  await retailer?.close().catch((error) => {
    ownedProcessCleanupFailed = true;
    retainCleanupFailure(error, "retailer process cleanup");
  });
  if (retailer) {
    driver.evidence.push(
      path.join(artifacts, "retailer/fixture.json"),
      path.join(artifacts, "retailer/requests.json"),
    );
  }
  await harness?.close().catch((error) => {
    retainCleanupFailure(error, "Worker cleanup");
  });
  await storage?.close().catch((error) => {
    retainCleanupFailure(error, "object storage cleanup");
  });
  restoreEnvironment();
  if (created)
    await admin
      .query(`DROP DATABASE "${databaseName}" WITH (FORCE)`)
      .catch((error) => {
        retainCleanupFailure(error, "database cleanup");
      });
  await admin.end();
}

function retainCleanupFailure(
  error: unknown,
  stage = "fixture resource cleanup",
): string {
  const parsed = z.instanceof(Error).safeParse(error);
  const diagnostic = parsed.success
    ? parsed.data
    : new Error("Non-Error Mac fixture cleanup failure");
  const message = scrubErrorMessage(diagnostic.message);
  cleanupFailures.push({ stage, message });
  failure ??= diagnostic;
  return message;
}

async function main(): Promise<void> {
  const bootstrapEnvironment = { ...process.env };
  process.env.DATABASE_URL = databaseURL;
  process.env.BETTER_AUTH_SECRET = "cubby-sim-local-secret";
  const admin = new Pool({ connectionString: adminURL });
  let created = false;
  let opened = false;
  let fixtureUIReady = false;
  let fixtureUserId = "";
  let retailer:
    | Awaited<ReturnType<typeof createMacRetailerFixture>>
    | undefined;
  let browserScenario:
    | Awaited<ReturnType<typeof createMacBrowserScenario>>
    | undefined;
  let composed:
    | Awaited<ReturnType<typeof createMacComposedScenario>>
    | undefined;
  let restoreEnvironment = () => {};
  let harness:
    | ReturnType<
        (typeof import("./local-workerd-harness"))["createLocalWorkerdHarness"]
      >
    | undefined;
  let storage:
    | Awaited<
        ReturnType<
          (typeof import("./local-object-storage"))["createE2EObjectStorage"]
        >
      >
    | undefined;
  let fixtureLease: ReturnType<typeof acquireMacFixtureLease> | undefined;
  try {
    phase = "fixture-identity-preflight";
    fixtureLease = acquireMacFixtureLease(fixturePaths.root, nonce);
    assertMacFixturesIdle();
    const signingIdentity = macFixtureSigningIdentity(repoRoot);
    signingTeam = signingIdentity.team;
    const identityEvidence = path.join(
      artifacts,
      "fixture-identity-preflight.json",
    );
    writeFileSync(
      identityEvidence,
      JSON.stringify(
        {
          bundleID,
          browserBundleID: "com.cubby.fixture.browser",
          certificateKind: "Developer ID Application",
          signingTeam,
          serializedHostLease: true,
          runningFixturesAbsent: true,
        },
        null,
        2,
      ) + "\n",
    );
    driver.evidence.push(identityEvidence);
    phase = "web-build";
    await ensureWebBuild(
      repoRoot,
      async (skipCache) => {
        const environment: NodeJS.ProcessEnv = {
          ...process.env,
          NX_DAEMON: "false",
        };
        if (skipCache) environment.NX_SKIP_NX_CACHE = "true";
        await run(
          "pnpm",
          ["exec", "nx", "run", "@cubby/web:build-cf", "--outputStyle=stream"],
          environment,
        );
      },
      process.env.CUBBY_E2E_PREBUILT_WEB === "1",
    );
    phase = "database";
    if (process.env.CUBBY_SIM_DB_EXTERNAL !== "1") {
      await run("node", ["scripts/dev-db.ts", "up"], bootstrapEnvironment);
    }
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    const watchdog = spawn(
      process.execPath,
      [
        path.join(webRoot, "tooling/e2e-db-watchdog.mjs"),
        adminURL,
        databaseName,
        String(process.pid),
        path.join(artifacts, "watchdog.log"),
      ],
      { cwd: webRoot, detached: true, stdio: "ignore" },
    );
    if (!watchdog.pid)
      throw new Error("Could not start disposable database watchdog");
    watchdog.unref();
    const pool = new Pool({ connectionString: databaseURL });
    try {
      const { migrateDatabase } = await import("./db-migrate");
      await migrateDatabase(drizzle(pool));
      // A freshly migrated database needs the same hierarchy root as the web E2E lane.
      await pool.query(`
        INSERT INTO "Location" (shortcode, name, aliases, tags, type, "parentId")
        VALUES ('LOC-HM3E', 'Home', ARRAY[]::text[], ARRAY[]::text[], 'house', NULL)
      `);
    } finally {
      await pool.end();
    }
    phase = "worker-startup";
    const { writeLocalWorkerdConfig } = await import("./e2e-worker-config");
    writeLocalWorkerdConfig(webRoot);
    const runtime = await import("./local-workerd-harness");
    restoreEnvironment = runtime.installDatabaseEnvironment(databaseURL);
    const { createE2EObjectStorage } = await import("./local-object-storage");
    storage = await createE2EObjectStorage();
    const restoreScenarioEnvironment = installScenarioEnvironment(storage.url);
    const restoreDatabaseEnvironment = restoreEnvironment;
    restoreEnvironment = () => {
      restoreScenarioEnvironment();
      restoreDatabaseEnvironment();
    };
    harness = runtime.createLocalWorkerdHarness(databaseURL, storage.url);
    const { url } = await harness.listen();
    const context = await request.newContext({
      baseURL: url.origin,
      extraHTTPHeaders: { Origin: url.origin },
    });
    try {
      const response = await context.post("/api/auth/sign-up/email", {
        data: {
          email: "sim@cubby.localhost",
          password: "cubby-sim-local-only",
          name: "Synthetic Mac Member",
        },
      });
      if (!response.ok())
        throw new Error(
          `Synthetic signup failed: ${response.status()} ${await response.text()}`,
        );
      fixtureUserId = z
        .object({ user: z.object({ id: z.string().min(1) }) })
        .parse(await response.json()).user.id;
    } finally {
      await context.dispose();
    }
    if (browserMode) {
      phase = "browser-fixture";
      retailer = await createMacRetailerFixture(artifacts, nonce, {
        identity: signingIdentity,
        lease: fixtureLease,
      });
      const { createMacBrowserScenario } =
        await import("./mac-browser-import-scenario");
      browserScenario = await createMacBrowserScenario({
        databaseURL,
        userId: fixtureUserId,
        artifacts,
        repoRoot,
        nonce,
        harness,
        retailer,
      });
      if (order) {
        const { createMacComposedScenario } =
          await import("./mac-import-composed-scenario");
        composed = await createMacComposedScenario({
          browser: browserScenario,
          driver,
          artifacts,
          webRoot,
          appPath: () => appPath,
          onStage: (stage) => {
            phase = stage;
          },
          onMilestone: (stage) => {
            milestones[stage] = true;
          },
        });
      }
      await retailer.launch();
      milestones.browserFixturePrepared = true;
    }
    phase = "native-build";
    sourceFingerprint = nativeSourceFingerprint();
    const reuseManifest = process.env.CUBBY_E2E_REUSE_NATIVE_MANIFEST;
    if (reuseManifest) {
      await reuseNativeBuild(reuseManifest);
    } else {
      await run("pnpm", ["apple", "gen"]);
      sourceFingerprint = nativeSourceFingerprint();
      await run("xcodebuild", [
        "-project",
        "apps/apple/Cubby.xcodeproj",
        "-scheme",
        "Cubby-macOS",
        "-configuration",
        "Debug",
        "-destination",
        "platform=macOS",
        "-derivedDataPath",
        derivedData,
        "-skipPackagePluginValidation",
        "COMPILER_INDEX_STORE_ENABLE=NO",
        "CODE_SIGNING_ALLOWED=NO",
        "ENABLE_DEBUG_DYLIB=NO",
        `PRODUCT_BUNDLE_IDENTIFIER=${bundleID}`,
        "build",
      ]);
    }
    milestones.built = true;
    const entitlements = path.join(artifacts, "Cubby-e2e.entitlements");
    let fixtureEntitlements = readFileSync(
      path.join(repoRoot, "apps/apple/App/macOS/Cubby.entitlements"),
      "utf8",
    );
    if (retailer) {
      fixtureEntitlements = fixtureEntitlements.replace(
        /(<key>com\.apple\.security\.temporary-exception\.apple-events<\/key>\s*)<array>[\s\S]*?<\/array>/u,
        `$1<array><string>${retailer.bundleID}</string></array>`,
      );
    }
    writeFileSync(
      entitlements,
      fixtureEntitlements.replace(
        /\s*<key>com\.apple\.developer\.associated-domains<\/key>\s*<array>[\s\S]*?<\/array>/u,
        "",
      ),
    );
    cacheBinaryFingerprint = nativeBundleFingerprint(appPath);
    const prepared = prepareMacFixtureApp({
      source: appPath,
      target: fixturePaths.app,
      bundleID,
      identity: signingIdentity,
      entitlements,
    });
    appPath = fixturePaths.app;
    const signatureEvidence = path.join(artifacts, "native-signature.json");
    writeFileSync(signatureEvidence, JSON.stringify(prepared, null, 2) + "\n");
    driver.evidence.push(signatureEvidence);
    milestones.signed = true;
    binaryFingerprint = prepared.signedFingerprint;
    phase = "native-launch";
    await run(
      "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
      ["-f", appPath],
    );
    nativeProcessExpectation = {
      executable: path.join(appPath, "Contents/MacOS/Cubby"),
      arguments: [
        "--cubby-e2e-server",
        url.origin,
        ...(retailer ? ["--cubby-e2e-browser-bundle", retailer.bundleID] : []),
      ],
    };
    opened = true;
    await run("open", [
      "-n",
      appPath,
      "--args",
      ...nativeProcessExpectation.arguments,
    ]);
    ownedNativeProcess = await waitForOwnedMacProcess(nativeProcessExpectation);
    const beforePID = ownedNativeProcess.pid;
    verifiedLaunchedPID = beforePID;
    milestones.launched = true;
    const beforeEvidence = path.join(
      artifacts,
      "app-launch-before-adapter.json",
    );
    writeFileSync(
      beforeEvidence,
      JSON.stringify(
        {
          bundleID,
          fixtureServer: true,
          ownedPID: beforePID,
          launchArgumentsVerified: true,
        },
        null,
        2,
      ) + "\n",
    );
    driver.evidence.push(beforeEvidence);
    await driver.open(bundleID, beforePID);
    const afterPID = (await waitForOwnedMacProcess(nativeProcessExpectation))
      .pid;
    if (afterPID !== beforePID)
      throw new Error("Native UI adapter changed the verified fixture process");
    milestones.launched = true;
    const launchEvidence = path.join(artifacts, "app-launch.json");
    writeFileSync(
      launchEvidence,
      JSON.stringify(
        {
          bundleID,
          executable: "Cubby.app/Contents/MacOS/Cubby",
          fixtureServer: true,
          running: true,
          beforeAdapterPID: beforePID,
          afterAdapterPID: afterPID,
          launchArgumentsPreserved: true,
        },
        null,
        2,
      ) + "\n",
    );
    driver.evidence.push(launchEvidence);
    await driver.wait("id=sidebar.destinations");
    fixtureUIReady = true;
    milestones.fixtureUIObserved = true;
    async function csv() {
      phase = "file-import";
      await driver.clickSidebar("Browse");
      await driver.openStatementImport();
      await driver.importStatement(
        path.join(webRoot, "tests/e2e/fixtures/synthetic-monarch-wardrobe.csv"),
      );
      milestones.previewObserved = true;
      await driver.screenshot("csv-review");
      const review = await driver.snapshot();
      const toggle = review.match(
        /(@e\d+(?:~s\d+)?)\s+[^\n]*Record transaction/,
      );
      if (!toggle?.[1])
        throw new Error(
          "Native review did not expose the synthetic charge selector",
        );
      await driver.click(toggle[1]);
      await driver.click("id=statement.csv.confirm");
      await driver.wait('text="Statement saved"');
      milestones.savedObserved = true;
      await driver.screenshot("csv-saved");
      phase = "database-readback";
      const checkPool = new Pool({ connectionString: databaseURL });
      try {
        const count = await checkPool.query<{
          rows: string;
          transactions: string;
          purchases: string;
        }>(
          `SELECT (SELECT count(*) FROM "StatementRow")::text AS rows, (SELECT count(*) FROM "FinancialTransaction")::text AS transactions, (SELECT count(*) FROM "FinancialTransaction" WHERE kind = 'purchase')::text AS purchases`,
        );
        if (
          count.rows[0]?.rows !== "2" ||
          count.rows[0]?.transactions !== "1" ||
          count.rows[0]?.purchases !== "1"
        )
          throw new Error(
            `Native CSV readback differs: ${JSON.stringify(count.rows)}`,
          );
        milestones.databaseVerified = true;
        const output = path.join(artifacts, "database-assertions.json");
        writeFileSync(
          output,
          JSON.stringify(
            {
              sourceRows: 2,
              transactions: 1,
              input: "synthetic-monarch-wardrobe.csv",
            },
            null,
            2,
          ),
        );
        driver.evidence.push(output);
      } finally {
        await checkPool.end();
      }
    }
    if (order && composed) {
      await composed.run(order, csv);
      milestones.composedGraphVerified = true;
    } else await csv();
    if (browserScenario && !composed) {
      phase = "native-browser-capture-resume";
      await browserScenario.run(driver);
      milestones.browserCaptureVerified = true;
    }
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
    if (fixtureUIReady) await driver.screenshot("failure").catch(() => {});
    await holdFailedFixture();
  } finally {
    let cleanupSucceeded = false;
    try {
      await cleanupResources({
        opened,
        browserScenario,
        retailer,
        harness,
        storage,
        restoreEnvironment,
        created,
        admin,
      });
      cleanupSucceeded = true;
    } catch (error) {
      retainCleanupFailure(error);
    } finally {
      finishFixtureLease(fixtureLease, cleanupSucceeded);
    }
    saveArtifact();
  }
  if (failure) throw failure;
}
await main();
