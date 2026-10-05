#!/usr/bin/env node
// Run a Worker build and stamp its output with the source fingerprint it was
// built from, so the coupled Workers harness can tell a stale build from a
// current one. The web Worker keeps its richer stamp (web-build-provenance.ts);
// this covers the other Workers the harness loads.
//
//   node scripts/stamped-worker-build.ts <name> -- <build command...>
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  type BuildSource,
  sourceFingerprint,
} from "./lib/source-fingerprint.ts";
import { digestTree } from "./lib/tree-digest.ts";

interface StampedWorkerBuild {
  /** Repository-relative directory the build writes. */
  output: string;
  /** Repository-relative stamp file, outside `output` so Vite never empties it. */
  stamp: string;
  source: BuildSource;
}

export const STAMPED_WORKER_BUILDS = {
  "purchase-agent": {
    output: "apps/purchase-agent/dist/purchase_agent",
    stamp: "apps/purchase-agent/dist/build-source.json",
    source: {
      globs: [
        "apps/purchase-agent/**",
        "packages/**",
        "scripts/generator/**",
        "scripts/lib/**",
        "*.{json,jsonc,yaml,yml,toml,lock}",
        ".npmrc",
      ],
      generatedRoots: ["apps/purchase-agent", "packages"],
    },
  },
} satisfies Record<string, StampedWorkerBuild>;

export type StampedWorkerBuildName = keyof typeof STAMPED_WORKER_BUILDS;

const outputDigest = (repoRoot: string, build: StampedWorkerBuild) =>
  digestTree(path.join(repoRoot, build.output));

/** Why the build's output does not match its current source, or `undefined`. */
export function stampedBuildStaleReason(
  repoRoot: string,
  name: StampedWorkerBuildName,
): string | undefined {
  const build: StampedWorkerBuild = STAMPED_WORKER_BUILDS[name];
  const stampPath = path.join(repoRoot, build.stamp);
  if (!existsSync(stampPath)) return "missing-build-stamp";
  let stamp: { source?: unknown; output?: unknown };
  try {
    stamp = JSON.parse(readFileSync(stampPath, "utf8"));
  } catch {
    return "invalid-build-stamp";
  }
  if (stamp.output !== outputDigest(repoRoot, build))
    return "build-output-changed";
  if (stamp.source !== sourceFingerprint(repoRoot, build.source))
    return "source-changed";
  return undefined;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [name, separator, command, ...args] = process.argv.slice(2);
  const build: StampedWorkerBuild | undefined = Object.entries(
    STAMPED_WORKER_BUILDS,
  ).find(([key]) => key === name)?.[1];
  if (!build || separator !== "--" || !command)
    throw new Error(
      `usage: stamped-worker-build.ts <${Object.keys(STAMPED_WORKER_BUILDS).join("|")}> -- <command...>`,
    );
  const repoRoot = path.resolve(import.meta.dirname, "..");
  rmSync(path.join(repoRoot, build.stamp), { force: true });
  const source = sourceFingerprint(repoRoot, build.source);
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
  if (sourceFingerprint(repoRoot, build.source) !== source)
    throw new Error(
      `Source changed during the ${name} build; refusing to stamp potentially stale output. Rebuild with stable source inputs.`,
    );
  writeFileSync(
    path.join(repoRoot, build.stamp),
    `${JSON.stringify({ source, output: outputDigest(repoRoot, build) }, null, 2)}\n`,
  );
}
