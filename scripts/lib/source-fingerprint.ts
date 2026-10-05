import { execFileSync } from "node:child_process";
import path from "node:path";

import { digestFiles, walkFiles } from "./tree-digest.ts";

// Dependency-free on purpose: Worker build scripts import it before any
// workspace tooling runs.

/** The inputs a build reads, for a content fingerprint of its source. */
export interface BuildSource {
  /** Repository-relative globs of tracked (or untracked, unignored) inputs. */
  globs: readonly string[];
  /** Directories also walked on disk for Git-ignored generated inputs. */
  generatedRoots: readonly string[];
  /** Markdown the build bundles (`?raw`, `import.meta.glob`); other docs never count. */
  bundledMarkdown?: readonly string[];
  /** A non-file input (a build flag) that must also change the fingerprint. */
  seed?: string;
}

const EXCLUDED_PARTS = new Set([
  "dist",
  "node_modules",
  "target",
  "artifacts",
  "test-results",
  "playwright-report",
  "coverage",
  ".auth",
  ".git",
  ".nx",
  "certificates",
  "secrets",
]);

function excludedSource(file: string): boolean {
  return (
    file.startsWith("packages/wasm/") ||
    file
      .split("/")
      .some(
        (part) =>
          EXCLUDED_PARTS.has(part) ||
          part.startsWith(".env") ||
          part.startsWith(".dev.vars") ||
          part.startsWith(".wrangler") ||
          part.startsWith(".cache"),
      )
  );
}

function sourceFilesUnder(repoRoot: string, relative: string): string[] {
  if (excludedSource(relative)) return [];
  return walkFiles(path.join(repoRoot, relative), {
    skip: (name) => excludedSource(name),
  }).map((file) => path.relative(repoRoot, file));
}

/** SHA-256 over every source file's path and bytes; tests and docs excluded. */
export function sourceFingerprint(
  repoRoot: string,
  source: BuildSource,
): string {
  const gitFiles = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: repoRoot, encoding: "utf8" },
  )
    .split("\0")
    .filter(
      (file) =>
        file && source.globs.some((glob) => path.matchesGlob(file, glob)),
    );
  // Generated TS/routes are ignored by Git but still consumed by the build.
  // Include their actual bytes and paths so edits, additions and deletions fail
  // freshness verification just like hand-written inputs.
  const files = [
    ...gitFiles,
    ...source.generatedRoots.flatMap((root) =>
      sourceFilesUnder(repoRoot, root),
    ),
  ]
    .filter((file) => !excludedSource(file))
    .filter(
      (file) =>
        !/\.(?:test|spec)\.[^.]+$/u.test(file) &&
        (!file.endsWith(".md") ||
          (source.bundledMarkdown ?? []).some((glob) =>
            path.matchesGlob(file, glob),
          )),
    );
  return digestFiles(
    repoRoot,
    [...new Set(files)].sort().map((file) => path.join(repoRoot, file)),
    { seed: source.seed },
  );
}
