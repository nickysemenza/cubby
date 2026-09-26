/**
 * `split_expense`'s MCP result: `originalCost`/`partsSum`/`delta`.
 *
 * The delta arithmetic itself is pure and covered in
 * `packages/schemas/src/purchase.unit.test.ts` (`splitExpenseDelta`). What
 * only a real database can prove is the ORDER the tool reads in: the original
 * Expense's cost has to be captured via `expense.getByID` BEFORE
 * `purchase.split` runs, because the split soft-deletes the original in the
 * same transaction — reading it after would 404. Driven through the real MCP
 * server (`client.callTool`) with a real request context, mirroring
 * `mcp-shortcode-boundary.integration.test.ts`.
 */

import type { UserId } from "@cubby/schemas/identifiers";
import { expenseCreateInput } from "@cubby/schemas/project";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  type CallToolResult,
  CallToolResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import type { EntityKernelContext } from "~/server/entity-kernel";
import { createExpense, getExpenseByShortcode } from "~/server/repo/expense";
import { makeExpenseInput } from "~/server/repo/repo.fixtures";
import { requireActor } from "~/server/request-context";
import { createTestRequestContext } from "~/server/testing/request-context";

import { createMcpServer } from "./server";
import { splitExpenseMcpOut } from "./tools/purchase.tools";
import type {
  McpRequestContext,
  ToolArguments,
} from "./tools/tool-registration";

async function callTool(
  name: string,
  args: ToolArguments,
  requestContext: McpRequestContext,
  entityKernel: EntityKernelContext,
): Promise<CallToolResult> {
  const server = createMcpServer();
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });

  const originalSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) =>
    originalSend(message, {
      ...options,
      authInfo: {
        token: "",
        clientId: "test",
        scopes: [],
        extra: { requestContext, entityKernel },
      },
    });

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  try {
    return CallToolResultSchema.parse(
      await client.callTool({ name, arguments: args }),
    );
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

function structured(result: CallToolResult) {
  return splitExpenseMcpOut.parse(result.structuredContent);
}

function errorText(result: CallToolResult): string {
  return JSON.stringify(result.content);
}

function workflowContext(
  db: Parameters<typeof createTestRequestContext>[0],
  userId: UserId,
) {
  return requireActor(createTestRequestContext(db, { auth: { userId } }));
}

describe("split_expense MCP tool — originalCost/partsSum/delta", () => {
  const ctx = withTestDb();
  const caller = () => workflowContext(ctx.db, ctx.actor.userId);

  it("reports a zero delta when the parts sum exactly to the original", async () => {
    const { output: original } = await createExpense(
      ctx.db,
      expenseCreateInput.parse(
        makeExpenseInput({
          name: "combo kit",
          cost: 100,
          vendor: "Split Delta Vendor",
          orderId: "SPLIT-DELTA-1",
        }),
      ),
      ctx.actor,
    );

    const result = await callTool(
      "split_expense",
      {
        expenseId: original.id,
        parts: [
          { name: "part a", cost: 70, costType: "materials", trade: "other" },
          { name: "part b", cost: 30, costType: "materials", trade: "other" },
        ],
      },
      caller(),
      workflowContext(ctx.db, ctx.actor.userId),
    );

    // oxlint-disable-next-line vitest/valid-expect -- The second argument is an assertion label for this table-driven check.
    expect(result.isError, errorText(result)).not.toBe(true);
    const out = structured(result);
    expect(out.originalCost).toBe(100);
    expect(out.partsSum).toBe(100);
    expect(out.delta).toBe(0);
  });

  it("rejects a nonconserving split and preserves the original expense", async () => {
    const { output: original } = await createExpense(
      ctx.db,
      expenseCreateInput.parse(
        makeExpenseInput({
          name: "partially refunded combo",
          cost: 100,
          vendor: "Split Delta Vendor",
          orderId: "SPLIT-DELTA-2",
        }),
      ),
      ctx.actor,
    );

    const result = await callTool(
      "split_expense",
      {
        expenseId: original.id,
        parts: [
          { name: "part a", cost: 70, costType: "materials", trade: "other" },
          { name: "part b", cost: 15, costType: "materials", trade: "other" },
        ],
      },
      caller(),
      workflowContext(ctx.db, ctx.actor.userId),
    );

    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain(
      "Split parts must conserve the original expense amount exactly.",
    );
    await expect(
      getExpenseByShortcode(ctx.db, original.id),
    ).resolves.toMatchObject({
      id: original.id,
      name: "partially refunded combo",
      cost: 100,
    });
  });

  it("returns null originalCost/delta when the original has no recorded cost", async () => {
    const { output: original } = await createExpense(
      ctx.db,
      expenseCreateInput.parse(
        makeExpenseInput({
          name: "uncosted combo",
          cost: null,
          vendor: "Split Delta Vendor",
          orderId: "SPLIT-DELTA-3",
        }),
      ),
      ctx.actor,
    );

    const result = await callTool(
      "split_expense",
      {
        expenseId: original.id,
        parts: [
          { name: "part a", cost: 5, costType: "materials", trade: "other" },
          { name: "part b", cost: 5, costType: "materials", trade: "other" },
        ],
      },
      caller(),
      workflowContext(ctx.db, ctx.actor.userId),
    );

    // oxlint-disable-next-line vitest/valid-expect -- The second argument is an assertion label for this table-driven check.
    expect(result.isError, errorText(result)).not.toBe(true);
    const out = structured(result);
    expect(out.originalCost).toBeNull();
    expect(out.partsSum).toBe(10);
    expect(out.delta).toBeNull();
  });
});
