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

  it("uses the cached read handle only for user-facing search operations", () => {
    const browser = read("./search-browser.server.ts");
    const mcpCaller = read("./mcp/workflow-caller.ts");
    const find = between(
      browser,
      "export const findSearchHitsForBrowser",
      "export const inspectSearchDocumentHealthForBrowser",
    );
    const documentHealth = between(
      browser,
      "export const inspectSearchDocumentHealthForBrowser",
      "export const repairSearchDocumentsForBrowser",
    );
    const repairDocuments = between(
      browser,
      "export const repairSearchDocumentsForBrowser",
      "export const findRelatedSearchHitsForBrowser",
    );
    const related = between(
      browser,
      "export const findRelatedSearchHitsForBrowser",
      "export const inspectSearchDebugForBrowser",
    );
    const debug = between(
      browser,
      "export const inspectSearchDebugForBrowser",
      "export const enqueueEmbeddingBackfillForBrowser",
    );
    const mutations = browser.slice(
      browser.indexOf("export const enqueueEmbeddingBackfillForBrowser"),
    );
    const mcpSearch = between(mcpCaller, "search: {", "statementRow: {");

    expect(find).toContain("findSearchHitsWorkflow(context.readDb");
    expect(related).toContain("findRelatedSearchHitsWorkflow(context.readDb");
    expect(mcpSearch).toContain("findSearchHitsWorkflow(context.readDb");
    expect(mcpSearch).toContain("findRelatedSearchHitsWorkflow(context.readDb");
    expect(mcpSearch).toContain("findSimilarEntitiesWorkflow(context.readDb");

    for (const authoritative of [
      documentHealth,
      repairDocuments,
      debug,
      mutations,
    ]) {
      expect(authoritative).toMatch(/context\.db/u);
      expect(authoritative).not.toMatch(/context\.readDb/u);
    }
  });

  it("routes generic Start filter options through readDb", () => {
    const source = read("./entity-runtime.server.ts");

    expect(source).toContain("getFilterOptions(context.readDb, input)");
    expect(source).not.toContain("getFilterOptions(context.db, input)");
  });

  it("keeps generic Start reads on the kernel action seam", () => {
    const runtime = read("./entity-runtime.server.ts");

    expect(runtime).toContain("executeEntity(context");
    expect(runtime).toContain('action: "list"');
    expect(runtime).toContain('action: "get"');
  });

  it("keeps correctness-sensitive and non-browser API surfaces authoritative", () => {
    const authoritativeSurfaces = [
      ["./problems-browser.server.ts", "./workflows/problems.server.ts"],
      ["./location-browser.server.ts", "./workflows/location.server.ts"],
      ["./inventory-browser.server.ts", "./workflows/inventory.server.ts"],
      [
        "./background-batch-browser.server.ts",
        "./workflows/background-jobs.server.ts",
      ],
      ["./task-browser.server.ts", "./workflows/task.server.ts"],
      ["./oauth-browser.server.ts"],
      ["./agent-browser.server.ts", "./workflows/agent.server.ts"],
      ["./mcp-browser.server.ts", "./workflows/mcp-browser.server.ts"],
      [
        "./recipe-browser.server.ts",
        "./workflows/recipe.server.ts",
        "./workflows/recipe-import.server.ts",
      ],
    ];

    for (const paths of authoritativeSurfaces) {
      const source = paths.map(read).join("\n");
      expect(source, paths.join(", ")).toMatch(
        /(?:context|ctx|c)\.db|readPolicy: "strong"/u,
      );
      expect(source, paths.join(", ")).not.toMatch(
        /(?:context|ctx|c)\.readDb/u,
      );
    }

    const agentWorkflow = read("./workflows/agent.server.ts");
    expect(agentWorkflow).toContain("readDb: context.db");
    expect(agentWorkflow).not.toContain("readDb: context.readDb");

    const dataQualityTools = read("./mcp/tools/data-quality.tools.ts");
    const entityIntegrityTools = read("./mcp/tools/entity-integrity.tools.ts");
    const sharedTools = read("./mcp/tools/_shared.ts");

    expect(dataQualityTools).toContain("getCaller(extra)");
    expect(dataQualityTools).not.toContain("getReadCaller(extra)");
    expect(entityIntegrityTools).toContain("registerRouterTool(server");
    expect(sharedTools).toContain("config.call(\n        getCaller(extra)");
  });

  it("allows only MCP entity list/search and search tools onto bounded-stale reads", () => {
    const route = read("../routes/api/mcp.ts");
    const searchTools = read("./mcp/tools/search.tools.ts");
    const sharedTools = read("./mcp/tools/_shared.ts");

    expect(route).toContain("const caller = createMcpWorkflowCaller(ctx)");
    expect(route).toContain("readDb: boundedStaleDb");
    expect(route).toContain("readCaller,");
    expect(route).toContain("entityKernel: {");
    expect(route).toContain("db: ctx.db");
    expect(searchTools).toContain("getReadCaller(extra)");
    expect(searchTools).not.toContain("getCaller(extra)");
    expect(sharedTools).toContain("getCaller(extra)");
  });
});
