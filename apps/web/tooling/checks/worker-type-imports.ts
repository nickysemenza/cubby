#!/usr/bin/env node
// Configuration inference and RPC contracts must not pull backend implementations
// into the global Worker environment's importer closure.
import { execFileSync } from "node:child_process";
import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseSync } from "oxc-parser";

// An implementation reached through this global script invalidates the whole
// app after edits to its dependencies. Inspect the compiler's resolved graph,
// including type-only and dynamic imports, rather than just the entry spelling.
if (process.argv.includes("--check")) {
  const web = resolve(import.meta.dirname, "../..");
  for (const file of globSync(["src/**/*.ts", "src/**/*.tsx"], { cwd: web })) {
    if (file.endsWith(".d.ts")) continue;
    const source = readFileSync(resolve(web, file), "utf8");
    if (!source.includes("global")) continue;
    const ast = parseSync(file, source).program;
    if (
      ast.body.some(
        (statement) =>
          statement.type === "TSModuleDeclaration" && statement.global,
      )
    ) {
      throw new Error(
        `${file} augments global types from a runtime module; move the declaration and its type dependencies into an isolated .d.ts module.`,
      );
    }
  }

  const files = execFileSync(
    resolve(import.meta.dirname, "../../../../node_modules/.bin/tsc"),
    [
      "--listFilesOnly",
      "-p",
      resolve(import.meta.dirname, "tsconfig.worker-types.json"),
    ],
    { encoding: "utf8" },
  ).split("\n");
  const server = resolve(import.meta.dirname, "../../src/server") + "/";
  const implementationFiles = files.filter((file) => {
    if (!file.startsWith(server)) return false;
    const relative = file.slice(server.length);
    return (
      relative.includes("/repo/") ||
      relative === "db.ts" ||
      relative === "db/database.ts" ||
      relative.startsWith("generated/")
    );
  });
  if (implementationFiles.length) {
    throw new Error(
      "Global Worker binding types reach backend implementations; expose a type-only RPC contract instead:\n" +
        implementationFiles.slice(0, 10).join("\n") +
        `\n(${implementationFiles.length} implementation files reached)`,
    );
  }
}
