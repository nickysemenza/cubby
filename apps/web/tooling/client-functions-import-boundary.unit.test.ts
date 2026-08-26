import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { START_OPERATIONS } from "~/lib/generated/start-operation-registry.gen";
import { START_OPERATION_HANDLER_LOADERS } from "~/server/generated/start-operation-handlers.gen";

const sourceRoot = resolve(import.meta.dirname, "../src");

const clientFunctionFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return clientFunctionFiles(path);
    return entry.name.endsWith(".functions.ts") ? [path] : [];
  });

const isTypeOnlyImport = (clause: string): boolean => {
  const trimmed = clause.trim();
  if (trimmed.startsWith("type ")) return true;
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return false;
  return trimmed
    .slice(1, -1)
    .split(",")
    .every((specifier) => specifier.trim().startsWith("type "));
};

const runtimeImports = (
  source: string,
): Array<{ clause: string; from: string }> =>
  [...source.matchAll(/^\s*import\s+([\s\S]*?)\s+from\s+["']([^"']+)["'];?/gmu)]
    .map(([, clause, from]) => ({ clause: clause!, from: from! }))
    .filter(({ clause }) => !isTypeOnlyImport(clause));

const forbiddenImport = (source: string): boolean =>
  source === "@tanstack/react-start" ||
  source === "@cubby/db" ||
  (source.startsWith("~/server-functions/") &&
    source !== "~/server-functions/start-operation-dispatch.functions") ||
  source.startsWith("~/server/");

describe("client function import boundary", () => {
  it("keeps all client operation modules free of eager server/runtime imports", () => {
    const violations = ["app", "entities", "lib"]
      .flatMap((directory) => clientFunctionFiles(join(sourceRoot, directory)))
      .flatMap((path) =>
        runtimeImports(readFileSync(path, "utf8"))
          .filter(({ from }) => forbiddenImport(from))
          .map(({ from }) => `${relative(sourceRoot, path)} -> ${from}`),
      )
      .sort();

    expect(violations).toEqual([]);
  });

  it("keeps generated operation handlers complete", () => {
    const dispatchableOperations = Object.entries(START_OPERATIONS)
      .filter(([, definition]) => definition.kind !== "subscription")
      .map(([operation]) => operation)
      .sort();

    expect(Object.keys(START_OPERATION_HANDLER_LOADERS).sort()).toEqual(
      dispatchableOperations,
    );
  });
});
