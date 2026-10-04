import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

/** The primary checkout that owns `.git`; worktrees share it but not its `.env`. */
function primaryCheckoutRoot(from: string): string | undefined {
  try {
    const common = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: from, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return path.dirname(common);
  } catch {
    return undefined;
  }
}

/**
 * One credential for an explicit opt-in tool (live evals, Tester Army), read
 * from the shell, then `envFile`, then this checkout's `apps/web/.env`, then
 * the primary checkout's. Worktrees intentionally get no `.env` copy, so the
 * primary-checkout fallback is the supported way to reach a local secret.
 * Only the requested names are read, so database and storage settings in the
 * same file never enter the caller.
 */
export function localSecret(
  names: readonly string[],
  {
    env = process.env,
    envFile,
    checkoutRoot = repoRoot,
    mainCheckoutRoot = primaryCheckoutRoot(checkoutRoot),
  }: {
    env?: Readonly<Record<string, string | undefined>>;
    envFile?: string;
    checkoutRoot?: string;
    mainCheckoutRoot?: string;
  } = {},
): string | undefined {
  const files = [
    envFile,
    path.join(checkoutRoot, "apps/web/.env"),
    mainCheckoutRoot && path.join(mainCheckoutRoot, "apps/web/.env"),
  ].flatMap((file) => (file && existsSync(file) ? [file] : []));
  const sources = [
    env,
    ...files.map((file) => parseEnv(readFileSync(file, "utf8"))),
  ];
  for (const source of sources)
    for (const name of names) if (source[name]) return source[name];
  return undefined;
}
