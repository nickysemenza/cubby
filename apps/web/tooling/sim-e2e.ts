import {
  readTesterArmySummary,
  testerArmyRawOutput,
} from "./tester-army/report";
import { execFileSync, spawn } from "node:child_process";
import { pollUntil } from "@cubby/shared/retry";
import { walkFiles } from "../../../scripts/lib/tree-digest.ts";
import { spawnToExit } from "../../../scripts/lib/run.ts";
import {
  hasMatchingSimulatorBuild,
  hostedSimulatorBuildArgs,
  simulatorBuildFingerprint,
  stampSimulatorBuild,
} from "../../../scripts/apple-simulator-build-cache.ts";
import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { request } from "@playwright/test";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { z } from "zod";

import { writeE2ERunBundle } from "./e2e-run-bundle";
import {
  collectNativeDriverDiagnostics,
  projectNativeNavigationSnapshot,
} from "./native-driver-diagnostics";
import { simulatorInventorySchema } from "./simulator-inventory-schema";
import {
  iosSimulatorDeviceType,
  selectIOSSimulator,
} from "../../../scripts/apple-simulator-selection.ts";
import { scrubErrorMessage } from "../src/lib/error-diagnostics";
import { assertSimulatorAdminUrl } from "./sim-db-guard";
import { ensureWebBuild, readWebBuildProvenance } from "./web-build-provenance";

const webRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repoRoot = path.resolve(webRoot, "../..");
const kitRoot = path.join(repoRoot, "apps/apple/CubbyKit");
const appleRoot = path.join(repoRoot, "apps/apple");
// `pnpm test:e2e:sim -- <flags>` may forward the separator itself.
const rawFlags = process.argv.slice(2).filter((argument) => argument !== "--");
// Agents read this 2k-line file in slices to learn its modes; keep this the
// one place that answers "which flag, which env, where are the artifacts".
if (rawFlags.includes("--help") || rawFlags.includes("-h")) {
  console.log(`pnpm test:e2e:sim -- [mode] [modifiers]

Each run creates a fresh cubby_sim_<hex> database on localhost:55432, builds
the web Worker (reused when provenance matches), and drops the database after.

Modes (one per run; no mode = full native journey in the iOS simulator):
  --headless                 Swift CubbyKit CLI against the Worker, no simulator
    --photo [--purchase]     synthetic photo-inventory (+ wardrobe purchase) run
    --statement-csv          Swift CSV statement preview/import
    --watch                  stay up; press Enter to rerun
  --watch                    simulator app against real API data; Enter replays
  --video                    full journey plus MP4 and contact sheet
  --layout [--video]         layout probe screens
  --product-clarity [--video]  focused synthetic Product journey (Maestro)
  --input-journey [--video]  PhotosPicker/Files input acceptance
  --emoji-review [--video]   category emoji review replay
  --qa [--hold] [--video]    seeded synthetic household QA pass; --hold keeps it up
  --tester-army [--journey a,b] [--replay] [--wrong]
                             live-model agent journeys (billed; see docs/tester-army.md)

Environment:
  CUBBY_SIM_DEVICE           simulator name or UDID to prefer
  CUBBY_SIM_DB_EXTERNAL=1    skip starting PostgreSQL (already running)
  CUBBY_E2E_PREBUILT_WEB=1   trust the existing web build
  TESTER_ARMY_*              Tester Army model/journey settings
  R2_*, BETTER_AUTH_SECRET and DATABASE_URL are set to local simulation values.

Artifacts: artifacts/<lane>/<cubby_sim_hex>/ (run-manifest.json, logs, video).
Workflow guide: apps/apple/ITERATION.md; acceptance map: docs/agents/core-journey-e2e.md.`);
  process.exit(0);
}
const journeyFlag = rawFlags.indexOf("--journey");
if (journeyFlag >= 0) {
  const value = rawFlags[journeyFlag + 1];
  if (!value) throw new Error("--journey needs a comma-separated id list");
  process.env.TESTER_ARMY_JOURNEYS = value;
}
const flags = rawFlags.filter(
  (argument, index) =>
    argument !== "--journey" && rawFlags[index - 1] !== "--journey",
);
const headless = flags.includes("--headless");
const photo = flags.includes("--photo");
const purchase = flags.includes("--purchase");
const statementCsv = flags.includes("--statement-csv");
const inputJourney = flags.includes("--input-journey");
const watch = flags.includes("--watch");
const video = flags.includes("--video");
const layout = flags.includes("--layout");
const productClarity = flags.includes("--product-clarity");
const emojiReview = flags.includes("--emoji-review");
const testerArmy = flags.includes("--tester-army");
const testerArmyReplay = flags.includes("--replay");
const wrongName = flags.includes("--wrong") || flags.includes("--wrong-name");
const qa = flags.includes("--qa");
const qaHold = flags.includes("--hold");
if (
  (qa &&
    flags.some(
      (flag) => flag !== "--qa" && flag !== "--hold" && flag !== "--video",
    )) ||
  (qaHold && !qa) ||
  (emojiReview &&
    flags.some((flag) => flag !== "--emoji-review" && flag !== "--video")) ||
  (inputJourney &&
    (testerArmy ||
      headless ||
      photo ||
      purchase ||
      statementCsv ||
      watch ||
      layout ||
      productClarity)) ||
  (testerArmy &&
    (inputJourney ||
      headless ||
      photo ||
      purchase ||
      statementCsv ||
      watch ||
      video ||
      layout ||
      productClarity)) ||
  ((testerArmyReplay || wrongName) && !testerArmy) ||
  (watch && video) ||
  (video && headless) ||
  (layout && (headless || photo || purchase || watch || productClarity)) ||
  (productClarity &&
    (headless || photo || purchase || watch || statementCsv)) ||
  (photo && (!headless || watch)) ||
  (purchase && !photo) ||
  (statementCsv && (!headless || photo || purchase || watch)) ||
  flags.some(
    (argument) =>
      ![
        "--emoji-review",
        "--input-journey",
        "--headless",
        "--watch",
        "--video",
        "--photo",
        "--purchase",
        "--layout",
        "--product-clarity",
        "--statement-csv",
        "--tester-army",
        "--replay",
        "--wrong-name",
        "--qa",
        "--hold",
        "--wrong",
      ].includes(argument),
  )
)
  throw new Error(
    "Usage (see --help): sim-e2e.ts [--emoji-review [--video] | --input-journey [--video] | --tester-army [--journey a,b] [--replay] [--wrong] | --video | --layout [--video] | --product-clarity [--video] | --qa [--hold] [--video] | --watch | --headless [--watch | --photo [--purchase] | --statement-csv]]",
  );
const lane = qa
  ? "sim-qa-e2e"
  : emojiReview
    ? "sim-emoji-review-e2e"
    : inputJourney
      ? "sim-input-journey-e2e"
      : testerArmy
        ? "sim-tester-army-e2e"
        : productClarity
          ? "sim-product-clarity-e2e"
          : statementCsv
            ? "headless-statement-csv-e2e"
            : layout
              ? "sim-layout-e2e"
              : purchase
                ? "headless-wardrobe-e2e"
                : photo
                  ? "headless-photo-e2e"
                  : headless
                    ? "headless-e2e"
                    : watch
                      ? "sim-dev"
                      : "sim-e2e";
// Database bootstrap validates the caller's environment before simulation-only overrides.
const bootstrapEnvironment = { ...process.env };
for (const [key, value] of Object.entries({
  R2_ACCESS_KEY_ID: "cubby-sim",
  R2_SECRET_ACCESS_KEY: "cubby-sim",
  R2_ENDPOINT: "http://127.0.0.1:9",
  R2_BUCKET_NAME: "cubby-sim",
  R2_PUBLIC_URL: "http://127.0.0.1:9",
  UPC_UPSTREAM_DISABLED: "true",
  BETTER_AUTH_SECRET: "cubby-sim-local-secret",
}))
  process.env[key] ??= value;

const adminURL = "postgresql://postgres:password@localhost:55432/postgres";
const simName = `cubby_sim_${randomBytes(8).toString("hex")}`;
const databaseURL = adminURL.replace(/\/postgres$/u, `/${simName}`);
process.env.DATABASE_URL = databaseURL;
const artifacts = path.join(
  repoRoot,
  "artifacts",
  statementCsv ? "headless-e2e/statement-csv" : lane,
  simName,
);
mkdirSync(artifacts, { recursive: true });
const runStartedAt = performance.now();
const phases: Array<{ name: string; durationMs: number }> = [];
let phase = "setup";
let nativeBuildBinary: string | undefined;
let nativeBuildSourceVersion: string | undefined;
let currentNativeSourceVersion: (() => string) | undefined;
let nativeBuildReady = false;
const scenarioEvidence: string[] = [];
let xcodebuildVersion: string | undefined;
let simulatorName: string | undefined;
let simulatorRuntime: string | undefined;
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
  const files = walkFiles(sourceRoot).filter((entry) =>
    entry.endsWith(".swift"),
  );
  files.push(path.join(kitRoot, "Package.swift"));
  return files
    .sort()
    .map((file) => {
      const stat = statSync(file);
      return `${file}:${stat.mtimeMs}:${stat.size}`;
    })
    .join("|");
}

function appleSourceVersion(): string {
  const appRoot = path.join(appleRoot, "App");
  const files = walkFiles(appRoot).filter((entry) => entry.endsWith(".swift"));
  files.push(path.join(appleRoot, "project.yml"));
  return [
    swiftSourceVersion(),
    ...files.sort().map((file) => {
      const stat = statSync(file);
      return `${file}:${stat.mtimeMs}:${stat.size}`;
    }),
  ].join("|");
}

function nativeSourceFingerprint(includeApp: boolean): string {
  const kitSources = path.join(kitRoot, "Sources");
  const files = readdirSync(kitSources, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".swift"))
    .map((entry) => path.join(kitSources, entry));
  files.push(path.join(kitRoot, "Package.swift"));
  if (includeApp) {
    const appSources = path.join(appleRoot, "App");
    files.push(
      ...readdirSync(appSources, { recursive: true, encoding: "utf8" })
        .filter((entry) => entry.endsWith(".swift"))
        .map((entry) => path.join(appSources, entry)),
      path.join(appleRoot, "project.yml"),
    );
  }
  const hash = createHash("sha256");
  for (const file of files.sort()) {
    hash.update(path.relative(repoRoot, file));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function assertNativeEdit(
  productId: string,
  expectedName?: string,
  expectedEmoji?: string | null,
): Promise<void> {
  const checkPool = new Pool({ connectionString: databaseURL });
  try {
    const { SIM_PRODUCT_UPDATED_NAME } =
      await import("./scenarios/simulator-product-fixture");
    const targetName =
      expectedName ??
      (emojiReview
        ? "Synthetic Emoji Category Updated"
        : SIM_PRODUCT_UPDATED_NAME);
    const readName = async () => {
      const result = await checkPool.query<{
        name: string;
        emoji: string | null;
      }>(
        emojiReview
          ? 'SELECT name, emoji FROM "ProductCategory" WHERE shortcode = $1'
          : 'SELECT name, NULL::text AS emoji FROM "Product" WHERE shortcode = $1',
        [productId],
      );
      const row = result.rows[0];
      return expectedEmoji === undefined || row?.emoji === expectedEmoji
        ? row?.name
        : undefined;
    };
    try {
      await pollUntil(
        async () => ((await readName()) === targetName ? true : undefined),
        { label: `native edit of ${productId}`, timeoutMs: 15_000 },
      );
    } catch (error) {
      throw new Error(
        `Native edit did not reach ${simName}: ${(await readName()) ?? "missing"}`,
        { cause: error },
      );
    }
    console.log(`[${lane}] Native edit verified in ${simName}`);
  } finally {
    await checkPool.end();
  }
}

async function assertNativePhotoImport(
  runID: string,
  objectStorageUrl: string,
  expectedCount: number,
): Promise<string[]> {
  const checkPool = new Pool({ connectionString: databaseURL });
  try {
    const result = await checkPool.query<{
      id: string;
      key: string;
      size: number;
    }>(
      `SELECT i.shortcode AS id, i.key, i.size
       FROM "RunTarget" t
       JOIN "Run" r ON r.id = t."runId"
       JOIN "Image" i ON i.id = t."entityId"
       WHERE r.shortcode = $1 AND r.purpose = 'photo_inventory'
         AND t.state = 'pending'
       ORDER BY t.position`,
      [runID],
    );
    if (result.rows.length !== expectedCount)
      throw new Error(
        `Native photo import created ${result.rows.length} pending targets, expected ${expectedCount}`,
      );
    for (const row of result.rows) {
      const response = await fetch(
        `${objectStorageUrl}/e2e-bucket/${encodeURIComponent(row.key)}`,
      );
      if (
        !response.ok ||
        (await response.arrayBuffer()).byteLength !== row.size
      )
        throw new Error(
          `Native uploaded photo bytes are unavailable for ${runID}`,
        );
    }
    const jobs = await checkPool.query<{ imageId: string; kind: string }>(
      `SELECT i.shortcode AS "imageId", j.kind
       FROM "ImageProcessingJob" j
       JOIN "Image" i ON i.id = j."imageId"
       JOIN "RunTarget" t ON t."entityId" = i.id
       JOIN "Run" r ON r.id = t."runId"
       WHERE r.shortcode = $1`,
      [runID],
    );
    for (const row of result.rows) {
      const kinds = jobs.rows
        .filter((job) => job.imageId === row.id)
        .map((job) => job.kind)
        .sort();
      if (kinds.join(",") !== "describe_image,subject_lift")
        throw new Error(`Native photo ${row.id} scheduled ${kinds.join(",")}`);
    }
    console.log(
      `[${lane}] ${expectedCount} native photo uploads and ${jobs.rows.length} processing jobs verified in ${simName}`,
    );
    return result.rows.map((row) => row.id);
  } finally {
    await checkPool.end();
  }
}

async function exercisePhotoProcessingJobs(imageIDs: string[]): Promise<void> {
  const pool = new Pool({ connectionString: databaseURL });
  try {
    const [scenario, processing, dispatch, schemas] = await Promise.all([
      import("./scenarios/context"),
      import("~/server/repo/image-processing"),
      import("~/server/image-processing/dispatch"),
      import("@cubby/schemas/image-processing"),
    ]);
    const db = scenario.buildScenarioDatabase(pool);
    const result = await pool.query<{
      imageId: string;
      jobId: string;
      kind: "describe_image" | "subject_lift";
    }>(
      `SELECT i.shortcode AS "imageId", j.id AS "jobId", j.kind
       FROM "ImageProcessingJob" j
       JOIN "Image" i ON i.id = j."imageId"
       WHERE i.shortcode = ANY($1::text[])`,
      [imageIDs],
    );
    for (const [index, imageID] of imageIDs.entries()) {
      const job = result.rows.find(
        (row) => row.imageId === imageID && row.kind === "describe_image",
      );
      if (!job) throw new Error(`Missing description job for ${imageID}`);
      const lease = await processing.claimImageProcessingJob(db, {
        jobId: job.jobId,
        kinds: ["describe_image"],
        leaseMs: 60_000,
      });
      if (!lease) {
        const state = await pool.query(
          `SELECT j.state, j."nextAttemptAt", now() AS now, i.status,
                  j."sourceContentHash" = i.sha256 AS "sourceMatches"
           FROM "ImageProcessingJob" j JOIN "Image" i ON i.id = j."imageId"
           WHERE j.id = $1`,
          [job.jobId],
        );
        throw new Error(
          `Could not claim description job ${job.jobId}: ${JSON.stringify({
            job: state.rows[0],
          })}`,
        );
      }
      const completed = await processing.completeImageProcessingJob(db, {
        result: {
          jobId: job.jobId,
          attemptId: lease.attemptId,
          completedAt: new Date().toISOString(),
          outcome: {
            kind: "describe_image",
            status: "completed",
            description: {
              description:
                [
                  "Synthetic gray crew shirt",
                  "Synthetic clothing label",
                  "Synthetic brown boots",
                ][index] ?? "Synthetic wardrobe item",
              claims: [],
              cutoutEligibility: index === 1 ? "ineligible" : "eligible",
            },
            runtime: { platform: "cloud", model: "synthetic-test" },
          },
        },
        cloudAnalysis: {
          provider: "synthetic-test",
          model: "synthetic-test",
          promptRevision: schemas.IMAGE_DESCRIPTION_PROMPT_REVISION,
          resultSchemaRevision:
            schemas.IMAGE_DESCRIPTION_RESULT_SCHEMA_REVISION,
          inputFingerprint: `synthetic-${imageID}`,
        },
      });
      if (!completed.adopted)
        throw new Error(`Description result was not adopted for ${imageID}`);
    }
    for (const row of result.rows.filter((job) => job.kind === "subject_lift"))
      await dispatch.dispatchImageProcessingWakeup(db, row.jobId);
    const states = await pool.query<{
      imageId: string;
      kind: string;
      state: string;
    }>(
      `SELECT i.shortcode AS "imageId", j.kind, j.state
       FROM "ImageProcessingJob" j
       JOIN "Image" i ON i.id = j."imageId"
       WHERE i.shortcode = ANY($1::text[])`,
      [imageIDs],
    );
    for (const [index, imageID] of imageIDs.entries()) {
      const state = (kind: string) =>
        states.rows.find((row) => row.imageId === imageID && row.kind === kind)
          ?.state;
      if (state("describe_image") !== "ready")
        throw new Error(`Description job not ready for ${imageID}`);
      const expectedLiftState = index === 1 ? "skipped" : "waiting_for_device";
      if (state("subject_lift") !== expectedLiftState)
        throw new Error(
          `Cutout job state for ${imageID}: ${state("subject_lift")}`,
        );
    }
    console.log(
      `[${lane}] Synthetic descriptions adopted; cutouts skipped or waiting for a device as expected`,
    );
  } finally {
    await pool.end();
  }
}

async function run(
  command: string,
  args: string[],
  cwd = repoRoot,
  stdoutFile?: string,
  allowInterrupted = false,
  environment: NodeJS.ProcessEnv = process.env,
  stderrFile?: string,
): Promise<void> {
  if (interrupted && !allowInterrupted)
    throw new Error(`${lane} interrupted by ${interrupted}`);
  appendFileSync(
    path.join(artifacts, "commands.log"),
    `${command} ${args.join(" ")}\n`,
  );
  const log = path.join(artifacts, "runner.log");
  const status = await spawnToExit(command, args, {
    cwd,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    onSpawn: (child) => {
      activeChild = child;
      for (const stream of [child.stdout, child.stderr]) {
        stream?.on("data", (chunk: Buffer) => {
          appendFileSync(log, chunk);
          if (stdoutFile && stream === child.stdout)
            appendFileSync(stdoutFile, chunk);
          if (stderrFile && stream === child.stderr)
            appendFileSync(stderrFile, chunk);
          if (!stdoutFile || stream === child.stderr)
            (stream === child.stdout ? process.stdout : process.stderr).write(
              chunk,
            );
        });
      }
    },
    onClose: () => {
      activeChild = undefined;
    },
  });
  if (status !== 0 || (interrupted && !allowInterrupted))
    throw new Error(
      `${command} exited ${status}${interrupted ? ` after ${interrupted}` : ""}`,
    );
}

async function simulator(): Promise<
  NonNullable<ReturnType<typeof selectIOSSimulator>>
> {
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
  const parsed = simulatorInventorySchema.parse(JSON.parse(raw));
  const preferred = process.env.CUBBY_SIM_DEVICE;
  const selected = selectIOSSimulator(parsed, preferred);
  if (!selected && !preferred) {
    await run("xcrun", [
      "simctl",
      "create",
      "cubby-e2e-iPhone17",
      iosSimulatorDeviceType,
    ]);
    return simulator();
  }
  if (!selected)
    throw new Error(
      `No iPhone 17 simulator found${preferred ? ` matching ${preferred}` : ""}`,
    );
  return selected;
}

async function recordSimulatorVideo(
  deviceID: string,
): Promise<() => Promise<void>> {
  const output = path.join(artifacts, "run.mp4");
  appendFileSync(
    path.join(artifacts, "commands.log"),
    `xcrun simctl io ${deviceID} recordVideo --codec=h264 ${output}\n`,
  );
  const recorder = spawn(
    "xcrun",
    ["simctl", "io", deviceID, "recordVideo", "--codec=h264", output],
    { cwd: repoRoot, stdio: ["ignore", "ignore", "pipe"] },
  );
  const log = path.join(artifacts, "runner.log");
  const closed = new Promise<void>((resolve, reject) => {
    recorder.once("error", reject);
    recorder.once("close", (code, signal) => {
      if (code === 0 || signal === "SIGINT") resolve();
      else reject(new Error(`simctl recordVideo exited ${code ?? signal}`));
    });
  });
  void closed.catch(() => {});
  let started = false;
  try {
    await new Promise<void>((resolve, reject) => {
      let outputText = "";
      const timeout = setTimeout(
        () =>
          reject(
            new Error("Simulator recording did not start within 30 seconds"),
          ),
        30_000,
      );
      const finish = (error?: Error) => {
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };
      recorder.stderr.on("data", (chunk: Buffer) => {
        appendFileSync(log, chunk);
        outputText += chunk.toString();
        if (outputText.includes("Recording started")) finish();
      });
      recorder.once("error", (error) => finish(error));
      recorder.once("close", () =>
        finish(new Error("Simulator recording stopped before its first frame")),
      );
    });
    started = true;
  } finally {
    if (!started) {
      recorder.kill("SIGINT");
      await closed.catch(() => {});
    }
  }
  console.log(`[${lane}] Recording simulator video to ${output}`);
  return async () => {
    if (recorder.exitCode === null) recorder.kill("SIGINT");
    await closed;
    if (!existsSync(output) || statSync(output).size === 0)
      throw new Error(`Simulator video was not saved at ${output}`);
    console.log(`[${lane}] Video saved: ${output}`);
    const contactSheet = path.join(artifacts, "contact-sheet.png");
    await run("pnpm", [
      "exec",
      "agent-device",
      "record",
      "contact-sheet",
      output,
      "--out",
      contactSheet,
    ]);
    console.log(`[${lane}] Contact sheet saved: ${contactSheet}`);
  };
}

async function runWarmSimulator(options: {
  deviceID: string;
  common: string[];
  session: string;
  productId: string;
  userId: string;
  install: () => Promise<void>;
  launch: () => Promise<void>;
}): Promise<void> {
  const { SIM_PRODUCT_NAME, SIM_PRODUCT_UPDATED_NAME } =
    await import("./scenarios/simulator-product-fixture");
  const { seedSimulatorScenario } = await import("./scenarios/simulator");
  const { deviceID, common, session, productId, userId, install, launch } =
    options;
  const stateDir = path.join(artifacts, "agent-device-state");
  const sessionArgs = [
    ...common,
    "--session",
    session,
    "--state-dir",
    stateDir,
  ];
  let builtVersion = appleSourceVersion();
  let sessionActive = false;
  const input = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  input.on("SIGINT", () => {
    interrupted = "SIGINT";
    activeChild?.kill("SIGTERM");
    input.close();
  });
  stopWatch = () => input.close();
  const replay = async (
    id: string,
    originalName: string,
    updatedName: string,
  ) => {
    const started = performance.now();
    try {
      if (appleSourceVersion() !== builtVersion) {
        await run("pnpm", [
          "exec",
          "agent-device",
          "close",
          ...sessionArgs,
        ]).catch(() => {});
        sessionActive = false;
        await install();
        builtVersion = appleSourceVersion();
        await launch();
      }
      console.log(`[${lane}] Product ${id}; cubby://entity/${id}`);
      sessionActive = true;
      await run("pnpm", [
        "exec",
        "agent-device",
        "replay",
        "apps/apple/e2e/product-edit-warm.ad",
        ...sessionArgs,
        "--timeout",
        "120000",
        "-e",
        `PRODUCT_ID=${id}`,
        "-e",
        `PRODUCT_NAME=${originalName}`,
        "-e",
        `UPDATED_NAME=${updatedName}`,
      ]);
      await assertNativeEdit(id, updatedName);
      console.log(
        `[${lane}] Simulator replay ${(performance.now() - started).toFixed(0)}ms`,
      );
    } catch (error) {
      if (interrupted) throw error;
      await run("pnpm", [
        "exec",
        "agent-device",
        "screenshot",
        ...sessionArgs,
        "--out",
        path.join(artifacts, "failure.png"),
      ]).catch(() => {});
      await run(
        "pnpm",
        ["exec", "agent-device", "snapshot", "-i", ...sessionArgs],
        repoRoot,
        path.join(artifacts, "failure-ui-tree.txt"),
      ).catch(() => {});
      console.error(
        `[${lane}] Replay failed: ${String(error)}; inspect ${artifacts}`,
      );
    }
  };
  console.log(
    `[${lane}] Simulator ${deviceID}; agent-device session ${session}; state ${stateDir}`,
  );
  try {
    await replay(productId, SIM_PRODUCT_NAME, SIM_PRODUCT_UPDATED_NAME);
    let iteration = 0;
    console.log(
      `[${lane}] Press Enter to seed and replay; Ctrl-C drops ${simName}`,
    );
    for await (const _ of input) {
      if (interrupted) break;
      iteration += 1;
      const originalName = `${SIM_PRODUCT_NAME} ${iteration}`;
      const updatedName = `${SIM_PRODUCT_UPDATED_NAME} ${iteration}`;
      const nextPool = new Pool({ connectionString: databaseURL });
      let nextID: string;
      try {
        nextID = await seedSimulatorScenario(nextPool, userId, originalName);
      } finally {
        await nextPool.end();
      }
      await replay(nextID, originalName, updatedName);
      console.log(`[${lane}] Press Enter to rerun; Ctrl-C drops ${simName}`);
    }
  } finally {
    stopWatch = undefined;
    input.close();
    if (sessionActive)
      await run(
        "pnpm",
        ["exec", "agent-device", "close", ...sessionArgs],
        repoRoot,
        undefined,
        true,
      ).catch(console.error);
  }
}

function startDatabaseWatchdog(): void {
  const watchdog = spawn(
    process.execPath,
    [
      path.join(webRoot, "tooling/e2e-db-watchdog.mjs"),
      adminURL,
      simName,
      String(process.pid),
      path.join(artifacts, "watchdog.log"),
      ...(headless
        ? []
        : [`cubby-sim-${simName}`, path.join(artifacts, "agent-device-state")]),
    ],
    { cwd: webRoot, detached: true, stdio: "ignore" },
  );
  if (!watchdog.pid) throw new Error("Could not start E2E DB watchdog");
  watchdog.unref();
}

async function runHeadlessPhotoScenario(
  url: URL,
  objectStorageUrl: string,
  userId: string,
): Promise<void> {
  const scenarioStarted = performance.now();
  const pool = new Pool({ connectionString: databaseURL });
  try {
    const [{ seedSimulatorPhotoActor }, scenario, maintenance] =
      await Promise.all([
        import("./scenarios/simulator"),
        import("./scenarios/context"),
        import("~/server/repo/image-processing-maintenance"),
      ]);
    await seedSimulatorPhotoActor(pool, userId);
    await maintenance.updateImageProcessingSettings(
      scenario.buildScenarioDatabase(pool),
      { enabled: true, paused: false },
    );
  } finally {
    await pool.end();
  }
  const imagePaths = ["shirt", "label", "boots"].map((label) =>
    path.join(webRoot, "tests/e2e/fixtures", `synthetic-wardrobe-${label}.png`),
  );
  const nativeOutput = path.join(artifacts, "native-photo-output.txt");
  const sourceFingerprint = nativeSourceFingerprint(false);
  await run(
    "pnpm",
    [
      "apple",
      "cli",
      "headless-photo-import",
      "--base-url",
      url.origin,
      ...imagePaths,
    ],
    repoRoot,
    nativeOutput,
  );
  nativeBuildBinary = path.join(kitRoot, ".build/debug/cubby");
  nativeBuildSourceVersion = sourceFingerprint;
  currentNativeSourceVersion = () => nativeSourceFingerprint(false);
  nativeBuildReady = true;
  const match = readFileSync(nativeOutput, "utf8").match(
    /Headless native photo import verified: (RUN-[A-Z0-9]+)/u,
  );
  const runID = match?.[1];
  if (!runID)
    throw new Error("Native photo importer did not report its run id");
  const imageIDs = await assertNativePhotoImport(
    runID,
    objectStorageUrl,
    imagePaths.length,
  );
  const nativeReady = performance.now();
  const context = await request.newContext({
    baseURL: url.origin,
    extraHTTPHeaders: { Origin: url.origin },
  });
  try {
    const login = await context.post("/api/auth/sign-in/email", {
      data: { email: "sim@cubby.localhost", password: "cubby-sim-local-only" },
    });
    if (!login.ok())
      throw new Error(`Review sign-in failed: ${await login.text()}`);
    const groups = [
      {
        groupKey: "synthetic-shirt",
        images: [
          { id: imageIDs[0], purpose: "item" },
          { id: imageIDs[1], purpose: "label" },
        ],
        product: {
          kind: "create",
          create: { name: "Synthetic Gray Crew Shirt" },
        },
      },
      {
        groupKey: "synthetic-boots",
        images: [{ id: imageIDs[2], purpose: "item" }],
        product: {
          kind: "create",
          create: { name: "Synthetic Brown Boots" },
        },
      },
    ];
    const proposalPool = new Pool({ connectionString: databaseURL });
    try {
      const proposed = await context.post("/api/v1/photoImport/saveGroups", {
        data: { runId: runID, groups },
      });
      if (!proposed.ok())
        throw new Error(`Photo proposal failed: ${await proposed.text()}`);
      const beforeApproval = await proposalPool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM "Product"
         WHERE name IN ('Synthetic Gray Crew Shirt', 'Synthetic Brown Boots')
           AND "deletedAt" IS NULL`,
      );
      if (beforeApproval.rows[0]?.count !== "0")
        throw new Error("Photo proposals created Products before review");
    } finally {
      await proposalPool.end();
    }
    const proposedAt = performance.now();
    await exercisePhotoProcessingJobs(imageIDs);
    const reviewPath = path.join(artifacts, "native-photo-reviewed.json");
    await run(
      nativeBuildBinary,
      [
        "run-review",
        "--base-url",
        url.origin,
        runID,
        "--save-review",
        reviewPath,
      ],
      repoRoot,
      path.join(artifacts, "native-photo-review-output.json"),
    );
    // Commit exactly the proposals saved by the shared native review session.
    await run(
      nativeBuildBinary,
      [
        "run-review",
        "--base-url",
        url.origin,
        runID,
        "--review-file",
        reviewPath,
        "--approve-group",
        "synthetic-shirt",
        "--approve-group",
        "synthetic-boots",
      ],
      repoRoot,
      path.join(artifacts, "native-photo-approved.json"),
    );
    const reviewedAt = performance.now();
    const pool = new Pool({ connectionString: databaseURL });
    try {
      const result = await pool.query<{ status: string; completed: string }>(
        `SELECT r.status, count(*) FILTER (WHERE t.state = 'completed')::text AS completed
         FROM "Run" r
         JOIN "RunTarget" t ON t."runId" = r.id
         WHERE r.shortcode = $1
         GROUP BY r.id`,
        [runID],
      );
      if (
        result.rows[0]?.status !== "completed" ||
        result.rows[0]?.completed !== String(imagePaths.length)
      )
        throw new Error(
          `Photo approval left run unsettled: ${JSON.stringify(result.rows)}`,
        );
      const products = await pool.query<{ name: string }>(
        `SELECT name FROM "Product"
         WHERE name IN ('Synthetic Gray Crew Shirt', 'Synthetic Brown Boots')
           AND "deletedAt" IS NULL`,
      );
      if (products.rows.length !== 2)
        throw new Error("Photo approval did not create both Products");
      const attachments = await pool.query<{
        id: string;
        purpose: string | null;
      }>(
        `SELECT i.shortcode AS id, a.purpose
         FROM "EntityAttachment" a
         JOIN "Image" i ON i.id = a."imageId"
         WHERE i.shortcode = ANY($1::text[]) AND a."deletedAt" IS NULL`,
        [imageIDs],
      );
      const purposes = new Map(
        attachments.rows.map((row) => [row.id, row.purpose]),
      );
      if (
        purposes.size !== imageIDs.length ||
        imageIDs.some(
          (id, index) => purposes.get(id) !== ["item", "label", "item"][index],
        )
      )
        throw new Error("Photo approval lost item or label attachments");
    } finally {
      await pool.end();
    }
    console.log(
      `[${lane}] Photo stages: native upload ${(nativeReady - scenarioStarted).toFixed(0)}ms; backend proposal ${(proposedAt - nativeReady).toFixed(0)}ms; processing and CLI review ${(reviewedAt - proposedAt).toFixed(0)}ms; final checks ${(performance.now() - reviewedAt).toFixed(0)}ms`,
    );
    console.log(`[${lane}] Proposal submission and reviewer approval verified`);
  } finally {
    await context.dispose();
  }
}

async function runHeadlessProductScenario(
  url: URL,
  productId: string,
  userId: string,
): Promise<void> {
  const { SIM_PRODUCT_NAME, SIM_PRODUCT_UPDATED_NAME } =
    await import("./scenarios/simulator-product-fixture");
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
    const sourceFingerprint = nativeSourceFingerprint(false);
    if (sourceVersion === builtVersion) {
      await run(path.join(kitRoot, ".build/debug/cubby"), args);
    } else {
      await run("pnpm", ["apple", "cli", ...args]);
      builtVersion = sourceVersion;
    }
    nativeBuildBinary = path.join(kitRoot, ".build/debug/cubby");
    nativeBuildSourceVersion = sourceFingerprint;
    currentNativeSourceVersion = () => nativeSourceFingerprint(false);
    nativeBuildReady = true;
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
      activeChild?.kill("SIGTERM");
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
          nextID = await seedSimulatorScenario(nextPool, userId, originalName);
        } finally {
          await nextPool.end();
        }
        await runNative(nextID, originalName, updatedName);
        console.log(`[${lane}] Press Enter to rerun; Ctrl-C drops ${simName}`);
      }
    } finally {
      stopWatch = undefined;
      input.close();
    }
  }
}

async function runHeadlessStatementCsvScenario(url: URL, userId: string) {
  nativeBuildSourceVersion = nativeSourceFingerprint(false);
  currentNativeSourceVersion = () => nativeSourceFingerprint(false);
  // Build output stays in the runner log; each scenario invocation needs JSON-only stdout.
  await run("pnpm", ["apple", "cli", "version"]);
  nativeBuildBinary = path.join(kitRoot, ".build/debug/cubby");
  nativeBuildReady = true;
  const binary = nativeBuildBinary;
  const pool = new Pool({ connectionString: databaseURL });
  try {
    const { runSwiftStatementCsvScenario } =
      await import("./scenarios/swift-statement-csv");
    const evidence = await runSwiftStatementCsvScenario({
      pool,
      origin: url.origin,
      artifacts,
      userId,
      runNative: (args, outputPath, errorPath) =>
        run(binary, args, repoRoot, outputPath, false, process.env, errorPath),
    });
    scenarioEvidence.push(...evidence);
  } finally {
    await pool.end();
  }
}

function nativeBuildMetadata() {
  const web = readWebBuildProvenance(repoRoot);
  const fingerprint =
    nativeBuildReady && nativeBuildBinary && existsSync(nativeBuildBinary)
      ? createHash("sha256")
          .update(readFileSync(nativeBuildBinary))
          .digest("hex")
      : null;
  const nativeFresh =
    fingerprint !== null &&
    nativeBuildSourceVersion !== undefined &&
    currentNativeSourceVersion?.() === nativeBuildSourceVersion;
  const runtime = {
    mode: headless ? "headless-cli" : "ios-simulator",
    ...(xcodebuildVersion && { xcodebuildVersion }),
    ...(simulatorName && { simulatorName }),
    ...(simulatorRuntime && { simulatorRuntime }),
    ...(fingerprint && {
      [headless ? "cliBinarySha256" : "appBinarySha256"]: fingerprint,
    }),
  };
  return {
    build: {
      fingerprint,
      sourceFresh: nativeFresh && web.sourceFresh,
      matchesSource: nativeFresh && web.matchesSource,
      details: {
        webFingerprint: web.fingerprint ?? "unavailable",
        webSourceFresh: web.sourceFresh,
        webSourceFingerprint: web.details.sourceFingerprint ?? "unavailable",
      },
    },
    runtime,
  };
}

function retainRunDiagnostics(failure: Error | undefined): string[] {
  const evidenceFiles: string[] = [];
  if (failure) {
    const driverRoot = path.resolve(
      process.env.AGENT_DEVICE_STATE_DIR ??
        path.join(homedir(), ".agent-device"),
    );
    const log = path.join(artifacts, "runner.log");
    const diagnosticPaths = existsSync(log)
      ? [...readFileSync(log, "utf8").matchAll(/Diagnostics Log: ([^\r\n]+)/gu)]
      : [];
    for (const [index, match] of diagnosticPaths.entries()) {
      const diagnosticPath = match[1];
      if (!diagnosticPath) continue;
      const source = path.resolve(diagnosticPath.trim());
      const relative = path.relative(driverRoot, source);
      if (
        relative.startsWith("..") ||
        path.isAbsolute(relative) ||
        !existsSync(source) ||
        statSync(source).size > 2 * 1024 * 1024
      )
        continue;
      const diagnostic = path.join(artifacts, `driver-diagnostic-${index}.log`);
      writeFileSync(
        diagnostic,
        readFileSync(source, "utf8")
          .split("\n")
          .map(scrubErrorMessage)
          .join("\n"),
      );
      evidenceFiles.push(diagnostic);
    }
  }
  const sourceStatus = path.join(artifacts, "source-status.txt");
  writeFileSync(
    sourceStatus,
    execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot }),
  );
  evidenceFiles.push(sourceStatus);
  const wasmDiff = path.join(artifacts, "wasm-package-diff.patch");
  writeFileSync(
    wasmDiff,
    execFileSync("git", ["diff", "--", "packages/wasm/package.json"], {
      cwd: repoRoot,
    }),
  );
  evidenceFiles.push(wasmDiff);
  for (const name of [
    "failure.txt",
    "failure.png",
    "failure-ui-tree.ndjson",
    "diagnostic-error.txt",
    "fixture-app-settings.json",
    "input-statement.xml",
    "input-photo.xml",
    "input-statement.json",
    "input-statement-open.json",
    "input-statement-files.json",
    "input-photo.json",
    "input-photo-approval.json",
    "input-driver-close.json",
  ]) {
    const evidence = path.join(artifacts, name);
    if (!existsSync(evidence)) continue;
    if (name !== "failure.png")
      writeFileSync(
        evidence,
        readFileSync(evidence, "utf8")
          .split("\n")
          .map(scrubErrorMessage)
          .join("\n"),
      );
    evidenceFiles.push(evidence);
  }
  return evidenceFiles;
}

function finishE2ERun(failure: Error | undefined): Error | undefined {
  if (watch) return failure;
  try {
    const { build, runtime } = nativeBuildMetadata();
    const status = failure === undefined ? "passed" : "failed";
    const durationMs = Math.round(performance.now() - runStartedAt);
    const resultsPath = path.join(artifacts, "run-results.json");
    scenarioEvidence.push(...retainRunDiagnostics(failure));
    if (testerArmy) {
      const summary = path.join(
        testerArmyRawOutput(artifacts),
        "agent-summary.json",
      );
      if (existsSync(summary)) {
        const evidence = path.join(artifacts, "agent-summary.json");
        writeFileSync(
          evidence,
          `${JSON.stringify(readTesterArmySummary(path.dirname(summary)), null, 2)}\n`,
        );
        scenarioEvidence.push(evidence);
      }
    }
    writeFileSync(
      resultsPath,
      `${JSON.stringify({ schemaVersion: 1, status, scenario: lane, durationMs }, null, 2)}\n`,
    );
    const manifest = writeE2ERunBundle({
      repoRoot,
      outputDir: artifacts,
      evidence: [resultsPath, ...scenarioEvidence],
      kind: "native",
      status,
      command: ["pnpm", "test:e2e:sim", "--", ...flags],
      cases: [{ name: lane, status, durationMs }],
      profile: "worker",
      scenario: lane,
      fixture: productClarity
        ? "synthetic-product-evidence"
        : statementCsv
          ? "synthetic-statement-csv"
          : layout
            ? "synthetic-layout"
            : photo
              ? "synthetic-wardrobe"
              : "synthetic-product",
      fixtureVersion: 1,
      phase,
      phases,
      runtime: testerArmy
        ? {
            ...runtime,
            testerArmy: "0.16.0",
            model: process.env.TESTER_ARMY_MODEL ?? "openai/gpt-6-luna",
            effort: "medium",
          }
        : runtime,
      build,
    });
    console.log(`[${lane}] E2E artifact: ${manifest}`);
    if (failure)
      console.log(
        `[${lane}] Replay: pnpm test:e2e:sim -- ${flags.join(" ")}\n[${lane}] Evidence: ${manifest}`,
      );
    return failure;
  } catch (artifactError) {
    return new AggregateError(
      failure === undefined ? [artifactError] : [failure, artifactError],
      `${lane} could not save its E2E artifact`,
    );
  }
}

let qaIds: Record<string, string> = {};
let qaUserId = "";
let journeyIdsFile = "";

async function seedNativeScenario(userId: string): Promise<{
  productId: string;
  layoutRunID?: string;
  purchaseId?: string;
}> {
  const seedPool = new Pool({ connectionString: databaseURL });
  try {
    const {
      seedSimulatorPhotoActor,
      seedSimulatorScenario,
      seedSimulatorEmojiCategory,
      seedSimulatorLayoutRun,
      seedSimulatorProductClarity,
    } = await import("./scenarios/simulator");
    await seedSimulatorPhotoActor(seedPool, userId);
    if (qa) {
      const { seedNativeQa } = await import("./scenarios/native-qa");
      qaIds = await seedNativeQa(seedPool, userId);
      qaUserId = userId;
      return { productId: qaIds.PRODUCT_ID ?? "" };
    }
    if (testerArmy) {
      const { seedJourneyWorld } =
        await import("./scenarios/tester-army-journeys");
      journeyIdsFile = path.join(artifacts, "journey-ids.json");
      writeFileSync(
        journeyIdsFile,
        JSON.stringify(await seedJourneyWorld(seedPool, userId)),
      );
      return { productId: "" };
    }
    if (productClarity)
      return await seedSimulatorProductClarity(seedPool, userId);
    if (emojiReview)
      return { productId: await seedSimulatorEmojiCategory(seedPool, userId) };
    return {
      productId:
        photo || statementCsv || inputJourney
          ? ""
          : await seedSimulatorScenario(seedPool, userId),
      layoutRunID: layout
        ? await seedSimulatorLayoutRun(seedPool, userId)
        : undefined,
    };
  } finally {
    await seedPool.end();
  }
}

/** Reads the database back after the QA journeys: each native write must have landed exactly once. */
async function assertQaOutcomes(): Promise<void> {
  const checkPool = new Pool({ connectionString: databaseURL });
  const rows = async <T extends object>(text: string, values: unknown[] = []) =>
    (await checkPool.query<T>(text, values)).rows;
  try {
    const stock = await rows<{ code: string; amount: number }>(
      `SELECT e.shortcode AS code, e."amountValue" AS amount
       FROM "InventoryEntry" e WHERE e.shortcode = ANY($1)`,
      [[qaIds.INVENTORY_ID, qaIds.SHELF_INVENTORY_ID]],
    );
    const amountOf = (code: string | undefined) =>
      stock.find((row) => row.code === code)?.amount;
    if (
      amountOf(qaIds.INVENTORY_ID) !== 6 ||
      amountOf(qaIds.SHELF_INVENTORY_ID) !== 2
    )
      throw new Error(
        `Discard with a shelf choice must take one unit from the chosen shelf only: ${JSON.stringify(stock)}`,
      );
    const discards = await rows(
      `SELECT 1 FROM "Expense" WHERE name = 'Discarded — Synthetic Flour Bag' AND "productQuantity" = -1`,
    );
    if (discards.length !== 1)
      throw new Error(`Expected one discard line, found ${discards.length}`);
    const allocations = await rows<{ amount: number }>(
      `SELECT a.amount FROM "FinancialTransactionAllocation" a
       JOIN "FinancialTransaction" t ON t.id = a."transactionId"
       WHERE t.shortcode = $1 AND a."deletedAt" IS NULL ORDER BY a.amount`,
      [qaIds.SPLIT_CHARGE_ID],
    );
    if (allocations.map((row) => row.amount).join() !== "42.5,48.5")
      throw new Error(
        `Statement match must allocate 42.5 and 48.5: ${JSON.stringify(allocations)}`,
      );
    const mappings = await rows<{ bValue: number }>(
      `SELECT "bValue" FROM "ProductUnitMapping" WHERE "aUnit" = 'cup' AND "deletedAt" IS NULL`,
    );
    if (mappings.length !== 1 || mappings[0]?.bValue !== 125)
      throw new Error(
        `Unit mapping edit must update the one cup row in place: ${JSON.stringify(mappings)}`,
      );
    const approvals = await rows<{ state: string }>(
      `SELECT a.state FROM "RunApproval" a JOIN "Run" r ON r.id = a."runId" WHERE r.shortcode = $1`,
      [qaIds.APPROVAL_RUN_ID],
    );
    if (approvals.map((row) => row.state).join() !== "granted")
      throw new Error(
        `Run approval must be granted: ${JSON.stringify(approvals)}`,
      );
    const groups = await rows<{ groupKey: string; state: string }>(
      `SELECT g."groupKey", g.state FROM "PhotoGroupProposal" g JOIN "Run" r ON r.id = g."runId"
       WHERE r.shortcode = $1 ORDER BY g."groupKey"`,
      [qaIds.PHOTO_RUN_ID],
    );
    const photoProducts = await rows<{ name: string }>(
      `SELECT p.name FROM "PhotoGroupProposal" g JOIN "Run" r ON r.id = g."runId"
       JOIN "Product" p ON p.id = g."productId" WHERE r.shortcode = $1`,
      [qaIds.PHOTO_RUN_ID],
    );
    if (
      groups.map((row) => `${row.groupKey}:${row.state}`).join() !==
        "synthetic-qa-a-unselected-mug:proposed,synthetic-qa-b-selected-shirt:committed" ||
      photoProducts.map((row) => row.name).join() !== qaIds.PHOTO_SELECTED_NAME
    )
      throw new Error(
        `Approving the selection must commit only the selected ready group: ${JSON.stringify({ groups, photoProducts })}`,
      );
    console.log(`[${lane}] Native QA writes verified in ${simName}`);
  } finally {
    await checkPool.end();
  }
}

/**
 * A journey that commits before its last checks (photo approval) may have written already when it
 * fails, so its retry gets a freshly seeded subject; the outcome check reads the latest one.
 */
async function reseedQaJourney(journey: string): Promise<void> {
  if (journey !== "qa-photo-selected-approval.ad") return;
  const { seedProposedPhotoRun } = await import("./scenarios/native-qa");
  const seedPool = new Pool({ connectionString: databaseURL });
  try {
    Object.assign(qaIds, await seedProposedPhotoRun(seedPool, qaUserId));
  } finally {
    await seedPool.end();
  }
}

/**
 * Replays every `apps/apple/e2e/qa-*.ad` journey against the seeded QA world. Each attempt starts
 * from a relaunched app: a journey's `open` only foregrounds it, so a sheet a previous journey or
 * failed attempt left open (an Edit Product editor) hid the next journey's first screen.
 */
async function runQaJourneys(
  common: string[],
  relaunch: () => Promise<void>,
): Promise<void> {
  writeFileSync(
    path.join(artifacts, "qa-ids.json"),
    `${JSON.stringify({ database: simName, ids: qaIds }, null, 2)}\n`,
  );
  if (qaHold) {
    const stop = path.join(artifacts, "qa.stop");
    console.log(
      `[${lane}] HOLD ${databaseURL} ids=${path.join(artifacts, "qa-ids.json")}; touch ${stop} to finish`,
    );
    const stopped = () => existsSync(stop) || interrupted !== undefined;
    while (!stopped())
      await new Promise((resolve) => setTimeout(resolve, 2000));
    return;
  }
  const journeys = readdirSync(path.join(appleRoot, "e2e"))
    .filter((file) => /^qa-.*\.(ad|yaml)$/u.test(file))
    .sort();
  const stopRecording = video
    ? await recordSimulatorVideo(common[3] ?? "")
    : undefined;
  const flaky: string[] = [];
  try {
    for (const journey of journeys) {
      // A scroll can land short while a detail page is still laying out; a journey only
      // writes after its last scroll, so one retry from a relaunched app is a clean replay.
      for (let attempt = 1; ; attempt += 1) {
        await relaunch();
        try {
          await run(
            "pnpm",
            [
              "exec",
              "agent-device",
              "test",
              `apps/apple/e2e/${journey}`,
              ...common,
              "--retries",
              "0",
              "--artifacts-dir",
              artifacts,
              "--reporter",
              "default",
              "--reporter",
              // Per attempt, so a retried pass keeps the failed attempt's report beside it.
              `junit:${path.join(artifacts, `junit-${journey}-attempt-${attempt}.xml`)}`,
              ...Object.entries(qaIds).flatMap(([key, value]) => [
                "-e",
                `${key}=${value}`,
              ]),
            ],
            repoRoot,
          );
          break;
        } catch (error) {
          flaky.push(journey);
          if (attempt >= 2 || interrupted) throw error;
          console.log(
            `[${lane}] ${journey} attempt ${attempt} failed; retrying`,
          );
          await reseedQaJourney(journey);
        }
      }
    }
  } finally {
    await stopRecording?.();
    if (flaky.length > 0)
      console.log(
        `[${lane}] Failed an attempt: ${[...new Set(flaky)].join(", ")}`,
      );
  }
  await assertQaOutcomes();
}

async function runNativeJourney(
  deviceID: string,
  common: string[],
  productId: string,
  layoutRunID?: string,
  purchaseId?: string,
): Promise<void> {
  if (testerArmy) {
    const output = testerArmyRawOutput(artifacts);
    await run(
      "pnpm",
      ["--dir", webRoot, "exec", "e2e", "run", "--output", output],
      repoRoot,
      undefined,
      false,
      {
        ...process.env,
        E2E_TELEMETRY_DISABLED: "1",
        TESTER_ARMY_TARGET: "ios",
        TESTER_ARMY_ORIGIN: process.env.TESTER_ARMY_ORIGIN,
        TESTER_ARMY_IDS_FILE: journeyIdsFile,
        TESTER_ARMY_DEVICE_ID: deviceID,
        TESTER_ARMY_SESSION: `tester-army-${simName}`,
        ...(testerArmyReplay && { TESTER_ARMY_REPLAY: "1" }),
        ...(wrongName && { TESTER_ARMY_WRONG: "1" }),
      },
    );
    const summary = readTesterArmySummary(output);
    if (summary.status !== "passed")
      throw new Error("Tester Army iOS journey did not pass");
    return;
  }
  // CLI replay owns a separate daemon. Release the prepare daemon so it
  // cannot retain the runner lease; this hosted daemon belongs to this job.
  if (process.env.GITHUB_ACTIONS === "true")
    await run("pnpm", ["exec", "agent-device", "daemon", "stop"]);
  const stopRecording = video
    ? await recordSimulatorVideo(deviceID)
    : undefined;
  try {
    await run(
      "pnpm",
      [
        "exec",
        "agent-device",
        "test",
        emojiReview
          ? "apps/apple/e2e/emoji-review.ad"
          : productClarity
            ? "apps/apple/e2e/product-clarity.yaml"
            : layout
              ? "apps/apple/e2e/native-layout.ad"
              : "apps/apple/e2e/product-edit.ad",
        ...common,
        ...(productClarity ? ["--maestro"] : []),
        "--artifacts-dir",
        artifacts,
        "--reporter",
        "default",
        "--reporter",
        path.join(webRoot, "tooling/native-replay-progress-reporter.ts"),
        "--reporter",
        `junit:${path.join(artifacts, "junit.xml")}`,
        "-e",
        `PRODUCT_ID=${productId}`,
        ...(layoutRunID ? ["-e", `RUN_ID=${layoutRunID}`] : []),
        ...(purchaseId ? ["-e", `PURCHASE_ID=${purchaseId}`] : []),
      ],
      repoRoot,
      undefined,
      false,
      {
        ...process.env,
        ...(process.env.GITHUB_ACTIONS === "true" && {
          CUBBY_NATIVE_DIAGNOSTICS_DIR: artifacts,
        }),
      },
    );
  } finally {
    await stopRecording?.();
  }
  if (!layout && !productClarity)
    await assertNativeEdit(productId, undefined, null);
}

// eslint-disable-next-line complexity -- All disposable native lanes share one exception, artifact and cleanup boundary.
async function main(): Promise<void> {
  assertSimulatorAdminUrl(adminURL);
  const admin = new Pool({ connectionString: adminURL });
  let created = false;
  let harness:
    | Awaited<
        ReturnType<
          (typeof import("./local-workerd-harness"))["createLocalWorkerdHarness"]
        >
      >
    | undefined;
  let objectStorage:
    | Awaited<
        ReturnType<
          (typeof import("./local-object-storage"))["createE2EObjectStorage"]
        >
      >
    | undefined;
  let suggestionPeer:
    | Awaited<
        ReturnType<
          (typeof import("./native-emoji-review-peer"))["createNativeEmojiReviewPeer"]
        >
      >
    | undefined;
  let restoreEnvironment = () => {};
  let productId = "";
  let disposableSimulatorID: string | undefined;
  let inputDriverSessionArgs: string[] | undefined;
  let failure: Error | undefined;
  const closeInputDriver = async (): Promise<Error[]> => {
    if (!inputDriverSessionArgs) return [];
    const report = path.join(artifacts, "input-driver-close.json");
    try {
      await run(
        "pnpm",
        ["exec", "agent-device", "close", ...inputDriverSessionArgs, "--json"],
        repoRoot,
        report,
        true,
      );
      return [];
    } catch (error) {
      // A failed one-shot replay can already have closed its owned session.
      let alreadyClosed = false;
      try {
        alreadyClosed = z
          .object({
            success: z.literal(false),
            error: z.object({ code: z.literal("SESSION_NOT_FOUND") }),
          })
          .safeParse(JSON.parse(readFileSync(report, "utf8"))).success;
      } catch {
        // Missing or malformed output preserves the original cleanup failure.
      }
      return alreadyClosed
        ? []
        : [error instanceof Error ? error : new Error(String(error))];
    }
  };
  const cleanup = async (): Promise<Error[]> => {
    const errors = await closeInputDriver();
    try {
      await suggestionPeer?.close();
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
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
    if (disposableSimulatorID) {
      await run(
        "xcrun",
        ["simctl", "shutdown", disposableSimulatorID],
        repoRoot,
        undefined,
        true,
      ).catch(() => {});
      try {
        await run(
          "xcrun",
          ["simctl", "delete", disposableSimulatorID],
          repoRoot,
          undefined,
          true,
        );
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
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
    if (testerArmy) {
      phase = "model-preflight";
      const { preflightTesterArmyModel } = await import("./tester-army/model");
      process.env.E2E_TELEMETRY_DISABLED = "1";
      await preflightTesterArmyModel();
    }
    phase = "web-build";
    const buildStarted = performance.now();
    const buildAction = await ensureWebBuild(
      repoRoot,
      async (skipCache) => {
        const previous = process.env.NX_SKIP_NX_CACHE;
        process.env.NX_DAEMON = "false";
        if (skipCache) process.env.NX_SKIP_NX_CACHE = "true";
        try {
          await run("pnpm", [
            "exec",
            "nx",
            "run",
            "@cubby/web:build-cf",
            "--outputStyle=stream",
          ]);
        } finally {
          if (previous === undefined) delete process.env.NX_SKIP_NX_CACHE;
          else process.env.NX_SKIP_NX_CACHE = previous;
        }
      },
      process.env.CUBBY_E2E_PREBUILT_WEB === "1",
    );
    phases.push({
      name: "web-build",
      durationMs: Math.round(performance.now() - buildStarted),
    });
    console.log(`[${lane}] Web build ${buildAction}`);
    phase = "database";
    const databaseStarted = performance.now();
    if (process.env.CUBBY_SIM_DB_EXTERNAL !== "1")
      await run(
        "node",
        ["scripts/dev-db.ts", "up"],
        repoRoot,
        undefined,
        false,
        bootstrapEnvironment,
      );
    await admin.query(`CREATE DATABASE "${simName}"`);
    created = true;
    console.log(`[${lane}] Disposable database ${simName}`);
    if (watch) startDatabaseWatchdog();
    const pool = new Pool({ connectionString: databaseURL });
    try {
      const { migrateDatabase } = await import("./db-migrate");
      await migrateDatabase(drizzle(pool));
    } finally {
      await pool.end();
    }

    phase = "worker-startup";
    phases.push({
      name: "database",
      durationMs: Math.round(performance.now() - databaseStarted),
    });
    const workerStarted = performance.now();
    const { writeLocalWorkerdConfig } = await import("./e2e-worker-config");
    writeLocalWorkerdConfig(webRoot);
    const runtime = await import("./local-workerd-harness");
    const { createE2EObjectStorage } = await import("./local-object-storage");
    restoreEnvironment = runtime.installDatabaseEnvironment(databaseURL);
    objectStorage = await createE2EObjectStorage();
    harness = runtime.createLocalWorkerdHarness(databaseURL, objectStorage.url);
    const { url } = await harness.listen();
    if (testerArmy) process.env.TESTER_ARMY_ORIGIN = url.origin;
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
    const seeded = await seedNativeScenario(userId);
    productId = seeded.productId;
    if (emojiReview) {
      const { createNativeEmojiReviewPeer } =
        await import("./native-emoji-review-peer");
      suggestionPeer = await createNativeEmojiReviewPeer(url, productId);
    }
    const nativeOrigin = suggestionPeer?.url.origin ?? url.origin;
    const layoutRunID = seeded.layoutRunID;
    console.log(
      `[${lane}] Workerd at ${url.origin}${productId ? `; seeded product ${productId}` : ""}`,
    );

    phase = "native-scenario";
    phases.push({
      name: "worker-startup",
      durationMs: Math.round(performance.now() - workerStarted),
    });
    const scenarioStarted = performance.now();
    if (headless) {
      if (statementCsv) {
        await runHeadlessStatementCsvScenario(url, userId);
      } else if (photo) {
        await runHeadlessPhotoScenario(url, objectStorage.url, userId);
        if (purchase) {
          const { runWardrobeConvergenceScenario } =
            await import("./scenarios/wardrobe-convergence");
          const convergenceStarted = performance.now();
          await runWardrobeConvergenceScenario({
            databaseURL,
            origin: url.origin,
            artifacts,
            userId,
          });
          console.log(
            `[${lane}] Purchase and Product convergence ${(performance.now() - convergenceStarted).toFixed(0)}ms`,
          );
        }
      } else await runHeadlessProductScenario(url, productId, userId);
    } else {
      let device = await simulator();
      if (inputJourney) {
        const creation = path.join(artifacts, "disposable-simulator.txt");
        const name = `Synthetic Input ${simName}`;
        await run(
          "xcrun",
          [
            "simctl",
            "create",
            name,
            device.deviceTypeIdentifier,
            device.runtime,
          ],
          repoRoot,
          creation,
        );
        disposableSimulatorID = z
          .uuid()
          .parse(readFileSync(creation, "utf8").trim());
        device = {
          ...device,
          udid: disposableSimulatorID,
          name,
          state: "Shutdown",
        };
      }
      const nativeToolchain = execFileSync("xcodebuild", ["-version"], {
        cwd: repoRoot,
        encoding: "utf8",
      }).trim();
      xcodebuildVersion = nativeToolchain.replaceAll("\n", "; ");
      simulatorName = device.name;
      simulatorRuntime = device.runtime;
      const appPath = path.join(
        repoRoot,
        "apps/apple/DerivedData/Build/Products/Debug-iphonesimulator/Cubby.app",
      );
      const common = [
        "--platform",
        "ios",
        "--udid",
        device.udid,
        ...(process.env.GITHUB_ACTIONS === "true" ? ["--debug"] : []),
      ];
      const session = `cubby-sim-${simName}`;
      let simulatorReady = false;
      let driverPrepared = false;
      const install = async () => {
        const buildStarted = performance.now();
        await run("pnpm", ["apple", "gen"]);
        const hosted = process.env.GITHUB_ACTIONS === "true";
        if (hosted)
          await run("node", ["scripts/stamp-source-mtimes.ts", "apps/apple"]);
        nativeBuildSourceVersion = nativeSourceFingerprint(true);
        currentNativeSourceVersion = () => nativeSourceFingerprint(true);
        const buildArgs = hosted
          ? hostedSimulatorBuildArgs
          : [
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
              "-skipPackagePluginValidation",
              "-skipMacroValidation",
              "CODE_SIGNING_ALLOWED=NO",
              "COMPILER_INDEX_STORE_ENABLE=NO",
            ];
        let certifiedInput: string | undefined;
        // A certificate already binds the resolved package state to this app.
        // Resolve again only when current inputs or bundle bytes do not match.
        let reuseCertifiedApp =
          hosted &&
          hasMatchingSimulatorBuild(repoRoot, nativeToolchain, buildArgs);
        if (hosted && !reuseCertifiedApp) {
          await run("xcodebuild", [
            ...buildArgs,
            "-resolvePackageDependencies",
          ]);
          try {
            certifiedInput = simulatorBuildFingerprint(
              repoRoot,
              nativeToolchain,
              buildArgs,
            );
          } catch (error) {
            console.warn(
              `[${lane}] Simulator cache unavailable: ${String(error)}`,
            );
          }
          reuseCertifiedApp = hasMatchingSimulatorBuild(
            repoRoot,
            nativeToolchain,
            buildArgs,
          );
        }
        if (reuseCertifiedApp) {
          console.log(`[${lane}] Reusing the verified simulator app bundle`);
        } else {
          await run("xcodebuild", [...buildArgs, "build"]);
          if (certifiedInput)
            stampSimulatorBuild(
              repoRoot,
              nativeToolchain,
              certifiedInput,
              buildArgs,
            );
        }
        nativeBuildBinary = path.join(appPath, "Cubby");
        nativeBuildReady = true;
        phases.push({
          name: "native-build",
          durationMs: Math.round(performance.now() - buildStarted),
        });
        // Simulator startup competes with Swift compilation on hosted runners.
        if (!simulatorReady) {
          const bootStarted = performance.now();
          if (device.state !== "Booted")
            await run("xcrun", ["simctl", "boot", device.udid]);
          await run("xcrun", ["simctl", "bootstatus", device.udid, "-b"]);
          simulatorReady = true;
          phases.push({
            name: "simulator-boot",
            durationMs: Math.round(performance.now() - bootStarted),
          });
        }
        const installStarted = performance.now();
        const plist = path.join(appPath, "Info.plist");
        const originalPlist = inputJourney ? readFileSync(plist) : undefined;
        try {
          if (inputJourney) {
            await run("python3", [
              "-c",
              "import plistlib,sys; p=sys.argv[1]; d=plistlib.load(open(p,'rb')); d.update(UIFileSharingEnabled=True,LSSupportsOpeningDocumentsInPlace=True); plistlib.dump(d,open(p,'wb'))",
              plist,
            ]);
            writeFileSync(
              path.join(artifacts, "fixture-app-settings.json"),
              JSON.stringify(
                {
                  UIFileSharingEnabled: true,
                  LSSupportsOpeningDocumentsInPlace: true,
                  scope: "installed disposable simulator fixture only",
                },
                null,
                2,
              ),
            );
          }
          // App replacement does not need XCTest or an agent-device daemon.
          await run("xcrun", [
            "simctl",
            "uninstall",
            device.udid,
            "com.nickysemenza.cubby",
          ]);
          await run("xcrun", ["simctl", "install", device.udid, appPath]);
        } finally {
          if (originalPlist) writeFileSync(plist, originalPlist);
        }
        phases.push({
          name: "native-install",
          durationMs: Math.round(performance.now() - installStarted),
        });
      };
      const launch = async () => {
        const launchStarted = performance.now();
        try {
          await run("xcrun", [
            "simctl",
            "launch",
            "--terminate-running-process",
            device.udid,
            "com.nickysemenza.cubby",
            "--cubby-e2e-server",
            nativeOrigin,
          ]);
        } finally {
          phases.push({
            name: "native-launch",
            durationMs: Math.round(performance.now() - launchStarted),
          });
        }
      };
      try {
        await install();
        const driverStarted = performance.now();
        if (inputJourney)
          inputDriverSessionArgs = [
            ...common,
            "--session",
            session,
            "--state-dir",
            path.join(artifacts, "agent-device-state"),
          ];
        try {
          await run("pnpm", [
            "exec",
            "agent-device",
            "prepare",
            "ios-runner",
            "--debug",
            ...(inputDriverSessionArgs ?? common),
            "--timeout",
            "240000",
          ]);
        } finally {
          phases.push({
            name: "native-driver-prepare",
            durationMs: Math.round(performance.now() - driverStarted),
          });
        }
        driverPrepared = true;
        let journey:
          | Awaited<
              ReturnType<
                (typeof import("./scenarios/simulator-input-journey"))["createSimulatorInputJourney"]
              >
            >
          | undefined;
        let journeyPool: Pool | undefined;
        if (inputJourney) {
          journeyPool = new Pool({ connectionString: databaseURL });
          const { createSimulatorInputJourney } =
            await import("./scenarios/simulator-input-journey");
          try {
            journey = await createSimulatorInputJourney({
              pool: journeyPool,
              userId,
              repoRoot,
              artifacts,
              deviceID: device.udid,
              session,
              common: inputDriverSessionArgs ?? common,
              run: (command, args, stdoutFile) =>
                run(command, args, repoRoot, stdoutFile),
            });
            const container = execFileSync(
              "xcrun",
              [
                "simctl",
                "get_app_container",
                device.udid,
                "com.nickysemenza.cubby",
                "data",
              ],
              { encoding: "utf8" },
            ).trim();
            await journey.installInputs(path.join(container, "Documents"));
            scenarioEvidence.push(
              ...journey.inputs,
              path.join(artifacts, "fixture-app-settings.json"),
            );
          } catch (error) {
            await journeyPool.end();
            throw error;
          }
        }
        await launch();
        if (journey && journeyPool) {
          try {
            scenarioEvidence.push(await journey.execute());
          } finally {
            await journeyPool.end();
          }
        } else if (watch) {
          await runWarmSimulator({
            deviceID: device.udid,
            common,
            session,
            productId,
            userId,
            install,
            launch,
          });
        } else if (qa) {
          await runQaJourneys(common, launch);
        } else {
          await runNativeJourney(
            device.udid,
            common,
            productId,
            layoutRunID,
            seeded.purchaseId,
          );
        }
      } catch (error) {
        await run("xcrun", [
          "simctl",
          "io",
          device.udid,
          "screenshot",
          path.join(artifacts, "failure.png"),
        ]).catch(console.error);
        // Snapshot would retry the failed XCTest startup and hide its original cost.
        if (!driverPrepared) throw error;
        const diagnosticSession = `cubby-sim-diagnostic-${simName}`;
        const diagnosticArgs = inputDriverSessionArgs ?? [
          ...common,
          "--session",
          diagnosticSession,
        ];
        try {
          await run("pnpm", [
            "exec",
            "agent-device",
            "open",
            "com.nickysemenza.cubby",
            ...diagnosticArgs,
          ]);
          await run(
            "pnpm",
            [
              "exec",
              "agent-device",
              "snapshot",
              "--raw",
              "--json",
              ...diagnosticArgs,
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
            ...diagnosticArgs,
          ]).catch(console.error);
        }
        throw error;
      }
    }
    phases.push({
      name: "native-scenario",
      durationMs: Math.round(performance.now() - scenarioStarted),
    });
    phase = "completed";
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
    writeFileSync(path.join(artifacts, "failure.txt"), String(error));
    console.error(`[${lane}] Failure artifacts: ${artifacts}`);
  } finally {
    const cleanupErrors = await cleanup();
    if (cleanupErrors.length > 0) {
      phase = "cleanup";
      failure = new AggregateError(
        failure === undefined ? cleanupErrors : [failure, ...cleanupErrors],
        `${lane} failed with cleanup errors for ${simName}`,
      );
    }
  }
  if (process.env.GITHUB_ACTIONS === "true") {
    try {
      const diagnostics = await collectNativeDriverDiagnostics(
        path.join(homedir(), ".agent-device"),
        new Date(performance.timeOrigin + runStartedAt).toISOString(),
      );
      let navigation:
        | ReturnType<typeof projectNativeNavigationSnapshot>
        | undefined;
      const snapshot = path.join(artifacts, "failure-ui-tree.ndjson");
      if (existsSync(snapshot)) {
        try {
          navigation = projectNativeNavigationSnapshot(
            statSync(snapshot).size <= 2_000_000
              ? JSON.parse(readFileSync(snapshot, "utf8"))
              : undefined,
          );
        } catch {
          navigation = projectNativeNavigationSnapshot(undefined);
        }
      }
      const output = path.join(artifacts, "native-driver-diagnostics.json");
      writeFileSync(
        output,
        `${JSON.stringify({ ...diagnostics, ...(navigation && { navigation }) }, null, 2)}\n`,
      );
      scenarioEvidence.push(output);
    } catch {
      console.warn(`[${lane}] Native driver diagnostics unavailable`);
    }
    const textDiagnostics = path.join(
      artifacts,
      "native-text-entry-diagnostics.json",
    );
    if (existsSync(textDiagnostics)) scenarioEvidence.push(textDiagnostics);
    const replayDiagnostics = path.join(
      artifacts,
      "native-replay-driver-diagnostics.json",
    );
    if (existsSync(replayDiagnostics)) scenarioEvidence.push(replayDiagnostics);
  }
  failure = finishE2ERun(failure);
  if (failure !== undefined) throw failure;
}

await main();
