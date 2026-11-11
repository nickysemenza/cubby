import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it, vi } from "vitest";

import {
  MCP_TOOL_BINDINGS,
  MCP_TOOL_DECLARATIONS,
} from "~/server/mcp/tool-bindings";

import { callMcpTool } from "../testing/mcp-test-utils";
import { createMcpServer } from "./server";
import { describeMcpActions } from "./tools/progressive-disclosure";
import { compiledMcpTools } from "./tools/tool-registration";

describe("MCP response policies", () => {
  it("names the failing paths of a malformed import and points at describe instead of leaving the agent to guess", async () => {
    const result = await callMcpTool(createMcpServer(), "purchase_import", {
      action: "prepare",
      input: { orders: [{}] },
    });
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    expect(text).toContain("INVALID_INPUT");
    expect(text).not.toContain("inputSchema");
    expect(text).toContain("stableOrderId");
  });

  it("publishes the same page and recipe defaults that handlers apply", () => {
    const tools = compiledMcpTools(MCP_TOOL_BINDINGS, MCP_TOOL_DECLARATIONS);
    for (const [toolName, actionName] of [
      ["activity_read", "report"],
      ["product_enrichment_read", "search"],
    ] as const) {
      const tool = tools.find((candidate) => candidate.name === toolName);
      if (!tool) throw new Error(`Missing tool ${toolName}`);
      expect(
        describeMcpActions(tool, [actionName]).actions[0]?.inputSchema,
      ).toMatchObject({
        properties: {
          cursor: { type: "string" },
          pageSize: { default: 25, minimum: 1, maximum: 100 },
        },
      });
    }
    const recipeInsights = tools.find(
      (candidate) => candidate.name === "nutrition_read",
    );
    if (!recipeInsights) throw new Error("Missing recipe_insights_read tool");
    expect(
      describeMcpActions(recipeInsights, ["costing_explanation"]).actions[0]
        ?.inputSchema,
    ).toMatchObject({ properties: { detail: { default: "lines" } } });
  });

  it("pages compact USDA search rows by cursor and preserves complete totals", async () => {
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
    const listFoods = vi.fn(async (..._args: unknown[]) => ({
      data: [row],
      count: 123,
    }));
    const search = (input: Record<string, unknown>) =>
      callMcpTool(
        createMcpServer(),
        "product_enrichment_read",
        { action: "search", input: { query: "synthetic oats", ...input } },
        { usdaService: fromPartial({ listFoods }) },
      );
    const first = await search({ pageSize: 1 });
    expect(first.isError).not.toBe(true);
    expect(first.structuredContent).toEqual({
      items: [
        expect.objectContaining({
          fdc_id: 9900001,
          description: "Synthetic rolled oats",
          nutrientsPer100: { "208": 380 },
        }),
      ],
      pageSize: 1,
      nextCursor: expect.any(String),
      totalCount: 123,
    });
    const second = await search({
      cursor: first.structuredContent?.nextCursor,
      pageSize: 1,
    });
    expect(second.isError).not.toBe(true);
    expect(listFoods.mock.calls.map((call) => call.at(3))).toEqual([
      { pageIndex: 0, pageSize: 1 },
      { pageIndex: 1, pageSize: 1 },
    ]);
  });

  it.each([
    ["activity_read", "report"],
    ["product_enrichment_read", "search"],
  ])(
    "rejects invalid or legacy paging before executing %s.%s",
    async (tool, action) => {
      for (const input of [
        { pageIndex: 1 },
        { cursor: "not-a-cursor" },
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
