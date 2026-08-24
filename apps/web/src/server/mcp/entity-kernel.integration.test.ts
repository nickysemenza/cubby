import { unsafeUserId } from "@cubby/schemas/identifiers";
import { wishCreateInput, wishOut } from "@cubby/schemas/wish";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { mock } from "~/lib/test/mock-schema";
import { createTestTRPCContext } from "~/server/api/trpc";
import type { EntityKernelContext } from "~/server/entity-kernel";
import { callMcpTool } from "./mcp-test-utils";
import { registerEntityTools } from "./tools/entity.tools";

describe("MCP entity kernel boundary", () => {
  const ctx = withTestDb("mcp");

  it("runs a real protocol-to-kernel shortcode round trip", async () => {
    const entityKernel = createTestTRPCContext(ctx.db, {
      auth: { userId: unsafeUserId("test-user-id") },
    }) as EntityKernelContext;
    const callEntity = (command: Record<string, unknown>) => {
      const server = new McpServer({ name: "test", version: "1.0.0" });
      registerEntityTools(server);
      return callMcpTool(server, "entity", { command }, {}, { entityKernel });
    };

    const created = await callEntity({
      action: "create",
      entity: "wish",
      data: mock(wishCreateInput, {
        overrides: { name: "MCP kernel boundary wish" },
      }),
    });
    expect(created.isError).not.toBe(true);
    const createdWish = wishOut.parse(
      (created.structuredContent as { item: unknown }).item,
    );

    const fetched = await callEntity({
      action: "get",
      entity: "wish",
      id: createdWish.id,
    });
    expect(fetched.isError).not.toBe(true);
    expect(
      wishOut.parse((fetched.structuredContent as { item: unknown }).item).name,
    ).toBe("MCP kernel boundary wish");

    const wrongPrefix = await callEntity({
      action: "get",
      entity: "wish",
      id: "VND-ABC123",
    });
    expect(wrongPrefix.isError).toBe(true);
  });
});
