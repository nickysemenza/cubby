import { execFileSync } from "node:child_process";
import path from "node:path";

import { readWebBuildProvenance } from "./web-build-provenance";

const webRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(webRoot, "../..");

interface WorkerBuild {
  name: string;
  /** The exact command that rebuilds it, runnable from any directory. */
  command: [string, ...string[]];
  /** Why its output does not match the current source, or `undefined`. */
  staleReason(): string | undefined;
}

const webWorkerBuild: WorkerBuild = {
  name: "web",
  command: ["pnpm", "--dir", webRoot, "run", "build:cf"],
  staleReason() {
    const provenance = readWebBuildProvenance(repoRoot);
    return provenance.sourceFresh ? undefined : provenance.details.reason;
  },
};

/**
 * Every Worker build the coupled workerd harness loads. The web Worker hosts
 * the purchase agent (#1581), so its one build covers both.
 */
export const COUPLED_WORKER_BUILDS: readonly WorkerBuild[] = [webWorkerBuild];

const verified = new Set<string>();

/**
 * Make each build match its current source: locally a stale build is rebuilt
 * in place; in CI, where the Worker artifact must already be current, it
 * fails with the exact rebuild command. Run under the harness lock so a
 * rebuild never overlaps another suite or rebuilds the same dist twice.
 */
export function ensureWorkerBuilds(
  builds: readonly WorkerBuild[],
  { rebuild = process.env.CI !== "true" }: { rebuild?: boolean } = {},
): void {
  for (const build of builds) {
    if (verified.has(build.name)) continue;
    const reason = build.staleReason();
    if (reason !== undefined) {
      const command = build.command.join(" ");
      if (!rebuild)
        throw new Error(
          `The ${build.name} Worker build is stale (${reason}). Rebuild it: ${command}`,
        );
      process.stderr.write(
        `[worker build] ${build.name} is stale (${reason}); running ${command}\n`,
      );
      const [file, ...args] = build.command;
      execFileSync(file, args, { stdio: "inherit" });
      const after = build.staleReason();
      if (after !== undefined)
        throw new Error(
          `The ${build.name} Worker build is still stale (${after}) after ${command}`,
        );
    }
    verified.add(build.name);
  }
}
