import { fromPartial } from "@total-typescript/shoehorn";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { runApproval, runOperation } from "~/server/db/schema";
import { controlRun } from "~/server/purchase-import/run-service";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { requireActor } from "~/server/request-context";
import { createTestRequestContext } from "~/server/testing/request-context";

import { McpOperationContext } from "./operation-context";
import { executePurchaseAgentMutation } from "./purchase-agent-protocol";
import type { ToolExtra } from "./tools/tool-registration";

// PostgreSQL jsonb reorders object keys. An exact approved replay must survive
// that round trip, reject changed values, and consume the grant only once.
describe("purchase-agent persisted mutation approval", () => {
  const ctx = withTestDb();

  it("executes an unchanged grant after jsonb storage and replays without another mutation", async () => {
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
    await expect(executePurchaseAgentMutation(input)).rejects.toThrow(
      "awaiting exact human approval",
    );
    expect(executions).toBe(0);
    await controlRun(ctx.db, ctx.actor, {
      runPublicId: run.shortcode,
      action: "approve",
      operationId: input.execution.operationId,
    });
    const [approval] = await getDb(ctx.db)
      .select()
      .from(runApproval)
      .where(eq(runApproval.runId, run.id));
    expect(approval?.state).toBe("granted");
    // Prove the test crosses the real jsonb key-order boundary.
    expect(JSON.stringify(approval?.args)).not.toBe(
      JSON.stringify({ toolName: input.toolName, params: input.args }),
    );
    await expect(
      executePurchaseAgentMutation({
        ...input,
        args: {
          ...input.args,
          data: { disposition: "ignored", dispositionNote: null },
        },
      }),
    ).rejects.toThrow("different input");
    expect(executions).toBe(0);
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
    expect(consumed?.state).toBe("consumed");
    expect(operation?.state).toBe("completed");
  });
});
