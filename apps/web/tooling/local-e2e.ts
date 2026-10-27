import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildWebWorker } from "./build-cf";

/**
 * Small native smoke by default; select affected domain lanes or --all for
 * extended acceptance. Lanes stay sequential; after the first Nx build each
 * lane's own build-cf run is a cache hit.
 */
const webRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const simulatorLanes = [
  { name: "headless", args: ["--headless"] },
  { name: "headless:photo", args: ["--headless", "--photo"] },
  { name: "headless:wardrobe", args: ["--headless", "--photo", "--purchase"] },
  { name: "sim", args: ["--video"] },
  { name: "sim:extended", args: ["--extended-journey", "--video"] },
  { name: "sim:layout", args: ["--layout", "--video"] },
  { name: "sim:input", args: ["--input-journey"] },
];
const lanes = [
  ...simulatorLanes.map((lane) => ({ ...lane, script: "sim-e2e.ts" })),
  { name: "mac:import", script: "mac-import-e2e.ts", args: [] },
];
const only = process.argv.slice(2).filter((argument) => argument !== "--");
if (only.includes("--help")) {
  console.log(
    `Usage: pnpm test:e2e:local [lane ... | --all]\nDefault: headless sim\nLanes: ${lanes.map((lane) => lane.name).join(", ")}`,
  );
  process.exit(0);
}
if (
  only.some(
    (name) => name !== "--all" && !lanes.some((lane) => lane.name === name),
  )
)
  throw new Error(
    `Unknown lane; choose from ${lanes.map((lane) => lane.name).join(", ")}`,
  );
const names = only.length ? only : ["headless", "sim"];
const selected = names.includes("--all")
  ? lanes
  : lanes.filter((lane) => names.includes(lane.name));

const time = (run: () => number) => {
  const started = Date.now();
  const status = run();
  return { status, seconds: Math.round((Date.now() - started) / 1000) };
};
const buildStarted = Date.now();
await buildWebWorker();
const build = {
  status: 0,
  seconds: Math.round((Date.now() - buildStarted) / 1000),
};

const results = [{ name: "web build", ...build }];
for (const lane of selected) {
  results.push({
    name: lane.name,
    ...time(
      () =>
        spawnSync(
          "pnpm",
          ["exec", "tsx", `tooling/${lane.script}`, ...lane.args],
          {
            cwd: webRoot,
            stdio: "inherit",
          },
        ).status ?? 1,
    ),
  });
}
console.log("\nLocal-only E2E lanes:");
for (const result of results)
  console.log(
    `  ${result.status === 0 ? "pass" : "FAIL"}  ${result.name.padEnd(18)} ${result.seconds}s`,
  );
process.exit(results.some((result) => result.status !== 0) ? 1 : 0);
