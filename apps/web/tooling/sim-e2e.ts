import { execFileSync, spawn } from "node:child_process";
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
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { chromium, expect, request } from "@playwright/test";
import { drizzle } from "drizzle-orm/node-postgres";
import dotenv from "dotenv";
import { Pool } from "pg";
import { z } from "zod";

import { writeE2ERunBundle } from "./e2e-run-bundle";
import { assertSimulatorAdminUrl } from "./sim-db-guard";

const webRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repoRoot = path.resolve(webRoot, "../..");
const kitRoot = path.join(repoRoot, "apps/apple/CubbyKit");
const appleRoot = path.join(repoRoot, "apps/apple");
const headless = process.argv.slice(2).includes("--headless");
const photo = process.argv.slice(2).includes("--photo");
const purchase = process.argv.slice(2).includes("--purchase");
const watch = process.argv.slice(2).includes("--watch");
const video = process.argv.slice(2).includes("--video");
if (
  (watch && video) ||
  (video && headless) ||
  (photo && (!headless || watch)) ||
  (purchase && !photo) ||
  process.argv
    .slice(2)
    .some(
      (argument) =>
        !["--headless", "--watch", "--video", "--photo", "--purchase"].includes(
          argument,
        ),
    )
)
  throw new Error(
    "Usage: sim-e2e.ts [--video | --watch | --headless [--watch | --photo [--purchase]]]",
  );
const lane = purchase
  ? "headless-wardrobe-e2e"
  : photo
    ? "headless-photo-e2e"
    : headless
      ? "headless-e2e"
      : watch
        ? "sim-dev"
        : "sim-e2e";
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
const runStartedAt = performance.now();
let nativeBuildBinary: string | undefined;
let nativeBuildSourceVersion: string | undefined;
let currentNativeSourceVersion: (() => string) | undefined;
let nativeBuildReady = false;
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

function appleSourceVersion(): string {
  const appRoot = path.join(appleRoot, "App");
  const files = readdirSync(appRoot, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".swift"))
    .map((entry) => path.join(appRoot, entry));
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
): Promise<void> {
  const checkPool = new Pool({ connectionString: databaseURL });
  try {
    const { SIM_PRODUCT_UPDATED_NAME } = await import("./scenarios/simulator");
    const targetName = expectedName ?? SIM_PRODUCT_UPDATED_NAME;
    const deadline = performance.now() + 15_000;
    let actualName: string | undefined;
    do {
      const result = await checkPool.query<{ name: string }>(
        'SELECT name FROM "Product" WHERE shortcode = $1',
        [productId],
      );
      actualName = result.rows[0]?.name;
      if (actualName === targetName) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    } while (performance.now() < deadline);
    if (actualName !== targetName) {
      throw new Error(
        `Native edit did not reach ${simName}: ${actualName ?? "missing"}`,
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
       FROM "ImportRunTarget" t
       JOIN "ImportRun" r ON r.id = t."runId"
       JOIN "Image" i ON i.id = t."imageId"
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
       JOIN "ImportRunTarget" t ON t."imageId" = i.id
       JOIN "ImportRun" r ON r.id = t."runId"
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
): Promise<void> {
  if (interrupted && !allowInterrupted)
    throw new Error(`${lane} interrupted by ${interrupted}`);
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
      if (code === 0 && (!interrupted || allowInterrupted)) resolve();
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
  runtime: string;
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
    .flatMap(([runtime, devices]) =>
      devices.map((device) => ({ ...device, runtime })),
    )
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
  const { SIM_PRODUCT_NAME, SIM_PRODUCT_UPDATED_NAME, seedSimulatorScenario } =
    await import("./scenarios/simulator");
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
      const [
        { callMcpTool },
        { McpServer },
        { registerPhotoImportTools },
        scenario,
        testing,
      ] = await Promise.all([
        import("~/server/mcp/mcp-test-utils"),
        import("@modelcontextprotocol/sdk/server/mcp.js"),
        import("~/server/mcp/tools/photo-import.tools"),
        import("./scenarios/context"),
        import("@cubby/schemas/testing"),
      ]);
      const db = scenario.buildScenarioDatabase(proposalPool);
      const kernel = scenario.buildKernelContext(
        db,
        testing.testUserId(userId),
      );
      const server = new McpServer({
        name: "photo-import-sim",
        version: "1.0",
      });
      registerPhotoImportTools(server);
      const proposed = await callMcpTool(
        server,
        "propose_photo_groups",
        { runId: runID, groups },
        {},
        { entityKernel: kernel },
      );
      if (proposed.isError)
        throw new Error(
          `MCP photo proposal failed: ${JSON.stringify(proposed.content)}`,
        );
      const beforeApproval = await proposalPool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM "Product"
         WHERE name IN ('Synthetic Gray Crew Shirt', 'Synthetic Brown Boots')
           AND "deletedAt" IS NULL`,
      );
      if (beforeApproval.rows[0]?.count !== "0")
        throw new Error("MCP proposals created Products before review");
    } finally {
      await proposalPool.end();
    }
    const proposedAt = performance.now();
    const browser = await chromium.launch();
    try {
      const state = await context.storageState();
      state.cookies = state.cookies.filter(
        (cookie) => !cookie.name.endsWith("session_data"),
      );
      const browserContext = await browser.newContext({
        storageState: state,
        viewport: { width: 1280, height: 900 },
        recordVideo: { dir: artifacts, size: { width: 1280, height: 900 } },
      });
      const page = await browserContext.newPage();
      try {
        await page.goto(`${url.origin}/runs/${runID}`);
        await expect(
          page.getByRole("heading", { name: "Proposed items" }),
        ).toBeVisible();
        for (const [name, expectedPhotos] of [
          ["Synthetic Gray Crew Shirt", 2],
          ["Synthetic Brown Boots", 1],
        ] as const) {
          const card = page.locator('[data-slot="card"]').filter({
            has: page.getByRole("heading", { name }),
          });
          await expect
            .poll(() =>
              card
                .locator("img")
                .evaluateAll(
                  (images) =>
                    images.filter(
                      (image) =>
                        image instanceof HTMLImageElement &&
                        image.complete &&
                        image.naturalWidth > 0,
                    ).length,
                ),
            )
            .toBe(expectedPhotos);
        }
        const approveAll = page.getByRole("button", {
          name: "Approve all (2)",
        });
        await expect(approveAll).toBeDisabled();
        await exercisePhotoProcessingJobs(imageIDs);
        await expect(approveAll).toBeEnabled({ timeout: 15_000 });
        await approveAll.click();
        await expect(
          page.getByText("Completed", { exact: true }).first(),
        ).toBeVisible();
      } finally {
        await browserContext.close();
        const videoPath = await page.video()?.path();
        if (videoPath) console.log(`[${lane}] Web review video: ${videoPath}`);
      }
    } finally {
      await browser.close();
    }
    const reviewedAt = performance.now();
    const pool = new Pool({ connectionString: databaseURL });
    try {
      const result = await pool.query<{ status: string; completed: string }>(
        `SELECT r.status, count(*) FILTER (WHERE t.state = 'completed')::text AS completed
         FROM "ImportRun" r
         JOIN "ImportRunTarget" t ON t."runId" = r.id
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
      `[${lane}] Photo stages: native upload ${(nativeReady - scenarioStarted).toFixed(0)}ms; MCP proposal ${(proposedAt - nativeReady).toFixed(0)}ms; processing and browser review ${(reviewedAt - proposedAt).toFixed(0)}ms; final checks ${(performance.now() - reviewedAt).toFixed(0)}ms`,
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

function nativeBuildMetadata() {
  const fingerprint =
    nativeBuildReady && nativeBuildBinary && existsSync(nativeBuildBinary)
      ? createHash("sha256")
          .update(readFileSync(nativeBuildBinary))
          .digest("hex")
      : null;
  const matchesSource =
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
  return { build: { fingerprint, matchesSource }, runtime };
}

function finishE2ERun(failure: Error | undefined): Error | undefined {
  if (watch) return failure;
  try {
    const { build, runtime } = nativeBuildMetadata();
    const status = failure === undefined ? "passed" : "failed";
    const durationMs = Math.round(performance.now() - runStartedAt);
    const resultsPath = path.join(artifacts, "run-results.json");
    writeFileSync(
      resultsPath,
      `${JSON.stringify({ schemaVersion: 1, status, scenario: lane, durationMs }, null, 2)}\n`,
    );
    const command = purchase
      ? "test:e2e:headless:wardrobe"
      : photo
        ? "test:e2e:headless:photo"
        : headless
          ? "test:e2e:headless"
          : video
            ? "test:e2e:sim:video"
            : "test:e2e:sim";
    const manifest = writeE2ERunBundle({
      repoRoot,
      outputDir: artifacts,
      evidence: [resultsPath],
      kind: "native",
      status,
      command: ["pnpm", command],
      cases: [{ name: lane, status, durationMs }],
      runtime,
      build,
    });
    console.log(`[${lane}] E2E artifact: ${manifest}`);
    return failure;
  } catch (artifactError) {
    return new AggregateError(
      failure === undefined ? [artifactError] : [failure, artifactError],
      `${lane} could not save its E2E artifact`,
    );
  }
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
    if (watch) startDatabaseWatchdog();
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
    const { writeLocalWorkerdConfig } = await import("./e2e-worker-config");
    writeLocalWorkerdConfig(webRoot);
    const runtime = await import("./local-workerd-harness");
    const { createE2EObjectStorage } = await import("./local-object-storage");
    restoreEnvironment = runtime.installDatabaseEnvironment(databaseURL);
    objectStorage = await createE2EObjectStorage();
    harness = runtime.createLocalWorkerdHarness(databaseURL, objectStorage.url);
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
      const { seedSimulatorPhotoActor, seedSimulatorScenario } =
        await import("./scenarios/simulator");
      await seedSimulatorPhotoActor(seedPool, userId);
      if (!photo) productId = await seedSimulatorScenario(seedPool, userId);
    } finally {
      await seedPool.end();
    }
    console.log(
      `[${lane}] Workerd at ${url.origin}${productId ? `; seeded product ${productId}` : ""}`,
    );

    if (headless) {
      if (photo) {
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
      const device = await simulator();
      xcodebuildVersion = execFileSync("xcodebuild", ["-version"], {
        cwd: repoRoot,
        encoding: "utf8",
      })
        .trim()
        .replaceAll("\n", "; ");
      simulatorName = device.name;
      simulatorRuntime = device.runtime;
      if (device.state !== "Booted")
        await run("xcrun", ["simctl", "boot", device.udid]);
      await run("xcrun", ["simctl", "bootstatus", device.udid, "-b"]);
      const appPath = path.join(
        repoRoot,
        "apps/apple/DerivedData/Build/Products/Debug-iphonesimulator/Cubby.app",
      );
      const common = ["--platform", "ios", "--udid", device.udid];
      const session = `cubby-sim-${simName}`;
      const install = async () => {
        await run("pnpm", ["apple", "gen"]);
        nativeBuildSourceVersion = nativeSourceFingerprint(true);
        currentNativeSourceVersion = () => nativeSourceFingerprint(true);
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
        nativeBuildBinary = path.join(appPath, "Cubby");
        nativeBuildReady = true;
        await run("pnpm", [
          "exec",
          "agent-device",
          "reinstall",
          "com.nickysemenza.cubby",
          appPath,
          ...common,
        ]);
      };
      const launch = async () => {
        await run("xcrun", [
          "simctl",
          "launch",
          "--terminate-running-process",
          device.udid,
          "com.nickysemenza.cubby",
          "--cubby-e2e-server",
          url.origin,
        ]);
      };
      try {
        await install();
        await run("pnpm", [
          "exec",
          "agent-device",
          "prepare",
          "ios-runner",
          ...common,
          "--timeout",
          "240000",
        ]);
        await launch();
        if (watch) {
          await runWarmSimulator({
            deviceID: device.udid,
            common,
            session,
            productId,
            userId,
            install,
            launch,
          });
        } else {
          const stopRecording = video
            ? await recordSimulatorVideo(device.udid)
            : undefined;
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
          } finally {
            await stopRecording?.();
          }
          await assertNativeEdit(productId);
        }
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
  failure = finishE2ERun(failure);
  if (failure !== undefined) throw failure;
}

await main();
