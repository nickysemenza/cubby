import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it, vi } from "vitest";

import { MCP_TOOLS } from "~/contracts/mcp-tools";
import { MCP_TOOL_BINDINGS } from "~/server/generated/mcp-tools.gen";

import { callMcpTool } from "./mcp-test-utils";
import { createMcpServer, listMcpToolCatalog } from "./server";
import { compiledMcpTools } from "./tools/tool-registration";

describe("MCP response policies", () => {
  it("routes kernel reads authoritatively before selecting a request database", () => {
    const entityRead = compiledMcpTools(MCP_TOOL_BINDINGS, MCP_TOOLS).find(
      (tool) => tool.name === "entity_read",
    )!;
    for (const action of ["get", "list", "search", "preview", "resolve"]) {
      expect(
        entityRead.actions.get(action)!.readPolicy({ entity: "product" }),
      ).toBe("strong");
    }
  });
  it("publishes the same page and recipe defaults that handlers apply", async () => {
    const { tools } = await listMcpToolCatalog();
    for (const name of ["activity", "usda_food"]) {
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
      tools.find((tool) => tool.name === "recipe_insights")?.inputSchema,
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
        { action: "search", query: "synthetic food", ...input },
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
        meta: { ...page, totalCount: 123 },
      });
    },
  );

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
            query: "synthetic food",
            type: "orphanedProducts",
            ...input,
          },
          {},
        );
        expect(result.isError).toBe(true);
      }
    },
  );
});
