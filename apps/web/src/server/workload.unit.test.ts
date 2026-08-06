import { describe, expect, it } from "vitest";
import {
  classifyHttpWorkload,
  classifyTrpcWorkload,
  importStreamProcedures,
} from "./workload";

describe("performance workload classification", () => {
  it.each([
    ["/api/auth/session", "other"],
    ["/_serverFn/getGuardSession", "other"],
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
