/**
 * `split_expense`'s MCP-only cue: `originalCost`/`partsSum`/`delta`.
 *
 * The delta arithmetic itself is pure and covered in
 * `packages/schemas/src/purchase.unit.test.ts` (`splitExpenseDelta`). What
 * only a real database can prove is the ORDER the tool reads in: the original
 * Expense's cost has to be captured via `expense.getByID` BEFORE
 * `purchase.split` runs, because the split soft-deletes the original in the
 * same transaction — reading it after would 404. Driven through the real MCP
 * server (`client.callTool`) with a real tRPC caller
 * (`createTestCaller(domainRouter, ...)`), mirroring
 * `mcp-shortcode-boundary.integration.test.ts`.
 */

import type { UserId } from "@cubby/schemas/identifiers";
import { expenseCreateInput } from "@cubby/schemas/project";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import type { DomainCaller } from "~/server/api/domain";
import { domainRouter } from "~/server/api/domain";
import { createTestCaller, createTestTRPCContext } from "~/server/api/trpc";
import type { EntityKernelContext } from "~/server/entity-kernel";
import { createExpense } from "~/server/repo/expense";
import { makeExpenseInput } from "~/server/repo/repo.fixtures";
import { createMcpServer } from "./server";

async function callTool(
  name: string,
  args: Record<string, unknown>,
  caller: DomainCaller,
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
        extra: { caller, entityKernel },
      },
    });

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  try {
    return (await client.callTool({ name, arguments: args })) as CallToolResult;
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

function structured(result: CallToolResult): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

function errorText(result: CallToolResult): string {
  return JSON.stringify(result.content);
}

function kernelContext(
  db: Parameters<typeof createTestTRPCContext>[0],
  userId: UserId,
): EntityKernelContext {
  const context = createTestTRPCContext(db, { auth: { userId } });
  if (!context.actorContext) throw new Error("Test actor context is missing");
  return { ...context, actorContext: context.actorContext };
}

describe("split_expense MCP tool — originalCost/partsSum/delta", () => {
  const ctx = withTestDb();

  it("reports a zero delta when the parts sum exactly to the original", async () => {
    const caller = createTestCaller(domainRouter, ctx.db);
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
      caller,
      kernelContext(ctx.db, ctx.actor.userId),
    );

    expect(result.isError, errorText(result)).not.toBe(true);
    const out = structured(result);
    expect(out.originalCost).toBe(100);
    expect(out.partsSum).toBe(100);
    expect(out.delta).toBe(0);
  });

  it("reports a non-zero delta as a cue, without rejecting the split", async () => {
    const caller = createTestCaller(domainRouter, ctx.db);
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

    // A one-sided discount: the parts add up to less than the original —
    // exactly the "legitimate mismatch" the tool description calls out.
    const result = await callTool(
      "split_expense",
      {
        expenseId: original.id,
        parts: [
          { name: "part a", cost: 70, costType: "materials", trade: "other" },
          { name: "part b", cost: 15, costType: "materials", trade: "other" },
        ],
      },
      caller,
      kernelContext(ctx.db, ctx.actor.userId),
    );

    expect(result.isError, errorText(result)).not.toBe(true);
    const out = structured(result);
    expect(out.originalCost).toBe(100);
    expect(out.partsSum).toBe(85);
    expect(out.delta).toBe(-15);
    // Not a gate: both parts were still created despite the mismatch.
    expect((out.items as unknown[]).length).toBe(2);
  });

  it("returns null originalCost/delta when the original has no recorded cost", async () => {
    const caller = createTestCaller(domainRouter, ctx.db);
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
      caller,
      kernelContext(ctx.db, ctx.actor.userId),
    );

    expect(result.isError, errorText(result)).not.toBe(true);
    const out = structured(result);
    expect(out.originalCost).toBeNull();
    expect(out.partsSum).toBe(10);
    expect(out.delta).toBeNull();
  });
});
