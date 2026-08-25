import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  classifyHttpWorkload,
  classifyTrpcWorkload,
  importStreamProcedures,
} from "./workload";

function findTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return findTypeScriptFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("performance workload classification", () => {
  it.each([
    ["/api/auth/session", "other"],
    ["/_serverFn/getGuardSession", "ui"],
    ["/api/mcp", "mcp"],
    ["/api/debug/timing", "other"],
  ] as const)("classifies HTTP path %s as %s", (path, workload) => {
    expect(classifyHttpWorkload(path)).toBe(workload);
  });

  it("separates browser documents from static assets", () => {
    expect(
      classifyHttpWorkload("/locations", new Headers({ accept: "text/html" })),
    ).toBe("ui");
    expect(
      classifyHttpWorkload(
        "/assets/app.js",
        new Headers({ accept: "application/javascript" }),
      ),
    ).toBe("other");
  });

  it("counts only TanStack Start tRPC calls as UI work", () => {
    expect(
      classifyHttpWorkload(
        "/api/trpc/location.makeTree",
        new Headers({ "x-trpc-source": "tanstack-start" }),
      ),
    ).toBe("ui");
    expect(
      classifyHttpWorkload("/api/trpc/location.makeTree", new Headers()),
    ).toBe("other");
  });

  it("classifies async-generator tRPC results as import streams", () => {
    async function* stream() {
      yield { done: 1, total: 2 };
    }

    expect(
      classifyTrpcWorkload("ui", "recipe.importCookbookStream", stream()),
    ).toBe("import-stream");
  });

  it("covers every explicitly streamed tRPC procedure", () => {
    expect([...importStreamProcedures].sort()).toEqual(
      [
        "agent.askStream",
        "ai.backfillLocationDescriptions",
        "ai.precomputeEnrichmentProposals",
        "problems.pruneAllUnusedAliasesStream",
        "problems.reparseStale",
        "product.backfillUPCImages",
        "product.createMany",
        "product.markUsdaUnavailableMany",
        "recipe.importCookbookStream",
        "recipe.importNotionSyncStream",
        "recipe.recomputeAllDurable",
        "recipe.recomputeStaleDurable",
        "recipe.reprocessCookbook",
      ].sort(),
    );
  });

  it("requires every router async generator to be classified", () => {
    const routerDirectory = join(
      dirname(fileURLToPath(import.meta.url)),
      "api/routers",
    );
    const asyncGeneratorCount = findTypeScriptFiles(routerDirectory).reduce(
      (count, file) =>
        count +
        (readFileSync(file, "utf8").match(/async\s+function\s*\*/g)?.length ??
          0),
      0,
    );

    // Streaming procedures use async generator resolvers by convention. This
    // source-level guard intentionally fails when one is added without also
    // extending the workload allowlist above.
    expect(importStreamProcedures.size).toBe(asyncGeneratorCount);
  });

  it("does not mislabel an unexpected async result as an import stream", () => {
    async function* stream() {
      yield { done: 1, total: 2 };
    }
    expect(classifyTrpcWorkload("ui", "location.makeTree", stream())).toBe(
      "ui",
    );
  });

  it.each([
    ["ui", "ui"],
    ["mcp", "mcp"],
    ["agent", "other"],
    ["api", "other"],
  ] as const)("classifies %s tRPC calls as %s", (origin, workload) => {
    expect(classifyTrpcWorkload(origin)).toBe(workload);
  });
});
