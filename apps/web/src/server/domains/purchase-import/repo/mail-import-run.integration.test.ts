import { parseEntityId, runShortcode } from "@cubby/schemas/identifiers";
import { coordinatorModelFor } from "@cubby/schemas/import-run-agent";
import type { PurchaseAgentEvent } from "@cubby/schemas/purchase-import";
import { mailResearchRunInput } from "@cubby/schemas/run-fields";
import { gatewayFetchThrough } from "@cubby/shared/ai/gateway-request";
import { sha256Hex } from "@cubby/shared/sha256";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import {
  databaseForTransaction,
  getDb,
  withTransaction,
} from "~/server/db/helpers";
import {
  aiUsage,
  orderMail,
  email as emailTable,
  run,
  runOperation,
} from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { paidRunPreflight } from "~/server/domains/run/service/execution-transport";
import { entityKernelContextSchema } from "~/server/entity-kernel";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { createMcpServer } from "~/server/mcp/server";
import {
  callMcpTool,
  kernelRequestContext,
} from "~/server/testing/mcp-test-utils";
import { createTestRequestContext } from "~/server/testing/request-context";

import { settleMail } from "../operations/mail-tool";
import { retainedMailFixture } from "../operations/order-import.fixtures";
import { startAgentRunFixture } from "../service/import-run.fixtures";
import { writeOutcomeReceipts } from "../service/run-outcome.fixtures";
import { startMailImport } from "./mail-import-run";
import { transferMailRunSources } from "./mail-run-membership";
import * as sourceIdentity from "./mail-source-identity";
import { controlRun, loadRunDetail } from "./run-service";

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
    const mail = await retainedMailFixture(ctx.db, {
      ledgerPartyId: party.id,
      mailboxId: "synthetic-mailbox",
      messageId: "synthetic-message",
      sender: "receipts@shop.example",
      subject: "Your receipt",
      receivedAt: new Date("2026-09-01T18:00:00Z"),
      checksum: "a".repeat(64),
      content: {
        snippet: null,
        bodyText: "Workshop admission: $24",
        bodyHtml: null,
      },
    });
    if (!mail) throw new Error("Synthetic mail fixture did not persist");
    return { party, mail };
  }
  it("preserves the parent Email outcome after a retry transfers its live assignment", async () => {
    const { party, mail } = await source();
    const [admitted] = await startMailImport(
      ctx.db,
      {
        ledgerPartyId: party.id,
        userId: ctx.actor.userId,
        messageIds: [mail.id],
      },
      { send: async () => {} },
    );
    if (!admitted) throw new Error("Synthetic parent missing");
    await settleMail(ctx.db, {
      mail,
      importRunId: parseEntityId("run", admitted.runId),
      status: "blocked",
      detail: "Synthetic ambiguous source needs review",
    });
    const parent = (
      await getDb(ctx.db)
        .select()
        .from(run)
        .where(eq(run.id, parseEntityId("run", admitted.runId)))
    )[0]!;
    const before = (await loadRunDetail(ctx.db, parent.shortcode)).targets;
    const child = await insertWithShortcode(ctx.db, "run", {
      ledgerPartyId: party.id,
      actorLedgerPartyShortcode: party.shortcode,
      actorLedgerPartyName: party.name,
      actorLedgerPartyKind: "member",
      actorUserId: ctx.actor.userId,
      actorName: "Synthetic review member",
      actorEmail: "member@example.test",
      purpose: "mail_import",
      trigger: "manual",
      status: "running",
      input: parent.input,
    });
    await withTransaction(ctx.db, (tx) =>
      transferMailRunSources(tx, parent.id, child.id),
    );
    await getDb(ctx.db)
      .update(emailTable)
      .set({ status: "completed" })
      .where(eq(emailTable.runId, child.id));
    expect((await loadRunDetail(ctx.db, parent.shortcode)).targets).toEqual(
      before,
    );
    expect(before).toMatchObject([
      {
        targetType: "email",
        targetShortcode: expect.stringMatching(/^EML-/),
        targetName: "Your receipt",
        state: "unresolved",
        outcome: "ambiguous",
        warning: "Synthetic ambiguous source needs review",
      },
    ]);
  });
  it("preserves a migrated blocked receipt after its successor completes and the live Email changes", async () => {
    const { party, mail } = await source();
    const [admitted] = await startMailImport(
      ctx.db,
      {
        ledgerPartyId: party.id,
        userId: ctx.actor.userId,
        messageIds: [mail.id],
      },
      { send: async () => {} },
    );
    if (!admitted) throw new Error("Synthetic migrated parent missing");
    const db = getDb(ctx.db);
    const parent = await db.query.run.findFirst({
      where: eq(run.id, parseEntityId("run", admitted.runId)),
    });
    if (!parent) throw new Error("Synthetic migrated parent missing");
    const fingerprint = await sha256Hex(
      JSON.stringify([mail.id, mail.rawChecksum, "synthetic-legacy-mail/v1"]),
    );
    await writeOutcomeReceipts(ctx.db, [
      {
        runId: parent.id,
        entityKind: "run",
        entityId: parent.id,
        workKey: mail.id,
        sourceKind: "mail_message",
        sourceExternalKey: mail.id,
        targetFingerprint: fingerprint,
        state: "unresolved",
        outcome: "ambiguous",
        warning: "Synthetic migrated source needs review",
        completedAt: new Date("2026-09-02T18:00:00Z"),
      },
    ]);
    await db
      .update(runOperation)
      .set({ operationId: `migrated-target:${crypto.randomUUID()}` })
      .where(eq(runOperation.runId, parent.id));
    await db
      .update(emailTable)
      .set({
        status: "blocked",
        classificationReason: "Synthetic current classification",
      })
      .where(eq(emailTable.runId, parent.id));
    const receipts = await db.select().from(runOperation);
    const before = (await loadRunDetail(ctx.db, parent.shortcode)).targets;
    expect(before).toMatchObject([
      {
        state: "unresolved",
        outcome: "ambiguous",
        warning: "Synthetic migrated source needs review",
      },
    ]);
    const child = await insertWithShortcode(ctx.db, "run", {
      ledgerPartyId: party.id,
      actorLedgerPartyShortcode: party.shortcode,
      actorLedgerPartyName: party.name,
      actorLedgerPartyKind: "member",
      actorUserId: ctx.actor.userId,
      actorName: "Synthetic review member",
      actorEmail: "member@example.test",
      purpose: "mail_import",
      trigger: "manual",
      status: "running",
      input: parent.input,
    });
    await withTransaction(ctx.db, (tx) =>
      transferMailRunSources(tx, parent.id, child.id),
    );
    await settleMail(ctx.db, {
      mail,
      importRunId: child.id,
      status: "completed",
      detail: "Synthetic successor resolved the source",
    });
    await db
      .update(emailTable)
      .set({
        checksum: "b".repeat(64),
        classificationReason: "Synthetic later classification",
      })
      .where(eq(emailTable.runId, child.id));
    expect((await loadRunDetail(ctx.db, parent.shortcode)).targets).toEqual(
      before,
    );
    expect(
      await db
        .select()
        .from(runOperation)
        .where(eq(runOperation.runId, parent.id)),
    ).toEqual(receipts);
  });
  it("refuses classification-only discovery admission even when content is retained", async () => {
    const { party, mail } = await source();
    await getDb(ctx.db)
      .update(emailTable)
      .set({ executionPolicy: "classification_only" })
      .where(eq(emailTable.orderMailId, mail.id));
    const parent = await ensureRun(ctx.db, ctx.actor, {
      purpose: "mail_discovery",
      trigger: "scheduled",
      input: {
        mailboxId: mail.mailboxId,
        scopedQueries: [],
        executionPolicy: "classification_only",
      },
    });
    const events: PurchaseAgentEvent[] = [];
    await expect(
      startMailImport(
        ctx.db,
        {
          ledgerPartyId: party.id,
          userId: ctx.actor.userId,
          messageIds: [mail.id],
          parentRunId: parent,
        },
        {
          send: async (event) => {
            events.push(event);
          },
        },
      ),
    ).rejects.toThrow(/classification.only/iu);
    expect(events).toEqual([]);
    expect(
      (await getDb(ctx.db).select().from(run)).filter(
        (row) => row.purpose === "mail_import",
      ),
    ).toEqual([]);
  });
  it("refuses selected Luna when cancellation completes during source validation", async () => {
    const { party, mail } = await source();
    if (!mail.rawChecksum) throw new Error("Synthetic checksum missing");
    const [admitted] = await startMailImport(
      ctx.db,
      {
        ledgerPartyId: party.id,
        userId: ctx.actor.userId,
        messageIds: [mail.id],
        expectedChecksums: [
          { orderMailId: mail.id, checksum: mail.rawChecksum },
        ],
      },
      { send: async () => {} },
    );
    if (!admitted) throw new Error("Synthetic Run missing");
    const [saved] = await getDb(ctx.db)
      .select({ shortcode: run.shortcode })
      .from(run)
      .where(eq(run.id, parseEntityId("run", admitted.runId)));
    if (!saved) throw new Error("Synthetic Run missing");
    const original = sourceIdentity.assertMailSourceIdentityReady;
    // Preserve the real source read and place the public cancellation at its boundary.
    const interleaving = vi
      .spyOn(sourceIdentity, "assertMailSourceIdentityReady")
      .mockImplementation(async (...args) => {
        await original(...args);
        await controlRun(ctx.db, ctx.actor, {
          runPublicId: saved.shortcode,
          action: "cancel",
        });
      });
    let transmissions = 0;
    const paid = gatewayFetchThrough({
      provider: "openai",
      beforePaidRequest: paidRunPreflight(
        ctx.db,
        parseEntityId("run", admitted.runId),
        "purchase_import_agent",
      ),
      gateway: async () => {
        transmissions += 1;
        return Response.json({});
      },
    });
    try {
      await expect(
        paid("https://ai-gateway.invalid/openai/responses", {
          method: "POST",
          body: JSON.stringify({ model: "gpt-6-luna", input: [] }),
        }),
      ).rejects.toThrow(/executable/iu);
      expect(transmissions).toBe(0);
    } finally {
      interleaving.mockRestore();
    }
  });

  it.each([
    {
      provider: "openai",
      model: "gpt-6-luna",
      endpoint: "responses",
      unapprovedModel: "gpt-6-astra",
    },
    {
      provider: "openai",
      model: "gpt-6-sol",
      endpoint: "responses",
      unapprovedModel: "gpt-6-astra",
    },
    {
      provider: "anthropic",
      model: "claude-opus-5-5",
      endpoint: "v1/messages",
      unapprovedModel: "claude-sonnet-4-6",
    },
  ] as const)(
    "admits member-selected coordinator $model past a spent background budget",
    async ({ provider, model, endpoint, unapprovedModel }) => {
      const { party, mail } = await source();
      const [admitted] = await startMailImport(
        ctx.db,
        {
          ledgerPartyId: party.id,
          userId: ctx.actor.userId,
          messageIds: [mail.id],
          expectedChecksums: [
            { orderMailId: mail.id, checksum: mail.rawChecksum! },
          ],
        },
        { send: async () => {} },
      );
      if (!admitted) throw new Error("Selected mail Run missing");
      let transmissions = 0;
      const paid = gatewayFetchThrough({
        provider,
        beforePaidRequest: paidRunPreflight(
          ctx.db,
          parseEntityId("run", admitted.runId),
          "purchase_import_agent",
        ),
        gateway: async () => {
          transmissions += 1;
          return Response.json({});
        },
      });
      const url = `https://ai-gateway.invalid/${provider}/${endpoint}`;
      const requestBody = (requestModel: string) =>
        JSON.stringify(
          provider === "anthropic"
            ? { model: requestModel, max_tokens: 32, messages: [] }
            : { model: requestModel, input: [] },
        );
      const request = (requestModel: string = model) =>
        paid(url, { method: "POST", body: requestBody(requestModel) });
      // Foreground coordinator work is not background spend; any other model is.
      await getDb(ctx.db)
        .insert(aiUsage)
        .values({
          runId: parseEntityId("run", admitted.runId),
          feature: "purchase_import_agent",
          provider: "openai",
          model: "gpt-6-luna",
          operation: "agent.generation",
          durationMs: 1,
          chargedCost: 1,
        });
      await expect(request()).resolves.toBeInstanceOf(Response);
      await expect(request(unapprovedModel)).rejects.toThrow(
        /AI budget reached/u,
      );
      expect(transmissions).toBe(1);
      await getDb(ctx.db)
        .update(run)
        .set({ status: "failed", failureCode: "user_cancelled" })
        .where(eq(run.id, parseEntityId("run", admitted.runId)));
      await expect(request()).rejects.toThrow(/executable/iu);
      expect(transmissions).toBe(1);
      const [previous] = await getDb(ctx.db)
        .select({ shortcode: run.shortcode })
        .from(run)
        .where(eq(run.id, parseEntityId("run", admitted.runId)));
      if (!previous) throw new Error("Selected Run missing");
      const successor = await controlRun(ctx.db, ctx.actor, {
        runPublicId: previous.shortcode,
        action: "retry",
      });
      if (!("successorRunId" in successor))
        throw new Error("Selected retry missing");
      const [retryScope] = await getDb(ctx.db)
        .select({
          trigger: run.trigger,
          cause: run.cause,
          predecessorRunId: run.predecessorRunId,
          input: run.input,
        })
        .from(run)
        .where(eq(run.id, parseEntityId("run", successor.successorRunId)));
      expect(retryScope?.predecessorRunId).toBe(admitted.runId);
      expect(mailResearchRunInput.parse(retryScope?.input).sources).toEqual([
        { orderMailId: mail.id, checksum: mail.rawChecksum },
      ]);
      const retryPaid = gatewayFetchThrough({
        provider,
        beforePaidRequest: paidRunPreflight(
          ctx.db,
          parseEntityId("run", successor.successorRunId),
          "purchase_import_agent",
        ),
        gateway: async () => {
          transmissions += 1;
          return Response.json({});
        },
      });
      await expect(
        retryPaid(url, {
          method: "POST",
          body: requestBody(model),
        }),
      ).resolves.toBeInstanceOf(Response);
      expect(transmissions).toBe(2);
    },
  );

  it.each([
    "retained checksum",
    "Email checksum",
    "Email ownership",
    "excluded Email",
  ])(
    "refuses selected Luna retries when current source changes: %s",
    async (change) => {
      const { party, mail } = await source();
      const [admitted] = await startMailImport(
        ctx.db,
        {
          ledgerPartyId: party.id,
          userId: ctx.actor.userId,
          messageIds: [mail.id],
          expectedChecksums: [
            { orderMailId: mail.id, checksum: mail.rawChecksum! },
          ],
        },
        { send: async () => {} },
      );
      if (!admitted) throw new Error("Synthetic selection missing");
      const admittedId = parseEntityId("run", admitted.runId);
      await getDb(ctx.db)
        .update(run)
        .set({ status: "failed" })
        .where(eq(run.id, admittedId));
      const [previous] = await getDb(ctx.db)
        .select({ shortcode: run.shortcode })
        .from(run)
        .where(eq(run.id, admittedId));
      if (!previous) throw new Error("Synthetic selection missing");
      const successor = await controlRun(ctx.db, ctx.actor, {
        runPublicId: previous.shortcode,
        action: "retry",
      });
      if (!("successorRunId" in successor))
        throw new Error("Synthetic retry missing");
      if (change === "retained checksum")
        await getDb(ctx.db)
          .update(orderMail)
          .set({ rawChecksum: "b".repeat(64) })
          .where(eq(orderMail.id, mail.id));
      else
        await getDb(ctx.db)
          .update(emailTable)
          .set(
            change === "Email checksum"
              ? { checksum: "b".repeat(64) }
              : change === "Email ownership"
                ? { runId: admittedId }
                : { status: "excluded" },
          )
          .where(eq(emailTable.orderMailId, mail.id));
      let transmissions = 0;
      const paid = gatewayFetchThrough({
        provider: "openai",
        beforePaidRequest: paidRunPreflight(
          ctx.db,
          parseEntityId("run", successor.successorRunId),
          "purchase_import_agent",
        ),
        gateway: async () => {
          transmissions += 1;
          return Response.json({});
        },
      });
      await expect(
        paid("https://ai-gateway.invalid/openai/responses", {
          method: "POST",
          body: JSON.stringify({ model: "gpt-6-luna", input: [] }),
        }),
      ).rejects.toThrow(/source|ownership|evidence/iu);
      expect(transmissions).toBe(0);
    },
  );

  it("refuses a historical ownership block before admitting or dispatching mail", async () => {
    const { party, mail } = await source();
    await getDb(ctx.db)
      .update(emailTable)
      .set({
        status: "blocked",
        classificationVersion: "legacy-source-identity-unresolved/v1",
      })
      .where(eq(emailTable.orderMailId, mail.id));
    const before = await getDb(ctx.db).select().from(emailTable);
    const retainedBefore = await getDb(ctx.db).select().from(orderMail);
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
    expect(await getDb(ctx.db).select().from(emailTable)).toEqual(before);
    expect(await getDb(ctx.db).select().from(orderMail)).toEqual(
      retainedBefore,
    );
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
      coordinatorModel: coordinatorModelFor("mail_import"),
    });
    const [ledger] = await getDb(ctx.db)
      .select()
      .from(emailTable)
      .where(eq(emailTable.orderMailId, mail.id));
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
    const second = await retainedMailFixture(ctx.db, {
      ledgerPartyId: party.id,
      mailboxId: mail.mailboxId,
      messageId: "synthetic-second",
      sender: mail.sender,
      subject: "Shipping update",
      receivedAt: mail.receivedAt,
      checksum: "b".repeat(64),
      content: mail.content,
    });
    if (!second) throw new Error("Second synthetic source did not persist");
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
      .from(emailTable)
      .where(eq(emailTable.orderMailId, mail.id));
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
      .update(emailTable)
      .set({ status: "excluded", orderMailId: null })
      .where(eq(emailTable.orderMailId, mail.id));
    const before = await getDb(ctx.db).select().from(emailTable);
    const retainedBefore = await getDb(ctx.db).select().from(orderMail);
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
          send: async (event: PurchaseAgentEvent) => {
            events.push(event);
          },
        },
      ),
    ).rejects.toBeInstanceOf(Error);
    expect(events).toEqual([]);
    expect(await getDb(ctx.db).select().from(run)).toEqual([]);
    expect(await getDb(ctx.db).select().from(runOperation)).toEqual([]);
    expect(await getDb(ctx.db).select().from(emailTable)).toEqual(before);
    expect(await getDb(ctx.db).select().from(orderMail)).toEqual(
      retainedBefore,
    );
  });
});

// Unrelated-source retirement erased a mail Run's input and progress columns
// to SQL NULL; run_status must still read that Run.
describe("retired mail import status", () => {
  const ctx = withTestDb();

  const runStatus = (runId: string) => {
    const entityKernel = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
    return callMcpTool(
      createMcpServer(),
      "imports_read",
      { action: "run_status", runId: runShortcode.parse(runId) },
      kernelRequestContext(entityKernel),
      { entityKernel },
    );
  };
  const mailRun = async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Retired mail member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const parent = await startAgentRunFixture(ctx.db, {
      ledgerPartyId: party.id,
    });
    const child = await startAgentRunFixture(ctx.db, {
      ledgerPartyId: party.id,
    });
    return { parent, child };
  };

  it("refuses a live mail Run whose admitted roster is missing", async () => {
    const { child } = await mailRun();
    await getDb(ctx.db)
      .update(run)
      .set({ input: null })
      .where(eq(run.id, parseEntityId("run", child.id)));

    const response = await runStatus(child.publicId);
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.content)).toMatch(
      /expected object, received null/u,
    );
  });

  it("reads a Run whose unrelated-source retirement erased its input and progress", async () => {
    const { parent, child } = await mailRun();
    await getDb(ctx.db)
      .update(run)
      .set({
        parentRunId: parseEntityId("run", parent.id),
        status: "needs_review",
        endedAt: new Date("2026-09-02T18:00:00Z"),
        imported: 4,
        retiredAt: new Date("2026-09-02T18:00:00Z"),
        retirementReason: "unrelated_source",
        input: null,
        progress: null,
        notes: null,
        agentSessionId: null,
      })
      .where(eq(run.id, parseEntityId("run", child.id)));
    const response = await runStatus(child.publicId);

    expect(response.isError ? response.content : null).toBeNull();
    expect(response.structuredContent).toMatchObject({
      runId: child.publicId,
      purpose: "mail_import",
      status: "needs_review",
      retirementReason: "unrelated_source",
      imported: 4,
      targets: [],
    });
    // Nothing remains to copy, so the Run offers no restart.
    expect(
      (await loadRunDetail(ctx.db, child.publicId)).restartInputs,
    ).toBeNull();
  });
});
