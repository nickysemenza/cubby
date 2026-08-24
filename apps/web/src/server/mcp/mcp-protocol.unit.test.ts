import { mcpToolName } from "@cubby/schemas/entity-manifest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { ENTITY_KERNEL_ENTITIES } from "~/server/entity-kernel/contracts";
import { callMcpTool } from "./mcp-test-utils";
import { listMcpResourceCatalog, listMcpToolCatalog } from "./server";
import { type ExecuteEntity, registerEntityTools } from "./tools/entity.tools";

describe("MCP protocol smoke", () => {
  it("replaces kernel CRUD names with one entity tool and a discoverable catalog", async () => {
    const [{ tools }, { resources }] = await Promise.all([
      listMcpToolCatalog(),
      listMcpResourceCatalog(),
    ]);
    const names = new Set(tools.map((tool) => tool.name));
    const entityInput = tools.find((tool) => tool.name === "entity")
      ?.inputSchema as { properties?: { command?: unknown } };

    expect(names).toContain("entity");
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

    const result = await callMcpTool(
      server,
      "entity",
      { command: { action: "list", entity: "expense" } },
      {},
      { entityKernel: {} },
    );

    expect(result.isError).not.toBe(true);
    expect(runEntity).toHaveBeenCalledOnce();
    expect(result.structuredContent).toMatchObject({
      action: "list",
      entity: "expense",
      meta: { pageIndex: 0, pageSize: 10, totalCount: 0 },
    });
  });
});
