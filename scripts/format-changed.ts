/**
 * Format only what changed.
 *
 * `pnpm format:write` is `pnpm -r format:write` — Biome over every package.
 * Across 21 days of agent transcripts that was **519 calls / 5.3h at a median
 * of 18.4s**, nearly always to tidy a handful of files that had just been
 * edited. Biome on a single file measures **1.2s**.
 *
 * Compares against the merge-base with the default branch (overridable with
 * `FORMAT_BASE`) and includes uncommitted work, so it covers the same files a
 * reviewer would see in the diff.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const git = (args: string[]) =>
  spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });

const base = process.env.FORMAT_BASE ?? "origin/main";
const mergeBase = git(["merge-base", "HEAD", base]);
const diffAgainst = mergeBase.status === 0 ? mergeBase.stdout.trim() : "HEAD";
if (mergeBase.status !== 0) {
  console.error(
    `format-changed: no merge-base with ${base}; comparing against HEAD only.`,
  );
}

const tracked = git(["diff", "--name-only", "--diff-filter=ACMR", diffAgainst]);
const untracked = git(["ls-files", "--others", "--exclude-standard"]);

const files = [
  ...(tracked.stdout ?? "").split("\n"),
  ...(untracked.stdout ?? "").split("\n"),
]
  .filter(Boolean)
  .filter((file) => /\.(ts|tsx|js|jsx|mjs|cjs|json|jsonc|css)$/.test(file));

if (files.length === 0) {
  console.error("format-changed: nothing to format.");
  process.exit(0);
}

console.error(`format-changed: ${files.length} file(s)`);
const result = spawnSync(
  "biome",
  ["check", "--write", "--no-errors-on-unmatched", ...files],
  {
    cwd: repoRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      PATH: `${join(repoRoot, "node_modules/.bin")}:${process.env.PATH ?? ""}`,
    },
  },
);
process.exit(result.status ?? 1);
