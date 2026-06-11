import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

interface CliOptions {
  artifactDir: string;
  remote: boolean;
  persistTo: string;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const getArg = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  return {
    artifactDir:
      getArg("--artifacts") ?? path.resolve("artifacts", "usda-edge", "sample"),
    remote: args.includes("--remote"),
    persistTo: getArg("--persist-to") ?? path.resolve(".wrangler", "state"),
  };
}

function wrangler(args: string[], options: CliOptions) {
  const binary = path.resolve("node_modules", ".bin", "wrangler");
  const modeArgs = options.remote
    ? ["--remote"]
    : ["--local", "--persist-to", options.persistTo];
  const result = spawnSync(
    binary,
    [...args, ...modeArgs, "--config", "wrangler.jsonc"],
    {
      stdio: "inherit",
    },
  );
  if (result.status !== 0) {
    throw new Error(`wrangler ${args.join(" ")} failed`);
  }
}

function listFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(fullPath) : [fullPath];
  });
}

function contentType(filePath: string) {
  if (filePath.endsWith(".json")) return "application/json";
  if (filePath.endsWith(".ndjson")) return "application/x-ndjson";
  return "application/octet-stream";
}

function main() {
  const options = parseArgs();
  const d1Dir = path.join(options.artifactDir, "d1");
  const r2Dir = path.join(options.artifactDir, "r2");

  for (const filePath of listFiles(r2Dir)) {
    const key = path.relative(r2Dir, filePath).split(path.sep).join("/");
    wrangler(
      [
        "r2",
        "object",
        "put",
        `usda-api-bundles/${key}`,
        "--file",
        filePath,
        "--content-type",
        contentType(filePath),
        "--force",
      ],
      options,
    );
  }

  for (const file of [
    "001_schema.sql",
    "002_data.sql",
    "003_finalize.sql",
    "004_activate.sql",
  ]) {
    wrangler(
      [
        "d1",
        "execute",
        "usda-api-index",
        "--file",
        path.join(d1Dir, file),
        "--yes",
      ],
      options,
    );
  }
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
