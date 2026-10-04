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
import { applyJourneyFlags } from "./flags";

/** The shared journey catalog on the standard browser E2E runtime. */
const flags = process.argv.slice(2).filter((argument) => argument !== "--");
applyJourneyFlags(flags, "test:e2e:agent:web", ["--services-ready"]);
process.env.E2E_TELEMETRY_DISABLED = "1";
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
    const { seedSimulatorPhotoActor } = await import("../scenarios/simulator");
    const { seedJourneyWorld } =
      await import("../scenarios/tester-army-journeys");
    await seedSimulatorPhotoActor(pool, userId);
    const idsFile = path.join(output, "journey-ids.json");
    writeFileSync(
      idsFile,
      JSON.stringify(await seedJourneyWorld(pool, userId)),
    );
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
        TESTER_ARMY_JOURNEY: "catalog",
        TESTER_ARMY_ORIGIN: runtime.baseURL,
        TESTER_ARMY_IDS_FILE: idsFile,
        TESTER_ARMY_WEB_STATE: state,
      },
    });
    assertJourneyPassed(rawOutput, "web journeys");
  } finally {
    rmSync(path.join(output, "browser-state.json"), { force: true });
    rmSync(path.join(output, "journey-ids.json"), { force: true });
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
    caseName: "web journeys",
    fixture: "synthetic-journeys",
    output,
    rawOutput,
    tracker,
  });
