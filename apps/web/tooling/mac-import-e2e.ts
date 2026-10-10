import { execFileSync, spawn } from "node:child_process";
import { withKitPackageResolution } from "../../../scripts/apple-package-resolution.ts";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pollUntil } from "@cubby/shared/retry";
import { runOrThrow } from "../../../scripts/lib/run.ts";
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
import { seedBaseWorld } from "./factories/base-world";
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
import { openWorkerdRuntime, type WorkerdRuntime } from "./workerd-runtime";
import { leaseNamedDatabase } from "./test-database-lease";
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
const productClarity = flags.length === 1 && flags[0] === "--product-clarity";
if ((flags.length && !productClarity) || process.platform !== "darwin")
  throw new Error(
    "Usage on macOS: pnpm --dir apps/web exec tsx tooling/mac-import-e2e.ts [--product-clarity]",
  );
const replayFlags = productClarity ? ["--product-clarity"] : [];
const scenarioTitle = productClarity
  ? "Actual sandboxed macOS Product explanations, financial relations and native table"
  : "Actual sandboxed macOS app statement CSV file import";
const fixtureVersion = productClarity ? 2 : 1;
const nonce = randomBytes(8).toString("hex");
const databaseName = `cubby_sim_${nonce}`;
const adminURL = "postgresql://postgres:password@localhost:55432/postgres";
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
  valuationExplanationObserved: false,
  productPurchaseEvidenceObserved: false,
  purchaseProductEvidenceObserved: false,
  entityTableObserved: false,
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
  await pollUntil(
    () => (interrupted || existsSync(release) ? true : undefined),
    { label: "diagnostic release", timeoutMs: 180_000, intervalMs: 1000 },
  ).catch(() => undefined);
}

async function run(
  program: string,
  args: string[],
  environment = process.env,
): Promise<void> {
  console.log(`[mac-import-e2e] ${program} ${args.join(" ")}`);
  await runOrThrow(program, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: environment,
    describe: (status) => `${program} exited ${status}`,
    onSpawn: (child) => {
      activeChild = child;
    },
    onClose: () => {
      activeChild = undefined;
    },
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
    UPC_UPSTREAM_DISABLED: "true",
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
    "packages.yml",
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
    rustFingerprint(path.join(repoRoot, "Cargo.toml"), [
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
    fixture: productClarity
      ? "synthetic-product-evidence"
      : "synthetic-monarch-wardrobe",
    fixtureVersion,
    cases: [
      {
        name: productClarity
          ? "Mac valuation explanation, financial relations and sorted native table"
          : "Mac file selection, review, commit and database readback",
        status: (
          productClarity
            ? [
                milestones.valuationExplanationObserved,
                milestones.productPurchaseEvidenceObserved,
                milestones.purchaseProductEvidenceObserved,
                milestones.entityTableObserved,
              ].every(Boolean)
            : milestones.databaseVerified
        )
          ? "passed"
          : milestones.fixtureUIObserved
            ? "failed"
            : "not-run",
        durationMs: Math.round(performance.now() - started),
      },
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
async function finishFixtureLease(
  lease: ReturnType<typeof acquireMacFixtureLease> | undefined,
  cleanupSucceeded: boolean,
): Promise<void> {
  if (!lease) return;
  try {
    if (!cleanupSucceeded || ownedProcessCleanupFailed)
      throw new Error(
        "Mac fixture cleanup failed; host lease retained for diagnosis",
      );
    await pollUntil(
      () => {
        try {
          assertMacFixturesIdle();
          return true;
        } catch (error) {
          // Verified app exit can precede its fixture child processes exiting.
          if (
            error instanceof Error &&
            error.message.startsWith(
              "Stable Mac fixture app is already running.",
            )
          )
            return undefined;
          throw error;
        }
      },
      {
        label: "Mac fixture processes exited",
        timeoutMs: 10000,
        intervalMs: 100,
      },
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
  runtime: WorkerdRuntime | undefined;
  restoreEnvironment: () => void;
}): Promise<void> {
  const { opened, runtime, restoreEnvironment } = input;
  if (opened)
    await driver.close().catch((error) => {
      retainCleanupFailure(error, "native adapter cleanup");
    });
  await cleanupNativeProcess();
  await runtime?.close().catch((error) => {
    retainCleanupFailure(error, "Worker runtime cleanup");
  });
  restoreEnvironment();
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

async function runNativeScenario(
  csv: () => Promise<void>,
  productFixture: { productId: string; purchaseId: string } | undefined,
): Promise<void> {
  if (productClarity && productFixture) {
    phase = "product-clarity-presentation";
    const { productId, purchaseId } = productFixture;
    await driver.openEntity(productId, appPath);
    await driver.wait("id=detail.product.edit");
    await driver.scrollTo(
      `id=field.explanation.product.${productId}.price label="About Valuation price"`,
      "detail.product",
    );
    await driver.click(
      `id=field.explanation.product.${productId}.price label="About Valuation price"`,
      "detail.product",
    );
    await driver.wait("id=field.explanation.popover");
    await driver.scrollTo(
      'id=field.explanation.effective-value text="$40.00"',
      "field.explanation.popover",
    );
    await driver.scrollTo(
      'text="Overrides inherited"',
      "field.explanation.popover",
    );
    await driver.scrollTo(
      'id=field.explanation.fallback-value text="$25.00"',
      "field.explanation.popover",
    );
    milestones.valuationExplanationObserved = true;
    await driver.screenshot("valuation-explanation");
    await driver.scrollTo(
      "id=field.explanation.close",
      "field.explanation.popover",
      "up",
    );
    await driver.click(
      "id=field.explanation.close",
      "field.explanation.popover",
    );
    await driver.waitAbsent("id=field.explanation.popover");
    async function relationEvidence(
      target: "product" | "purchase",
      id: string,
    ) {
      for (const suffix of [
        "movement.acquired",
        "movement.adjusted",
        "planned",
        "linked",
      ]) {
        await driver.scrollTo(
          `id=relation.evidence.${target}.${id}.${suffix}`,
          `detail.${target === "purchase" ? "product" : "purchase"}`,
        );
      }
    }
    await relationEvidence("purchase", purchaseId);
    milestones.productPurchaseEvidenceObserved = true;
    await driver.screenshot("product-purchase-evidence");
    await driver.click(
      `id=relation.row.purchase.${purchaseId}`,
      "detail.product",
    );
    await driver.wait("id=detail.purchase.edit");
    await relationEvidence("product", productId);
    milestones.purchaseProductEvidenceObserved = true;
    await driver.screenshot("purchase-product-evidence");
    phase = "entity-table-presentation";
    await driver.openEntity(productId, appPath);
    await driver.wait("id=detail.product.edit");
    await driver.click("role=popupbutton id=browse.product.view.list");
    await driver.click("id=browse.product.view.table");
    await driver.wait("role=outline");
    await driver.click("label=Name");
    async function waitForFirstTableProduct(expected: string) {
      await pollUntil(
        async () => {
          const snapshot = await driver.snapshot();
          const first = snapshot.match(
            /\[statictext\] "(Synthetic table product \d+)"/,
          );
          return first?.[1] === expected ? true : undefined;
        },
        { label: `native table first product ${expected}`, timeoutMs: 30000 },
      );
    }
    await waitForFirstTableProduct("Synthetic table product 00");
    await driver.click("label=Name");
    await waitForFirstTableProduct("Synthetic table product 15");
    await driver.scrollTo(
      'label="Synthetic table product 01"',
      "browse.product.list",
    );
    const reusedRowId = z
      .string()
      .min(1)
      .parse(
        (await driver.snapshot()).match(
          /\[statictext\] "Synthetic table product 05" id=browse\.product\.table\.row\.(\S+)/,
        )?.[1],
      );
    await driver.click(
      `id=field.explanation.product.${reusedRowId}.dataQuality label="Quality: About Quality"`,
    );
    await driver.wait("id=field.explanation.popover");
    await driver.wait('contains="Score calculation"');
    await driver.screenshot("table-explanation");
    await driver.click(
      "id=field.explanation.close",
      "field.explanation.popover",
    );
    await driver.waitAbsent("id=field.explanation.popover");
    const manufacturerCount = (snapshot: string) =>
      [...snapshot.matchAll(/\[statictext\] "Synthetic Works"/g)].length;
    const hiddenManufacturerCount = manufacturerCount(await driver.snapshot());
    await driver.click('label="Show or hide table columns"');
    await driver.click("id=browse.product.column.manufacturer");
    await driver.wait("role=button label=Manufacturer");
    await pollUntil(
      async () =>
        manufacturerCount(await driver.snapshot()) > hiddenManufacturerCount
          ? true
          : undefined,
      { label: "native table manufacturer values rendered", timeoutMs: 30000 },
    );
    await driver.screenshot("entity-table");
    await driver.click('label="Show or hide table columns"');
    await driver.click("id=browse.product.column.manufacturer");
    await driver.waitAbsent("role=button label=Manufacturer");
    await pollUntil(
      async () =>
        manufacturerCount(await driver.snapshot()) === hiddenManufacturerCount
          ? true
          : undefined,
      { label: "native table manufacturer values hidden", timeoutMs: 30000 },
    );
    for (const field of ["dataQuality", "acquisitionOrigin"]) {
      await driver.click('label="Show or hide table columns"');
      await driver.click(`id=browse.product.column.${field}`);
    }
    await driver.click(
      `id=browse.product.table.reference.${reusedRowId}.categoryId`,
    );
    await driver.wait("id=detail.productCategory.edit");
    await driver.click("role=popupbutton id=browse.product.view.table");
    await driver.click("id=browse.product.view.list");
    await driver.wait("role=popupbutton id=browse.product.view.list");
    milestones.entityTableObserved = true;
  } else await csv();
}

async function main(): Promise<void> {
  const bootstrapEnvironment = { ...process.env };
  process.env.DATABASE_URL = databaseURL;
  process.env.BETTER_AUTH_SECRET = "cubby-sim-local-secret";
  let opened = false;
  let fixtureUIReady = false;
  let fixtureUserId = "";
  let productFixture: { productId: string; purchaseId: string } | undefined;
  let restoreEnvironment = () => {};
  let runtime: WorkerdRuntime | undefined;
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
    ({ runtime } = await openWorkerdRuntime(
      {
        profile: "native-import",
        database: {
          lease: async () => {
            const { lease } = await leaseNamedDatabase(
              {
                adminUrl: adminURL,
                name: databaseName,
                retention: "drop",
                onCreated: () => {
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
                    throw new Error(
                      "Could not start disposable database watchdog",
                    );
                  watchdog.unref();
                },
              },
              async ({ databaseUrl }) => {
                const pool = new Pool({ connectionString: databaseUrl });
                try {
                  await seedBaseWorld(drizzle(pool));
                } finally {
                  await pool.end();
                }
              },
            );
            phase = "worker-startup";
            return lease;
          },
        },
        objectStorage: {},
      },
      async () => undefined,
    ));
    const storageUrl = runtime.objectStorageUrl;
    if (!storageUrl)
      throw new Error("Native runtime is missing object storage");
    restoreEnvironment = installScenarioEnvironment(storageUrl);
    const url = new URL(runtime.origin);
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
    const { seedMacStatementAccount } =
      await import("./mac-import-prerequisites");
    await seedMacStatementAccount(databaseURL, fixtureUserId);
    if (productClarity) {
      const {
        seedSimulatorPhotoActor,
        seedSimulatorProductClarity,
        seedSimulatorScenario,
      } = await import("./scenarios/simulator");
      const pool = new Pool({ connectionString: databaseURL });
      try {
        await seedSimulatorPhotoActor(pool, fixtureUserId);
        productFixture = await seedSimulatorProductClarity(pool, fixtureUserId);
        for (let index = 0; index < 16; index++) {
          await seedSimulatorScenario(
            pool,
            fixtureUserId,
            `Synthetic table product ${String(index).padStart(2, "0")}`,
            40,
          );
        }
      } finally {
        await pool.end();
      }
    }
    phase = "native-build";
    sourceFingerprint = nativeSourceFingerprint();
    const reuseManifest = process.env.CUBBY_E2E_REUSE_NATIVE_MANIFEST;
    if (reuseManifest) {
      await reuseNativeBuild(reuseManifest);
    } else {
      await run("pnpm", ["apple", "gen"]);
      sourceFingerprint = nativeSourceFingerprint();
      await withKitPackageResolution(repoRoot, async () => {
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
      });
    }
    milestones.built = true;
    const entitlements = path.join(artifacts, "Cubby-e2e.entitlements");
    const fixtureEntitlements = readFileSync(
      path.join(repoRoot, "apps/apple/App/macOS/Cubby.entitlements"),
      "utf8",
    );
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
    phase = "native-backend-preparation";
    await driver.prepareBackend();
    phase = "native-launch";
    await run(
      "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
      ["-f", appPath],
    );
    nativeProcessExpectation = {
      executable: path.join(appPath, "Contents/MacOS/Cubby"),
      arguments: ["--cubby-e2e-server", url.origin],
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
    await runNativeScenario(csv, productFixture);
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
    if (fixtureUIReady) await driver.screenshot("failure").catch(() => {});
    await holdFailedFixture();
  } finally {
    let cleanupSucceeded = false;
    try {
      await cleanupResources({
        opened,
        runtime,
        restoreEnvironment,
      });
      cleanupSucceeded = true;
    } catch (error) {
      retainCleanupFailure(error);
    } finally {
      await finishFixtureLease(fixtureLease, cleanupSucceeded);
    }
    saveArtifact();
  }
  if (failure) throw failure;
}
await main();
