import { runSyncChecked } from "../../../scripts/lib/run.ts";

export function checkApple(root: string, scope = "all") {
  if (!["all", "host", "app", "lint"].includes(scope))
    throw new Error("usage: pnpm apple check [host|app|lint]");
  const run = (program: string, args: string[]) =>
    runSyncChecked(program, args, root);
  if (scope === "all" || scope === "lint")
    run("pnpm", ["exec", "nx", "run", "apple:lint"]);
  if (scope === "lint") return;

  run(process.execPath, ["scripts/ensure.ts", "generate"]);
  run(process.execPath, ["scripts/ensure.ts", "apple-ffi"]);
  run("pnpm", [
    "exec",
    "nx",
    "run-many",
    "--projects=apple",
    `--targets=${scope === "all" ? "host-tests,simulator-build" : scope === "host" ? "host-tests" : "simulator-build"}`,
    "--parallel=1",
  ]);
}
