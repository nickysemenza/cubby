import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const buildStampSchema = z.object({
  schemaVersion: z.literal(1),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  sourceDirty: z.boolean(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  fileCount: z.number().int().nonnegative(),
});

type BuildStamp = z.infer<typeof buildStampSchema>;

interface BuildFingerprint {
  fingerprint: string;
  fileCount: number;
}

export interface WebBuildProvenance {
  fingerprint: string | null;
  matchesSource: boolean;
  details: {
    reason: string;
    sourceCommit?: string;
    sourceDirty?: boolean;
    buildMatches?: boolean;
    fileCount?: number;
  };
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

function buildFingerprint(repoRoot: string): BuildFingerprint {
  const webRoot = path.join(repoRoot, "apps/web");
  const required = [
    path.join(webRoot, "dist/client"),
    path.join(webRoot, "dist/server/index.js"),
    path.join(repoRoot, "packages/wasm/recipebridge_bg.wasm"),
  ];
  for (const target of required) {
    if (!existsSync(target))
      throw new Error(
        `Missing web build output: ${path.relative(repoRoot, target)}`,
      );
  }
  // Only deployed code and generated WASM enter this digest. The dist/server
  // directory also contains Wrangler variables and local .dev.vars files.
  const files = [
    ...required.flatMap(filesUnder),
    ...filesUnder(path.join(webRoot, "dist/server/assets")),
    ...filesUnder(path.join(repoRoot, "packages/wasm/recipebridge.js")),
    ...filesUnder(path.join(repoRoot, "packages/wasm/recipebridge_bg.js")),
  ].sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(path.relative(repoRoot, file));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return { fingerprint: hash.digest("hex"), fileCount: files.length };
}

function stampPath(repoRoot: string): string {
  return path.join(repoRoot, "apps/web/dist/web-build-provenance.json");
}

export function writeWebBuildProvenance(repoRoot: string): string {
  const build = buildFingerprint(repoRoot);
  const stamp: BuildStamp = {
    schemaVersion: 1,
    sourceCommit: git(repoRoot, ["rev-parse", "HEAD"]),
    sourceDirty: git(repoRoot, ["status", "--porcelain"]).length > 0,
    ...build,
  };
  const output = stampPath(repoRoot);
  writeFileSync(output, `${JSON.stringify(stamp, null, 2)}\n`);
  return output;
}

export function readWebBuildProvenance(repoRoot: string): WebBuildProvenance {
  const output = stampPath(repoRoot);
  if (!existsSync(output))
    return {
      fingerprint: null,
      matchesSource: false,
      details: { reason: "missing-build-stamp" },
    };
  let stamp: BuildStamp;
  try {
    stamp = buildStampSchema.parse(JSON.parse(readFileSync(output, "utf8")));
  } catch {
    return {
      fingerprint: null,
      matchesSource: false,
      details: { reason: "invalid-build-stamp" },
    };
  }
  let buildMatches = false;
  try {
    const currentBuild = buildFingerprint(repoRoot);
    buildMatches =
      currentBuild.fingerprint === stamp.fingerprint &&
      currentBuild.fileCount === stamp.fileCount;
  } catch {
    return {
      fingerprint: stamp.fingerprint,
      matchesSource: false,
      details: {
        reason: "missing-build-output",
        sourceCommit: stamp.sourceCommit,
        sourceDirty: stamp.sourceDirty,
        buildMatches: false,
        fileCount: stamp.fileCount,
      },
    };
  }
  const sourceMatches =
    stamp.sourceCommit === git(repoRoot, ["rev-parse", "HEAD"]) &&
    !stamp.sourceDirty &&
    git(repoRoot, ["status", "--porcelain"]).length === 0;
  return {
    fingerprint: stamp.fingerprint,
    matchesSource: sourceMatches && buildMatches,
    details: {
      reason: !buildMatches
        ? "build-output-changed"
        : !sourceMatches
          ? "source-changed-or-dirty"
          : "verified",
      sourceCommit: stamp.sourceCommit,
      sourceDirty: stamp.sourceDirty,
      buildMatches,
      fileCount: stamp.fileCount,
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repoRoot = path.resolve(import.meta.dirname, "../../..");
  console.log(`[web build] Provenance: ${writeWebBuildProvenance(repoRoot)}`);
}
