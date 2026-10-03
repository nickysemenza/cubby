import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { z } from "zod";
import { runOrThrow, spawnToExit } from "../../../../scripts/lib/run.ts";
import { captureE2ERunIdentity, writeE2ERunBundle } from "../e2e-run-bundle";
import { ensureWebBuild } from "../web-build-provenance";
import { modelConfiguration, preflightTesterArmyModel } from "./model";
import { readTesterArmySummary, testerArmyRawOutput } from "./report";

const webRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const repoRoot = path.resolve(webRoot, "../..");
const flags = process.argv.slice(2).filter((argument) => argument !== "--");
if (
  flags.some(
    (flag) => !["--services-ready", "--replay", "--wrong-name"].includes(flag),
  )
)
  throw new Error("Usage: test:e2e:agent:web [--replay] [--wrong-name]");
process.env.E2E_TELEMETRY_DISABLED = "1";
if (flags.includes("--replay")) process.env.TESTER_ARMY_REPLAY = "1";
if (flags.includes("--wrong-name"))
  process.env.TESTER_ARMY_EXPECTED_NAME =
    "Synthetic deliberately incorrect name";
const output =
  process.env.TESTER_ARMY_OUTPUT ??
  path.join(repoRoot, "artifacts/tester-army/web", randomUUID());
mkdirSync(output, { recursive: true });
const rawOutput = testerArmyRawOutput(output);

let child: ChildProcess | undefined;
const trackChild = {
  onSpawn: (spawned: ChildProcess) => {
    child = spawned;
  },
  onClose: () => {
    child = undefined;
  },
};
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    if (child) child.kill(signal);
    else process.exitCode = signal === "SIGINT" ? 130 : 143;
  });

async function runWithServices() {
  for (const [key, value] of Object.entries({
    E2E_TEST_USER_EMAIL: "tester-army@example.test",
    E2E_TEST_USER_PASSWORD: "tester-army-local-only",
    DATABASE_URL: "postgresql://postgres:password@localhost:5432/cubby",
    R2_ACCESS_KEY_ID: "e2e",
    R2_SECRET_ACCESS_KEY: "e2e",
    R2_ENDPOINT: "http://localhost:9000",
    R2_BUCKET_NAME: "e2e",
    R2_PUBLIC_URL: "http://localhost:9000",
    UPC_UPSTREAM_DISABLED: "true",
    BETTER_AUTH_SECRET: "e2e-test-secret",
  }))
    process.env[key] ??= value;
  const { writeLocalWorkerdConfig } = await import("../e2e-worker-config");
  const { prepareE2EDatabaseTemplate } =
    await import("../../tests/e2e/e2e-database");
  const { createE2EWorkerRuntime } =
    await import("../../tests/e2e/e2e-worker-runtime");
  writeLocalWorkerdConfig(webRoot);
  await prepareE2EDatabaseTemplate();
  const runtime = await createE2EWorkerRuntime({
    authenticated: true,
    parallelIndex: 0,
  });
  const pool = new Pool({ connectionString: runtime.databaseUrl });
  try {
    const actor = await pool.query<{ id: string }>(
      'SELECT id FROM "user" WHERE email = $1',
      [process.env.E2E_TEST_USER_EMAIL],
    );
    const userId = z.string().min(1).parse(actor.rows[0]?.id);
    const { seedSimulatorPhotoActor, seedSimulatorScenario } =
      await import("../scenarios/simulator");
    await seedSimulatorPhotoActor(pool, userId);
    const productId = await seedSimulatorScenario(pool, userId);
    const state = path.join(output, "browser-state.json");
    writeFileSync(state, JSON.stringify(runtime.storageState), { mode: 0o600 });
    await runOrThrow("pnpm", ["exec", "e2e", "run", "--output", rawOutput], {
      ...trackChild,
      cwd: webRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        DATABASE_URL: runtime.databaseUrl,
        TESTER_ARMY_TARGET: "web",
        TESTER_ARMY_ORIGIN: runtime.baseURL,
        TESTER_ARMY_PRODUCT_ID: productId,
        TESTER_ARMY_WEB_STATE: state,
      },
    });
    const summary = readTesterArmySummary(rawOutput);
    if (summary.status !== "passed")
      throw new Error("Tester Army web journey did not pass");
  } finally {
    rmSync(path.join(output, "browser-state.json"), { force: true });
    try {
      await pool.end();
    } finally {
      await runtime.close();
    }
  }
}

if (flags.includes("--services-ready")) {
  await runWithServices();
} else {
  const startedAt = performance.now();
  let phase = "model-preflight";
  let status = "failed";
  let started: ReturnType<typeof captureE2ERunIdentity> | undefined;
  try {
    await preflightTesterArmyModel();
    phase = "web-build";
    await ensureWebBuild(
      repoRoot,
      async () => {
        await runOrThrow("pnpm", ["--dir", webRoot, "run", "build:cf"], {
          ...trackChild,
          cwd: repoRoot,
          stdio: "inherit",
        });
      },
      false,
    );
    started = captureE2ERunIdentity(repoRoot);
    phase = "journey";
    const exit = await spawnToExit(
      "node",
      [
        "scripts/test-services.ts",
        "--",
        "pnpm",
        "--dir",
        webRoot,
        "exec",
        "tsx",
        "tooling/tester-army/web.ts",
        "--services-ready",
      ],
      {
        ...trackChild,
        cwd: repoRoot,
        stdio: "inherit",
        env: { ...process.env, NODE_ENV: "test", TESTER_ARMY_OUTPUT: output },
      },
    );
    if (exit !== 0) throw new Error(`Tester Army web runner exited ${exit}`);
    const summary = readTesterArmySummary(rawOutput);
    if (summary.status !== "passed")
      throw new Error("Tester Army web journey did not pass");
    status = "passed";
    phase = "completed";
  } finally {
    const summaryFile = path.join(output, "agent-summary.json");
    const evidence: string[] = [];
    if (existsSync(path.join(rawOutput, "agent-summary.json"))) {
      writeFileSync(
        summaryFile,
        `${JSON.stringify(readTesterArmySummary(rawOutput), null, 2)}\n`,
      );
      evidence.push(summaryFile);
    }
    const results = path.join(output, "run-results.json");
    writeFileSync(
      results,
      `${JSON.stringify({ schemaVersion: 1, status, phase, durationMs: Math.round(performance.now() - startedAt) }, null, 2)}\n`,
    );
    const config = modelConfigurationSafe();
    writeE2ERunBundle({
      repoRoot,
      outputDir: output,
      evidence: [results, ...evidence],
      kind: "browser",
      status,
      command: ["pnpm", "test:e2e:agent:web", ...flags],
      started,
      phase,
      cases: [{ name: "web product rename and reopen", status }],
      fixture: "synthetic-product",
      fixtureVersion: 1,
      runtime: { testerArmy: "0.16.0", model: config, effort: "medium" },
    });
    console.log(`[tester-army] Run bundle: ${output}`);
  }
}

function modelConfigurationSafe() {
  try {
    return modelConfiguration().TESTER_ARMY_MODEL;
  } catch {
    return "unconfigured";
  }
}
