import { fromPartial } from "@total-typescript/shoehorn";
import { eq } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { getDb } from "~/server/db/helpers";
import {
  ledgerParty,
  run as runTable,
  runApproval,
  runOperation,
} from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { requireActor } from "~/server/http/request-context";
import { createTestRequestContext } from "~/server/testing/request-context";

import { runMcpBatch } from "./batch";
import { McpOperationContext } from "./operation-context";
import { executePurchaseAgentMutation } from "./purchase-agent-protocol";
import type { ToolExtra } from "./tools/tool-registration";

// Routine permitted writes execute immediately; stable operation IDs still
// reject changed arguments and replay saved results without another write.
// A stopped Run still returns completed results, but fences new mutations.
describe("purchase-agent automatic mutations", () => {
  const ctx = withTestDb();

  it("persists summary receipts and completes a full batch replay without repeating its mutations", async () => {
    const member = await createRepoEntity(ctx, "ledgerParty", {
      name: "Synthetic summary batch member",
      kind: "member",
    });
    // Login ownership is storage-only, outside ordinary LedgerParty create input.
    await getDb(ctx.db)
      .update(ledgerParty)
      .set({ userId: ctx.actor.userId })
      .where(eq(ledgerParty.id, member.entityId));
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "account_sync",
      trigger: "manual",
    });
    const context = requireActor(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
    const extra = fromPartial<ToolExtra>({
      http: {
        authInfo: {
          extra: {
            entityKernel: context,
            operationContext: new McpOperationContext(context),
            purchaseAgent: { runId, grantId: "synthetic-summary-grant" },
          },
        },
      },
    });
    let writes = 0;
    let reads = 0;
    const config = {
      name: "synthetic.commands",
      key: "commands",
      mutation: true,
      itemInput: z.object({ label: z.string() }),
      itemOutput: z.object({ id: z.string(), value: z.number() }),
      summaryOutput: z
        .object({ id: z.string() })
        .transform((item) => ({ reference: item.id })),
      reference: (item: { id: string }) => item.id,
      run: async (
        _item: { label: string },
        _extra: ToolExtra,
        detail: "summary" | "full",
      ) => {
        expect(detail).toBe("summary");
        writes += 1;
        return { id: "synthetic-receipt", resultDetail: "summary" };
      },
      completeOutput: async (receipt: unknown) => {
        expect(receipt).toEqual({
          id: "synthetic-receipt",
          resultDetail: "summary",
        });
        reads += 1;
        return { id: "synthetic-receipt", value: 42 };
      },
    };
    const input = {
      items: [{ label: "Synthetic item" }],
      execution: {
        runId,
        operationId: "synthetic:batch",
        itemOperationIds: ["synthetic:item"],
      },
    };
    const summary = await runMcpBatch(
      config,
      { ...input, resultDetail: "summary" },
      extra,
    );
    expect(summary.results).toEqual([
      { index: 0, status: "succeeded", reference: "synthetic-receipt" },
    ]);
    expect(writes).toBe(1);
    expect(reads).toBe(0);
    const full = await runMcpBatch(
      config,
      { ...input, resultDetail: "full" },
      extra,
    );
    expect(full.results).toEqual([
      {
        index: 0,
        status: "succeeded",
        reference: "synthetic-receipt",
        item: { id: "synthetic-receipt", value: 42 },
      },
    ]);
    expect(writes).toBe(1);
    expect(reads).toBe(1);
  });

  it("executes without approval and replays without another mutation", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic approval member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const run = await insertWithShortcode(ctx.db, "run", {
      ledgerPartyId: party.id,
      actorUserId: ctx.actor.userId,
      actorName: "Synthetic approval actor",
      actorEmail: "approval@example.test",
      actorLedgerPartyShortcode: party.shortcode,
      actorLedgerPartyName: party.name,
      actorLedgerPartyKind: party.kind,
      trigger: "manual",
      agentSessionId: "synthetic-approval-session",
    });
    let executions = 0;
    const input = {
      db: ctx.db,
      actor: ctx.actor,
      operationContext: new McpOperationContext(
        requireActor(
          createTestRequestContext(ctx.db, {
            auth: { userId: ctx.actor.userId },
          }),
        ),
      ),
      trusted: { runId: run.id, grantId: "synthetic-grant" },
      toolName: "statement_rows.update",
      args: {
        selector: { source: "synthetic", externalIds: ["row-a", "row-b"] },
        data: { disposition: "open", dispositionNote: null },
      },
      execution: { runId: run.id, operationId: "synthetic:restore" },
      run: async () => {
        executions += 1;
        return { accepted: true };
      },
      baseExtra: fromPartial<ToolExtra>({}),
    };
    await expect(executePurchaseAgentMutation(input)).resolves.toEqual({
      accepted: true,
    });
    expect(executions).toBe(1);
    await expect(
      executePurchaseAgentMutation({
        ...input,
        args: {
          ...input.args,
          data: { disposition: "ignored", dispositionNote: null },
        },
      }),
    ).rejects.toThrow("different input");
    expect(executions).toBe(1);
    await expect(executePurchaseAgentMutation(input)).resolves.toEqual({
      accepted: true,
    });
    await expect(executePurchaseAgentMutation(input)).resolves.toEqual({
      accepted: true,
    });
    expect(executions).toBe(1);
    const [consumed] = await getDb(ctx.db)
      .select()
      .from(runApproval)
      .where(eq(runApproval.runId, run.id));
    const [operation] = await getDb(ctx.db)
      .select()
      .from(runOperation)
      .where(eq(runOperation.runId, run.id));
    expect(consumed).toBeUndefined();
    expect(operation?.state).toBe("completed");
    for (const status of ["paused", "completed", "failed"] as const) {
      await getDb(ctx.db)
        .update(runTable)
        .set({ status })
        .where(eq(runTable.id, run.id));
      await expect(executePurchaseAgentMutation(input)).resolves.toEqual({
        accepted: true,
      });
      await expect(
        executePurchaseAgentMutation({ ...input, args: { changed: true } }),
      ).rejects.toThrow("different input");
      await expect(
        executePurchaseAgentMutation({
          ...input,
          execution: {
            ...input.execution,
            operationId: `synthetic:new:${status}`,
          },
        }),
      ).rejects.toThrow("fenced");
    }
    expect(executions).toBe(1);
  });
});
