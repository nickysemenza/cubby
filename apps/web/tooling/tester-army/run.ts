import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnToExit } from "cubby/tooling/run";
import { localSecret } from "../local-secret";
import { writeJourneySummary } from "./report";
import { writeStartupHtml } from "./html";
import { prepareE2EProcessEnvironment } from "../e2e-process-env";

const webRoot = path.resolve(import.meta.dirname, "../..");
const output = path.join(webRoot, "artifacts/tester-army");
const started = performance.now();
let phase = "provider setup";
const controller = new AbortController();
const interrupt = () => controller.abort();
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
prepareE2EProcessEnvironment();
// The built Worker comes from Nx (`test:e2e:agent:web`, or the tester-army
// target's `dependsOn` build-cf).
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
try {
  const token = localSecret(["TESTER_ARMY_CF_API_TOKEN", "AI_GATEWAY_API_KEY"]);
  if (!token)
    throw new Error(
      "Provider setup incomplete: Tester Army requires a gateway credential",
    );
  phase = "database template";
  const { prepareTemplate } = await import("../test-database-lease");
  await prepareTemplate("browser");
  const setupMs = Math.round(performance.now() - started);
  phase = "journeys";
  const status = await spawnToExit(
    "pnpm",
    [
      "exec",
      "e2e",
      "run",
      ...(process.env.CUBBY_TESTER_ARMY_SHARD
        ? ["--shard", process.env.CUBBY_TESTER_ARMY_SHARD]
        : []),
      ...process.argv.slice(2),
    ],
    {
      cwd: webRoot,
      stdio: "inherit",
      signal: controller.signal,
      env: {
        ...process.env,
        TESTER_ARMY_CF_API_TOKEN: token,
        E2E_TELEMETRY_DISABLED: "1",
      },
    },
  );
  const passed = await writeJourneySummary(output, setupMs);
  process.exitCode = status === 0 && passed ? 0 : status || 1;
} catch (error) {
  process.exitCode = controller.signal.aborted ? 130 : 1;
  const message = controller.signal.aborted
    ? "Interrupted; no pass established"
    : error instanceof Error
      ? error.message
      : "Unknown failure";
  console.error(`Tester Army stopped during ${phase}: ${message}`);
  await writeFile(
    path.join(output, "startup-failure.json"),
    JSON.stringify({
      phase,
      message,
      elapsedMs: Math.round(performance.now() - started),
    }),
  );
  await writeStartupHtml(output, phase, message);
  await writeFile(
    path.join(output, "summary.md"),
    `## Tester Army web journeys (informational)\n\n**Failed / incomplete** during ${phase}. No passing result was established. See startup-failure.json and SDK artifacts.\n`,
  );
} finally {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
