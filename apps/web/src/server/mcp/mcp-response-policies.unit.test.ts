import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it, vi } from "vitest";

import {
  MCP_TOOL_BINDINGS,
  MCP_TOOL_DECLARATIONS,
} from "~/server/generated/mcp-tools.gen";

import { callMcpTool } from "../testing/mcp-test-utils";
import { createMcpServer } from "./server";
import { describeMcpActions } from "./tools/progressive-disclosure";
import { compiledMcpTools } from "./tools/tool-registration";

describe("MCP response policies", () => {
  it("returns the live action contract with a malformed import instead of leaving the agent to guess", async () => {
    const result = await callMcpTool(createMcpServer(), "purchase_import", {
      action: "prepare",
      input: { orders: [{}] },
    });
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    expect(text).toContain("INVALID_INPUT");
    expect(text).toContain("inputSchema");
    expect(text).toContain("stableOrderId");
    expect(text).toContain("printedGrandTotal");
    expect(text).toContain("productUrl");
  });

  it("publishes the same page and recipe defaults that handlers apply", () => {
    const tools = compiledMcpTools(MCP_TOOL_BINDINGS, MCP_TOOL_DECLARATIONS);
    for (const [toolName, actionName] of [
      ["activity_read", "report"],
      ["usda_food", "search"],
    ] as const) {
      const tool = tools.find((candidate) => candidate.name === toolName);
      if (!tool) throw new Error(`Missing tool ${toolName}`);
      expect(
        describeMcpActions(tool, [actionName]).actions[0]?.inputSchema,
      ).toMatchObject({
        properties: {
          pageIndex: { default: 0, minimum: 0 },
          pageSize: { default: 25, minimum: 1, maximum: 100 },
        },
      });
    }
    const recipeInsights = tools.find(
      (candidate) => candidate.name === "recipe_insights_read",
    );
    if (!recipeInsights) throw new Error("Missing recipe_insights_read tool");
    expect(
      describeMcpActions(recipeInsights, ["costing_explanation"]).actions[0]
        ?.inputSchema,
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
        "usda_food",
        {
          action: "search",
          input: { query: "synthetic food", ...input },
        },
        { usdaService: fromPartial({ listFoods }) },
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
        meta: { ...page, totalCount: 123, hasNextPage: true },
      });
    },
  );

  it("projects compact USDA search rows, which carry no nutrient summary", async () => {
    // A complete member row: the runner validates the member's own output
    // before the MCP projection slims it.
    const row = {
      fdc_id: 9900001,
      description: "Synthetic rolled oats",
      inferredUnitMappings: [],
      foodInfo: {
        data_type: "foundation_food",
        description: "Synthetic rolled oats",
      },
      brandedFoodInfo: null,
      legacyFoodInfo: null,
      nutritionInfo: { nutrientsPer100: { "208": 380 } },
      portionInfoRaw: [],
      linkedProducts: [],
    };
    const result = await callMcpTool(
      createMcpServer(),
      "usda_food",
      { action: "search", input: { query: "synthetic oats" } },
      {
        usdaService: fromPartial({
          listFoods: async () => ({ data: [row], count: 1 }),
        }),
      },
    );
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      items: [
        {
          fdc_id: 9900001,
          description: "Synthetic rolled oats",
          nutrientsPer100: { "208": 380 },
        },
      ],
    });
  });

  it.each([
    ["activity", "problems"],
    ["usda_food", "search"],
  ])(
    "rejects invalid pagination before executing %s.%s",
    async (tool, action) => {
      for (const input of [
        { pageIndex: -1 },
        { pageSize: 0 },
        { pageSize: 101 },
      ]) {
        const result = await callMcpTool(
          createMcpServer(),
          tool,
          {
            action,
            input: {
              query: "synthetic food",
              type: "orphanedProducts",
              ...input,
            },
          },
          {},
        );
        expect(result.isError).toBe(true);
      }
    },
  );
});
