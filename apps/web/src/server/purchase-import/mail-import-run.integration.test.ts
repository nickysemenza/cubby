import { executionAuthorizationInput } from "@cubby/schemas/execution-authorization";
import { parseEntityId } from "@cubby/schemas/identifiers";
import type { PurchaseAgentEvent } from "@cubby/schemas/purchase-import";
import { mailResearchRunInput } from "@cubby/schemas/run-fields";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { account } from "~/server/db/auth.schema";
import { orderMail, mailboxMessage, run, runTarget } from "~/server/db/schema";
import {
  databaseForTransaction,
  getDb,
  withTransaction,
} from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { ensureRun } from "~/server/runs/ensure-run";
import { issueExecutionAuthorization } from "~/server/runs/execution-authorization";
import { executionAuthorizationFromInput } from "~/server/runs/execution-context";

import { startMailImport } from "./mail-import-run";

// Admission must bind original sources without a known Vendor, order, or Mac;
// replay cannot create a second Run, and stale/foreign sources cannot enter it.
describe("mail research admission", () => {
  const ctx = withTestDb();
  // The Run's admitted Emails, frozen at their admitted checksums.
  const frozenSources = async (runId: string) => {
    const [saved] = await getDb(ctx.db)
      .select({ input: run.input })
      .from(run)
      .where(eq(run.id, parseEntityId("run", runId)));
    return mailResearchRunInput.parse(saved?.input).sources;
  };
  async function source() {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Research admission member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const [mail] = await getDb(ctx.db)
      .insert(orderMail)
      .values({
        ledgerPartyId: party.id,
        mailboxId: "synthetic-mailbox",
        messageId: "synthetic-message",
        sender: "receipts@shop.example",
        subject: "Your receipt",
        receivedAt: new Date("2026-09-01T18:00:00Z"),
        rawChecksum: "a".repeat(64),
        content: {
          snippet: null,
          bodyText: "Workshop admission: $24",
          bodyHtml: null,
        },
      })
      .returning();
    if (!mail) throw new Error("Synthetic mail fixture did not persist");
    await getDb(ctx.db).insert(mailboxMessage).values({
      ledgerPartyId: party.id,
      mailboxId: mail.mailboxId,
      messageId: mail.messageId,
      checksum: mail.rawChecksum,
      classification: "related",
      classificationVersion: "synthetic-v1",
      status: "pending",
      orderMailId: mail.id,
    });
    return { party, mail };
  }
  it.each(["owned", "foreign"] as const)(
    "binds retained mail backfill only to an owned connected mailbox: %s",
    async (ownership) => {
      const { party, mail } = await source();
      await getDb(ctx.db).insert(account).values({
        id: crypto.randomUUID(),
        accountId: mail.mailboxId,
        providerId: "google",
        userId: ctx.actor.userId,
        updatedAt: new Date(),
      });
      const approval = await issueExecutionAuthorization(
        ctx.db,
        ctx.actor,
        executionAuthorizationInput.parse({
          kind: "execution_authorization",
          version: 1,
          owner: { userId: ctx.actor.userId, ledgerPartyId: party.id },
          scope: {
            kind: "backfill",
            mailboxId: mail.mailboxId,
            discovery: "all_history",
          },
          meteredBudget: { period: "lifetime", limitMicroUSD: 10_000_000 },
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      );
      if (ownership === "foreign")
        await getDb(ctx.db)
          .update(account)
          .set({ accountId: "another-mailbox" })
          .where(eq(account.userId, ctx.actor.userId));
      const [admitted] = await startMailImport(
        ctx.db,
        {
          ledgerPartyId: party.id,
          userId: ctx.actor.userId,
          mailboxId: mail.mailboxId,
          messageIds: [mail.id],
        },
        { send: async () => {} },
      );
      expect(admitted).toBeDefined();
      const [saved] = await getDb(ctx.db)
        .select()
        .from(run)
        .where(eq(run.id, parseEntityId("run", admitted!.runId)));
      expect(executionAuthorizationFromInput(saved?.input)).toEqual(
        ownership === "owned" ? approval : undefined,
      );
    },
  );
  it("refuses a historical ownership block before admitting or dispatching mail", async () => {
    const { party, mail } = await source();
    await getDb(ctx.db)
      .update(mailboxMessage)
      .set({
        status: "blocked",
        classificationVersion: "legacy-source-identity-unresolved/v1",
      })
      .where(eq(mailboxMessage.orderMailId, mail.id));
    const events: PurchaseAgentEvent[] = [];
    await expect(
      startMailImport(
        ctx.db,
        {
          ledgerPartyId: party.id,
          userId: ctx.actor.userId,
          mailboxId: mail.mailboxId,
          messageIds: [mail.id],
        },
        {
          send: async (event) => {
            events.push(event);
          },
        },
      ),
    ).rejects.toThrow(/historical.*ownership|original.*mapping/u);
    expect(events).toEqual([]);
    expect(await getDb(ctx.db).select().from(run)).toEqual([]);
    expect(await getDb(ctx.db).select().from(orderMail)).toEqual([mail]);
  });
  it("publishes admitted mail only after the enclosing transaction commits", async () => {
    const { party, mail } = await source();
    const events: unknown[] = [];
    const input = {
      ledgerPartyId: party.id,
      userId: ctx.actor.userId,
      mailboxId: mail.mailboxId,
      messageIds: [mail.id],
    };
    await expect(
      withTransaction(ctx.db, async (tx) => {
        await startMailImport(databaseForTransaction(tx), input, {
          send: async (event: PurchaseAgentEvent) => {
            events.push(event);
          },
        });
        expect(events).toEqual([]);
        throw new Error("Synthetic admission rollback");
      }),
    ).rejects.toThrow("Synthetic admission rollback");
    expect(events).toEqual([]);
    expect(await getDb(ctx.db).select().from(run)).toEqual([]);
    await withTransaction(ctx.db, async (tx) => {
      await startMailImport(databaseForTransaction(tx), input, {
        send: async (event: PurchaseAgentEvent) => {
          events.push(event);
        },
      });
      expect(events).toEqual([]);
    });
    expect(events).toHaveLength(1);
  });
  it("admits a source set once, with durable message ownership and no browser prerequisite", async () => {
    const { party, mail } = await source();
    const events: unknown[] = [];
    const queue = {
      send: async (event: PurchaseAgentEvent) => {
        events.push(event);
      },
    };
    const input = {
      ledgerPartyId: party.id,
      userId: ctx.actor.userId,
      mailboxId: mail.mailboxId,
      messageIds: [mail.id],
    };
    const first = await startMailImport(ctx.db, input, queue);
    expect(first).toHaveLength(1);
    expect(await startMailImport(ctx.db, input, queue)).toEqual(first);
    const [result] = first;
    if (!result) throw new Error("Research Run was not created");
    expect(events).toHaveLength(1);
    const [saved] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, parseEntityId("run", result.runId)));
    expect(saved).toMatchObject({
      vendorId: null,
      vendorAccountId: null,
      purpose: "mail_import",
      status: "running",
      endedAt: null,
    });
    const [ledger] = await getDb(ctx.db)
      .select()
      .from(mailboxMessage)
      .where(eq(mailboxMessage.orderMailId, mail.id));
    expect(ledger).toMatchObject({
      status: "researching",
      runId: result.runId,
    });
    expect(await frozenSources(result.runId)).toMatchObject([
      { orderMailId: mail.id, checksum: mail.rawChecksum },
    ]);
  });
  it("preserves the discovery cause on the mail child without using a retry edge", async () => {
    const { party, mail } = await source();
    const parentRunId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "background",
      trigger: "scheduled",
      status: "running",
    });
    const [started] = await startMailImport(
      ctx.db,
      {
        ledgerPartyId: party.id,
        userId: ctx.actor.userId,
        mailboxId: mail.mailboxId,
        messageIds: [mail.id],
        parentRunId,
      },
      { send: async (_event: PurchaseAgentEvent) => {} },
    );
    if (!started) throw new Error("Synthetic mail child was not created");
    const [saved] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, parseEntityId("run", started.runId)));
    expect(saved).toMatchObject({
      parentRunId,
      predecessorRunId: null,
      cause: "source_discovered",
    });
  });
  it("refuses stale and foreign source admission without creating a Run", async () => {
    const { party, mail } = await source();
    const queue = { send: async (_event: PurchaseAgentEvent) => {} };
    const input = {
      ledgerPartyId: party.id,
      userId: ctx.actor.userId,
      mailboxId: mail.mailboxId,
      messageIds: [mail.id],
    };
    await expect(
      startMailImport(
        ctx.db,
        {
          ...input,
          expectedChecksums: [
            { orderMailId: mail.id, checksum: "b".repeat(64) },
          ],
        },
        queue,
      ),
    ).rejects.toThrow(/changed/);
    await expect(
      startMailImport(
        ctx.db,
        { ...input, userId: "synthetic-other-user" },
        queue,
      ),
    ).rejects.toThrow(/member|owner/);
    expect(await getDb(ctx.db).select().from(run)).toEqual([]);
  });
  it("reuses the active owner when scoped and broad discovery batches overlap", async () => {
    const { party, mail } = await source();
    const [second] = await getDb(ctx.db)
      .insert(orderMail)
      .values({
        ledgerPartyId: party.id,
        mailboxId: mail.mailboxId,
        messageId: "synthetic-second",
        sender: mail.sender,
        subject: "Shipping update",
        receivedAt: mail.receivedAt,
        rawChecksum: "b".repeat(64),
        content: mail.content,
      })
      .returning();
    if (!second) throw new Error("Second synthetic source did not persist");
    await getDb(ctx.db).insert(mailboxMessage).values({
      ledgerPartyId: party.id,
      mailboxId: mail.mailboxId,
      messageId: second.messageId,
      checksum: second.rawChecksum,
      classification: "related",
      classificationVersion: "synthetic-v1",
      status: "pending",
      orderMailId: second.id,
    });
    const events: unknown[] = [];
    const queue = {
      send: async (event: PurchaseAgentEvent) => {
        events.push(event);
      },
    };
    const input = {
      ledgerPartyId: party.id,
      userId: ctx.actor.userId,
      mailboxId: mail.mailboxId,
      messageIds: [mail.id],
    };
    const [first] = await startMailImport(ctx.db, input, queue);
    if (!first) throw new Error("First research Run was not created");
    const overlapping = await startMailImport(
      ctx.db,
      { ...input, messageIds: [mail.id, second.id] },
      queue,
    );
    expect(overlapping).toHaveLength(2);
    expect(overlapping).toContainEqual(first);
    expect(events).toHaveLength(2);
    const [stillOwned] = await getDb(ctx.db)
      .select()
      .from(mailboxMessage)
      .where(eq(mailboxMessage.orderMailId, mail.id));
    expect(stillOwned?.runId).toBe(first.runId);
    const fresh = overlapping.find((result) => result.runId !== first.runId);
    if (!fresh) throw new Error("Fresh source was not admitted");
    expect(await frozenSources(fresh.runId)).toMatchObject([
      { orderMailId: second.id },
    ]);
  });
  it("redelivers a committed admission when the coordinator was never dispatched", async () => {
    const { party, mail } = await source();
    const events: unknown[] = [];
    const queue = {
      send: async (event: PurchaseAgentEvent) => {
        events.push(event);
      },
    };
    const input = {
      ledgerPartyId: party.id,
      userId: ctx.actor.userId,
      mailboxId: mail.mailboxId,
      messageIds: [mail.id],
    };
    const [first] = await startMailImport(ctx.db, input, queue);
    if (!first) throw new Error("Research Run was not created");
    // The durable admission survives a process exit before its first queue send.
    await getDb(ctx.db)
      .update(run)
      .set({ dispatchAttempts: 0 })
      .where(eq(run.id, parseEntityId("run", first.runId)));
    events.length = 0;
    expect(await startMailImport(ctx.db, input, queue)).toEqual([first]);
    expect(events).toHaveLength(1);
  });
  it("does not relaunch retained historical mail after Gmail excluded or deleted it", async () => {
    const { party, mail } = await source();
    await getDb(ctx.db)
      .update(mailboxMessage)
      .set({ status: "excluded", orderMailId: null })
      .where(eq(mailboxMessage.orderMailId, mail.id));
    await expect(
      startMailImport(
        ctx.db,
        {
          ledgerPartyId: party.id,
          userId: ctx.actor.userId,
          mailboxId: mail.mailboxId,
          messageIds: [mail.id],
        },
        { send: async (_event: PurchaseAgentEvent) => {} },
      ),
    ).rejects.toThrow(/excluded|deleted/);
    expect(await getDb(ctx.db).select().from(run)).toEqual([]);
  });
  it("gives each retained message its own immutable task inside one admitted Run", async () => {
    const { party, mail } = await source();
    const [second] = await getDb(ctx.db)
      .insert(orderMail)
      .values({
        ledgerPartyId: party.id,
        mailboxId: mail.mailboxId,
        messageId: "synthetic-batched-message",
        sender: mail.sender,
        subject: "A second receipt",
        receivedAt: mail.receivedAt,
        rawChecksum: "b".repeat(64),
        content: mail.content,
      })
      .returning();
    if (!second) throw new Error("Second synthetic receipt is missing");
    await getDb(ctx.db).insert(mailboxMessage).values({
      ledgerPartyId: party.id,
      mailboxId: second.mailboxId,
      messageId: second.messageId,
      checksum: second.rawChecksum,
      classification: "related",
      classificationVersion: "synthetic-v1",
      status: "pending",
      orderMailId: second.id,
    });
    const input = {
      ledgerPartyId: party.id,
      userId: ctx.actor.userId,
      mailboxId: mail.mailboxId,
      messageIds: [mail.id, second.id],
    };
    const [started] = await startMailImport(ctx.db, input, {
      send: async (_event: PurchaseAgentEvent) => {},
    });
    if (!started) throw new Error("Batch Run is missing");
    const tasks = await getDb(ctx.db)
      .select()
      .from(runTarget)
      .where(eq(runTarget.runId, started.runId));
    expect(tasks).toHaveLength(2);
    expect(tasks.map((task) => task.workKey).sort()).toEqual(
      [mail.id, second.id].sort(),
    );
    await getDb(ctx.db)
      .update(runTarget)
      .set({ state: "completed", outcome: "verified" })
      .where(eq(runTarget.id, tasks[0]!.id));
    expect(
      await startMailImport(ctx.db, input, {
        send: async (_event: PurchaseAgentEvent) => {},
      }),
    ).toEqual([started]);
    const replayed = await getDb(ctx.db)
      .select()
      .from(runTarget)
      .where(eq(runTarget.runId, started.runId));
    expect(replayed.filter((task) => task.state === "pending")).toHaveLength(1);
    expect(replayed.filter((task) => task.state === "completed")).toHaveLength(
      1,
    );
  });
});
