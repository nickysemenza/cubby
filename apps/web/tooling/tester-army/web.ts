import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { z } from "zod";
import { runOrThrow } from "../../../../scripts/lib/run.ts";
import type { WorkerdModelWorker } from "../purchase-agent-workerd-harness";
import { modelSwapSchema } from "../responses-model-swap";
import { applyJourneyFlags } from "./flags";
import { harnessOf, selectedJourneys, type Harness } from "./journey";
import { journeys } from "./journeys";
import { modelConfiguration } from "./model";
import { publicStorageOrigin } from "./public-storage";
import { mergeTesterArmySummaries } from "./report";
import {
  applyServiceDefaults,
  assertJourneyPassed,
  childTracker,
  laneOutput,
  runTesterArmyLane,
  webRoot,
} from "./runner";

/**
 * The shared journey catalog on the web engine. Standard journeys run on the
 * browser E2E runtime; coupled journeys run on the purchase-agent workerd
 * harness with live model peers. A run covering both starts each harness in
 * turn and merges their summaries.
 */
const flags = process.argv.slice(2).filter((argument) => argument !== "--");
applyJourneyFlags(flags, "test:e2e:agent:web", ["--services-ready"]);
process.env.E2E_TELEMETRY_DISABLED = "1";
const { output, rawOutput } = laneOutput("web");
const tracker = childTracker();
const selected = selectedJourneys(journeys, "web");
if (selected.length === 0) throw new Error("No Tester Army journey selected");
const harnesses = (["standard", "coupled"] as const).filter((harness) =>
  selected.some((journey) => harnessOf(journey) === harness),
);
const usageFile = path.join(output, "gateway-usage.json");
// The coupled harness swaps this coordinator model in for the agent's pinned one.
const agentModel = modelSwapSchema.parse({
  model: process.env.TESTER_ARMY_AGENT_MODEL || "gpt-6-luna",
  effort: process.env.TESTER_ARMY_AGENT_EFFORT || "high",
});

type Runtime = {
  origin: string;
  databaseUrl: string;
  storageState: { cookies: Array<{ name: string; value: string }> };
  seed: (
    pool: Pool,
    userId: string,
  ) => Promise<Record<string, Record<string, string>>>;
};

const phaseOutput = (harness: Harness) => path.join(rawOutput, harness);

/** Seeds one harness's journeys and runs them in a single Tester Army run. */
async function runJourneys(harness: Harness, runtime: Runtime) {
  const pool = new Pool({ connectionString: runtime.databaseUrl });
  const idsFile = path.join(output, `journey-ids-${harness}.json`);
  const state = path.join(output, `browser-state-${harness}.json`);
  try {
    const actor = await pool.query<{ id: string }>(
      'SELECT id FROM "user" WHERE email = $1',
      [process.env.E2E_TEST_USER_EMAIL],
    );
    const userId = z.string().min(1).parse(actor.rows[0]?.id);
    writeFileSync(idsFile, JSON.stringify(await runtime.seed(pool, userId)));
    writeFileSync(state, JSON.stringify(runtime.storageState), { mode: 0o600 });
    mkdirSync(phaseOutput(harness), { recursive: true });
    await runOrThrow(
      "pnpm",
      ["exec", "e2e", "run", "--output", phaseOutput(harness)],
      {
        ...tracker,
        cwd: webRoot,
        stdio: "inherit",
        env: {
          ...process.env,
          DATABASE_URL: runtime.databaseUrl,
          TESTER_ARMY_TARGET: "web",
          TESTER_ARMY_ORIGIN: runtime.origin,
          TESTER_ARMY_IDS_FILE: idsFile,
          TESTER_ARMY_WEB_STATE: state,
          TESTER_ARMY_JOURNEYS: selected
            .filter((journey) => harnessOf(journey) === harness)
            .map((journey) => journey.id)
            .join(","),
        },
      },
    );
  } finally {
    rmSync(state, { force: true });
    rmSync(idsFile, { force: true });
    await pool.end();
  }
}

async function runStandard() {
  const { writeLocalWorkerdConfig } = await import("../e2e-worker-config");
  const { prepareTemplate } = await import("../test-database-lease");
  const { createE2EWorkerRuntime } =
    await import("../../tests/e2e/e2e-worker-runtime");
  writeLocalWorkerdConfig(webRoot);
  await prepareTemplate("browser");
  const runtime = await createE2EWorkerRuntime({
    authenticated: true,
    parallelIndex: 0,
  });
  try {
    await runJourneys("standard", {
      origin: runtime.baseURL,
      databaseUrl: runtime.databaseUrl,
      storageState: runtime.storageState,
      seed: async (pool, userId) => {
        const { seedSimulatorPhotoActor } =
          await import("../scenarios/simulator");
        const { seedJourneyWorld } =
          await import("../scenarios/tester-army-journeys");
        await seedSimulatorPhotoActor(pool, userId);
        return seedJourneyWorld(pool, userId);
      },
    });
  } finally {
    await runtime.close();
  }
}

const routeUsage = z.record(
  z.string(),
  z.object({
    requests: z.number(),
    failed: z.number(),
    failedStatuses: z.array(z.number()),
    models: z.record(z.string(), z.number()),
  }),
);

/**
 * The live model peer for both harness seams; the agent's swaps in the
 * coordinator model under test (`live-gateway.ts`).
 */
function liveGatewayWorker(swap?: typeof agentModel): WorkerdModelWorker {
  const config = modelConfiguration();
  const vars: NonNullable<WorkerdModelWorker["vars"]> = {
    GATEWAY_BASE_URL: `https://gateway.ai.cloudflare.com/v1/${config.TESTER_ARMY_CF_ACCOUNT_ID}/${config.TESTER_ARMY_CF_GATEWAY_ID}`,
    RUN_REVISION: process.env.GITHUB_SHA ?? "local",
  };
  if (swap) {
    vars.RESPONSES_MODEL = swap.model;
    vars.RESPONSES_EFFORT = swap.effort;
  }
  return {
    main: "tooling/tester-army/live-gateway.ts",
    vars,
    secrets: { GATEWAY_TOKEN: config.TESTER_ARMY_CF_API_TOKEN },
  };
}

async function runCoupled() {
  const { prepareTemplate } = await import("../test-database-lease");
  const { createE2EDatabase } = await import("../../tests/e2e/e2e-database");
  const { authenticate } = await import("../../tests/e2e/e2e-worker-runtime");
  const { createWorkerdHarness } =
    await import("../purchase-agent-workerd-harness");
  const { createE2EObjectStorage } = await import("../local-object-storage");
  const { seedCoupledJourneys } =
    await import("../scenarios/tester-army-coupled");
  // Every acquired resource closes, newest first, even when a later
  // acquisition or an earlier close fails: a leaked workerd keeps the runner alive.
  const closers: Array<() => Promise<void>> = [];
  const failures: unknown[] = [];
  try {
    await prepareTemplate("browser");
    const database = await createE2EDatabase();
    closers.push(() => database.close());
    const storage = await createE2EObjectStorage();
    closers.push(() => storage.close());
    const publicStorage = await publicStorageOrigin(storage.url);
    closers.push(() => publicStorage.close());
    // The web Worker's Hyperdrive bindings resolve through these in workerd.
    for (const key of [
      "WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE",
      "WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_CACHED",
    ])
      process.env[key] = database.databaseUrl;
    const harness = await createWorkerdHarness(
      database.databaseUrl,
      liveGatewayWorker(agentModel),
      liveGatewayWorker(),
      {
        objectStorage: {
          endpoint: storage.url,
          publicUrl: publicStorage.origin,
        },
        backgroundQueue: true,
      },
    );
    closers.push(() => harness.close());
    const { url } = await harness.listen();
    const storageState = await authenticate(url.origin);
    const queue = harness.getWorker("cubby-queue-producer");
    try {
      await runJourneys("coupled", {
        origin: url.origin,
        databaseUrl: database.databaseUrl,
        storageState,
        seed: (pool, userId) =>
          seedCoupledJourneys(pool, userId, {
            origin: url.origin,
            cookies: storageState.cookies,
            connectBrowser: async (input) => {
              const response = await queue.fetch(
                "https://queue.test/browser-connect",
                {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify(input),
                },
              );
              if (!response.ok)
                throw new Error(
                  `Simulated browser connect ${response.status}: ${await response.text()}`,
                );
            },
          }),
      });
    } finally {
      // Request counts per Gateway route, for the run bundle; never content.
      const usageOf = async (worker: string) =>
        routeUsage.parse(
          await (
            await harness
              .getWorker(worker)
              .fetch("https://live-gateway.test/usage")
          ).json(),
        );
      writeFileSync(
        usageFile,
        `${JSON.stringify({ agent: await usageOf("cubby-test-model"), web: await usageOf("cubby-test-gateway") }, null, 2)}\n`,
      );
    }
  } catch (error) {
    failures.push(error);
  }
  for (const close of closers.reverse()) {
    try {
      await close();
    } catch (error) {
      failures.push(error);
    }
  }
  // The journey's own failure comes first; cleanup failures follow it.
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "Coupled run failed");
}

async function runWithServices() {
  applyServiceDefaults();
  const failures: unknown[] = [];
  // Each harness owns workerd and its database; never run two at once.
  for (const harness of harnesses) {
    try {
      await (harness === "standard" ? runStandard() : runCoupled());
    } catch (error) {
      failures.push(error);
    }
  }
  mergeTesterArmySummaries(harnesses.map(phaseOutput), rawOutput);
  if (failures.length) throw new AggregateError(failures, "Journeys failed");
  assertJourneyPassed(rawOutput, "web journeys");
}

if (flags.includes("--services-ready")) await runWithServices();
else
  await runTesterArmyLane({
    script: "tooling/tester-army/web.ts",
    command: ["pnpm", "test:e2e:agent:web", ...flags],
    caseName: "web journeys",
    fixture: "synthetic-journeys",
    output,
    rawOutput,
    tracker,
    evidence: [usageFile],
    runtime: harnesses.includes("coupled")
      ? { agentModel: agentModel.model, agentEffort: agentModel.effort }
      : undefined,
  });
