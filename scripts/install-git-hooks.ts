import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

// Share only dispatchers: hook behavior always comes from the active checkout.
// A per-worktree ignored dispatcher disappears in each new linked worktree.
const dispatcher = `#!/usr/bin/env sh
[ "\${HUSKY-}" = "0" ] && exit 0
exec sh -e ".husky/$(basename "$0")" "$@"
`;

if (process.env.HUSKY !== "0" && existsSync(resolve(".git"))) {
  const common = execFileSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { encoding: "utf8" },
  ).trim();
  const directory = join(common, "cubby-hooks");
  mkdirSync(directory, { recursive: true });
  for (const hook of ["pre-commit", "commit-msg"]) {
    const path = join(directory, hook);
    if (existsSync(path) && readFileSync(path, "utf8") === dispatcher) {
      chmodSync(path, 0o755);
      continue;
    }
    // A commit must never observe a partially rewritten shared dispatcher.
    const pending = `${path}.${process.pid}.tmp`;
    writeFileSync(pending, dispatcher, { mode: 0o755 });
    renameSync(pending, path);
  }
  execFileSync("git", ["config", "core.hooksPath", directory]);
  const effective = execFileSync("git", ["config", "--get", "core.hooksPath"], {
    encoding: "utf8",
  }).trim();
  if (effective !== directory)
    throw new Error(
      `Git hooksPath override ${effective} prevents using ${directory}`,
    );
  console.log(
    "Git hooks installed; linked worktrees share checkout-local dispatch.",
  );
}
