import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { z } from "zod";
import { runOrThrow } from "../../../../scripts/lib/run.ts";
import { modelConfiguration } from "./model";
import {
  applyServiceDefaults,
  assertJourneyPassed,
  childTracker,
  laneOutput,
  repoRoot,
  runTesterArmyLane,
  webRoot,
} from "./runner";

/**
 * The live import journey: Tester Army drives the web app while the real
 * purchase agent coordinates the import. The coupled web + agent harness
 * replaces both deterministic model peers with `live-gateway.ts`, so the
 * driver, the pi coordinator, and the web Worker's extraction and audit all
 * call real models through the synthetic testing AI Gateway.
 */
const flags = process.argv.slice(2).filter((argument) => argument !== "--");
if (flags.some((flag) => flag !== "--services-ready"))
  throw new Error("Usage: test:e2e:agent:import");
process.env.E2E_TELEMETRY_DISABLED = "1";
const { output, rawOutput } = laneOutput("import");
const tracker = childTracker();
const usageFile = path.join(output, "gateway-usage.json");

const routeUsage = z.record(
  z.string(),
  z.object({
    requests: z.number(),
    failed: z.number(),
    failedStatuses: z.array(z.number()),
  }),
);

function liveGatewayWorker() {
  const config = modelConfiguration();
  return {
    main: "tooling/tester-army/live-gateway.ts",
    vars: {
      GATEWAY_BASE_URL: `https://gateway.ai.cloudflare.com/v1/${config.TESTER_ARMY_CF_ACCOUNT_ID}/${config.TESTER_ARMY_CF_GATEWAY_ID}`,
      RUN_REVISION: process.env.GITHUB_SHA ?? "local",
    },
    secrets: { GATEWAY_TOKEN: config.TESTER_ARMY_CF_API_TOKEN },
  };
}

async function runWithServices() {
  applyServiceDefaults();
  const { prepareE2EDatabaseTemplate, createE2EDatabase } =
    await import("../../tests/e2e/e2e-database");
  const { authenticate } = await import("../../tests/e2e/e2e-worker-runtime");
  const { createWorkerdHarness } =
    await import("../purchase-agent-workerd-harness");
  const { seedImportAgentScenario } = await import("../scenarios/import-agent");
  await prepareE2EDatabaseTemplate();
  const database = await createE2EDatabase();
  // The web Worker's Hyperdrive bindings resolve through these in workerd.
  for (const key of [
    "WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE",
    "WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_CACHED",
  ])
    process.env[key] = database.databaseUrl;
  const live = liveGatewayWorker();
  const harness = createWorkerdHarness(database.databaseUrl, live, live);
  const pool = new Pool({ connectionString: database.databaseUrl });
  try {
    const { url } = await harness.listen();
    const storageState = await authenticate(url.origin);
    const actor = await pool.query<{ id: string }>(
      'SELECT id FROM "user" WHERE email = $1',
      [process.env.E2E_TEST_USER_EMAIL],
    );
    const userId = z.string().min(1).parse(actor.rows[0]?.id);
    const seeded = await seedImportAgentScenario(pool, userId);
    const state = path.join(output, "browser-state.json");
    writeFileSync(state, JSON.stringify(storageState), { mode: 0o600 });
    try {
      await runOrThrow("pnpm", ["exec", "e2e", "run", "--output", rawOutput], {
        ...tracker,
        cwd: webRoot,
        stdio: "inherit",
        env: {
          ...process.env,
          DATABASE_URL: database.databaseUrl,
          TESTER_ARMY_TARGET: "web",
          TESTER_ARMY_JOURNEY: "import",
          TESTER_ARMY_ORIGIN: url.origin,
          TESTER_ARMY_VENDOR_ID: seeded.vendorShortcode,
          TESTER_ARMY_VENDOR_UUID: seeded.vendorId,
          TESTER_ARMY_WEB_STATE: state,
        },
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
    assertJourneyPassed(rawOutput, "web import");
  } finally {
    rmSync(path.join(output, "browser-state.json"), { force: true });
    try {
      await pool.end();
      await harness.close();
    } finally {
      await database.close();
    }
  }
}

if (flags.includes("--services-ready")) await runWithServices();
else
  await runTesterArmyLane({
    script: "tooling/tester-army/import.ts",
    command: ["pnpm", "test:e2e:agent:import"],
    caseName: "web import through the live agent",
    fixture: "synthetic-order-confirmation",
    output,
    rawOutput,
    tracker,
    evidence: [usageFile],
    build: () =>
      runOrThrow("pnpm", ["--dir", "apps/purchase-agent", "run", "build"], {
        ...tracker,
        cwd: repoRoot,
        stdio: "inherit",
      }),
  });
