import { fromPartial } from "@total-typescript/shoehorn";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { runApproval, runOperation } from "~/server/db/schema";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { requireActor } from "~/server/http/request-context";
import { createTestRequestContext } from "~/server/testing/request-context";

import { McpOperationContext } from "./operation-context";
import { executePurchaseAgentMutation } from "./purchase-agent-protocol";
import type { ToolExtra } from "./tools/tool-registration";

// Routine permitted writes execute immediately; stable operation IDs still
// reject changed arguments and replay saved results without another write.
describe("purchase-agent automatic mutations", () => {
  const ctx = withTestDb();

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
  });
});
