#!/usr/bin/env node
// CI-only: sets every tracked file under the given paths to an mtime derived
// from its git blob hash, so a cached Swift build directory restored onto a
// fresh checkout sees unchanged sources as unchanged. A checkout stamps every
// file with "now", which makes SwiftPM/Xcode recompile all of our own modules
// (the 91k-line generated CubbyAPI client included) even when only the
// dependencies' output was reused.
//
//   stamp-source-mtimes.ts <path>...
//
// The mapping is content-addressed rather than commit-time based: identical
// bytes always get the identical mtime, different bytes get a different one
// (the build systems compare mtimes for equality, not ordering), and it does
// not depend on how GitHub's PR merge commit rewrote history. Never run it in
// a working checkout — it deliberately sets mtimes in the past.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, utimesSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Standalone on purpose: the Apple jobs run it without `pnpm install`.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// 2001-09-09 plus up to ~3.2 years: always in the past, always distinct per
// blob prefix, and far from any real checkout's mtime.
const BASE_SECONDS = 1_000_000_000;
const SPAN_SECONDS = 100_000_000;

export const blobMtime = (blobSha: string): number =>
  BASE_SECONDS + (Number.parseInt(blobSha.slice(0, 12), 16) % SPAN_SECONDS);

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error("usage: stamp-source-mtimes.ts <path>...");
  process.exit(2);
}

// `ls-files -s`: "<mode> <blob sha> <stage>\t<path>", NUL-terminated.
const entries = execFileSync("git", ["ls-files", "-s", "-z", "--", ...paths], {
  cwd: ROOT,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
})
  .split("\0")
  .filter(Boolean);

let stamped = 0;
for (const entry of entries) {
  const match = /^(\d+) ([0-9a-f]+) \d+\t(.+)$/su.exec(entry);
  const [, mode, sha, path] = match ?? [];
  if (!mode || !sha || !path) {
    throw new Error(`unexpected git ls-files entry: ${entry}`);
  }
  // Symlinks and submodules have no content mtime worth stamping.
  if (mode !== "100644" && mode !== "100755") continue;
  const seconds = blobMtime(sha);
  utimesSync(join(ROOT, path), seconds, seconds);
  stamped += 1;
}

// xcodegen recreates this ignored project on every hosted checkout. Give its
// build graph the same content-based mtime as tracked sources, otherwise a
// fresh project timestamp can invalidate an exact DerivedData cache hit.
if (paths.includes("apps/apple")) {
  const project = join(ROOT, "apps/apple/Cubby.xcodeproj/project.pbxproj");
  const hash = createHash("sha256").update(readFileSync(project)).digest("hex");
  const seconds = blobMtime(hash);
  utimesSync(project, seconds, seconds);
  stamped += 1;
}
console.log(`stamp-source-mtimes: ${stamped} files under ${paths.join(" ")}`);
