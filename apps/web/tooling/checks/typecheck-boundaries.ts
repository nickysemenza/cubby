// Guard the actual resolved programs: excludes alone do not prevent imported
// implementations, unresolved declaration imports, or newly unclassified roots.
import { execFileSync, spawn } from "node:child_process";
import { globSync } from "node:fs";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";

const sharedServerModules = new Set([
  "operation-runtime/start-operation.contract.ts",
  "generated/entity-bindings.gen.ts",
  "generated/entity-kernel-entities.gen.ts",
  "generated/entity-relation-contracts.gen.ts",
  "entity-kernel/contracts.ts",
  "operation-runtime/start-operation-dispatch.contract.ts",
  "observability/tracing.ts",
  "operation-runtime/middleware/entity-server-functions.ts",
  "ai/enrichment/proposals.ts",
  "ai/response-cache-rpc.ts",
  "ai/chatgpt/rpc.ts",
  "db/freshness/rpc.ts",
  "domains/calendar/operations/rpc.ts",
  "domains/image-processing/service/contracts.ts",
  "domains/purchase-agent/service/signals.ts",
  "domains/purchase-agent/service/environment.ts",
  "domains/usda-release/operations/rpc.ts",
  "workflows/runs/contract.ts",
  "ai/gateway-egress-contract.ts",
  "worker-bindings.ts",
]);

export async function checkTypecheckBoundaries(
  app: string,
  compiler: string,
): Promise<void> {
  const graph = (config: string) =>
    execFileSync(
      process.execPath,
      [compiler, "--listFilesOnly", "-p", join(app, config)],
      { cwd: app, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
    ).split(/\r?\n/u);
  const client: string[] = [];
  const server = graph("tsconfig.server.json");
  const serverRoot = join(app, "src/server/");
  const declarations = join(app, "artifacts/server-contracts/");
  let resolvingBoundary = false;
  // Resolution tracing is verbose; inspect it as a stream, retaining only files.
  const child = spawn(
    process.execPath,
    [
      compiler,
      "--listFilesOnly",
      "--traceResolution",
      "-p",
      join(app, "tsconfig.client.json"),
    ],
    { cwd: app, stdio: ["ignore", "pipe", "inherit"] },
  );
  const completed = new Promise<void>((accept, reject) => {
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? accept() : reject(new Error(`Client graph exited ${code}`)),
    );
  });
  const failures: string[] = [];
  for await (const line of createInterface({ input: child.stdout })) {
    if (line.startsWith(app)) client.push(line);
    if (line.startsWith("======== Resolving module "))
      resolvingBoundary = line.includes(`from '${declarations}`);
    if (resolvingBoundary && line.includes("was not resolved."))
      failures.push(`Unresolved generated contract dependency: ${line}`);
    if (
      line.startsWith(serverRoot) &&
      !sharedServerModules.has(line.slice(serverRoot.length))
    )
      failures.push(`Client check reaches a server implementation: ${line}`);
  }
  await completed;
  if (failures.length) throw new Error(failures.slice(0, 10).join("\n"));
  const ui = server.find(
    (file) =>
      file.startsWith(join(app, "src/")) &&
      (file.endsWith(".tsx") || file.includes("/src/routes/")),
  );
  if (ui)
    throw new Error(`Server check reaches the browser route graph: ${ui}`);
  const checked = new Set([...client, ...server]);
  const missing = globSync(["src/**/*.ts", "src/**/*.tsx"], {
    cwd: app,
  }).filter(
    (file) =>
      !/\.(test|spec)\.tsx?$/u.test(file) &&
      !file.startsWith("src/lib/test/") &&
      !checked.has(resolve(app, file)),
  );
  if (missing.length)
    throw new Error(
      `App source missing from both strict programs:\n${missing.join("\n")}`,
    );
}
