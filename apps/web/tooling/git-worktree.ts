import { execFileSync } from "node:child_process";
import path from "node:path";

type GitPath = "--git-dir" | "--git-common-dir";
type ResolveGitPath = (kind: GitPath, cwd: string) => string;

const resolveGitPath: ResolveGitPath = (kind, cwd) =>
  execFileSync("git", ["rev-parse", "--path-format=absolute", kind], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();

/** True for any linked Git worktree, independent of which agent created it. */
export function isGitWorktree(
  cwd = process.cwd(),
  resolvePath: ResolveGitPath = resolveGitPath,
): boolean {
  try {
    const gitDir = path.normalize(resolvePath("--git-dir", cwd));
    const commonDir = path.normalize(resolvePath("--git-common-dir", cwd));
    return gitDir !== commonDir;
  } catch {
    return false;
  }
}
