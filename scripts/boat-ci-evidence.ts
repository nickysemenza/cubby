import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import type { PilotJob } from "./boat-ci.ts";

const bundle = z.object({
  status: z.literal("passed"),
  source: z.object({ commit: z.string(), dirty: z.literal(false) }),
  // Browser bundles retain first-attempt diagnostics even when a retry passes.
  // The run status owns Playwright final success semantics.
  cases: z.array(z.object({ status: z.string() })).min(1),
});
const summary = z.object({
  status: z.literal("passed"),
  cases: z.array(z.object({ status: z.literal("passed") })).min(1),
});
const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));

// Task caches are disabled in the pilot and report directories are cleared
// before execution. Only newly produced diagnostics can certify this run.
export function hasPilotEvidence(
  root: string,
  job: PilotJob,
  revision: string,
): boolean {
  try {
    if (job.browser) {
      const report = bundle.parse(
        read(path.join(root, "apps/web/playwright-report/run-manifest.json")),
      );
      if (report.source.commit !== revision) return false;
      const blobs = path.join(root, "apps/web/blob-report");
      return readdirSync(blobs).some(
        (file) =>
          file.endsWith(".zip") && statSync(path.join(blobs, file)).size > 0,
      );
    }
    if (job.id.startsWith("postgres-")) {
      const report = z
        .object({
          success: z.literal(true),
          numTotalTests: z.number().positive(),
          numFailedTests: z.literal(0),
        })
        .parse(read(path.join(root, "apps/web/.vitest-results.json")));
      return report.success;
    }
    if (job.id === "ai-smoke") {
      const directory = path.join(root, "artifacts/tester-army/web");
      if (!existsSync(directory)) return false;
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
      return (
        manifests.length > 0 &&
        summaries.length > 0 &&
        manifests.every(
          (file) =>
            bundle.parse(read(path.join(directory, file))).source.commit ===
            revision,
        ) &&
        summaries.every(
          (file) => summary.safeParse(read(path.join(directory, file))).success,
        )
      );
    }
    return true;
  } catch {
    return false;
  }
}
