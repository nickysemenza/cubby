import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { readJourneyEvidence, writeJourneyHtml } from "./html.ts";
import { z } from "zod";

import {
  journeyReportSchema,
  journeyFailureBoundary,
  journeyPassed,
} from "../ci-report/records.ts";

/** Only parsed test results can establish a pass; missing reports remain startup failures. */
export async function writeJourneySummary(output: string, setupMs: number) {
  const { run } = journeyReportSchema.parse(
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
  const evidence = await readJourneyEvidence(output);
  const validPass =
    journeyPassed(run, fixtures.length) && evidence.issues.length === 0;
  const text = [
    "## Tester Army web journeys (informational)",
    "",
    `Result: **${validPass ? "passed" : "failed / incomplete"}**. Setup: ${(setupMs / 1000).toFixed(1)}s; journey execution: ${(journeyMs / 1000).toFixed(1)}s; total runner: ${(durationMs / 1000).toFixed(1)}s.`,
    `Fixture timing evidence: ${fixtures.length}/${run.summary.executed} attempts. Missing records are unknown, not zero.`,
    `Evidence executed at ${run.startedAt}; a whole-result cache replay retains this timestamp.`,
    ...evidence.issues.map((issue) => `Missing evidence: ${issue}`),
    ...evidence.providerDiagnostics.map(
      (entry) =>
        `Upstream provider failure: ${entry.provider} HTTP ${entry.status}${entry.requestId ? ` (${entry.requestId})` : ""}. See the HTML report for the retained response body.`,
    ),
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
            : `${journeyFailureBoundary(last.error)}${last.error ? ` (${last.error.code})` : ""}`;
        return `| ${result.titlePath.join(" / ").replaceAll("|", "\\|")} | ${result.status} | ${last ? (last.durationMs / 1000).toFixed(1) : "—"} | ${stoppedAt} |`;
      }),
    "",
    "A boundary identifies where execution stopped, not a proven root cause. See the SDK report, JUnit and traces for details.",
    "Nx may replay this whole result for identical inputs. SDK action replay still executes the journey and its outcome checks. Fresh execution bypasses both.",
    "",
  ].join("\n");
  await writeFile(path.join(output, "summary.md"), text);
  await writeJourneyHtml(output, [evidence]);
  return validPass;
}
