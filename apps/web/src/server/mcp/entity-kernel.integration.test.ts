import { testUserId } from "@cubby/schemas/testing";
import { wishCreateInput, wishOut } from "@cubby/schemas/wish";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { mock } from "~/lib/test/mock-schema";
import {
  entityKernelContextSchema,
  executeEntity,
} from "~/server/entity-kernel";
import { requireActor } from "~/server/request-context";
import { createTestRequestContext } from "~/server/testing/request-context";
import { executeWorkflow } from "~/server/workflow-runtime";
import { askAgentStreamWorkflow } from "~/server/workflows/agent.server";

import { callMcpTool } from "./mcp-test-utils";
import { registerEntityTools } from "./tools/entity.tools";
import type { ToolArguments } from "./tools/tool-registration";

const wishResultSchema = z.object({ item: wishOut });

describe("MCP entity kernel boundary", () => {
  const ctx = withTestDb("mcp");

  it("acquires the authenticated read-only assistant tools through its declared lifecycle", async () => {
    const context = requireActor(
      createTestRequestContext(ctx.db, {
        auth: { userId: ctx.actor.userId },
      }),
    );
    const input = { query: "Find ingredients" };
    const definition = askAgentStreamWorkflow.definition;
    const resource = await executeWorkflow(definition.acquire, {
      context,
      input,
    });
    try {
      const names = resource.tools.map((tool) => tool.name);
      expect(names).toContain("get_entities");
      expect(names).not.toContain("entity");
      expect(
        names.every((name) => /^(list_|get_|search_|find_)/.test(name)),
      ).toBe(true);
      expect(
        await executeWorkflow(definition.complete, {
          context,
          input: { input, resource },
        }),
      ).toEqual([{ type: "done", sources: [], toolCalls: [] }]);
    } finally {
      await executeWorkflow(definition.release, {
        context,
        input: { input, resource },
      });
    }
  });

  it("executes generated create, partial update, bulk marking, and delete definitions", async () => {
    const context = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, {
        auth: { userId: testUserId("test-user-id") },
      }),
    );
    const created = await executeEntity(context, {
      action: "create",
      entity: "ingredient",
      data: {
        name: "Kernel staple",
        aliases: [],
        naKinds: [],
        usuallyOnHand: true,
      },
    });
    const id = created.item.id;
    expect(created.item.usuallyOnHand).toBe(true);
    const updated = await executeEntity(context, {
      action: "update",
      entity: "ingredient",
      id,
      data: { name: "Renamed kernel staple" },
    });
    expect(updated.item).toMatchObject({
      name: "Renamed kernel staple",
      usuallyOnHand: true,
    });
    await executeEntity(context, {
      action: "bulkUpdate",
      entity: "ingredient",
      ids: [id],
      data: { usuallyOnHand: false },
    });
    const read = await executeEntity(context, {
      action: "get",
      entity: "ingredient",
      id,
      missing: "error",
    });
    expect(read.item?.usuallyOnHand).toBe(false);
    const removed = await executeEntity(context, {
      action: "delete",
      entity: "ingredient",
      ids: [id],
    });
    expect(removed.deletedReferences).toHaveLength(1);
    const missing = await executeEntity(context, {
      action: "get",
      entity: "ingredient",
      id,
      missing: "null",
    });
    expect(missing.item).toBeNull();
  });

  it("runs a real protocol-to-kernel shortcode round trip", async () => {
    const entityKernel = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, {
        auth: { userId: testUserId("test-user-id") },
      }),
    );
    const callEntity = (command: ToolArguments, tool = "entity") => {
      const server = new McpServer({ name: "test", version: "1.0.0" });
      registerEntityTools(server);
      return callMcpTool(server, tool, { command }, {}, { entityKernel });
    };

    const created = await callEntity({
      action: "create",
      entity: "wish",
      data: mock(wishCreateInput, {
        overrides: { name: "MCP kernel boundary wish" },
      }),
    });
    expect(created.isError).not.toBe(true);
    const createdWish = wishResultSchema.parse(created.structuredContent).item;

    const fetched = await callEntity(
      {
        action: "get",
        entity: "wish",
        id: createdWish.id,
      },
      "get_entities",
    );
    expect(fetched.isError).not.toBe(true);
    expect(wishResultSchema.parse(fetched.structuredContent).item.name).toBe(
      "MCP kernel boundary wish",
    );

    const wrongPrefix = await callEntity({
      action: "get",
      entity: "wish",
      id: "VND-ABC123",
    });
    expect(wrongPrefix.isError).toBe(true);
  });
});
