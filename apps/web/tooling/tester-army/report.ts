import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const failure = z.object({
  code: z.string(),
  category: z.string(),
  phase: z.string().optional(),
});
const report = z.object({
  run: z.object({
    status: z.string(),
    startedAt: z.string(),
    finishedAt: z.string(),
    summary: z.object({
      selected: z.number(),
      executed: z.number(),
      passed: z.number(),
      failed: z.number(),
      skipped: z.number(),
      flaky: z.number(),
    }),
    results: z.array(
      z.object({
        titlePath: z.array(z.string()),
        selected: z.boolean(),
        status: z.string(),
        attempts: z.array(
          z.object({ durationMs: z.number(), error: failure.optional() }),
        ),
      }),
    ),
    errors: z.array(z.unknown()),
  }),
});

function boundary(error: z.infer<typeof failure> | undefined) {
  if (!error) return "unclassified";
  if (/MODEL|PROVIDER|INFERENCE/u.test(error.code)) return "provider";
  if (error.phase && error.phase !== "body") return "startup / fixture";
  if (/AGENT|AUTOMATION|BUDGET|STEP_LIMIT/u.test(error.code)) return "agent";
  return "application / outcome";
}

/** Only parsed test results can establish a pass; missing reports remain startup failures. */
export async function writeJourneySummary(output: string, setupMs: number) {
  const { run } = report.parse(
    JSON.parse(await readFile(path.join(output, "run/report.json"), "utf8")),
  );
  const durationMs = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
  const fixtureDirectory = path.join(output, "fixtures");
  const fixtures = await Promise.all(
    (await readdir(fixtureDirectory).catch(() => [])).map(async (file) =>
      z
        .object({ setupMs: z.number(), journeyMs: z.number().nullable() })
        .parse(
          JSON.parse(await readFile(path.join(fixtureDirectory, file), "utf8")),
        ),
    ),
  );
  const runnerSetupMs = setupMs;
  setupMs += fixtures.reduce((sum, fixture) => sum + fixture.setupMs, 0);
  const journeyMs = fixtures.reduce(
    (sum, fixture) => sum + (fixture.journeyMs ?? 0),
    0,
  );
  const validPass =
    run.status === "passed" &&
    run.summary.selected > 0 &&
    run.summary.executed === run.summary.selected &&
    run.summary.failed === 0 &&
    run.summary.skipped === 0 &&
    run.summary.flaky === 0 &&
    run.errors.length === 0 &&
    fixtures.length === run.summary.executed;
  const text = [
    "## Tester Army web journeys (informational)",
    "",
    `Result: **${validPass ? "passed" : "failed / incomplete"}**. Setup: ${(setupMs / 1000).toFixed(1)}s; journey execution: ${(journeyMs / 1000).toFixed(1)}s; total runner: ${(durationMs / 1000).toFixed(1)}s.`,
    `Fixture timing evidence: ${fixtures.length}/${run.summary.executed} attempts. Missing records are unknown, not zero.`,
    `Evidence executed at ${run.startedAt}; a whole-result cache replay retains this timestamp.`,
    "",
    "| Journey | Result | Seconds | Failing boundary |",
    "| --- | --- | ---: | --- |",
    ...run.results
      .filter((result) => result.selected)
      .map((result) => {
        const last = result.attempts.at(-1);
        const unexecuted = result.status === "skipped" || !last;
        const stoppedAt = unexecuted
          ? "not executed"
          : result.status === "passed"
            ? "—"
            : `${boundary(last.error)}${last.error ? ` (${last.error.code})` : ""}`;
        return `| ${result.titlePath.join(" / ").replaceAll("|", "\\|")} | ${result.status} | ${last ? (last.durationMs / 1000).toFixed(1) : "—"} | ${stoppedAt} |`;
      }),
    "",
    "A boundary identifies where execution stopped, not a proven root cause. See the SDK report, JUnit and traces for details.",
    "Nx may replay this whole result for identical inputs. SDK action replay still executes the journey and its outcome checks. Fresh execution bypasses both.",
    "",
  ].join("\n");
  await writeFile(path.join(output, "summary.md"), text);
  await writeFile(
    path.join(output, "timings.json"),
    JSON.stringify({
      runnerSetupMs,
      setupMs,
      journeyMs,
      runnerMs: durationMs,
      summary: run.summary,
    }),
  );
  return validPass;
}
