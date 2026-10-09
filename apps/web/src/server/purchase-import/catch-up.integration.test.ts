import { fromPartial } from "@total-typescript/shoehorn";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it } from "vitest";

import { setCfEnv } from "~/server/cf-env";
import { researchRetention, runTarget } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { requestCatchUp } from "~/server/services/app-open-catch-up.service";
import { recoverMissedWork } from "~/server/services/catch-up.service";

describe("app-open catch-up", () => {
  const ctx = withTestDb();
  afterEach(() => setCfEnv(undefined));

  it("retries a retirement receipt whose queue handoff failed without reopening research", async () => {
    const member = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic recovery member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const scope = await insertWithShortcode(ctx.db, "run", {
      purpose: "mail_import",
      trigger: "manual",
      status: "needs_review",
      ledgerPartyId: member.id,
      actorUserId: ctx.actor.userId,
      actorName: member.name,
      actorEmail: "recovery@example.test",
      actorLedgerPartyShortcode: member.shortcode,
      actorLedgerPartyName: member.name,
      actorLedgerPartyKind: "member",
      retiredAt: new Date(),
      retirementReason: "unrelated_source",
    });
    const [target] = await getDb(ctx.db)
      .insert(runTarget)
      .values({
        runId: scope.id,
        entityId: scope.id,
        entityKind: "run",
        state: "completed",
        outcome: "unrelated",
        targetFingerprint: "synthetic-checksum",
      })
      .returning();
    if (!target) throw new Error("Synthetic recovery target missing");
    const receiptId = crypto.randomUUID();
    await getDb(ctx.db)
      .insert(researchRetention)
      .values({
        id: receiptId,
        runId: scope.id,
        workRef: target.id,
        ledgerPartyId: member.id,
        orderMailId: crypto.randomUUID(),
        mailboxId: "synthetic-mailbox",
        messageId: "synthetic-message",
        checksum: "synthetic-checksum",
        phase: "fenced",
        plan: {
          originOperationId: "synthetic-negative",
          objectKeys: [],
          screenshotRefs: [],
          retiredRunIds: [scope.id],
          successors: [],
        },
      });
    const sent: unknown[] = [];
    let unavailable = true;
    setCfEnv(
      fromPartial<Env>({
        PURCHASE_IMPORT: fromPartial({}),
        PURCHASE_AGENT_QUEUE: {
          send: async (event: PurchaseAgentEvent) => {
            sent.push(event);
            if (unavailable)
              throw new Error("Synthetic retirement queue unavailable");
          },
        },
      }),
    );
    await expect(recoverMissedWork(ctx.db)).rejects.toThrow(
      "Synthetic retirement queue unavailable",
    );
    unavailable = false;
    await recoverMissedWork(ctx.db);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(sent[1]).toMatchObject({
      type: "research_retention",
      runId: scope.id,
      receiptId,
    });
    await getDb(ctx.db)
      .update(researchRetention)
      .set({ phase: "completed", completedAt: new Date() })
      .where(eq(researchRetention.id, receiptId));
    await recoverMissedWork(ctx.db);
    expect(sent).toHaveLength(2);
  });

  it("accepts one queue handoff across concurrent clients", async () => {
    const batches: Array<Array<{ body: { task: { kind: string } } }>> = [];
    setCfEnv(
      fromPartial<Env>({
        BACKGROUND_QUEUE: {
          sendBatch: async (
            messages: Iterable<{ body: { task: { kind: string } } }>,
          ) => {
            batches.push([...messages]);
          },
        },
      }),
    );

    const results = await Promise.all(
      Array.from({ length: 4 }, () => requestCatchUp(ctx.db)),
    );

    expect(results.filter(({ status }) => status === "queued")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "recent")).toHaveLength(3);
    expect(batches).toHaveLength(1);
    expect(batches[0]?.map(({ body }) => body.task.kind)).toEqual([
      "maintenance.recover",
      "maintenance.purchase-discovery",
    ]);
  });

  it("releases a rejected queue handoff so the next request can retry", async () => {
    let calls = 0;
    setCfEnv(
      fromPartial<Env>({
        BACKGROUND_QUEUE: {
          sendBatch: async () => {
            calls += 1;
            if (calls === 1) throw new Error("queue unavailable");
          },
        },
      }),
    );

    await expect(requestCatchUp(ctx.db)).rejects.toThrow("queue unavailable");
    await expect(requestCatchUp(ctx.db)).resolves.toEqual({ status: "queued" });
    expect(calls).toBe(2);
  });
});
import type { PurchaseAgentEvent } from "@cubby/schemas/purchase-import";
