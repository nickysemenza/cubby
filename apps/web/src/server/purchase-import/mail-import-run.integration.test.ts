import { executionAuthorizationInput } from "@cubby/schemas/execution-authorization";
import { parseEntityId, runShortcode } from "@cubby/schemas/identifiers";
import { coordinatorModelFor } from "@cubby/schemas/import-run-agent";
import type { PurchaseAgentEvent } from "@cubby/schemas/purchase-import";
import { mailResearchRunInput } from "@cubby/schemas/run-fields";
import { gatewayFetchThrough } from "@cubby/shared/ai/gateway-request";
import { sha256Hex } from "@cubby/shared/sha256";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import { account } from "~/server/db/auth.schema";
import {
  orderMail,
  email as emailTable,
  run,
  runOperation,
} from "~/server/db/schema";
import { entityKernelContextSchema } from "~/server/entity-kernel";
import { callMcpTool, kernelRequestContext } from "~/server/mcp/mcp-test-utils";
import { createMcpServer } from "~/server/mcp/server";
import {
  databaseForTransaction,
  getDb,
  withTransaction,
} from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { ensureRun } from "~/server/runs/ensure-run";
import { issueExecutionAuthorization } from "~/server/runs/execution-authorization";
import { executionAuthorizationFromInput } from "~/server/runs/execution-context";
import { paidResearchPreflight } from "~/server/runs/execution-transport";
import { createTestRequestContext } from "~/server/testing/request-context";

import { startAgentRunFixture } from "./import-run.fixtures";
import { startMailImport } from "./mail-import-run";
import { transferMailRunSources } from "./mail-run-membership";
import * as sourceIdentity from "./mail-source-identity";
import { settleMail } from "./mail-tool";
import { retainedMailFixture } from "./order-import.fixtures";
import { writeOutcomeReceipts } from "./run-outcome.fixtures";
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
      beforePaidRequest: paidResearchPreflight(
        ctx.db,
        parseEntityId("run", admitted.runId),
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

  it("permits only Luna inference for a member-selected source without a dollar grant", async () => {
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
      provider: "openai",
      beforePaidRequest: paidResearchPreflight(
        ctx.db,
        parseEntityId("run", admitted.runId),
      ),
      gateway: async () => {
        transmissions += 1;
        return Response.json({});
      },
    });
    const request = (model: string) =>
      paid("https://ai-gateway.invalid/openai/responses", {
        method: "POST",
        body: JSON.stringify({ model, input: [] }),
      });
    await expect(request("gpt-6-luna")).resolves.toBeInstanceOf(Response);
    await expect(request("gpt-6-sol")).rejects.toThrow(/authorization/iu);
    expect(transmissions).toBe(1);
    await getDb(ctx.db)
      .update(run)
      .set({ status: "failed", failureCode: "user_cancelled" })
      .where(eq(run.id, parseEntityId("run", admitted.runId)));
    await expect(request("gpt-6-luna")).rejects.toThrow(/executable/iu);
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
      provider: "openai",
      beforePaidRequest: paidResearchPreflight(
        ctx.db,
        parseEntityId("run", successor.successorRunId),
      ),
      gateway: async () => {
        transmissions += 1;
        return Response.json({});
      },
    });
    await expect(
      retryPaid("https://ai-gateway.invalid/openai/responses", {
        method: "POST",
        body: JSON.stringify({ model: "gpt-6-luna", input: [] }),
      }),
    ).resolves.toBeInstanceOf(Response);
    expect(transmissions).toBe(2);
    await getDb(ctx.db).insert(account).values({
      id: crypto.randomUUID(),
      accountId: mail.mailboxId,
      providerId: "google",
      userId: ctx.actor.userId,
      updatedAt: new Date(),
    });
    const historicalApproval = await issueExecutionAuthorization(
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
        meteredBudget: { period: "lifetime", limitMicroUSD: 500_000 },
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    const [approvalRoot] = await getDb(ctx.db)
      .select({ input: run.input })
      .from(run)
      .where(eq(run.id, historicalApproval.runId));
    await getDb(ctx.db)
      .update(run)
      .set({
        input: {
          ...executionAuthorizationInput.parse(approvalRoot?.input),
          expiresAt: "2020-01-01T00:00:00.000Z",
        },
      })
      .where(eq(run.id, historicalApproval.runId));
    const successorId = parseEntityId("run", successor.successorRunId);
    const [priorSuccessor] = await getDb(ctx.db)
      .select({ input: run.input, shortcode: run.shortcode })
      .from(run)
      .where(eq(run.id, successorId));
    if (!priorSuccessor) throw new Error("Selected successor missing");
    await getDb(ctx.db)
      .update(run)
      .set({
        status: "failed",
        input: {
          ...mailResearchRunInput.parse(priorSuccessor.input),
          executionAuthorization: historicalApproval,
        },
      })
      .where(eq(run.id, successorId));
    const expiredRetry = await controlRun(ctx.db, ctx.actor, {
      runPublicId: priorSuccessor.shortcode,
      action: "retry",
    });
    if (!("successorRunId" in expiredRetry))
      throw new Error("Expired-allowance retry missing");
    const expiredPaid = gatewayFetchThrough({
      provider: "openai",
      beforePaidRequest: paidResearchPreflight(
        ctx.db,
        parseEntityId("run", expiredRetry.successorRunId),
      ),
      gateway: async () => {
        transmissions += 1;
        return Response.json({});
      },
    });
    await expect(
      expiredPaid("https://ai-gateway.invalid/openai/responses", {
        method: "POST",
        body: JSON.stringify({ model: "gpt-6-luna", input: [] }),
      }),
    ).resolves.toBeInstanceOf(Response);
    expect(transmissions).toBe(3);
  });

  it.each(["retry", "restart"] as const)(
    "refuses Luna on a discovery %s after its grant expires",
    async (action) => {
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
          meteredBudget: { period: "lifetime", limitMicroUSD: 500_000 },
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      );
      const parentRunId = await ensureRun(ctx.db, ctx.actor, {
        purpose: "mail_discovery",
        trigger: "scheduled",
        input: {
          mailboxId: mail.mailboxId,
          scopedQueries: [],
          executionPolicy: "import",
          executionAuthorization: approval,
        },
      });
      const [admitted] = await startMailImport(
        ctx.db,
        {
          ledgerPartyId: party.id,
          userId: ctx.actor.userId,
          messageIds: [mail.id],
          parentRunId,
        },
        { send: async () => {} },
      );
      if (!admitted) throw new Error("Synthetic discovery child missing");
      const [root] = await getDb(ctx.db)
        .select({ input: run.input })
        .from(run)
        .where(eq(run.id, approval.runId));
      const expiredInput = executionAuthorizationInput.parse({
        ...executionAuthorizationInput.parse(root?.input),
        expiresAt: "2020-01-01T00:00:00.000Z",
      });
      await getDb(ctx.db)
        .update(run)
        .set({
          input: expiredInput,
        })
        .where(eq(run.id, approval.runId));
      const admittedId = parseEntityId("run", admitted.runId);
      const [child] = await getDb(ctx.db)
        .select({ input: run.input })
        .from(run)
        .where(eq(run.id, admittedId));
      await getDb(ctx.db)
        .update(run)
        .set({
          status: "failed",
          input: {
            ...mailResearchRunInput.parse(child?.input),
            executionAuthorization: {
              ...approval,
              approvalFingerprint: await sha256Hex(
                JSON.stringify(expiredInput),
              ),
            },
          },
        })
        .where(eq(run.id, admittedId));
      const [previous] = await getDb(ctx.db)
        .select({ shortcode: run.shortcode })
        .from(run)
        .where(eq(run.id, admittedId));
      if (!previous) throw new Error("Synthetic discovery child missing");
      const successor = await controlRun(ctx.db, ctx.actor, {
        runPublicId: previous.shortcode,
        action,
      });
      if (!("successorRunId" in successor))
        throw new Error("Synthetic discovery successor missing");
      let transmissions = 0;
      const paid = gatewayFetchThrough({
        provider: "openai",
        beforePaidRequest: paidResearchPreflight(
          ctx.db,
          parseEntityId("run", successor.successorRunId),
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
      ).rejects.toThrow(/expired/iu);
      expect(transmissions).toBe(0);
      if (!successor.successorRunPublicId)
        throw new Error("Synthetic successor missing");
      const [parent] = await getDb(ctx.db)
        .select({ shortcode: run.shortcode })
        .from(run)
        .where(eq(run.id, parentRunId));
      expect(
        (await loadRunDetail(ctx.db, successor.successorRunPublicId))
          .parentRunId,
      ).toBe(parent?.shortcode);
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
        beforePaidRequest: paidResearchPreflight(
          ctx.db,
          parseEntityId("run", successor.successorRunId),
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

  it("admits a member-selected checksum without inheriting an expired backfill allowance", async () => {
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
        meteredBudget: { period: "lifetime", limitMicroUSD: 500_000 },
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    const [root] = await getDb(ctx.db)
      .select({ input: run.input })
      .from(run)
      .where(eq(run.id, approval.runId));
    // An expired approval fixture must not become authority for this new selection.
    await getDb(ctx.db)
      .update(run)
      .set({
        input: {
          ...executionAuthorizationInput.parse(root?.input),
          expiresAt: "2020-01-01T00:00:00.000Z",
        },
      })
      .where(eq(run.id, approval.runId));
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
    const [saved] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, parseEntityId("run", admitted.runId)));
    expect(executionAuthorizationFromInput(saved?.input)).toBeUndefined();
    expect(await frozenSources(admitted.runId)).toEqual([
      { orderMailId: mail.id, checksum: mail.rawChecksum },
    ]);
  });

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
