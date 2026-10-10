import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Reporter } from "e2e";
import { z } from "zod";
import { testerArmyDriverIdentity } from "./model";

const summarySchema = z.object({
  schemaVersion: z.literal(1),
  status: z.string(),
  model: z.string(),
  effort: z.literal("medium"),
  tokens: z.number(),
  modelCalls: z.number(),
  estimatedCostUsd: z.number().optional(),
  cases: z.array(
    z.object({ name: z.string(), status: z.string(), durationMs: z.number() }),
  ),
  replay: z.object({
    replayed: z.number(),
    handedOff: z.number(),
    missed: z.number(),
  }),
});

export const testerArmyReporter: Reporter = {
  name: "cubby-sanitized-summary",
  async onRunFinished({ report, reportPath }) {
    if (!reportPath) throw new Error("Tester Army did not save its report");
    const results = report.run.results.filter((result) => result.selected);
    const steps = results.flatMap((result) =>
      result.attempts.flatMap((attempt) => attempt.steps),
    );
    const summary = summarySchema.parse({
      schemaVersion: 1,
      status: report.run.status,
      model: testerArmyDriverIdentity(),
      effort: "medium",
      tokens: report.run.usage.modelTokens,
      estimatedCostUsd: report.run.usage.estimatedCostUsd,
      modelCalls: steps.reduce(
        (sum, step) => sum + (step.metrics?.modelCalls ?? 0),
        0,
      ),
      cases: results.map((result) => ({
        name: result.titlePath.join(" > "),
        status: result.status,
        durationMs: result.attempts.reduce(
          (sum, attempt) => sum + attempt.durationMs,
          0,
        ),
      })),
      replay: {
        replayed: steps.filter((step) => step.cache?.mode === "self-finalized")
          .length,
        handedOff: steps.filter(
          (step) => step.cache?.mode === "agent-concluded",
        ).length,
        missed: steps.filter((step) => step.cache?.mode === "missed").length,
      },
    });
    writeFileSync(
      path.join(path.dirname(reportPath), "agent-summary.json"),
      `${JSON.stringify(summary, null, 2)}\n`,
    );
  },
};

export function readTesterArmySummary(output: string) {
  const summary = summarySchema.parse(
    JSON.parse(readFileSync(path.join(output, "agent-summary.json"), "utf8")),
  );
  if (
    summary.status === "passed" &&
    (summary.cases.length === 0 ||
      summary.cases.some((item) => item.status !== "passed"))
  )
    throw new Error("Tester Army passed without every journey passing");
  return summary;
}

/**
 * One summary for a lane that ran its journeys in several harnesses. A phase
 * that left no summary (it crashed before reporting) fails the whole run.
 */
export function mergeTesterArmySummaries(phases: string[], output: string) {
  const summaries = phases.map((phase) =>
    existsSync(path.join(phase, "agent-summary.json"))
      ? summarySchema.parse(
          JSON.parse(
            readFileSync(path.join(phase, "agent-summary.json"), "utf8"),
          ),
        )
      : undefined,
  );
  const reported = summaries.filter((summary) => summary !== undefined);
  const first = reported[0];
  if (!first) return;
  const sum = (pick: (summary: (typeof reported)[number]) => number) =>
    reported.reduce((total, summary) => total + pick(summary), 0);
  const costs = reported.map((summary) => summary.estimatedCostUsd);
  const merged = summarySchema.parse({
    ...first,
    status:
      reported.length === phases.length &&
      reported.every((summary) => summary.status === "passed")
        ? "passed"
        : "failed",
    tokens: sum((summary) => summary.tokens),
    modelCalls: sum((summary) => summary.modelCalls),
    estimatedCostUsd: costs.every((cost) => cost !== undefined)
      ? costs.reduce((total, cost) => total + cost, 0)
      : undefined,
    cases: reported.flatMap((summary) => summary.cases),
    replay: {
      replayed: sum((summary) => summary.replay.replayed),
      handedOff: sum((summary) => summary.replay.handedOff),
      missed: sum((summary) => summary.replay.missed),
    },
  });
  writeFileSync(
    path.join(output, "agent-summary.json"),
    `${JSON.stringify(merged, null, 2)}\n`,
  );
}

export function testerArmyRawOutput(runDirectory: string) {
  return path.join(
    fileURLToPath(new URL("../../.e2e/runs/", import.meta.url)),
    path.basename(path.dirname(runDirectory)),
    path.basename(runDirectory),
  );
}
