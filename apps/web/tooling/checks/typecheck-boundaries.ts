// Guard the actual resolved programs: excludes alone do not prevent imported
// implementations, unresolved declaration imports, or newly unclassified roots.
import { spawn } from "node:child_process";
import { globSync } from "node:fs";
import { isBuiltin } from "node:module";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import {
  repositoryOwners,
  repositoryPrograms,
} from "../typecheck-repositories.ts";

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
  const failures: string[] = [];
  const contracts = [
    join(app, "artifacts/server-contracts/"),
    repositoryPrograms.output + "/",
  ];
  const graph = async (config: string): Promise<string[]> => {
    const files: string[] = [];
    const child = spawn(
      process.execPath,
      [
        compiler,
        "--listFilesOnly",
        "--traceResolution",
        "-p",
        resolve(app, config),
      ],
      { cwd: app, stdio: ["ignore", "pipe", "inherit"] },
    );
    const completed = new Promise<void>((accept, reject) => {
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0
          ? accept()
          : reject(new Error(`Graph exited ${code}: ${config}`)),
      );
    });
    let boundary = false;
    let specifier = "";
    for await (const line of createInterface({ input: child.stdout })) {
      if (line.startsWith(app)) files.push(line);
      const resolution =
        /^======== Resolving module '([^']+)' from '([^']+)'/u.exec(line);
      if (resolution) {
        specifier = resolution[1]!;
        boundary = contracts.some((directory) =>
          resolution[2]!.startsWith(directory),
        );
      }
      if (
        boundary &&
        line.includes("was not resolved.") &&
        !isBuiltin(specifier)
      )
        failures.push(`Unresolved generated contract dependency: ${line}`);
    }
    await completed;
    return files;
  };
  const repositories = await graph(repositoryPrograms.config);
  const server = await graph(repositoryPrograms.serverConfig);
  const client = await graph("tsconfig.client.json");
  const serverRoot = join(app, "src/server/");
  for (const file of client) {
    if (
      file.startsWith(serverRoot) &&
      !sharedServerModules.has(file.slice(serverRoot.length))
    )
      failures.push(`Client check reaches a server implementation: ${file}`);
  }
  const ui = server.find(
    (file) =>
      file.startsWith(join(app, "src/")) &&
      (file.endsWith(".tsx") || file.includes("/src/routes/")),
  );
  if (ui) failures.push(`Server check reaches the browser route graph: ${ui}`);
  const owned = new Set(repositoryOwners.map((file) => resolve(app, file)));
  const shared = new Set(
    [
      "db/database.ts",
      "db/external-id-schema.ts",
      "errors/app-error.ts",
      "observability/tracing.ts",
    ].map((file) => join(serverRoot, file)),
  );
  for (const leak of server.filter((file) => owned.has(file)))
    failures.push(`Server check reaches repository implementation: ${leak}`);
  const backedge = repositories.find(
    (file) =>
      file.startsWith(serverRoot) && !owned.has(file) && !shared.has(file),
  );
  if (backedge)
    failures.push(`Repository check reaches server composition: ${backedge}`);
  const missingOwner = [...owned].find((file) => !repositories.includes(file));
  if (missingOwner)
    failures.push(
      `Repository source missing from its producer: ${missingOwner}`,
    );
  const duplicateHandle = [...server, ...repositories].find(
    (file) =>
      file.startsWith(repositoryPrograms.output) &&
      file.endsWith("/db/database.d.ts"),
  );
  if (duplicateHandle)
    failures.push(
      `Database identity resolves to a declaration copy: ${duplicateHandle}`,
    );
  const checked = new Set([...client, ...server, ...repositories]);
  const missing = globSync(["src/**/*.ts", "src/**/*.tsx"], {
    cwd: app,
  }).filter(
    (file) =>
      !/\.(test|spec)\.tsx?$/u.test(file) &&
      !file.startsWith("src/lib/test/") &&
      !checked.has(resolve(app, file)),
  );
  if (missing.length)
    failures.push(
      `App source missing from all strict programs:\n${missing.join("\n")}`,
    );
  if (failures.length) throw new Error(failures.slice(0, 10).join("\n"));
}
