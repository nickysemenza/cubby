import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every local-only E2E lane (the ones CI does not run), one after another so a
 * laptop is never running two workerd harnesses or simulators at once. The web
 * Worker is built once up front instead of once per lane.
 */
const webRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const lanes: { name: string; args: string[] }[] = [
  { name: "headless", args: ["--headless"] },
  { name: "headless:photo", args: ["--headless", "--photo"] },
  { name: "headless:wardrobe", args: ["--headless", "--photo", "--purchase"] },
  { name: "sim", args: ["--video"] },
  { name: "sim:layout", args: ["--layout", "--video"] },
];
const only = process.argv.slice(2);
const selected = only.length
  ? lanes.filter((lane) => only.includes(lane.name))
  : lanes;
if (!selected.length)
  throw new Error(
    `Unknown lane; choose from ${lanes.map((lane) => lane.name).join(", ")}`,
  );

const time = (run: () => number) => {
  const started = Date.now();
  const status = run();
  return { status, seconds: Math.round((Date.now() - started) / 1000) };
};
const build = time(
  () =>
    spawnSync("pnpm", ["run", "build:cf"], { cwd: webRoot, stdio: "inherit" })
      .status ?? 1,
);
if (build.status !== 0) process.exit(build.status);

const results = [{ name: "web build", ...build }];
for (const lane of selected) {
  results.push({
    name: lane.name,
    ...time(
      () =>
        spawnSync("pnpm", ["exec", "tsx", "tooling/sim-e2e.ts", ...lane.args], {
          cwd: webRoot,
          stdio: "inherit",
          env: { ...process.env, CUBBY_E2E_PREBUILT_WEB: "1" },
        }).status ?? 1,
    ),
  });
}
console.log("\nLocal-only E2E lanes:");
for (const result of results)
  console.log(
    `  ${result.status === 0 ? "pass" : "FAIL"}  ${result.name.padEnd(18)} ${result.seconds}s`,
  );
process.exit(results.some((result) => result.status !== 0) ? 1 : 0);
