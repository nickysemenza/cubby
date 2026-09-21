import {
  allProblemsMcpSchema,
  assembleAllProblems,
  problemsCoverageSchema,
  problemsFastSchema,
  problemsTrackerSchema,
  problemsUpcSchema,
  problemsViewsSchema,
} from "@cubby/schemas/problems";
import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it, vi } from "vitest";

import { mock } from "~/lib/test/mock-schema";

import { callMcpTool } from "./mcp-test-utils";
import { createMcpServer, listMcpToolCatalog } from "./server";

describe("MCP response policies", () => {
  it("publishes the same page and recipe defaults that handlers apply", async () => {
    const { tools } = await listMcpToolCatalog();
    for (const name of ["list_problems", "search_usda_foods"]) {
      expect(
        tools.find((tool) => tool.name === name)?.inputSchema,
      ).toMatchObject({
        properties: {
          pageIndex: { default: 0, minimum: 0 },
          pageSize: { default: 25, minimum: 1, maximum: 100 },
        },
      });
    }
    expect(
      tools.find((tool) => tool.name === "explain_recipe_costing")?.inputSchema,
    ).toMatchObject({ properties: { detail: { default: "lines" } } });
  });

  it.each([
    [{}, { pageIndex: 0, pageSize: 25 }],
    [
      { pageIndex: 2, pageSize: 5 },
      { pageIndex: 2, pageSize: 5 },
    ],
  ])(
    "forwards USDA pagination and preserves complete totals: %j",
    async (input, page) => {
      const listFoods = vi.fn(async () => ({ data: [], count: 123 }));
      const result = await callMcpTool(
        createMcpServer(),
        "search_usda_foods",
        { query: "synthetic food", ...input },
        {},
        {
          entityKernel: {
            db: null,
            readDb: null,
            actorContext: null,
            usdaClient: null,
            upcLookupClient: null,
            services: null,
            usdaService: fromPartial({ listFoods }),
          },
        },
      );
      expect(result.isError).not.toBe(true);
      expect(listFoods).toHaveBeenCalledWith(
        "synthetic food",
        undefined,
        { orderBy: "relevance", direction: "asc" },
        page,
        true,
      );
      expect(result.structuredContent).toEqual({
        items: [],
        meta: { ...page, totalCount: 123 },
      });
    },
  );

  it.each(["list_problems", "search_usda_foods"])(
    "rejects invalid pagination before executing %s",
    async (tool) => {
      for (const input of [
        { pageIndex: -1 },
        { pageSize: 0 },
        { pageSize: 101 },
      ]) {
        const result = await callMcpTool(
          createMcpServer(),
          tool,
          { query: "synthetic food", type: "orphanedProducts", ...input },
          {},
        );
        expect(result.isError).toBe(true);
      }
    },
  );

  it("retains the complete legacy report for explicit countsOnly false", async () => {
    const groups = {
      fast: mock(problemsFastSchema),
      coverage: mock(problemsCoverageSchema),
      upc: mock(problemsUpcSchema),
      tracker: mock(problemsTrackerSchema),
      views: mock(problemsViewsSchema),
    };
    const result = await callMcpTool(
      createMcpServer(),
      "list_problems",
      { countsOnly: false },
      {
        problems: {
          getFast: async () => groups.fast,
          getCoverage: async () => groups.coverage,
          getUpc: async () => groups.upc,
          getTracker: async () => groups.tracker,
          getViews: async () => groups.views,
        },
      },
    );
    expect(result.isError).not.toBe(true);
    const expected = allProblemsMcpSchema.parse(assembleAllProblems(groups));
    expect(result.structuredContent).toEqual(expected);
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify(expected) },
    ]);
  });
});
