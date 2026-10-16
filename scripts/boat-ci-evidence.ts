import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import type { PilotJob } from "./boat-ci.ts";

const bundle = z.object({
  status: z.string(),
  source: z.object({ commit: z.string(), dirty: z.boolean() }),
  // Browser bundles retain first-attempt diagnostics even when a retry passes.
  // The run status owns Playwright final success semantics.
  cases: z.array(z.object({ status: z.string() })),
});
const summary = z.object({
  status: z.string(),
  cases: z.array(z.object({ status: z.string() })),
});
const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));
type EvidenceStatus = "passed" | "failed" | "missing";

// Task caches are disabled and reports cleared before execution. Explicit
// failures must survive separately from missing or malformed diagnostics.
export function pilotEvidenceStatus(
  root: string,
  job: PilotJob,
  revision: string,
): EvidenceStatus {
  try {
    if (job.browser) {
      const report = bundle.parse(
        read(path.join(root, "apps/web/playwright-report/run-manifest.json")),
      );
      if (report.source.commit !== revision) return "missing";
      if (
        report.source.dirty ||
        ["failed", "timedout", "interrupted", "changed-during-run"].includes(
          report.status,
        )
      )
        return "failed";
      if (report.status !== "passed" || !report.cases.length) return "missing";
      const blobs = path.join(root, "apps/web/blob-report");
      return readdirSync(blobs).some(
        (file) =>
          file.endsWith(".zip") && statSync(path.join(blobs, file)).size > 0,
      )
        ? "passed"
        : "missing";
    }
    if (job.id.startsWith("postgres-")) {
      const report = z
        .object({
          success: z.boolean(),
          numTotalTests: z.number().nonnegative(),
          numFailedTests: z.number().nonnegative(),
        })
        .parse(read(path.join(root, "apps/web/.vitest-results.json")));
      if (!report.success || report.numFailedTests > 0) return "failed";
      return report.numTotalTests > 0 ? "passed" : "missing";
    }
    if (job.id === "ai-smoke") {
      const directory = path.join(root, "artifacts/tester-army/web");
      const files = readdirSync(directory, {
        recursive: true,
        encoding: "utf8",
      });
      const manifests = files.filter(
        (file) => path.basename(file) === "run-manifest.json",
      );
      const summaries = files.filter(
        (file) => path.basename(file) === "agent-summary.json",
      );
      let missing = !manifests.length || !summaries.length;
      for (const file of manifests) {
        const report = bundle.parse(read(path.join(directory, file)));
        if (report.source.commit !== revision) {
          missing = true;
          continue;
        }
        if (
          report.source.dirty ||
          ["failed", "timedout", "interrupted", "changed-during-run"].includes(
            report.status,
          )
        )
          return "failed";
        if (report.status !== "passed" || !report.cases.length) missing = true;
      }
      for (const file of summaries) {
        const report = summary.parse(read(path.join(directory, file)));
        if (
          report.status === "failed" ||
          report.cases.some((item) => item.status === "failed")
        )
          return "failed";
        if (
          report.status !== "passed" ||
          !report.cases.length ||
          report.cases.some((item) => item.status !== "passed")
        )
          missing = true;
      }
      return missing ? "missing" : "passed";
    }
    return "passed";
  } catch {
    return "missing";
  }
}
