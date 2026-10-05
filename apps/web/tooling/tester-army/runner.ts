import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runOrThrow, spawnToExit } from "../../../../scripts/lib/run.ts";
import { captureE2ERunIdentity, writeE2ERunBundle } from "../e2e-run-bundle";
import { ensureWebBuild } from "../web-build-provenance";
import { modelConfiguration, preflightTesterArmyModel } from "./model";
import { readTesterArmySummary, testerArmyRawOutput } from "./report";

/**
 * The shared shape of a Tester Army web lane: preflight the driver model,
 * build what the journey runs, start test services, run the journey inside
 * them (`--services-ready`), and always leave a sanitized run bundle.
 */
export const webRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
export const repoRoot = path.resolve(webRoot, "../..");

/** Synthetic, local-only settings every in-process server module reads. */
const SERVICE_DEFAULTS = {
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
};

export function applyServiceDefaults() {
  for (const [key, value] of Object.entries(SERVICE_DEFAULTS))
    process.env[key] ??= value;
}

/** Forward Ctrl-C to the running child instead of orphaning it. */
export function childTracker() {
  let child: ChildProcess | undefined;
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => {
      if (child) child.kill(signal);
      else process.exitCode = signal === "SIGINT" ? 130 : 143;
    });
  return {
    onSpawn: (spawned: ChildProcess) => {
      child = spawned;
    },
    onClose: () => {
      child = undefined;
    },
  };
}

export function laneOutput(lane: string) {
  const output =
    process.env.TESTER_ARMY_OUTPUT ??
    path.join(repoRoot, "artifacts/tester-army", lane, randomUUID());
  mkdirSync(output, { recursive: true });
  return { output, rawOutput: testerArmyRawOutput(output) };
}

/** The journey's verdict, read from Tester Army's own summary. */
export function assertJourneyPassed(rawOutput: string, journey: string) {
  if (readTesterArmySummary(rawOutput).status !== "passed")
    throw new Error(`Tester Army ${journey} journey did not pass`);
}

export async function runTesterArmyLane(input: {
  /** Script relative to `apps/web`, re-run with `--services-ready`. */
  script: string;
  command: string[];
  caseName: string;
  fixture: string;
  output: string;
  rawOutput: string;
  tracker: ReturnType<typeof childTracker>;
  /** Extra build steps after the web Worker, such as the agent Worker. */
  build?: () => Promise<void>;
  /** Additional sanitized evidence files the services phase may write. */
  evidence?: string[];
  /** Lane-specific runtime facts for the run manifest, such as the agent model. */
  runtime?: Record<string, string>;
}) {
  const startedAt = performance.now();
  let phase = "model-preflight";
  let status = "failed";
  let started: ReturnType<typeof captureE2ERunIdentity> | undefined;
  try {
    await preflightTesterArmyModel();
    phase = "build";
    await ensureWebBuild(
      repoRoot,
      async () => {
        await runOrThrow("pnpm", ["--dir", webRoot, "run", "build:cf"], {
          ...input.tracker,
          cwd: repoRoot,
          stdio: "inherit",
        });
      },
      false,
    );
    await input.build?.();
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
        input.script,
        "--services-ready",
      ],
      {
        ...input.tracker,
        cwd: repoRoot,
        stdio: "inherit",
        env: {
          ...process.env,
          NODE_ENV: "test",
          TESTER_ARMY_OUTPUT: input.output,
        },
      },
    );
    if (exit !== 0) throw new Error(`Tester Army runner exited ${exit}`);
    assertJourneyPassed(input.rawOutput, input.caseName);
    status = "passed";
    phase = "completed";
  } finally {
    const evidence: string[] = [];
    if (existsSync(path.join(input.rawOutput, "agent-summary.json"))) {
      const summaryFile = path.join(input.output, "agent-summary.json");
      writeFileSync(
        summaryFile,
        `${JSON.stringify(readTesterArmySummary(input.rawOutput), null, 2)}\n`,
      );
      evidence.push(summaryFile);
    }
    for (const file of input.evidence ?? [])
      if (existsSync(file)) evidence.push(file);
    const results = path.join(input.output, "run-results.json");
    writeFileSync(
      results,
      `${JSON.stringify({ schemaVersion: 1, status, phase, durationMs: Math.round(performance.now() - startedAt) }, null, 2)}\n`,
    );
    writeE2ERunBundle({
      repoRoot,
      outputDir: input.output,
      evidence: [results, ...evidence],
      kind: "browser",
      status,
      command: input.command,
      started,
      phase,
      cases: [{ name: input.caseName, status }],
      fixture: input.fixture,
      fixtureVersion: 1,
      runtime: {
        testerArmy: "0.16.0",
        model: configuredModel(),
        effort: "medium",
        ...input.runtime,
      },
    });
    console.log(`[tester-army] Run bundle: ${input.output}`);
  }
}

function configuredModel() {
  try {
    return modelConfiguration().TESTER_ARMY_MODEL;
  } catch {
    return "unconfigured";
  }
}
