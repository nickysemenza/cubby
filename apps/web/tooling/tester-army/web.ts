import { createPostgresPool } from "../postgres-pool";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { testAiGatewayEnvironment } from "@cubby/shared/ai/gateway-metadata";
import { type Pool } from "pg";
import { z } from "zod";
import { runOrThrow } from "../../../../scripts/lib/run.ts";
import type { WorkerdModelWorker } from "../workerd-harness";
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
 * browser E2E runtime's `offline` profile; coupled journeys on its `coupled`
 * profile with live model peers. A run covering both starts each runtime in
 * turn and merges their summaries.
 */
const flags = process.argv.slice(2).filter((argument) => argument !== "--");
applyJourneyFlags(flags, "test:e2e:agent:web", [
  "--services-ready",
  "--debug",
  "--update-snapshots",
  "--strict-cache",
]);
process.env.E2E_TELEMETRY_DISABLED = "1";
if (flags.includes("--debug")) process.env.TESTER_ARMY_DEBUG = "1";
const { output, rawOutput } = laneOutput("web");
const tracker = childTracker();
const mode = z
  .enum(["agent", "visual", "explore"])
  .parse(process.env.TESTER_ARMY_WEB_MODE ?? "agent");
const updateSnapshots =
  flags.includes("--update-snapshots") ||
  process.env.TESTER_ARMY_UPDATE_SNAPSHOTS === "1";
const strictCache =
  flags.includes("--strict-cache") ||
  process.env.TESTER_ARMY_STRICT_CACHE === "1";
if (strictCache && mode === "explore")
  throw new Error("Exploration does not use replay");
process.env.TESTER_ARMY_UPDATE_SNAPSHOTS = updateSnapshots ? "1" : "0";
process.env.TESTER_ARMY_STRICT_CACHE = strictCache ? "1" : "0";
if (updateSnapshots && mode !== "visual")
  throw new Error("Snapshot updates require visual mode");
if (mode !== "agent" && process.env.TESTER_ARMY_HARNESS === "coupled")
  throw new Error("Web checks require the standard harness");
const selected = selectedJourneys(
  mode === "agent"
    ? journeys
    : journeys.filter((journey) =>
        ["field-source-claim", "finance-split-expense"].includes(journey.id),
      ),
  "web",
);
if (selected.length === 0) throw new Error("No Tester Army journey selected");
const harnesses = (["standard", "coupled"] as const).filter((harness) =>
  selected.some((journey) => harnessOf(journey) === harness),
);
const usageFile = path.join(output, "gateway-usage.json");
// The coupled harness swaps this coordinator model in for the agent's pinned one.
/**
 * An explicit coordinator swap for a model comparison. Unset, the coordinator
 * runs on whatever model production sends (`coordinatorModelFor`), so a
 * journey exercises the coordinator the household actually uses.
 */
const agentModel = process.env.TESTER_ARMY_AGENT_MODEL
  ? modelSwapSchema.parse({
      model: process.env.TESTER_ARMY_AGENT_MODEL,
      effort: process.env.TESTER_ARMY_AGENT_EFFORT || "high",
    })
  : undefined;

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
  const pool = createPostgresPool({ connectionString: runtime.databaseUrl });
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
      [
        "exec",
        "e2e",
        ...(mode === "explore"
          ? [
              "explore",
              "Explore generic record editing, searchable pickers and expense split validation in this synthetic household. Every record is disposable: create, edit or delete any records as useful. Report broken controls or incorrect values with steps to reproduce.",
              "--session",
              "synthetic",
              "--agent",
              "explorer",
              "--max-steps",
              "4",
              "--timeout",
              "300000",
            ]
          : ["run"]),
        ...(updateSnapshots ? ["--update-snapshots"] : []),
        ...(strictCache ? ["--strict-cache"] : []),
        "--output",
        phaseOutput(harness),
        ...(process.env.TESTER_ARMY_DEBUG === "1" ? ["--debug"] : []),
      ],
      {
        ...tracker,
        cwd: webRoot,
        stdio: "inherit",
        env: {
          ...process.env,
          DATABASE_URL: runtime.databaseUrl,
          TESTER_ARMY_TARGET: "web",
          TESTER_ARMY_WEB_MODE: mode,
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
  const { createE2EWorkerRuntime } =
    await import("../../tests/e2e/support/e2e-worker-runtime");
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
/**
 * The coupled harness's peers still forward the application's own Workers AI
 * (Jev decisions, embeddings) and Anthropic recovery calls through the
 * Cloudflare gateway, so a coupled run needs its token even when the driver
 * runs on the ChatGPT subscription.
 */
function coupledGatewayToken(config: ReturnType<typeof modelConfiguration>) {
  if (!config.TESTER_ARMY_CF_API_TOKEN)
    throw new Error(
      "Coupled Tester Army journeys need TESTER_ARMY_CF_API_TOKEN (or AI_GATEWAY_API_KEY) for the application's own model calls",
    );
  return config.TESTER_ARMY_CF_API_TOKEN;
}

function liveGatewayWorker(
  pricingCatalog: string,
  swap?: typeof agentModel,
): WorkerdModelWorker {
  const config = modelConfiguration();
  const vars: NonNullable<WorkerdModelWorker["vars"]> = {
    ACCOUNT_ID: config.TESTER_ARMY_CF_ACCOUNT_ID,
    GATEWAY_ENVIRONMENT: testAiGatewayEnvironment(process.env.CI),
    PRICING_CATALOG: pricingCatalog,
  };
  if (swap) {
    vars.RESPONSES_MODEL = swap.model;
    vars.RESPONSES_EFFORT = swap.effort;
  }
  return {
    main: "tooling/tester-army/live-gateway.ts",
    ...(swap && { fixedModel: true as const }),
    vars,
    secrets: { GATEWAY_TOKEN: coupledGatewayToken(config) },
  };
}

async function runCoupled() {
  const catalog = await fetch("https://models.dev/api.json?type=all", {
    signal: AbortSignal.timeout(30_000),
  });
  if (!catalog.ok)
    throw new Error(
      `Live pricing catalog ${catalog.status}: ${await catalog.text()}`,
    );
  const pricingCatalog = await catalog.text();
  const { createE2EWorkerRuntime } =
    await import("../../tests/e2e/support/e2e-worker-runtime");
  const { seedCoupledJourneys } =
    await import("../scenarios/tester-army-coupled");
  const runtime = await createE2EWorkerRuntime({
    authenticated: true,
    parallelIndex: 0,
    profile: "coupled",
    models: {
      agent: liveGatewayWorker(pricingCatalog, agentModel),
      gateway: liveGatewayWorker(pricingCatalog),
    },
    objectStorage: { publish: publicStorageOrigin },
  });
  const { harness, baseURL: origin, storageState } = runtime;
  const failures: unknown[] = [];
  try {
    await runJourneys("coupled", {
      origin,
      databaseUrl: runtime.databaseUrl,
      storageState,
      seed: (pool, userId) =>
        seedCoupledJourneys(pool, userId, {
          origin,
          cookies: storageState.cookies,
        }),
    });
  } catch (error) {
    console.error(
      "[tester-army] Coupled Worker logs:",
      JSON.stringify(runtime.getLogs(), null, 2),
    );
    failures.push(error);
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
    try {
      writeFileSync(
        usageFile,
        `${JSON.stringify({ agent: await usageOf("cubby-test-model"), web: await usageOf("cubby-test-gateway") }, null, 2)}\n`,
      );
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    await runtime.close();
  } catch (error) {
    failures.push(error);
  }
  // The journey's own failure comes first; cleanup failures follow it.
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "Coupled run failed");
}

async function runWithServices() {
  applyServiceDefaults();
  const { prepareTemplate } = await import("../test-database-lease");
  await prepareTemplate("browser");
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
      ? {
          agentModel: agentModel?.model ?? "production",
          agentEffort: agentModel?.effort ?? "production",
        }
      : undefined,
  });
