import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import { formatTesterArmySummary as formatSummary } from "./tester-army-summary.ts";
import { scrubCredentialValues } from "../../packages/worker-tracing/src/scrub-error-message.ts";
export { classifyTesterArmyChanges } from "./tester-army-routing.ts";

export const testerArmySummarySchema = z.object({
  schemaVersion: z.literal(1),
  status: z.string(),
  model: z.string(),
  effort: z.literal("medium"),
  tokens: z.number().nonnegative(),
  modelCalls: z.number().nonnegative(),
  estimatedCostUsd: z.number().nonnegative().optional(),
  cases: z.array(
    z.object({
      name: z.string(),
      status: z.string(),
      durationMs: z.number().nonnegative(),
    }),
  ),
  replay: z.object({
    replayed: z.number().nonnegative(),
    handedOff: z.number().nonnegative(),
    missed: z.number().nonnegative(),
  }),
});

export function formatTesterArmySummary(input: {
  lane: string;
  head: string;
  runUrl: string;
  outcome: string;
  summaries: unknown[];
}) {
  return formatSummary({
    ...input,
    summaries: input.summaries.map((summary) =>
      testerArmySummarySchema.parse(summary),
    ),
  });
}

/** Copy only diagnostic evidence from a synthetic CI attempt, never sessions, downloads or transcripts. */
export function collectTesterArmyEvidence(
  source: string,
  output: string,
  secrets: readonly string[],
) {
  if (!existsSync(source)) return;
  const copy = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink())
        throw new Error("Tester Army evidence contains a symbolic link");
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (["downloads", "sessions", "transcripts"].includes(entry.name))
          continue;
        copy(file);
        continue;
      }
      if (!entry.isFile()) continue;
      const text =
        entry.name === "trace.md" || entry.name === "screen-at-failure.txt";
      const screenshot =
        path.basename(directory) === "screenshots" &&
        entry.name.endsWith(".png");
      const video = /\.(?:webm|mp4)$/u.test(entry.name);
      if (!text && !screenshot && !video) continue;
      const target = path.join(output, path.relative(source, file));
      mkdirSync(path.dirname(target), { recursive: true });
      if (text) {
        let content = readFileSync(file, "utf8");
        for (const secret of secrets.filter(Boolean))
          content = content.replaceAll(secret, "[REDACTED]");
        writeFileSync(target, scrubCredentialValues(content));
      } else copyFileSync(file, target);
    }
  };
  copy(source);
}
