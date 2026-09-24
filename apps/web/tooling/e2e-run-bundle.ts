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

export interface E2ERunBundleInput {
  repoRoot: string;
  outputDir: string;
  evidence: string[];
  kind: "browser" | "native";
  status: string;
  command: string[];
  cases?: Array<{ name: string; status: string; durationMs?: number }>;
  runtime?: Record<string, string>;
  build?: {
    fingerprint: string | null;
    matchesSource: boolean;
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

function filesUnder(target: string): string[] {
  if (!existsSync(target)) return [];
  if (statSync(target).isFile()) return [target];
  return readdirSync(target, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isSymbolicLink()) return [];
    const child = path.join(target, entry.name);
    return entry.isDirectory() ? filesUnder(child) : [child];
  });
}

/** Leave a replayable, content-checked summary without copying env or DB data. */
export function writeE2ERunBundle(input: E2ERunBundleInput): string {
  mkdirSync(input.outputDir, { recursive: true });
  const commit = git(input.repoRoot, ["rev-parse", "HEAD"]);
  const dirty = git(input.repoRoot, ["status", "--porcelain"]).length > 0;
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
    status: input.status,
    completedAt: new Date().toISOString(),
    source: { commit, dirty },
    build: input.build ?? null,
    replayableFromCommit: !dirty && input.build?.matchesSource === true,
    command: input.command.map((arg) =>
      /(?:password|secret|token|api[_-]?key)=/iu.test(arg) ? "[redacted]" : arg,
    ),
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
