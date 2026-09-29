import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { release } from "node:os";
import path from "node:path";
import {
  readWebBuildProvenance,
  webBuildSourceFingerprint,
  type WebBuildProvenance,
} from "./web-build-provenance";

export interface E2ERunIdentity {
  source: { commit: string; dirty: boolean; fingerprint: string };
  build: WebBuildProvenance;
}

export interface E2ERunBundleInput {
  repoRoot: string;
  outputDir: string;
  evidence: string[];
  kind: "browser" | "native";
  status: string;
  command: string[];
  cases?: Array<{ name: string; status: string; durationMs?: number }>;
  runtime?: Record<string, string>;
  profile?: string;
  scenario?: string;
  fixture?: string;
  fixtureVersion?: number;
  phase?: string;
  phases?: Array<{ name: string; durationMs: number }>;
  /** Source and output observed before tests start, including watch/UI runs. */
  started?: E2ERunIdentity;
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

function git(repoRoot: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
}

export function captureE2ERunIdentity(repoRoot: string): E2ERunIdentity {
  return {
    source: {
      commit: git(repoRoot, ["rev-parse", "HEAD"]),
      dirty: git(repoRoot, ["status", "--porcelain"]).length > 0,
      fingerprint: webBuildSourceFingerprint(repoRoot),
    },
    build: readWebBuildProvenance(repoRoot),
  };
}

function filesUnder(target: string): string[] {
  if (!existsSync(target)) return [];
  if (statSync(target).isFile()) return [target];
  return readdirSync(target, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isSymbolicLink()) return [];
    const child = path.join(target, entry.name);
    return entry.isDirectory() ? filesUnder(child) : [child];
  });
}

function runProvenance(input: E2ERunBundleInput) {
  const commit = git(input.repoRoot, ["rev-parse", "HEAD"]);
  const dirty = git(input.repoRoot, ["status", "--porcelain"]).length > 0;
  const ended = input.started
    ? captureE2ERunIdentity(input.repoRoot)
    : undefined;
  const changedDuringRun = Boolean(
    input.started &&
    ended &&
    (input.started.source.commit !== ended.source.commit ||
      input.started.source.dirty !== ended.source.dirty ||
      input.started.source.fingerprint !== ended.source.fingerprint ||
      input.started.build.fingerprint !== ended.build.fingerprint ||
      input.started.build.sourceFresh !== ended.build.sourceFresh),
  );
  const source = input.started?.source ?? { commit, dirty };
  const testedBuild = input.started?.build ?? input.build ?? null;
  const build =
    changedDuringRun && testedBuild
      ? {
          ...testedBuild,
          sourceFresh: false,
          matchesSource: false,
          details: { ...testedBuild.details, reason: "changed-during-run" },
        }
      : testedBuild;
  return { source, build, changedDuringRun, ended };
}

/** Leave a replayable, content-checked summary without copying env or DB data. */
export function writeE2ERunBundle(input: E2ERunBundleInput): string {
  mkdirSync(input.outputDir, { recursive: true });
  const { source, build, changedDuringRun, ended } = runProvenance(input);
  const files = [...new Set(input.evidence.flatMap(filesUnder))]
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
    schemaVersion: 1,
    kind: input.kind,
    status: changedDuringRun ? "changed-during-run" : input.status,
    completedAt: new Date().toISOString(),
    source,
    build,
    ...(input.started && {
      testStatus: input.status,
      changedDuringRun,
      endSource: ended?.source,
    }),
    replayableFromCommit:
      !changedDuringRun && !source.dirty && build?.matchesSource === true,
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
