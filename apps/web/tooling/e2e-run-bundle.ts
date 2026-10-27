import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { release } from "node:os";
import path from "node:path";
import { readSourceIdentity, worktreeDirty } from "./source-identity";
import { walkFiles } from "cubby/tooling/tree-digest";

/**
 * The checkout a run tested. Nx builds the Worker from this content (its
 * build-cf key), so a clean, unchanged checkout identifies the build too.
 */
export interface E2ERunIdentity {
  commit: string;
  branch: string;
  dirty: boolean;
}

export interface E2ERunBundleInput {
  repoRoot: string;
  outputDir: string;
  evidence: string[];
  kind: "browser" | "native";
  status: string;
  command: string[];
  cases?: Array<{
    name: string;
    status: string;
    durationMs?: number;
    /** Live explorer of the failed test's harness; only valid during the run. */
    explorerUrl?: string;
  }>;
  runtime?: Record<string, string>;
  profile?: string;
  scenario?: string;
  fixture?: string;
  fixtureVersion?: number;
  phase?: string;
  phases?: Array<{ name: string; durationMs: number }>;
  /** Checkout observed before tests start, including watch/UI runs. */
  started?: E2ERunIdentity;
  /** Lane-owned artifacts (native app binaries) beyond the Nx-built Worker. */
  build?: {
    fingerprint: string | null;
    matchesSource: boolean;
    sourceFresh?: boolean;
    details?: Record<string, string | boolean | number>;
  };
}

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function captureE2ERunIdentity(repoRoot: string): E2ERunIdentity {
  const { commit, branch } = readSourceIdentity(repoRoot);
  return { commit, branch, dirty: worktreeDirty(repoRoot) };
}

function runProvenance(input: E2ERunBundleInput) {
  const source = input.started ?? captureE2ERunIdentity(input.repoRoot);
  const ended = input.started
    ? captureE2ERunIdentity(input.repoRoot)
    : undefined;
  // A commit or a first edit during the run means the final HEAD is not what
  // was tested. Further edits to an already dirty checkout are invisible, but
  // a dirty run is never replayable.
  const changedDuringRun = Boolean(
    ended && (ended.commit !== source.commit || ended.dirty !== source.dirty),
  );
  return { source, changedDuringRun, ended };
}

/** Leave a replayable, content-checked summary without copying env or DB data. */
export function writeE2ERunBundle(input: E2ERunBundleInput): string {
  mkdirSync(input.outputDir, { recursive: true });
  const { source, changedDuringRun, ended } = runProvenance(input);
  const files = [
    ...new Set(input.evidence.flatMap((target) => walkFiles(target))),
  ]
    .filter(
      (file) =>
        !["run-manifest.json", "SHA256SUMS"].includes(path.basename(file)),
    )
    .sort()
    .map((file) => {
      const relativePath = path.relative(input.outputDir, file);
      if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
        throw new Error(`E2E evidence outside bundle: ${file}`);
      }
      return { path: relativePath, sha256: sha256(readFileSync(file)) };
    });
  const manifest = {
    schemaVersion: 2,
    kind: input.kind,
    status: changedDuringRun ? "changed-during-run" : input.status,
    completedAt: new Date().toISOString(),
    source,
    build: input.build ?? null,
    ...(input.started && {
      testStatus: input.status,
      changedDuringRun,
      endSource: ended,
    }),
    replayableFromCommit:
      !changedDuringRun &&
      !source.dirty &&
      (input.build === undefined || input.build.matchesSource),
    command: input.command.map((arg) =>
      /(?:password|secret|token|api[_-]?key)=/iu.test(arg) ? "[redacted]" : arg,
    ),
    ...(input.profile && { profile: input.profile }),
    ...(input.scenario && { scenario: input.scenario }),
    ...(input.fixture && { fixture: input.fixture }),
    ...(input.fixtureVersion !== undefined && {
      fixtureVersion: input.fixtureVersion,
    }),
    ...(input.phase && { phase: input.phase }),
    ...(input.phases && { phases: input.phases }),
    runtime: {
      node: process.version,
      platform: process.platform,
      osRelease: release(),
      architecture: process.arch,
      ...input.runtime,
    },
    cases: input.cases ?? [],
    evidence: files,
  };
  const manifestPath = path.join(input.outputDir, "run-manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  files.push({
    path: path.basename(manifestPath),
    sha256: sha256(readFileSync(manifestPath)),
  });
  writeFileSync(
    path.join(input.outputDir, "SHA256SUMS"),
    `${files.map((file) => `${file.sha256}  ${file.path}`).join("\n")}\n`,
  );
  return manifestPath;
}
