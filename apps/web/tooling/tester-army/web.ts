import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { z } from "zod";
import { runOrThrow } from "../../../../scripts/lib/run.ts";
import {
  applyServiceDefaults,
  assertJourneyPassed,
  childTracker,
  laneOutput,
  runTesterArmyLane,
  webRoot,
} from "./runner";

/** The product rename journey on the standard browser E2E runtime. */
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
const { output, rawOutput } = laneOutput("web");
const tracker = childTracker();

async function runWithServices() {
  applyServiceDefaults();
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
      ...tracker,
      cwd: webRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        DATABASE_URL: runtime.databaseUrl,
        TESTER_ARMY_TARGET: "web",
        TESTER_ARMY_JOURNEY: "product",
        TESTER_ARMY_ORIGIN: runtime.baseURL,
        TESTER_ARMY_PRODUCT_ID: productId,
        TESTER_ARMY_WEB_STATE: state,
      },
    });
    assertJourneyPassed(rawOutput, "web product");
  } finally {
    rmSync(path.join(output, "browser-state.json"), { force: true });
    try {
      await pool.end();
    } finally {
      await runtime.close();
    }
  }
}

if (flags.includes("--services-ready")) await runWithServices();
else
  await runTesterArmyLane({
    script: "tooling/tester-army/web.ts",
    command: ["pnpm", "test:e2e:agent:web", ...flags],
    caseName: "web product rename and reopen",
    fixture: "synthetic-product",
    output,
    rawOutput,
    tracker,
  });
