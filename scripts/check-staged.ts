import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const lintableFile = /\.(?:[cm]?[jt]sx?)$/;
const formattableFile = /\.(?:[cm]?[jt]sx?|jsonc?|css|html)$/;

export type StagedFiles = Readonly<{
  lintable: readonly string[];
  formattable: readonly string[];
}>;

export function parseStagedPaths(output: string): readonly string[] {
  return output.split("\0").filter(Boolean);
}

export function selectStagedFiles(paths: readonly string[]): StagedFiles {
  const uniquePaths = [...new Set(paths)];
  return {
    lintable: uniquePaths.filter((path) => lintableFile.test(path)),
    formattable: uniquePaths.filter((path) => formattableFile.test(path)),
  };
}

function stagedPaths(): readonly string[] {
  const result = spawnSync(
    "git",
    ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || "check-staged: could not read staged files");
  }
  return parseStagedPaths(result.stdout);
}

function runTool(tool: "oxlint" | "oxfmt", arguments_: readonly string[]) {
  const result = spawnSync("pnpm", ["exec", tool, ...arguments_], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
  }
}

export function checkStagedFiles(paths: readonly string[]) {
  const { lintable, formattable } = selectStagedFiles(paths);
  if (lintable.length > 0) {
    runTool("oxlint", [
      "--deny-warnings",
      "--no-error-on-unmatched-pattern",
      ...lintable,
    ]);
  }
  if (formattable.length > 0) {
    runTool("oxfmt", [
      "--check",
      "--no-error-on-unmatched-pattern",
      ...formattable,
    ]);
  }
}

if (import.meta.main) {
  checkStagedFiles(stagedPaths());
}
