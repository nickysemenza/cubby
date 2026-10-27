import { execFileSync } from "node:child_process";
import path from "node:path";

// Imported by cloudflare.config.ts through the dev profile: keep it
// dependency-free so the Cloudflare Vite plugin's config loader accepts it.

const git = (repoRoot: string, args: string[]) =>
  execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/** The checked-out commit. The Worker reads it at runtime, never from the bundle. */
export function readSourceIdentity(repoRoot: string) {
  const [commit, shortCommit, date] = git(repoRoot, [
    "show",
    "-s",
    "--format=%H%n%h%n%cI",
    "HEAD",
    "--",
  ]).split("\n");
  if (!commit || !shortCommit || !date)
    throw new Error(
      "Git HEAD metadata must include full SHA, short SHA and date",
    );
  return {
    commit,
    /** Names the Sentry release (vite.config.ts) and the runtime release. */
    shortCommit,
    branch: git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]),
    date,
  };
}

export type SourceIdentity = ReturnType<typeof readSourceIdentity>;

/** Whether the worktree has any change, tracked or untracked. */
export const worktreeDirty = (repoRoot: string) =>
  git(repoRoot, ["status", "--porcelain"]).length > 0;

/** The Worker values `getSourceRelease` (src/server/cf-env.ts) reads. */
export const sourceReleaseVars = (
  identity: SourceIdentity,
  branch = identity.branch,
) => ({
  CUBBY_SOURCE_COMMIT: identity.shortCommit,
  CUBBY_SOURCE_BRANCH: branch,
  CUBBY_SOURCE_DATE: identity.date,
});

// Deploy writes these as the Worker version's secrets file:
// `node tooling/source-identity.ts [--branch=main] > file.json`.
if (process.argv[1] === import.meta.filename) {
  const branch = process.argv
    .find((argument) => argument.startsWith("--branch="))
    ?.slice("--branch=".length);
  const repoRoot = path.resolve(import.meta.dirname, "../../..");
  console.log(
    JSON.stringify(sourceReleaseVars(readSourceIdentity(repoRoot), branch)),
  );
}
