import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");

const between = (source: string, start: string, end: string) => {
  const startAt = source.indexOf(start);
  if (startAt < 0) throw new Error(`Missing source marker: ${start}`);
  const endAt = source.indexOf(end, startAt + start.length);
  return source.slice(startAt, endAt < 0 ? undefined : endAt);
};

describe("cached-read policy", () => {
  it("uses readDb for kernel lists and search, not details or mutations", () => {
    const source = read("./entity-kernel/execute.ts");

    const get = between(source, 'case "get":', 'case "list":');
    const list = between(source, 'case "list":', 'case "search":');
    const search = between(source, 'case "search":', 'case "create":');
    const mutations = source.slice(source.indexOf('case "create":'));

    expect(list).toMatch(/readDb/u);
    expect(search).toMatch(/readDb/u);
    expect(get).not.toMatch(/readDb/u);
    expect(mutations).not.toMatch(/readDb/u);
  });

  it("uses the cached read handle only for user-facing search procedures", () => {
    const source = read("./api/routers/search.ts");
    const find = between(source, "find:", "documentHealth:");
    const documentHealth = between(
      source,
      "documentHealth:",
      "repairDocuments:",
    );
    const repairDocuments = between(source, "repairDocuments:", "related:");
    const related = between(source, "related:", "similar:");
    const similar = between(source, "similar:", "debug:");
    const debug = between(source, "debug:", "enqueueEmbeddingBackfill:");
    const mutations = source.slice(source.indexOf("enqueueEmbeddingBackfill:"));

    expect(find).toContain("findSearchHits(ctx.readDb");
    expect(related).toContain("findRelatedSearchHits(ctx.readDb");
    expect(similar).toContain("findSimilarEntitiesForPair(ctx.readDb");

    for (const authoritative of [
      documentHealth,
      repairDocuments,
      debug,
      mutations,
    ]) {
      expect(authoritative).toContain("ctx.db");
      expect(authoritative).not.toMatch(/ctx\.readDb/u);
    }
  });

  it("routes generic Start filter options through readDb", () => {
    const source = read("../entities/entity-filter-options.ts");

    expect(source).toContain("getFilterOptions(context.readDb, data)");
    expect(source).not.toContain("getFilterOptions(context.db, data)");
  });

  it("keeps generic Start reads on the kernel action seam", () => {
    const list = read("../entities/entity-list.ts");
    const detail = read("../entities/entity-detail.ts");
    const mutation = read("../entities/entity-mutation.ts");

    expect(list).toContain("executeEntity(context");
    expect(list).toContain('action: "list"');
    expect(detail).toContain("executeEntity(context");
    expect(detail).toContain('action: "get"');
    expect(mutation).toContain("executeEntity(context");
  });

  it("keeps correctness-sensitive and non-browser API surfaces authoritative", () => {
    const authoritativeFiles = [
      "./api/routers/problems.ts",
      "./api/routers/location.ts",
      "./api/routers/inventory.ts",
      "./api/routers/background-jobs.ts",
      "./api/routers/task.ts",
      "./api/routers/oauth.ts",
      "./api/routers/data-quality.ts",
      "./api/routers/entity-integrity.ts",
      "./api/routers/agent.ts",
      "./api/routers/mcp.ts",
      "./api/routers/recipe.ts",
      "./api/routers/recipe/analysis.ts",
    ];

    for (const path of authoritativeFiles) {
      expect(read(path), path).not.toMatch(/ctx\.readDb/u);
    }
  });

  it("keeps compatibility list procedures on the entity kernel seam", () => {
    const source = read("./api/entity-compatibility.ts");

    expect(source).toContain('action: "list"');
    expect(source).toContain("executeEntity(ctx");
    expect(source).not.toContain("getFilterOptions");

    const compatibilityRouters = [
      "./api/routers/expense.ts",
      "./api/routers/financial-account.ts",
      "./api/routers/financial-transaction.ts",
      "./api/routers/ingredient.ts",
      "./api/routers/inventory.ts",
      "./api/routers/location.ts",
      "./api/routers/meal.ts",
      "./api/routers/product.ts",
      "./api/routers/project.ts",
      "./api/routers/purchase.ts",
      "./api/routers/recipe/crud.ts",
      "./api/routers/task.ts",
      "./api/routers/vendor.ts",
      "./api/routers/wish.ts",
    ];
    for (const path of compatibilityRouters) {
      expect(read(path), path).toContain(
        "createEntityListCompatibilityProcedure",
      );
    }
  });

  it("allows only MCP entity list/search and search tools onto bounded-stale reads", () => {
    const route = read("../routes/api/mcp.ts");
    const searchTools = read("./mcp/tools/search.tools.ts");
    const sharedTools = read("./mcp/tools/_shared.ts");

    expect(route).toContain("const caller = createCaller(ctx)");
    expect(route).toContain("readDb: boundedStaleDb");
    expect(route).toContain("readCaller,");
    expect(route).toContain("entityKernel: {");
    expect(route).toContain("db: ctx.db");
    expect(searchTools).toContain("getReadCaller(extra)");
    expect(searchTools).not.toContain("getCaller(extra)");
    expect(sharedTools).toContain("getCaller(extra)");
  });
});
