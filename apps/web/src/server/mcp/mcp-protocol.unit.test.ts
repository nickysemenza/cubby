import { mcpToolName } from "@cubby/schemas/entity-manifest";
import { mealOut, mealRecipeOut } from "@cubby/schemas/meal";
import { buildNutrition, type NutritionTotals } from "@cubby/schemas/nutrition";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { mock } from "~/lib/test/mock-schema";
import {
  ENTITY_KERNEL_ENTITIES,
  entityMcpReadCommandSchema,
} from "~/server/entity-kernel/contracts";

import { callMcpTool } from "./mcp-test-utils";
import { listMcpResourceCatalog, listMcpToolCatalog } from "./server";
import { type ExecuteEntity, registerEntityTools } from "./tools/entity.tools";

describe("MCP protocol smoke", () => {
  it("publishes command and read-only entity capabilities with a discoverable catalog", async () => {
    const [{ tools }, { resources }] = await Promise.all([
      listMcpToolCatalog(),
      listMcpResourceCatalog(),
    ]);
    const names = new Set(tools.map((tool) => tool.name));
    const entityInput = z
      .object({
        properties: z.object({ command: z.json().optional() }).optional(),
      })
      .parse(tools.find((tool) => tool.name === "entity")?.inputSchema);

    expect(names).toContain("entity");
    expect(names).toContain("get_entities");
    expect(
      tools.find((tool) => tool.name === "get_entities")?.annotations
        ?.readOnlyHint,
    ).toBe(true);
    expect(resources.map((resource) => resource.uri)).toContain(
      "entities://catalog",
    );
    expect(entityInput.properties?.command).toBeDefined();
    for (const entity of ENTITY_KERNEL_ENTITIES) {
      for (const operation of ["list", "get", "create", "update"] as const) {
        expect(names).not.toContain(mcpToolName(entity, operation));
      }
    }
    expect(names).toContain("move_inventory_entries");
    expect(names).not.toContain("delete_entity");
    expect(names).not.toContain("attach_entity");
    expect(names).not.toContain("detach_entity");
    expect(names).not.toContain("merge_entity");
  });

  it.each([
    "create",
    "update",
    "delete",
    "merge",
    "bulkUpdate",
    "attach",
    "detach",
  ])("rejects %s at the read-only command boundary", (action) => {
    expect(
      entityMcpReadCommandSchema.safeParse({
        action,
        entity: "ingredient",
        id: "ING-2ABC",
        data: {},
        ids: ["ING-2ABC"],
      }).success,
    ).toBe(false);
  });

  it("dispatches entity commands through the explicit kernel capability", async () => {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    const runEntity: ExecuteEntity = vi.fn(async (_context, command) => {
      expect(command).toMatchObject({ action: "list", entity: "expense" });
      return {
        action: "list" as const,
        entity: "expense" as const,
        items: [],
        meta: { pageIndex: 0, pageSize: 10, totalCount: 0 },
      };
    });
    registerEntityTools(server, runEntity);

    // The tool boundary validates the injected kernel capability before it
    // dispatches. The executor is mocked here, so only that capability shape
    // is exercised, not a database-backed operation.
    const entityKernel = {
      db: null,
      readDb: null,
      actorContext: null,
      usdaClient: null,
      upcLookupClient: null,
      services: null,
    };

    const result = await callMcpTool(
      server,
      "entity",
      { command: { action: "list", entity: "expense" } },
      {},
      { entityKernel },
    );

    expect(result.isError).not.toBe(true);
    expect(runEntity).toHaveBeenCalledOnce();
    expect(result.structuredContent).toMatchObject({
      action: "list",
      entity: "expense",
      meta: { pageIndex: 0, pageSize: 10, totalCount: 0 },
    });
  });

  it("projects storage-only child ids out of generic entity results", async () => {
    const totals: NutritionTotals = {
      cost: { status: "unavailable", reason: "no_data" },
      nutrition: buildNutrition((key) =>
        key === "sodium"
          ? {
              status: "complete",
              lower: 0,
              upper: null,
              coverage: { covered: 1, total: 1 },
            }
          : { status: "pending", reason: "totals_missing" },
      ),
    };
    const mealRecipe = mock(mealRecipeOut, {
      overrides: { scaledTotals: totals },
    });
    const meal = mock(mealOut, {
      overrides: { recipes: [mealRecipe], totals },
    });
    const runEntity: ExecuteEntity = async () => ({
      action: "list",
      entity: "meal",
      items: [meal],
      meta: { pageIndex: 0, pageSize: 10, totalCount: 1 },
    });
    const server = new McpServer({ name: "test", version: "1.0.0" });
    registerEntityTools(server, runEntity);

    const result = await callMcpTool(
      server,
      "entity",
      { command: { action: "list", entity: "meal" } },
      {},
      {
        entityKernel: {
          db: null,
          readDb: null,
          actorContext: null,
          usdaClient: null,
          upcLookupClient: null,
          services: null,
        },
      },
    );
    const serialized = JSON.stringify(result.structuredContent);

    expect(result.isError).not.toBe(true);
    expect(serialized).not.toContain(mealRecipe.id);
    expect(serialized).toContain(mealRecipe.recipeId);
    expect(result.structuredContent).toMatchObject({
      items: [
        {
          totals: {
            nutrition: {
              sodium: { status: "complete", lower: 0 },
              protein: { status: "pending" },
            },
          },
        },
      ],
    });
  });
});
