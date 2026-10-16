// Failure modes: declarations must be fresh without touching unchanged output;
// removed exports must disappear; a failed emit must never publish partial types.
// The strict server program checks bodies; isolated declaration emission only
// supplies the client boundary. Run the two programs sequentially for peak RSS.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  globSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { checkTypecheckBoundaries } from "./checks/typecheck-boundaries.ts";

const app = resolve(import.meta.dirname, "..");
const compiler = join(
  dirname(fileURLToPath(import.meta.resolve("typescript/package.json"))),
  "bin/tsc",
);
const pending = join(app, "artifacts/server-contracts.pending");
const output = join(app, "artifacts/server-contracts");

function compile(args: string[]) {
  const result = spawnSync(process.execPath, [compiler, ...args], {
    cwd: app,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

rmSync(pending, { recursive: true, force: true });
compile(["-p", "tsconfig.contracts.json"]);
const emitted = new Set(globSync("**/*.d.ts", { cwd: pending }));
for (const path of emitted) {
  const target = join(output, path);
  const content = readFileSync(join(pending, path), "utf8");
  if (existsSync(target) && readFileSync(target, "utf8") === content) continue;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}
for (const path of globSync("**/*.d.ts", { cwd: output })) {
  if (!emitted.has(path)) rmSync(join(output, path));
}
rmSync(pending, { recursive: true, force: true });

const [mode = "app", ...args] = process.argv.slice(2);
if (mode === "app") {
  for (const config of ["tsconfig.server.json", "tsconfig.client.json"])
    compile(["--build", config, "--checkers", "1", ...args]);
} else if (mode === "guard") await checkTypecheckBoundaries(app, compiler);
else if (mode !== "contracts")
  throw new Error(`Unknown typecheck mode: ${mode}`);
