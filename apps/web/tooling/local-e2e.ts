import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureWebBuild } from "./web-build-provenance";

/**
 * Every local-only E2E lane (the ones CI does not run), one after another so a
 * laptop is never running two workerd harnesses or simulators at once. The web
 * Worker is built once up front instead of once per lane.
 */
const webRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const simulatorLanes = [
  { name: "headless", args: ["--headless"] },
  { name: "headless:photo", args: ["--headless", "--photo"] },
  { name: "headless:statement-csv", args: ["--headless", "--statement-csv"] },
  { name: "headless:wardrobe", args: ["--headless", "--photo", "--purchase"] },
  { name: "sim", args: ["--video"] },
  { name: "sim:layout", args: ["--layout", "--video"] },
  { name: "sim:input", args: ["--input-journey"] },
];
const lanes = [
  ...simulatorLanes.map((lane) => ({ ...lane, script: "sim-e2e.ts" })),
  {
    name: "mac:csv-first",
    script: "mac-import-e2e.ts",
    args: ["--order", "csv,photo,receipt"],
  },
  {
    name: "mac:receipt-first",
    script: "mac-import-e2e.ts",
    args: ["--order", "receipt,photo,csv"],
  },
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
const repoRoot = path.resolve(webRoot, "../..");
const buildStarted = Date.now();
const buildAction = await ensureWebBuild(
  repoRoot,
  (skipCache) => {
    const status =
      spawnSync(
        "pnpm",
        ["exec", "nx", "run", "@cubby/web:build-cf", "--outputStyle=stream"],
        {
          cwd: repoRoot,
          stdio: "inherit",
          env: {
            ...process.env,
            NX_DAEMON: "false",
            ...(skipCache && { NX_SKIP_NX_CACHE: "true" }),
          },
        },
      ).status ?? 1;
    if (status !== 0) process.exit(status);
  },
  process.env.CUBBY_E2E_PREBUILT_WEB === "1",
);
const build = {
  status: 0,
  seconds: Math.round((Date.now() - buildStarted) / 1000),
};
console.log(`[local-e2e] Web build ${buildAction}`);

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
            env: { ...process.env, CUBBY_E2E_PREBUILT_WEB: "1" },
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
