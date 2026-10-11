import type { z } from "zod";
import type { testerArmySummarySchema } from "./tester-army-ci.ts";

export function formatTesterArmySummary(input: {
  lane: string;
  head: string;
  runUrl: string;
  outcome: string;
  summaries: z.infer<typeof testerArmySummarySchema>[];
}) {
  const summaries = input.summaries;
  const cases = summaries.flatMap((summary) => summary.cases);
  const complete =
    cases.length > 0 &&
    cases.every((item) => item.status === "passed") &&
    summaries.every((summary) => summary.status === "passed");
  const status =
    input.outcome !== "success" ? "failed" : complete ? "passed" : "incomplete";
  const sum = (
    pick: (summary: z.infer<typeof testerArmySummarySchema>) => number,
  ) => summaries.reduce((total, summary) => total + pick(summary), 0);
  const cost =
    summaries.length > 0 &&
    summaries.every((summary) => summary.estimatedCostUsd !== undefined)
      ? `$${sum((summary) => summary.estimatedCostUsd ?? 0).toFixed(4)}`
      : "unavailable";
  return (
    [
      `<!-- cubby-tester-army:${input.lane} -->`,
      `### Tester Army ${input.lane}: ${status} (informational)`,
      `Revision: \`${input.head}\` · [Run and evidence](${input.runUrl})`,
      "This background trial does not block merging. A result may arrive after merge.",
      `${cases.filter((item) => item.status === "passed").length}/${cases.length} journeys passed · Scenario time: ${(cases.reduce((total, item) => total + item.durationMs, 0) / 1000).toFixed(1)}s (setup excluded)`,
      `${sum((summary) => summary.modelCalls)} model calls · ${sum((summary) => summary.tokens)} tokens · Cost: ${cost}`,
      `Replay: ${sum((summary) => summary.replay.replayed)} replayed · ${sum((summary) => summary.replay.handedOff)} handed off · ${sum((summary) => summary.replay.missed)} missed`,
      ...(complete
        ? []
        : [
            "Coverage is incomplete or failed. Inspect the run before treating any journey as verified.",
          ]),
    ].join("\n\n") + "\n"
  );
}
