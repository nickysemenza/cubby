import {
  type ShortcodeFor,
  parseEntityId,
  runShortcode,
  vendorShortcode,
} from "@cubby/schemas/identifiers";
import { coordinatorModelFor } from "@cubby/schemas/import-run-agent";
import { mailResearchRunInput } from "@cubby/schemas/run-fields";
import { gatewayFetchThrough } from "@cubby/shared/ai/gateway-request";
import { pollUntil } from "@cubby/shared/retry";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import { account } from "~/server/db/auth.schema";
import {
  databaseForTransaction,
  getDb,
  withTransaction,
} from "~/server/db/helpers";
import { relationalSql } from "~/server/db/helpers/relational-sql";
import {
  aiUsage,
  orderMail,
  email as emailTable,
  run,
  runFinding,
  runOperation,
  emailReview,
  vendor,
  vendorAccount,
  purchase,
} from "~/server/db/schema";
import { recordEmailClassificationObservation } from "~/server/domains/purchase-import/repo/gmail/observations";
import { paidRunPreflight } from "~/server/domains/purchase-import/service/execution-transport";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import {
  canDispatchRunCoordinator,
  controlRun,
  markRunFailed,
} from "~/server/domains/run/repo/run-control";
import { loadRunDetail } from "~/server/domains/run/repo/run-detail";
import { insertOperation } from "~/server/domains/run/repo/run-operation";
import { getRunWorkProgress } from "~/server/domains/run/repo/work-progress";
import { kernelCtx } from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { entityKernelContextSchema } from "~/server/entity-kernel";
import { readJobs } from "~/server/generic/jobs/repo/job-reads";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { reviewSuggestion } from "~/server/generic/suggestions/repo/review";
import { createMcpServer } from "~/server/mcp/server";
import {
  callMcpTool,
  kernelRequestContext,
} from "~/server/testing/mcp-test-utils";
import {
  createProductIdentityFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";
import { createTestRequestContext } from "~/server/testing/request-context";
import { discoverPurchases } from "~/server/workflows/catch-up";

import { startControlledMailImport } from "../operations/gmail/controlled-import";
import {
  preparePurchaseImport,
  commitPurchaseImport,
} from "../operations/import-orders";
import {
  readMailImportOutcomes,
  searchMail,
  settleMail,
} from "../operations/mail-tool";
import { retainedMailFixture } from "../operations/order-import.fixtures";
import { reconcileSettledRun } from "../operations/run-review";
import {
  startAgentRunFixture,
  startImportRunFixture,
} from "../service/import-run.fixtures";
import { writeOutcomeReceipts } from "../service/run-outcome.fixtures";
import {
  retainedControlledMailIds,
  waitForActiveMailboxImports,
} from "./controlled-mail-import";
import * as gmailProvider from "./gmail/provider";
import {
  admitMailImport,
  importPendingEmails,
  startMailImport,
} from "./mail-import-run";
import {
  readMailImportSettings,
  resumeControlledMailImport,
  setMailImport,
} from "./mail-import-settings";
import {
  MAIL_SOURCE_TRANSFER_OPERATION,
  transferMailRunSources,
} from "./mail-run-membership";
import * as sourceIdentity from "./mail-source-identity";
import { setSenderAttribution } from "./sender-attribution";
import { readSenderAttributions } from "./sender-attribution-read";

// Admission must bind original sources without a known Vendor, order, or Mac;
// replay cannot create a second Run, and stale/foreign sources cannot enter it.
describe("mail research admission", () => {
  const ctx = withTestDb();
  const dispatches = () => readJobs(ctx.db, { kind: "purchase.dispatch" });
  // The Run's admitted Emails, frozen at their admitted checksums.
  const frozenSources = async (runId: string) => {
    const [saved] = await getDb(ctx.db)
      .select({ input: run.input })
      .from(run)
      .where(eq(run.id, parseEntityId("run", runId)));
    return mailResearchRunInput.parse(saved?.input).sources;
  };
  async function source(options: { subject?: string; bodyText?: string } = {}) {
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
      subject: options.subject ?? "Your receipt",
      receivedAt: new Date("2026-09-01T18:00:00Z"),
      checksum: "a".repeat(64),
      content: {
        snippet: null,
        bodyText: options.bodyText ?? "Workshop admission: $24",
        bodyHtml: null,
      },
    });
    if (!mail) throw new Error("Synthetic mail fixture did not persist");
    return { party, mail };
  }
  // Any ended holder readmits only on a new evidence revision: readmitting
  // from failed or retired holders without one re-spent coordinators.
  it.each([
    { holder: "needs_review", retired: false },
    { holder: "failed", retired: false },
    { holder: "failed", retired: true },
  ] as const)(
    "reopens an untouched gap once for new accepted evidence of its exact own-account order from a $holder holder (retired: $retired)",
    async ({ holder, retired }) => {
      const { party, mail } = await source({
        subject: "Order SYN-RECOVERY-42 shipped",
        bodyText:
          "Order SYN-RECOVERY-42 shipped. Original itemization is missing.",
      });
      const seller = await createRepoEntity(ctx, "vendor", {
        name: "Synthetic recovery shop",
        orderEmailSenders: ["receipts@shop.example"],
      });
      const accountResult = await createRepoEntity(ctx, "vendorAccount", {
        vendorId: seller.output.id,
        ledgerPartyId: party.shortcode,
      });
      const [vendorAccountRow] = await getDb(ctx.db)
        .select({ id: vendorAccount.id })
        .from(vendorAccount)
        .where(eq(vendorAccount.shortcode, accountResult.output.id));
      if (!vendorAccountRow)
        throw new Error("Synthetic recovery account missing");
      await getDb(ctx.db).insert(account).values({
        id: crypto.randomUUID(),
        accountId: mail.mailboxId,
        providerId: "google",
        userId: ctx.actor.userId,
        updatedAt: new Date(),
      });
      await setMailImport(ctx.db, { mailboxId: mail.mailboxId, enabled: true });
      const [original] = await admitMailImport(ctx.db, {
        ledgerPartyId: party.id,
        userId: ctx.actor.userId,
        mailboxId: mail.mailboxId,
        messageIds: [mail.id],
        automatic: true,
        senderRecheck: {
          sender: "receipts@shop.example",
          vendorId: seller.output.id,
        },
      });
      if (!original) throw new Error("Synthetic unresolved owner missing");
      const block = async (ownerId: string) => {
        await settleMail(ctx.db, {
          mail,
          importRunId: parseEntityId("run", ownerId),
          status: "unsettled",
          detail: "Synthetic missing original",
        });
        await getDb(ctx.db)
          .update(run)
          .set({
            status: holder,
            endedAt: new Date(),
            ...(retired && {
              retiredAt: new Date(),
              retirementReason: "settled",
            }),
          })
          .where(eq(run.id, parseEntityId("run", ownerId)));
      };
      const good = await createProductIdentityFixture(
        ctx.db,
        makeProductInput({ name: "Synthetic recovery mug" }),
        ctx.actor,
      );
      const purchases = new Map<string, ShortcodeFor<"purchase">>();
      const history = async (orderId: string, revision: string) => {
        const capture = await startImportRunFixture(ctx.db, {
          ledgerPartyId: party.id,
          vendorAccountId: vendorAccountRow.id,
          trigger: "manual",
        });
        const stableOrderId = `synthetic-recovery-${orderId}-${revision}`;
        const prepared = await preparePurchaseImport(
          ctx.db,
          {
            _runExecution: {
              runId: capture.id,
              operationId: `prepare:${stableOrderId}`,
            },
            orders: [
              {
                stableOrderId,
                itemOperationId: `item:${stableOrderId}`,
                vendorId: seller.output.id,
                targetPurchaseId: purchases.get(orderId),
                source: {
                  kind: "vendor_export",
                  externalKey: `synthetic-recovery:${orderId}:${revision}`,
                  checksum: revision.repeat(64),
                },
                evidenceChecksum: revision.repeat(64),
                extractionRevision: "synthetic-recovery@1",
                extraction: {
                  status: "ready",
                  candidate: {
                    orderId,
                    orderedAt: "2026-09-01",
                    merchant: "Synthetic recovery shop",
                    currency: "USD",
                    printedGrandTotal: 12,
                    lines: [
                      {
                        title: "Synthetic recovery mug",
                        amount: 12,
                        quantity: 1,
                        lineKind: "principal",
                      },
                    ],
                    payments: [],
                  },
                },
                lineIds: ["synthetic-mug"],
                primaryDocumentImageId: null,
                screenshotImageId: null,
              },
            ],
          },
          ctx.actor,
        );
        const imported = await commitPurchaseImport(
          ctx.db,
          {
            _runExecution: {
              runId: capture.id,
              operationId: `commit:${stableOrderId}`,
            },
            prepareOperationId: prepared.operationId,
            defaultTrade: "other",
            resolutions: [
              {
                stableOrderId,
                stableLineId: "synthetic-mug",
                resolution: { kind: "existing", productId: good.id },
              },
            ],
          },
          ctx.actor,
        );
        const result = imported.items[0];
        expect(result?.outcome).not.toBe("conflict");
        if (!result?.purchaseId)
          throw new Error("Synthetic accepted receipt missing");
        purchases.set(orderId, result.purchaseId);
      };
      await history("SYN-RECOVERY-42", "a");
      await block(original.row.id);
      const owner = async () =>
        (
          await getDb(ctx.db)
            .select({ runId: emailTable.runId })
            .from(emailTable)
            .where(eq(emailTable.orderMailId, mail.id))
        )[0]?.runId;
      const attempts = async () =>
        (
          await getDb(ctx.db)
            .select({ importAttempts: emailTable.importAttempts })
            .from(emailTable)
            .where(eq(emailTable.orderMailId, mail.id))
        )[0]?.importAttempts;
      expect((await importPendingEmails(ctx.db)).errors).toEqual([]);
      expect(await owner()).toBe(original.row.id);
      await history("SYN-OTHER-ORDER", "b");
      expect((await importPendingEmails(ctx.db)).errors).toEqual([]);
      expect(await owner()).toBe(original.row.id);
      await history("SYN-RECOVERY-42", "c");
      // Plain admission of this checksum already used every attempt; a new
      // revision starts its own count.
      await getDb(ctx.db)
        .update(emailTable)
        .set({
          importAttempts: { revision: mail.rawChecksum, count: 3 },
          // A counter is not an Email change the recheck compares.
          updatedAt: sql`${emailTable.updatedAt}`,
        })
        .where(eq(emailTable.orderMailId, mail.id));
      expect((await importPendingEmails(ctx.db)).errors).toEqual([]);
      const successor = await owner();
      expect(successor).not.toBe(original.row.id);
      if (!successor)
        throw new Error("New exact evidence must admit a successor");
      expect((await attempts())?.count).toBe(1);
      expect(await frozenSources(original.row.id)).toEqual([
        { orderMailId: mail.id, checksum: mail.rawChecksum },
      ]);
      await block(successor);
      // Releasing part of a roster clears the replay key; the revision fence
      // lives in the frozen input and still refuses the same revision.
      await getDb(ctx.db)
        .update(run)
        .set({ clientKey: null })
        .where(eq(run.id, successor));
      expect((await importPendingEmails(ctx.db)).errors).toEqual([]);
      expect(await owner()).toBe(successor);
      // A Purchase edit is not new source evidence and cannot reset reasoning.
      await getDb(ctx.db)
        .update(purchase)
        .set({ statedTotal: 1300n })
        .where(eq(purchase.orderId, "SYN-RECOVERY-42"));
      expect((await importPendingEmails(ctx.db)).errors).toEqual([]);
      expect(await owner()).toBe(successor);
      const refreshedChecksum = "d".repeat(64);
      await getDb(ctx.db)
        .update(orderMail)
        .set({
          rawChecksum: refreshedChecksum,
          content: {
            snippet: null,
            bodyText:
              "Order SYN-RECOVERY-42 now includes a complete revised receipt.",
            bodyHtml: null,
          },
        })
        .where(eq(orderMail.id, mail.id));
      await getDb(ctx.db)
        .update(emailTable)
        .set({
          checksum: refreshedChecksum,
          status: "pending",
          updatedAt: new Date(),
        })
        .where(eq(emailTable.orderMailId, mail.id));
      expect((await importPendingEmails(ctx.db)).errors).toEqual([]);
      const refreshedOwner = await owner();
      expect(refreshedOwner).not.toBe(successor);
      if (!refreshedOwner)
        throw new Error("New retained bytes must admit a successor");
      expect(await frozenSources(successor)).toEqual([
        { orderMailId: mail.id, checksum: mail.rawChecksum },
      ]);
      expect(await frozenSources(refreshedOwner)).toEqual([
        { orderMailId: mail.id, checksum: refreshedChecksum },
      ]);
      expect(
        (
          await getDb(ctx.db)
            .select({ trigger: run.trigger })
            .from(run)
            .where(eq(run.id, refreshedOwner))
        )[0]?.trigger,
      ).toBe("discovery");
      expect(await attempts()).toEqual({
        revision: expect.stringMatching(
          new RegExp(`^${refreshedChecksum}:[0-9a-f]{64}$`, "u"),
        ),
        count: 1,
      });
      // A transient failure of that revision's first attempt retries it.
      await markRunFailed(ctx.db, {
        runId: refreshedOwner,
        failureCode: "agent_transient",
      });
      const retried = await owner();
      expect(retried).not.toBe(refreshedOwner);
      expect((await attempts())?.count).toBe(2);
    },
  );
  // Unchanged evidence buys no second Run: a sender mapping the holder's
  // coordinator already read is not new, while the order it waits on is.
  it("readmits a waiting Email when its awaited order arrives, not for a sender mapping its claim already saw", async () => {
    const { party, mail } = await source({
      subject: "Order SYN-WAIT-7 shipped",
      bodyText: "Your order SYN-WAIT-7 shipped.",
    });
    const seller = await createRepoEntity(ctx, "vendor", {
      name: "Synthetic waiting shop",
      orderEmailSenders: ["receipts@shop.example"],
    });
    const [sellerRow] = await getDb(ctx.db)
      .select({ id: vendor.id })
      .from(vendor)
      .where(eq(vendor.shortcode, seller.output.id));
    if (!sellerRow) throw new Error("Synthetic waiting Vendor missing");
    await getDb(ctx.db).insert(account).values({
      id: crypto.randomUUID(),
      accountId: mail.mailboxId,
      providerId: "google",
      userId: ctx.actor.userId,
      updatedAt: new Date(),
    });
    await setMailImport(ctx.db, { mailboxId: mail.mailboxId, enabled: true });
    const [holder] = await admitMailImport(ctx.db, {
      ledgerPartyId: party.id,
      userId: ctx.actor.userId,
      mailboxId: mail.mailboxId,
      messageIds: [mail.id],
      automatic: true,
    });
    if (!holder) throw new Error("Synthetic holder missing");
    await getDb(ctx.db)
      .insert(runOperation)
      .values({
        runId: holder.row.id,
        operationId: "claim:synthetic",
        kind: "claim_next_work",
        state: "completed",
        inputFingerprint: "synthetic",
        result: {
          kind: "email",
          email: {
            mailboxId: mail.mailboxId,
            messageId: mail.messageId,
            checksum: mail.rawChecksum,
          },
          known: { senderVendor: { id: seller.output.id } },
        },
      });
    await settleMail(ctx.db, {
      mail,
      importRunId: holder.row.id,
      status: "unsettled",
      detail: "The confirmation of SYN-WAIT-7 is not imported yet.",
      judgment: {
        kind: "unresolved",
        reason: "The confirmation of SYN-WAIT-7 is not imported yet.",
        category: "source_held",
        waitingOn: { kind: "order", orderId: "SYN-WAIT-7", vendorId: null },
      },
    });
    await getDb(ctx.db)
      .update(run)
      .set({ status: "completed", endedAt: new Date() })
      .where(eq(run.id, holder.row.id));
    const owner = async () =>
      (
        await getDb(ctx.db)
          .select({ runId: emailTable.runId })
          .from(emailTable)
          .where(eq(emailTable.orderMailId, mail.id))
      )[0]?.runId;
    expect((await importPendingEmails(ctx.db)).errors).toEqual([]);
    expect(await owner()).toBe(holder.row.id);
    await insertWithShortcode(ctx.db, "purchase", {
      vendorId: sellerRow.id,
      orderId: "#syn-wait-7",
    });
    expect((await importPendingEmails(ctx.db)).errors).toEqual([]);
    const successor = await owner();
    expect(successor).not.toBe(holder.row.id);
    // The same settlement readmits once.
    if (!successor) throw new Error("The awaited order must readmit the Email");
    await settleMail(ctx.db, {
      mail,
      importRunId: successor,
      status: "unsettled",
      detail: "Still waiting.",
      judgment: {
        kind: "unresolved",
        reason: "Still waiting.",
        category: "source_held",
        waitingOn: { kind: "order", orderId: "SYN-WAIT-7", vendorId: null },
      },
    });
    await getDb(ctx.db)
      .update(run)
      .set({ status: "completed", endedAt: new Date() })
      .where(eq(run.id, successor));
    expect((await importPendingEmails(ctx.db)).errors).toEqual([]);
    expect(await owner()).toBe(successor);
  });
  // A newer importer may settle what an older one left to an agent, once per
  // revision; a gap only the member settles is never re-run.
  // A held Email that reads pending is still its ended holder's to readmit.
  it.each([
    { category: "missing_evidence", readmitted: true, held: "unsettled" },
    { category: "missing_evidence", readmitted: true, held: "pending" },
    { category: "member_decision", readmitted: false, held: "unsettled" },
  ] as const)(
    "readmits a $held $category gap from an older importer revision: $readmitted",
    async ({ category, readmitted, held }) => {
      const { party, mail } = await source();
      await getDb(ctx.db).insert(account).values({
        id: crypto.randomUUID(),
        accountId: mail.mailboxId,
        providerId: "google",
        userId: ctx.actor.userId,
        updatedAt: new Date(),
      });
      await setMailImport(ctx.db, { mailboxId: mail.mailboxId, enabled: true });
      const settle = async (runId: (typeof run.$inferSelect)["id"]) => {
        await settleMail(ctx.db, {
          mail,
          importRunId: runId,
          status: "unsettled",
          detail: "Only a total is printed.",
          judgment: {
            kind: "unresolved",
            reason: "Only a total is printed.",
            category,
            waitingOn: null,
          },
        });
        await getDb(ctx.db)
          .update(run)
          .set({ status: "completed", endedAt: new Date() })
          .where(eq(run.id, runId));
      };
      const [holder] = await admitMailImport(ctx.db, {
        ledgerPartyId: party.id,
        userId: ctx.actor.userId,
        mailboxId: mail.mailboxId,
        messageIds: [mail.id],
        automatic: true,
      });
      if (!holder) throw new Error("Synthetic holder missing");
      await settle(holder.row.id);
      await getDb(ctx.db)
        .update(run)
        .set({ skillRevision: "purchase-import@0" })
        .where(eq(run.id, holder.row.id));
      // A routine re-observation is not an edit: updatedAt stays put.
      await getDb(ctx.db)
        .update(emailTable)
        .set({ status: held, updatedAt: emailTable.updatedAt })
        .where(eq(emailTable.orderMailId, mail.id));
      const owner = async () =>
        (
          await getDb(ctx.db)
            .select({ runId: emailTable.runId })
            .from(emailTable)
            .where(eq(emailTable.orderMailId, mail.id))
        )[0]?.runId;
      expect((await importPendingEmails(ctx.db)).errors).toEqual([]);
      const successor = await owner();
      expect(successor !== holder.row.id).toBe(readmitted);
      if (!readmitted || !successor) return;
      // The current revision's own gap stays settled.
      await settle(successor);
      expect((await importPendingEmails(ctx.db)).errors).toEqual([]);
      expect(await owner()).toBe(successor);
    },
  );
  // A member selecting what an ended holder left unsettled gets a new Run, not
  // the ended holder handed back.
  it("admits a member-selected Email afresh from an ended holder", async () => {
    const { party, mail } = await source();
    await getDb(ctx.db).insert(account).values({
      id: crypto.randomUUID(),
      accountId: mail.mailboxId,
      providerId: "google",
      userId: ctx.actor.userId,
      updatedAt: new Date(),
    });
    await setMailImport(ctx.db, { mailboxId: mail.mailboxId, enabled: true });
    const select = (automatic: boolean) =>
      admitMailImport(ctx.db, {
        ledgerPartyId: party.id,
        userId: ctx.actor.userId,
        mailboxId: mail.mailboxId,
        messageIds: [mail.id],
        automatic,
      });
    const [holder] = await select(true);
    if (!holder) throw new Error("Synthetic holder missing");
    await settleMail(ctx.db, {
      mail,
      importRunId: holder.row.id,
      status: "unsettled",
      detail: "Only a total is printed.",
      judgment: {
        kind: "unresolved",
        reason: "Only a total is printed.",
        category: "missing_evidence",
        waitingOn: null,
      },
    });
    await getDb(ctx.db)
      .update(run)
      .set({ status: "completed", endedAt: new Date() })
      .where(eq(run.id, holder.row.id));
    await getDb(ctx.db)
      .update(emailTable)
      .set({ status: "pending", updatedAt: new Date() })
      .where(eq(emailTable.orderMailId, mail.id));
    const [selected] = await select(false);
    expect(selected?.row.id).toBeDefined();
    expect(selected?.row.id).not.toBe(holder.row.id);
  });

  // A member's cancel is a decision: a sender mapping that already existed
  // must not buy the cancelled Email another paid Run.
  it("keeps a member-cancelled Email from evidence recovery without new evidence", async () => {
    const { party, mail } = await source();
    await createRepoEntity(ctx, "vendor", {
      name: "Synthetic cancelled shop",
      orderEmailSenders: ["receipts@shop.example"],
    });
    await getDb(ctx.db).insert(account).values({
      id: crypto.randomUUID(),
      accountId: mail.mailboxId,
      providerId: "google",
      userId: ctx.actor.userId,
      updatedAt: new Date(),
    });
    await setMailImport(ctx.db, { mailboxId: mail.mailboxId, enabled: true });
    const [admitted] = await startMailImport(ctx.db, {
      ledgerPartyId: party.id,
      userId: ctx.actor.userId,
      mailboxId: mail.mailboxId,
      messageIds: [mail.id],
      automatic: true,
    });
    if (!admitted) throw new Error("Synthetic Run missing");
    const [cancelled] = await getDb(ctx.db)
      .select({ shortcode: run.shortcode })
      .from(run)
      .where(eq(run.id, admitted.runId));
    await controlRun(ctx.db, ctx.actor, {
      runPublicId: cancelled!.shortcode,
      action: "cancel",
    });
    const holder = async () =>
      (
        await getDb(ctx.db)
          .select({ runId: emailTable.runId, status: emailTable.status })
          .from(emailTable)
          .where(eq(emailTable.orderMailId, mail.id))
      )[0];
    expect(await holder()).toEqual({
      runId: admitted.runId,
      status: "unsettled",
    });
    expect((await importPendingEmails(ctx.db)).errors).toEqual([]);
    expect(await holder()).toEqual({
      runId: admitted.runId,
      status: "unsettled",
    });
    expect(
      await getDb(ctx.db)
        .select({ id: run.id })
        .from(run)
        .where(eq(run.purpose, "mail_import")),
    ).toHaveLength(1);
  });

  it("rechecks the automatic switch at admission without stopping explicit or admitted work", async () => {
    const { party, mail } = await source();
    const input = {
      ledgerPartyId: party.id,
      userId: ctx.actor.userId,
      mailboxId: mail.mailboxId,
      messageIds: [mail.id],
    };
    expect(
      await startMailImport(ctx.db, { ...input, automatic: true }),
    ).toEqual([]);
    await setMailImport(ctx.db, { mailboxId: mail.mailboxId, enabled: true });
    const admitted = await startMailImport(ctx.db, {
      ...input,
      automatic: true,
    });
    expect(admitted).toHaveLength(1);
    await setMailImport(ctx.db, { mailboxId: mail.mailboxId, enabled: false });
    expect(
      await startMailImport(ctx.db, { ...input, automatic: true }),
    ).toEqual([]);
    const replayed = await startMailImport(ctx.db, input);
    expect(replayed[0]?.runId).toBe(admitted[0]?.runId);
    expect(replayed[0]?.status).toBe("running");
  });

  it("transfers only selected Vendor sources from an unstarted mixed owner, preserving active work, old evidence and replay", async () => {
    const { party, mail } = await source();
    const seller = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic Selected Seller",
      orderEmailSenders: ["receipts@shop.example"],
    });
    const other = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic Other Seller",
      orderEmailSenders: ["receipts@other.example"],
    });
    const selected = await retainedMailFixture(ctx.db, {
      ledgerPartyId: party.id,
      messageId: "synthetic-selected-queued",
      checksum: "b".repeat(64),
      vendorId: seller.id,
    });
    const foreign = await retainedMailFixture(ctx.db, {
      ledgerPartyId: party.id,
      messageId: "synthetic-foreign-queued",
      checksum: "c".repeat(64),
      vendorId: other.id,
    });
    const active = await retainedMailFixture(ctx.db, {
      ledgerPartyId: party.id,
      messageId: "synthetic-active-original",
      checksum: "d".repeat(64),
      vendorId: seller.id,
    });
    const fresh = await retainedMailFixture(ctx.db, {
      ledgerPartyId: party.id,
      messageId: "synthetic-fresh-selected",
      checksum: "e".repeat(64),
      vendorId: seller.id,
    });
    const settled = await retainedMailFixture(ctx.db, {
      ledgerPartyId: party.id,
      messageId: "synthetic-settled-selected",
      checksum: "1".repeat(64),
      vendorId: seller.id,
    });
    const blocked = await retainedMailFixture(ctx.db, {
      ledgerPartyId: party.id,
      messageId: "synthetic-review-selected",
      checksum: "2".repeat(64),
      vendorId: seller.id,
    });
    // Historical settled/reviewed mail may no longer have a live Run owner.
    await getDb(ctx.db)
      .update(emailTable)
      .set({ status: "completed" })
      .where(eq(emailTable.orderMailId, settled.id));
    await getDb(ctx.db)
      .update(emailTable)
      .set({ status: "unsettled" })
      .where(eq(emailTable.orderMailId, blocked.id));
    await getDb(ctx.db).insert(account).values({
      id: crypto.randomUUID(),
      accountId: mail.mailboxId,
      providerId: "google",
      userId: ctx.actor.userId,
      updatedAt: new Date(),
    });
    await setMailImport(ctx.db, { mailboxId: mail.mailboxId, enabled: true });
    const base = {
      ledgerPartyId: party.id,
      userId: ctx.actor.userId,
      mailboxId: mail.mailboxId,
      automatic: true,
    };
    const [queued] = await startMailImport(ctx.db, {
      ...base,
      messageIds: [mail.id, selected.id, foreign.id],
    });
    const [running] = await startMailImport(ctx.db, {
      ...base,
      messageIds: [active.id],
    });
    if (!queued || !running)
      throw new Error("Synthetic automatic owners were not admitted");
    const queuedId = parseEntityId("run", queued.runId);
    const activeId = parseEntityId("run", running.runId);
    await getDb(ctx.db)
      .update(run)
      .set({ coordinatorStartedAt: new Date() })
      .where(eq(run.id, activeId));
    await writeOutcomeReceipts(ctx.db, [
      {
        runId: queuedId,
        entityKind: "run",
        entityId: queuedId,
        workKey: foreign.id,
        sourceKind: "mail_message",
        sourceExternalKey: foreign.id,
        targetFingerprint: foreign.rawChecksum,
        state: "pending",
      },
    ]);
    const oldRoster = await frozenSources(queuedId);
    const oldEvidence = await getDb(ctx.db)
      .select()
      .from(runOperation)
      .where(eq(runOperation.runId, queuedId));
    const oldJobs = await readJobs(ctx.db, { runId: queuedId });
    const request = await startControlledMailImport(ctx.db, ctx.actor, {
      mailboxId: mail.mailboxId,
      vendorId: vendorShortcode.parse(seller.shortcode),
    });
    const [control] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.shortcode, request.run));
    if (!control)
      throw new Error("Synthetic controlled discovery was not saved");
    expect(await retainedControlledMailIds(ctx.db, control.id)).not.toEqual(
      expect.arrayContaining([settled.id]),
    );
    expect(await retainedControlledMailIds(ctx.db, control.id)).not.toEqual(
      expect.arrayContaining([blocked.id]),
    );
    const wait = () =>
      waitForActiveMailboxImports(ctx.db, {
        mailboxId: mail.mailboxId,
        memberId: party.id,
        controlRunId: control.id,
      });
    await expect(wait()).rejects.toThrow("active Mail import to finish");
    // A currently started coordinator retains its source even if admission is replayed.
    expect(
      await startMailImport(ctx.db, {
        ...base,
        parentRunId: control.id,
        messageIds: [active.id],
      }),
    ).toEqual([running]);
    const [stillActive] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, activeId));
    expect(stillActive).toMatchObject({
      status: "running",
      coordinatorStartedAt: expect.any(Date),
    });
    await getDb(ctx.db)
      .update(run)
      .set({ status: "completed" })
      .where(eq(run.id, activeId));
    await expect(wait()).resolves.toBeUndefined();
    const admission = {
      ...base,
      parentRunId: control.id,
      messageIds: [
        mail.id,
        selected.id,
        foreign.id,
        fresh.id,
        settled.id,
        blocked.id,
      ],
    };
    const admitted = await startMailImport(ctx.db, admission);
    expect(admitted).toHaveLength(2);
    const children = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.parentRunId, control.id));
    expect(children).toHaveLength(2);
    const controlledChild = children[0];
    if (!controlledChild) throw new Error("Synthetic controlled child missing");
    await expect(
      searchMail(
        ctx.db,
        { query: ") OR in:anywhere OR (" },
        { ...ctx.actor, runId: controlledChild.id },
      ),
    ).rejects.toThrow("Controlled mail search requires closed grouping");
    await expect(
      searchMail(
        ctx.db,
        { query: "receipt OR" },
        { ...ctx.actor, runId: controlledChild.id },
      ),
    ).rejects.toThrow("Controlled mail search requires closed grouping");
    expect(children.map((child) => child.vendorId)).toEqual([
      seller.id,
      seller.id,
    ]);
    const selectedRoster = (
      await Promise.all(children.map((child) => frozenSources(child.id)))
    ).flat();
    expect(selectedRoster.map((source) => source.orderMailId).sort()).toEqual(
      [mail.id, selected.id, fresh.id].sort(),
    );
    expect(await frozenSources(queuedId)).toEqual(oldRoster);
    expect(
      await getDb(ctx.db)
        .select()
        .from(runOperation)
        .where(eq(runOperation.runId, queuedId)),
    ).toEqual(expect.arrayContaining(oldEvidence));
    expect(await readJobs(ctx.db, { runId: queuedId })).toEqual(oldJobs);
    const [foreignEmail] = await getDb(ctx.db)
      .select()
      .from(emailTable)
      .where(eq(emailTable.orderMailId, foreign.id));
    expect(foreignEmail).toMatchObject({
      runId: queuedId,
      status: "researching",
    });
    const [oldOwner] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, queuedId));
    if (!oldOwner?.dispatchEventId)
      throw new Error("Synthetic original dispatch missing");
    await expect(
      canDispatchRunCoordinator(ctx.db, {
        runId: queuedId,
        eventId: oldOwner.dispatchEventId,
      }),
    ).rejects.toThrow("Automatic Mail import is paused");
    for (const child of children) {
      if (!child.dispatchEventId)
        throw new Error("Synthetic controlled child dispatch missing");
      expect(
        await canDispatchRunCoordinator(ctx.db, {
          runId: child.id,
          eventId: child.dispatchEventId,
        }),
      ).toBe(true);
    }
    expect(
      (await startMailImport(ctx.db, admission))
        .map((item) => item.runId)
        .sort(),
    ).toEqual(admitted.map((item) => item.runId).sort());
    expect(await readJobs(ctx.db, { kind: "purchase.dispatch" })).toHaveLength(
      4,
    );
    const owned = await getDb(ctx.db)
      .select()
      .from(emailTable)
      .where(inArray(emailTable.orderMailId, [mail.id, selected.id, fresh.id]));
    expect(
      owned.every((email) =>
        children.some((child) => child.id === email.runId),
      ),
    ).toBe(true);
    const preserved = await getDb(ctx.db)
      .select({ status: emailTable.status, runId: emailTable.runId })
      .from(emailTable)
      .where(inArray(emailTable.orderMailId, [settled.id, blocked.id]));
    expect(preserved).toEqual(
      expect.arrayContaining([
        { status: "completed", runId: null },
        { status: "unsettled", runId: null },
      ]),
    );
    await getDb(ctx.db)
      .update(run)
      .set({ status: "completed" })
      .where(eq(run.id, control.id));
    await resumeControlledMailImport(ctx.db, mail.mailboxId);
    expect((await readMailImportSettings(ctx.db)).enabledMailboxes).toContain(
      mail.mailboxId,
    );
    await settleMail(ctx.db, {
      mail: foreign,
      importRunId: queuedId,
      status: "completed",
      detail: "Synthetic unrelated lifecycle notice",
    });
    await expect(
      reconcileSettledRun(ctx.db, {
        runId: queuedId,
        operationId: "settled:after-controlled-transfer",
        generation: oldOwner.dispatchEventId,
        sequence: 1,
      }),
    ).resolves.toMatchObject({ reconciled: true, status: "completed" });
  });

  // Admission freezes the Mail population before any of its targets finish.
  it("reports the known Mail import total while its roster is active", async () => {
    const { party, mail } = await source();
    const [admitted] = await startMailImport(ctx.db, {
      ledgerPartyId: party.id,
      userId: ctx.actor.userId,
      messageIds: [mail.id],
    });
    if (!admitted) throw new Error("Synthetic Mail Run missing");
    const [owner] = await getDb(ctx.db)
      .select({ shortcode: run.shortcode })
      .from(run)
      .where(eq(run.id, parseEntityId("run", admitted.runId)));
    expect(
      (await getRunWorkProgress(ctx.db, owner!.shortcode))!.current,
    ).toMatchObject({ total: 1, processed: 0 });
  });

  it("refuses automatic admission when the sender is excluded while the member lock is held", async () => {
    const { party, mail } = await source();
    const seller = await createRepoEntity(ctx, "vendor", {
      name: "Synthetic lock-window seller",
      orderEmailSenders: ["receipts@shop.example"],
    });
    await getDb(ctx.db).insert(account).values({
      id: crypto.randomUUID(),
      accountId: mail.mailboxId,
      providerId: "google",
      userId: ctx.actor.userId,
      updatedAt: new Date(),
    });
    await setMailImport(ctx.db, { mailboxId: mail.mailboxId, enabled: true });
    expect(
      (await readSenderAttributions(ctx.db, ["receipts@shop.example"]))[0]
        ?.state,
    ).toBe("verified");
    let held!: () => void;
    const holding = new Promise<void>((done) => {
      held = done;
    });
    let release!: () => void;
    const released = new Promise<void>((done) => {
      release = done;
    });
    const holder = withTransaction(ctx.db, async (tx) => {
      await tx.execute(
        sql`SELECT id FROM "LedgerParty" WHERE id = ${party.id}::uuid FOR NO KEY UPDATE`,
      );
      held();
      await released;
    });
    await holding;
    const admission = admitMailImport(ctx.db, {
      ledgerPartyId: party.id,
      userId: ctx.actor.userId,
      mailboxId: mail.mailboxId,
      messageIds: [mail.id],
      automatic: true,
      senderRecheck: {
        sender: "receipts@shop.example",
        vendorId: seller.output.id,
      },
    });
    await pollUntil(
      async () => {
        const waiting = await getDb(ctx.db).execute(
          sql`SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid() LIMIT 1`,
        );
        const rows = Array.isArray(waiting) ? waiting : waiting.rows;
        return rows.length > 0 ? true : undefined;
      },
      {
        label: "admission waiting on the member lock",
        timeoutMs: 4_000,
        intervalMs: 20,
      },
    );
    await setSenderAttribution(
      ctx.db,
      {
        sender: "receipts@shop.example",
        vendorId: null,
        expectedVendorIds: [seller.output.id],
      },
      ctx.actor,
    );
    release();
    await holder;
    await expect(admission).resolves.toEqual([]);
    expect(
      await getDb(ctx.db)
        .select({ id: run.id })
        .from(run)
        .where(eq(run.purpose, "mail_import")),
    ).toEqual([]);
  });

  // Previously classified Email must progress without a member import click;
  // disabled mailboxes, excluded sources, and existing ownership stay respected.
  it("automatically admits retained related Email once its mailbox is enabled and replays without duplicate Runs", async () => {
    const { party, mail } = await source();
    const confirmedVendor = await createRepoEntity(ctx, "vendor", {
      name: "Synthetic confirmed receipt seller",
      orderEmailSenders: ["receipts@shop.example"],
    });
    await getDb(ctx.db).insert(account).values({
      id: crypto.randomUUID(),
      accountId: "synthetic-mailbox",
      providerId: "google",
      userId: ctx.actor.userId,
      updatedAt: new Date(),
    });
    const excluded = await retainedMailFixture(ctx.db, {
      ledgerPartyId: party.id,
      messageId: "excluded-message",
      checksum: "b".repeat(64),
    });
    await getDb(ctx.db)
      .update(emailTable)
      .set({ status: "excluded" })
      .where(eq(emailTable.orderMailId, excluded.id));
    const classificationRunId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "mail_discovery",
      trigger: "scheduled",
      status: "completed",
    });
    await getDb(ctx.db)
      .update(emailTable)
      .set({ runId: classificationRunId })
      .where(eq(emailTable.orderMailId, mail.id));
    await importPendingEmails(ctx.db);
    expect(
      await getDb(ctx.db)
        .select()
        .from(run)
        .where(eq(run.purpose, "mail_import")),
    ).toEqual([]);
    await setMailImport(ctx.db, {
      mailboxId: "synthetic-mailbox",
      enabled: true,
    });
    await importPendingEmails(ctx.db);
    const [owner] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.purpose, "mail_import"));
    expect(owner?.purpose).toBe("mail_import");
    expect(await frozenSources(owner!.id)).toEqual([
      { orderMailId: mail.id, checksum: mail.rawChecksum },
    ]);
    await importPendingEmails(ctx.db);
    expect(
      await getDb(ctx.db)
        .select()
        .from(run)
        .where(eq(run.purpose, "mail_import")),
    ).toHaveLength(1);
    const [excludedEmail] = await getDb(ctx.db)
      .select()
      .from(emailTable)
      .where(eq(emailTable.orderMailId, excluded.id));
    expect(excludedEmail?.runId).toBeNull();
    if (!owner) throw new Error("The automatic import must have an owner");
    await settleMail(ctx.db, {
      mail,
      importRunId: owner.id,
      status: "unsettled",
      detail: "Seller identity needs review",
    });
    await getDb(ctx.db)
      .update(run)
      .set({ status: "needs_review", endedAt: new Date() })
      .where(eq(run.id, owner.id));
    const originalOutcomes = await getDb(ctx.db)
      .select()
      .from(runOperation)
      .where(eq(runOperation.runId, owner.id))
      .orderBy(runOperation.id);
    await importPendingEmails(ctx.db);
    const [rechecked] = await getDb(ctx.db)
      .select()
      .from(emailTable)
      .where(eq(emailTable.orderMailId, mail.id));
    expect(rechecked?.runId).not.toBe(owner.id);
    expect(rechecked?.status).toBe("researching");
    expect(await frozenSources(owner.id)).toEqual([
      { orderMailId: mail.id, checksum: mail.rawChecksum },
    ]);
    const preserved = await getDb(ctx.db)
      .select()
      .from(runOperation)
      .where(eq(runOperation.runId, owner.id))
      .orderBy(runOperation.id);
    expect(preserved).toHaveLength(originalOutcomes.length + 1);
    expect(preserved).toEqual(expect.arrayContaining(originalOutcomes));
    expect(
      preserved.find(
        (operation) => operation.kind === MAIL_SOURCE_TRANSFER_OPERATION,
      )?.result,
    ).toMatchObject({
      toRunId: rechecked?.runId,
      sources: [{ orderMailId: mail.id, checksum: mail.rawChecksum }],
    });
    if (!rechecked?.runId)
      throw new Error("The verified sender must admit a successor");
    await settleMail(ctx.db, {
      mail,
      importRunId: rechecked.runId,
      status: "unsettled",
      detail: "Other receipt evidence is still missing",
    });
    await getDb(ctx.db)
      .update(run)
      .set({ status: "needs_review", endedAt: new Date() })
      .where(eq(run.id, rechecked.runId));
    await importPendingEmails(ctx.db);
    expect(
      await getDb(ctx.db)
        .select()
        .from(run)
        .where(eq(run.purpose, "mail_import")),
    ).toHaveLength(2);
    const alternate = await createRepoEntity(ctx, "vendor", {
      name: "Synthetic alternate seller",
    });
    await withTransaction(ctx.db, (tx) =>
      setSenderAttribution(
        tx,
        {
          sender: "receipts@shop.example",
          vendorId: alternate.output.id,
          expectedVendorIds: [confirmedVendor.output.id],
        },
        ctx.actor,
      ),
    );
    await importPendingEmails(ctx.db);
    const [alternateEmail] = await getDb(ctx.db)
      .select()
      .from(emailTable)
      .where(eq(emailTable.orderMailId, mail.id));
    if (!alternateEmail?.runId)
      throw new Error("Expected alternate mapping owner");
    expect(alternateEmail.runId).not.toBe(rechecked.runId);
    await settleMail(ctx.db, {
      mail,
      importRunId: alternateEmail.runId,
      status: "unsettled",
      detail: "Synthetic unresolved alternate",
    });
    await getDb(ctx.db)
      .update(run)
      .set({ status: "needs_review", endedAt: new Date() })
      .where(eq(run.id, alternateEmail.runId));
    await withTransaction(ctx.db, (tx) =>
      setSenderAttribution(
        tx,
        {
          sender: "receipts@shop.example",
          vendorId: confirmedVendor.output.id,
          expectedVendorIds: [alternate.output.id],
        },
        ctx.actor,
      ),
    );
    await importPendingEmails(ctx.db);
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(emailTable)
          .where(eq(emailTable.orderMailId, mail.id))
      )[0]?.runId,
    ).toBe(alternateEmail.runId);
    // History-only reviews protect retained intent without changing Email.updatedAt.
    const prediction = await recordEmailClassificationObservation(ctx.db, {
      emailId: alternateEmail.id,
      checksum: mail.rawChecksum,
      classification: "uncertain",
      stage: "decision",
      reason: "Synthetic retained prediction",
      classificationVersion: "synthetic-v1",
    });
    await reviewSuggestion(ctx.db, kernelCtx(ctx), {
      suggestionId: prediction.id,
      operationId: crypto.randomUUID(),
      verdict: "wrong",
      intent: "history",
    });
    const replacement = await createRepoEntity(ctx, "vendor", {
      name: "Synthetic replacement receipt seller",
    });
    await withTransaction(ctx.db, (tx) =>
      setSenderAttribution(
        tx,
        {
          sender: "receipts@shop.example",
          vendorId: replacement.output.id,
          expectedVendorIds: [confirmedVendor.output.id],
        },
        ctx.actor,
      ),
    );
    await importPendingEmails(ctx.db);
    expect(
      await getDb(ctx.db)
        .select()
        .from(run)
        .where(eq(run.purpose, "mail_import")),
    ).toHaveLength(3);
  });

  it("queues continuation when enabling import has more than one admission page", async () => {
    const { party } = await source();
    await getDb(ctx.db).insert(account).values({
      id: crypto.randomUUID(),
      accountId: "synthetic-mailbox",
      providerId: "google",
      userId: ctx.actor.userId,
      updatedAt: new Date(),
    });
    await setMailImport(ctx.db, {
      mailboxId: "synthetic-mailbox",
      enabled: true,
    });
    for (let index = 0; index < 50; index += 1)
      await retainedMailFixture(ctx.db, {
        ledgerPartyId: party.id,
        mailboxId: "synthetic-mailbox",
        messageId: `synthetic-backlog-${index}`,
        checksum: "b".repeat(64),
      });
    const configured = vi
      .spyOn(gmailProvider, "gmailOAuthConfigured")
      .mockReturnValue(true);
    try {
      await discoverPurchases(ctx.db);
      expect(
        await readJobs(ctx.db, { kind: "maintenance.purchase-discovery" }),
      ).toMatchObject([{ state: "queued" }]);
      let owners = await getDb(ctx.db)
        .select()
        .from(run)
        .where(eq(run.purpose, "mail_import"));
      expect(
        owners.flatMap(
          (owner) => mailResearchRunInput.parse(owner.input).sources,
        ),
      ).toHaveLength(50);
      await discoverPurchases(ctx.db);
      owners = await getDb(ctx.db)
        .select()
        .from(run)
        .where(eq(run.purpose, "mail_import"));
      const sources = owners.flatMap(
        (owner) => mailResearchRunInput.parse(owner.input).sources,
      );
      expect(sources).toHaveLength(51);
      expect(new Set(sources.map((item) => item.orderMailId)).size).toBe(51);
      await discoverPurchases(ctx.db);
      expect(
        await getDb(ctx.db)
          .select()
          .from(run)
          .where(eq(run.purpose, "mail_import")),
      ).toHaveLength(owners.length);
    } finally {
      configured.mockRestore();
    }
  });

  // Historical ownership blocks and contentless shells must not consume the
  // automatic admission page or prevent healthy retained evidence progressing.
  it("admits usable evidence past blocked sources and fifty empty shells", async () => {
    const { party, mail } = await source();
    await getDb(ctx.db).insert(account).values({
      id: crypto.randomUUID(),
      accountId: "synthetic-mailbox",
      providerId: "google",
      userId: ctx.actor.userId,
      updatedAt: new Date(),
    });
    await setMailImport(ctx.db, {
      mailboxId: "synthetic-mailbox",
      enabled: true,
    });
    await getDb(ctx.db)
      .update(emailTable)
      .set({
        status: "unsettled",
        classificationVersion:
          sourceIdentity.HISTORICAL_MAIL_SOURCE_IDENTITY_VERSION,
      })
      .where(eq(emailTable.orderMailId, mail.id));
    for (let index = 0; index < 50; index += 1) {
      await retainedMailFixture(ctx.db, {
        ledgerPartyId: party.id,
        messageId: `synthetic-shell-${index}`,
        checksum: "b".repeat(64),
        content: { snippet: " \n ", bodyText: null, bodyHtml: null },
      });
    }
    const healthy = await retainedMailFixture(ctx.db, {
      ledgerPartyId: party.id,
      messageId: "synthetic-retained-later",
      checksum: "c".repeat(64),
    });
    await expect(importPendingEmails(ctx.db)).resolves.toBeDefined();
    const [owner] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.purpose, "mail_import"));
    expect(owner).toBeDefined();
    expect(await frozenSources(owner!.id)).toEqual([
      { orderMailId: healthy.id, checksum: healthy.rawChecksum },
    ]);
    const [blocked] = await getDb(ctx.db)
      .select()
      .from(emailTable)
      .where(eq(emailTable.orderMailId, mail.id));
    expect(blocked?.runId).toBeNull();
    expect(blocked?.status).toBe("unsettled");
  });

  // A source can become inadmissible between selection and its transaction;
  // retain that error while allowing the rest of the page to progress.
  it("isolates an admission failure without abandoning healthy retained sources", async () => {
    const { party, mail } = await source();
    await getDb(ctx.db).insert(account).values({
      id: crypto.randomUUID(),
      accountId: "synthetic-mailbox",
      providerId: "google",
      userId: ctx.actor.userId,
      updatedAt: new Date(),
    });
    await setMailImport(ctx.db, {
      mailboxId: "synthetic-mailbox",
      enabled: true,
    });
    const healthy = await retainedMailFixture(ctx.db, {
      ledgerPartyId: party.id,
      messageId: "synthetic-healthy-after-failure",
      checksum: "d".repeat(64),
    });
    const original = sourceIdentity.assertMailSourceIdentityReady;
    const interleaving = vi
      .spyOn(sourceIdentity, "assertMailSourceIdentityReady")
      .mockImplementation(async (...args) => {
        await original(...args);
        if (args[1].id === mail.id)
          throw new Error("Synthetic source changed after selection");
      });
    try {
      const result = await importPendingEmails(ctx.db);
      expect(result.errors).toHaveLength(1);
      expect(String(result.errors[0])).toContain(
        "Synthetic source changed after selection",
      );
      const [owner] = await getDb(ctx.db)
        .select()
        .from(run)
        .where(eq(run.purpose, "mail_import"));
      expect(owner).toBeDefined();
      expect(await frozenSources(owner!.id)).toEqual([
        { orderMailId: healthy.id, checksum: healthy.rawChecksum },
      ]);
    } finally {
      interleaving.mockRestore();
    }
  });

  // Settlement must publish once, preserve the actual producer, and allow a
  // history grade without granting authority to rewrite the imported ledger.
  it("freezes Mail import outcomes with rule provenance and immutable retry identity", async () => {
    const { party, mail } = await source();
    const [admitted] = await startMailImport(ctx.db, {
      ledgerPartyId: party.id,
      userId: ctx.actor.userId,
      messageIds: [mail.id],
    });
    if (!admitted) throw new Error("Synthetic Run missing");
    const input = {
      mail,
      importRunId: parseEntityId("run", admitted.runId),
      status: "completed" as const,
      classification: "unrelated" as const,
      detail: "unrelated: Synthetic newsletter",
      ruleRevision: "synthetic-rule-v1",
    };
    await settleMail(ctx.db, input);
    await settleMail(ctx.db, input);
    const history = await readMailImportOutcomes(
      ctx.db,
      {
        mailboxId: mail.mailboxId,
        messageId: mail.messageId,
      },
      ctx.actor,
    );
    expect(history.items).toMatchObject([
      {
        checksum: mail.rawChecksum,
        judgment: { kind: "unrelated", reason: "Synthetic newsletter" },
        producer: { kind: "rule", model: null, revision: "synthetic-rule-v1" },
      },
    ]);
    const prediction = { id: history.items[0]!.suggestionId };
    expect(history.nextOffset).toBeNull();
    expect(history.items[0]?.producer?.runId).toMatch(/^RUN-/);
    await expect(
      readMailImportOutcomes(
        ctx.db,
        {
          mailboxId: "synthetic-unowned-mailbox",
          messageId: mail.messageId,
        },
        ctx.actor,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND", reason: "EMAIL_NOT_FOUND" });
    const { reviewSuggestion } =
      await import("~/server/generic/suggestions/repo/review");
    const { kernelCtx } =
      await import("~/server/domains/run/service/suggestion-sweep.fixtures");
    await reviewSuggestion(ctx.db, kernelCtx(ctx), {
      suggestionId: prediction.id,
      operationId: "synthetic-member-grade",
      verdict: "wrong",
      intent: "history",
      reason: "Synthetic member correction",
      correction: {
        present: true,
        value: { kind: "unresolved", reason: "Needs evidence" },
      },
    });
    await expect(
      reviewSuggestion(ctx.db, kernelCtx(ctx), {
        suggestionId: prediction.id,
        operationId: "synthetic-apply-refused",
        verdict: "correct",
        intent: "apply",
      }),
    ).rejects.toThrow(/history only/);
    expect(
      await getDb(ctx.db)
        .select({ operationId: emailReview.operationId })
        .from(emailReview)
        .where(
          and(
            eq(emailReview.subjectId, prediction.id),
            eq(emailReview.authority, "member"),
          ),
        ),
    ).toEqual([{ operationId: "synthetic-member-grade" }]);
  });

  it("preserves the parent Email outcome after a retry transfers its live assignment", async () => {
    const { party, mail } = await source();
    const [admitted] = await startMailImport(ctx.db, {
      ledgerPartyId: party.id,
      userId: ctx.actor.userId,
      messageIds: [mail.id],
    });
    if (!admitted) throw new Error("Synthetic parent missing");
    await settleMail(ctx.db, {
      mail,
      importRunId: parseEntityId("run", admitted.runId),
      status: "unsettled",
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

  it("shows a moved unattempted target without inheriting its successor's live outcome", async () => {
    const { party, mail } = await source();
    const [admitted] = await startMailImport(ctx.db, {
      ledgerPartyId: party.id,
      userId: ctx.actor.userId,
      messageIds: [mail.id],
    });
    if (!admitted) throw new Error("Synthetic parent missing");
    const parentId = parseEntityId("run", admitted.runId);
    await markRunFailed(ctx.db, {
      runId: parentId,
      failureCode: "agent_failed",
    });
    const [child] = await startMailImport(ctx.db, {
      ledgerPartyId: party.id,
      userId: ctx.actor.userId,
      messageIds: [mail.id],
    });
    if (!child) throw new Error("Synthetic successor missing");
    const childId = parseEntityId("run", child.runId);
    const [childRow] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, childId));
    const [parentRow] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, parentId));
    if (!childRow || !parentRow) throw new Error("Synthetic Run missing");
    await settleMail(ctx.db, {
      mail,
      importRunId: childId,
      status: "completed",
      detail: "Synthetic successor import",
    });
    const parent = await loadRunDetail(ctx.db, parentRow.shortcode);
    expect(parent.targets).toMatchObject([
      {
        state: "unresolved",
        outcome: null,
        completedAt: null,
        warning: `Moved to ${childRow.shortcode}.`,
      },
    ]);
  });

  it.each(["claim", "outcome"] as const)(
    "retains only Emails an earlier review Run attempted through a %s",
    async (attempt) => {
      const { party, mail } = await source();
      const untouched = await retainedMailFixture(ctx.db, {
        ledgerPartyId: party.id,
        mailboxId: "synthetic-mailbox",
        messageId: "synthetic-unattempted",
        checksum: "f".repeat(64),
      });
      const completed = await retainedMailFixture(ctx.db, {
        ledgerPartyId: party.id,
        mailboxId: "synthetic-mailbox",
        messageId: "synthetic-already-settled",
        checksum: "e".repeat(64),
      });
      const admission = {
        ledgerPartyId: party.id,
        userId: ctx.actor.userId,
        messageIds: [mail.id, untouched.id, completed.id],
      };
      const [first] = await startMailImport(ctx.db, admission);
      if (!first) throw new Error("Synthetic first Run missing");
      const firstId = parseEntityId("run", first.runId);
      await insertOperation(getDb(ctx.db), {
        runId: firstId,
        operationId: "claim:already-settled",
        kind: "claim_next_work",
        inputFingerprint: "synthetic-settled-claim",
        state: "completed",
        result: {
          kind: "email",
          email: {
            mailboxId: completed.mailboxId,
            messageId: completed.messageId,
          },
        },
      });
      await settleMail(ctx.db, {
        mail: completed,
        importRunId: firstId,
        status: "completed",
        detail: "Synthetic settled original",
      });
      if (attempt === "claim")
        await insertOperation(getDb(ctx.db), {
          runId: firstId,
          operationId: "claim:attempted",
          kind: "claim_next_work",
          inputFingerprint: "synthetic-claim",
          state: "completed",
          result: {
            kind: "email",
            email: { mailboxId: mail.mailboxId, messageId: mail.messageId },
          },
        });
      else {
        await settleMail(ctx.db, {
          mail,
          importRunId: firstId,
          status: "unsettled",
          detail: "Synthetic unresolved identity",
        });
      }
      await getDb(ctx.db)
        .update(run)
        .set({ status: "needs_review", endedAt: new Date() })
        .where(eq(run.id, firstId));
      const [firstRow] = await getDb(ctx.db)
        .select()
        .from(run)
        .where(eq(run.id, firstId));
      if (!firstRow) throw new Error("Synthetic first Run missing");
      const successor = await controlRun(ctx.db, ctx.actor, {
        runPublicId: firstRow.shortcode,
        action: "restart",
      });
      if (!("successorRunId" in successor) || !successor.successorRunId)
        throw new Error("Synthetic retry missing");
      const successorId = parseEntityId("run", successor.successorRunId);
      await markRunFailed(ctx.db, {
        runId: successorId,
        failureCode: "agent_failed",
      });
      const emails = await getDb(ctx.db).select().from(emailTable);
      expect(emails.find((row) => row.orderMailId === mail.id)).toMatchObject({
        runId: successorId,
        status: "unsettled",
      });
      expect(
        emails.find((row) => row.orderMailId === untouched.id),
      ).toMatchObject({ runId: null, status: "pending" });
      expect(
        emails.find((row) => row.orderMailId === completed.id),
      ).toMatchObject({ runId: null, status: "pending" });
    },
  );
  // A failed Run must not strand its unsettled Emails (discovery admits only
  // unowned ones), a message that fails twice must not spend a coordinator on
  // every discovery pass, and a retry must not refuse because one source left.
  it("returns a failed Run's unsettled Emails to discovery once and retries only what it still holds", async () => {
    const { party, mail } = await source();
    const settled = await retainedMailFixture(ctx.db, {
      ledgerPartyId: party.id,
      mailboxId: "synthetic-mailbox",
      messageId: "synthetic-settled",
      checksum: "c".repeat(64),
    });
    const [admitted] = await startMailImport(ctx.db, {
      ledgerPartyId: party.id,
      userId: ctx.actor.userId,
      messageIds: [mail.id, settled.id],
    });
    if (!admitted) throw new Error("Synthetic Run missing");
    const runId = parseEntityId("run", admitted.runId);
    // No coordinator reached `mail` in this Run, so it returns to discovery.
    await settleMail(ctx.db, {
      mail: settled,
      importRunId: runId,
      status: "unsettled",
      detail: "Synthetic gap the member reviews",
    });
    const emailState = async (orderMailId: string) =>
      (
        await getDb(ctx.db)
          .select({ runId: emailTable.runId, status: emailTable.status })
          .from(emailTable)
          .where(eq(emailTable.orderMailId, orderMailId))
      )[0];

    await markRunFailed(ctx.db, { runId, failureCode: "agent_failed" });
    expect(await emailState(mail.id)).toEqual({
      runId: null,
      status: "pending",
    });
    expect(await emailState(settled.id)).toEqual({
      runId,
      status: "unsettled",
    });
    const [failed] = await getDb(ctx.db)
      .select({ shortcode: run.shortcode })
      .from(run)
      .where(eq(run.id, runId));
    expect(
      (await loadRunDetail(ctx.db, failed!.shortcode)).targets,
    ).toContainEqual(
      expect.objectContaining({
        state: "unresolved",
        warning: "Returned to Mail discovery after this Run ended.",
      }),
    );

    const successor = await controlRun(ctx.db, ctx.actor, {
      runPublicId: failed!.shortcode,
      action: "retry",
    });
    if (!("successorRunId" in successor) || !successor.successorRunId)
      throw new Error("Synthetic retry missing");
    expect(await frozenSources(successor.successorRunId)).toEqual([
      { orderMailId: settled.id, checksum: settled.rawChecksum },
    ]);
    expect(await emailState(mail.id)).toEqual({
      runId: null,
      status: "pending",
    });

    const [again] = await startMailImport(ctx.db, {
      ledgerPartyId: party.id,
      userId: ctx.actor.userId,
      messageIds: [mail.id],
    });
    if (!again) throw new Error("Synthetic readmission missing");
    const againId = parseEntityId("run", again.runId);
    await insertOperation(getDb(ctx.db), {
      runId: againId,
      operationId: "claim:synthetic-failure",
      kind: "claim_next_work",
      inputFingerprint: "synthetic-failure",
      state: "completed",
      result: {
        kind: "email",
        email: { mailboxId: mail.mailboxId, messageId: mail.messageId },
      },
    });
    await markRunFailed(ctx.db, {
      runId: againId,
      failureCode: "agent_failed",
    });
    // A claimed Email stays with the Run, and no longer claims research
    // nothing is doing; only new evidence readmits it.
    expect(await emailState(mail.id)).toEqual({
      runId: againId,
      status: "unsettled",
    });
  });

  // A coordinator that stops before claiming every Email leaves the rest
  // researching under a Run in review, which discovery never admits again.
  it("returns unclaimed Emails to discovery when a Run stops for review, keeping its blocked ones", async () => {
    const { party, mail } = await source();
    const blocked = await retainedMailFixture(ctx.db, {
      ledgerPartyId: party.id,
      mailboxId: "synthetic-mailbox",
      messageId: "synthetic-blocked",
      checksum: "d".repeat(64),
    });
    const [admitted] = await startMailImport(ctx.db, {
      ledgerPartyId: party.id,
      userId: ctx.actor.userId,
      messageIds: [mail.id, blocked.id],
    });
    if (!admitted) throw new Error("Synthetic Run missing");
    const runId = parseEntityId("run", admitted.runId);
    await settleMail(ctx.db, {
      mail: blocked,
      importRunId: runId,
      status: "unsettled",
      detail: "Synthetic gap the member reviews",
    });
    const [owner] = await getDb(ctx.db)
      .select({ generation: run.dispatchEventId })
      .from(run)
      .where(eq(run.id, runId));
    await expect(
      reconcileSettledRun(ctx.db, {
        runId,
        operationId: "settled:unfinished",
        generation: owner!.generation!,
        sequence: 1,
      }),
    ).resolves.toMatchObject({ status: "needs_review" });
    const emailState = async (orderMailId: string) =>
      (
        await getDb(ctx.db)
          .select({ runId: emailTable.runId, status: emailTable.status })
          .from(emailTable)
          .where(eq(emailTable.orderMailId, orderMailId))
      )[0];
    expect(await emailState(mail.id)).toEqual({
      runId: null,
      status: "pending",
    });
    expect(await emailState(blocked.id)).toEqual({
      runId,
      status: "unsettled",
    });
  });

  it("holds automatic admission after a Run fails on its own, until the backoff passes", async () => {
    const { party, mail } = await source();
    await getDb(ctx.db).insert(account).values({
      id: crypto.randomUUID(),
      accountId: "synthetic-mailbox",
      providerId: "google",
      userId: ctx.actor.userId,
      updatedAt: new Date(),
    });
    const [first] = await startMailImport(ctx.db, {
      ledgerPartyId: party.id,
      userId: ctx.actor.userId,
      messageIds: [mail.id],
    });
    if (!first) throw new Error("Synthetic Run missing");
    const owner = async () =>
      (
        await getDb(ctx.db)
          .select({ runId: emailTable.runId })
          .from(emailTable)
          .where(eq(emailTable.orderMailId, mail.id))
      )[0]?.runId;
    // A deterministic failure says nothing about the next Run: no hold.
    await markRunFailed(ctx.db, {
      runId: parseEntityId("run", first.runId),
      failureCode: "agent_failed",
    });
    await setMailImport(ctx.db, { mailboxId: mail.mailboxId, enabled: true });
    await importPendingEmails(ctx.db);
    const failedId = await owner();
    if (!failedId) throw new Error("Synthetic readmission missing");
    expect(failedId).not.toBe(first.runId);
    // A transient one (here out of retries) holds admission for the backoff.
    await markRunFailed(ctx.db, {
      runId: failedId,
      failureCode: "agent_failed",
    });
    await getDb(ctx.db)
      .update(run)
      .set({ failureCode: "agent_transient" })
      .where(eq(run.id, failedId));
    await importPendingEmails(ctx.db);
    expect(await owner()).toBeNull();

    await getDb(ctx.db)
      .update(run)
      .set({ endedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
      .where(eq(run.id, failedId));
    await importPendingEmails(ctx.db);
    expect(await owner()).not.toBeNull();
  });

  // Each automatic retry re-spends a coordinator: only a transient failure
  // retries, only unsettled Emails move, and the third attempt is the last.
  it("retries a transient failure as escalated successors until its third attempt, then leaves one finding", async () => {
    const { party, mail } = await source();
    const settled = await retainedMailFixture(ctx.db, {
      ledgerPartyId: party.id,
      mailboxId: "synthetic-mailbox",
      messageId: "synthetic-settled-before-outage",
      checksum: "e".repeat(64),
    });
    const [admitted] = await startMailImport(ctx.db, {
      ledgerPartyId: party.id,
      userId: ctx.actor.userId,
      messageIds: [mail.id, settled.id],
    });
    if (!admitted) throw new Error("Synthetic Run missing");
    const first = parseEntityId("run", admitted.runId);
    await settleMail(ctx.db, {
      mail: settled,
      importRunId: first,
      status: "completed",
      detail: "linked:shipped",
    });
    const attempts = [first];
    const detail = "Coordinator transient failure (model_error): 503 synthetic";
    const failTransiently = async (current: (typeof attempts)[number]) => {
      await markRunFailed(ctx.db, {
        runId: current,
        failureCode: "agent_transient",
        detail,
      });
      const [successor] = await getDb(ctx.db)
        .select({
          id: run.id,
          cause: run.cause,
          status: run.status,
          coordinatorModel: run.coordinatorModel,
        })
        .from(run)
        .where(eq(run.predecessorRunId, current));
      return successor;
    };
    for (let attempt = 1; attempt < 3; attempt++) {
      const successor = await failTransiently(attempts.at(-1)!);
      expect(successor).toMatchObject({
        cause: "retry",
        status: "running",
        coordinatorModel: coordinatorModelFor("mail_import"),
      });
      expect(await frozenSources(successor!.id)).toEqual([
        { orderMailId: mail.id, checksum: mail.rawChecksum },
      ]);
      attempts.push(successor!.id);
    }
    expect(await failTransiently(attempts.at(-1)!)).toBeUndefined();
    const findings = await getDb(ctx.db)
      .select({ runId: runFinding.runId, summary: runFinding.summary })
      .from(runFinding)
      .where(inArray(runFinding.runId, attempts));
    expect(findings).toEqual([{ runId: attempts[2], summary: detail }]);
    const [held] = await getDb(ctx.db)
      .select({ runId: emailTable.runId, status: emailTable.status })
      .from(emailTable)
      .where(eq(emailTable.orderMailId, settled.id));
    expect(held).toEqual({ runId: first, status: "completed" });
  });

  // A coordinator failing before its first claim attempted nothing per Email;
  // without a per-revision bound, discovery readmitted the same evidence into
  // a new paid Run after every such failure.
  it("bounds automatic readmission of unchanged evidence after failures before any claim", async () => {
    const { mail } = await source();
    await getDb(ctx.db).insert(account).values({
      id: crypto.randomUUID(),
      accountId: "synthetic-mailbox",
      providerId: "google",
      userId: ctx.actor.userId,
      updatedAt: new Date(),
    });
    await setMailImport(ctx.db, { mailboxId: mail.mailboxId, enabled: true });
    const holder = async () =>
      (
        await getDb(ctx.db)
          .select({ runId: emailTable.runId, status: emailTable.status })
          .from(emailTable)
          .where(eq(emailTable.orderMailId, mail.id))
      )[0];
    const attempts: string[] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect((await importPendingEmails(ctx.db)).errors).toEqual([]);
      const current = await holder();
      expect(current?.status).toBe("researching");
      expect(attempts).not.toContain(current?.runId);
      attempts.push(current!.runId!);
      await markRunFailed(ctx.db, {
        runId: parseEntityId("run", current!.runId!),
        failureCode: "agent_failed",
      });
    }
    // Out of attempts, it stays with its last Run until new evidence.
    expect(await holder()).toEqual({ runId: attempts[2], status: "unsettled" });
    expect((await importPendingEmails(ctx.db)).errors).toEqual([]);
    expect(await holder()).toEqual({ runId: attempts[2], status: "unsettled" });
    expect(
      await getDb(ctx.db)
        .select({ id: run.id })
        .from(run)
        .where(eq(run.purpose, "mail_import")),
    ).toHaveLength(3);
  });

  it("readmits a released Email under a new Run when its failed Run admitted only it", async () => {
    const { party, mail } = await source();
    const admission = {
      ledgerPartyId: party.id,
      userId: ctx.actor.userId,
      messageIds: [mail.id],
    };
    const [first] = await startMailImport(ctx.db, admission);
    if (!first) throw new Error("Synthetic Run missing");
    await markRunFailed(ctx.db, {
      runId: parseEntityId("run", first.runId),
      failureCode: "agent_failed",
    });
    const [second] = await startMailImport(ctx.db, admission);
    expect(second?.runId).not.toBe(first.runId);
    const [owned] = await getDb(ctx.db)
      .select({ runId: emailTable.runId, status: emailTable.status })
      .from(emailTable)
      .where(eq(emailTable.orderMailId, mail.id));
    expect(owned).toEqual({ runId: second?.runId, status: "researching" });
  });

  it("preserves a migrated blocked receipt after its successor completes and the live Email changes", async () => {
    const { party, mail } = await source();
    const [admitted] = await startMailImport(ctx.db, {
      ledgerPartyId: party.id,
      userId: ctx.actor.userId,
      messageIds: [mail.id],
    });
    if (!admitted) throw new Error("Synthetic migrated parent missing");
    const db = getDb(ctx.db);
    const parent = await db.query.run.findFirst({
      where: {
        RAW: (table: PgTable) =>
          relationalSql(
            table,
            eq(run.id, parseEntityId("run", admitted.runId)),
          ),
      },
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
        status: "unsettled",
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
    await expect(
      startMailImport(ctx.db, {
        ledgerPartyId: party.id,
        userId: ctx.actor.userId,
        messageIds: [mail.id],
        parentRunId: parent,
      }),
    ).rejects.toThrow(/classification.only/iu);
    expect(await dispatches()).toEqual([]);
    expect(
      (await getDb(ctx.db).select().from(run)).filter(
        (row) => row.purpose === "mail_import",
      ),
    ).toEqual([]);
  });
  it("refuses selected Luna when cancellation completes during source validation", async () => {
    const { party, mail } = await source();
    if (!mail.rawChecksum) throw new Error("Synthetic checksum missing");
    const [admitted] = await startMailImport(ctx.db, {
      ledgerPartyId: party.id,
      userId: ctx.actor.userId,
      messageIds: [mail.id],
      expectedChecksums: [{ orderMailId: mail.id, checksum: mail.rawChecksum }],
    });
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
    },
    {
      provider: "openai",
      model: "gpt-6.1-sol",
      endpoint: "responses",
    },
    {
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      endpoint: "v1/messages",
    },
  ] as const)(
    "admits member-selected coordinator $model past a spent background budget",
    async ({ provider, model, endpoint }) => {
      const { party, mail } = await source();
      const [admitted] = await startMailImport(ctx.db, {
        ledgerPartyId: party.id,
        userId: ctx.actor.userId,
        messageIds: [mail.id],
        expectedChecksums: [
          { orderMailId: mail.id, checksum: mail.rawChecksum! },
        ],
      });
      if (!admitted) throw new Error("Selected mail Run missing");
      let transmissions = 0;
      const paid = gatewayFetchThrough({
        provider,
        beforePaidRequest: paidRunPreflight(
          ctx.db,
          parseEntityId("run", admitted.runId),
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
      // Foreground coordinator work is not budgeted background spend.
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
      const [admitted] = await startMailImport(ctx.db, {
        ledgerPartyId: party.id,
        userId: ctx.actor.userId,
        messageIds: [mail.id],
        expectedChecksums: [
          { orderMailId: mail.id, checksum: mail.rawChecksum! },
        ],
      });
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
        status: "unsettled",
        classificationVersion: "legacy-source-identity-unresolved/v1",
      })
      .where(eq(emailTable.orderMailId, mail.id));
    const before = await getDb(ctx.db).select().from(emailTable);
    const retainedBefore = await getDb(ctx.db).select().from(orderMail);
    await expect(
      startMailImport(ctx.db, {
        ledgerPartyId: party.id,
        userId: ctx.actor.userId,
        mailboxId: mail.mailboxId,
        messageIds: [mail.id],
      }),
    ).rejects.toThrow(/historical.*ownership|original.*mapping/u);
    expect(await dispatches()).toEqual([]);
    expect(await getDb(ctx.db).select().from(run)).toEqual([]);
    expect(await getDb(ctx.db).select().from(emailTable)).toEqual(before);
    expect(await getDb(ctx.db).select().from(orderMail)).toEqual(
      retainedBefore,
    );
  });
  it("commits mail admission and dispatch intent atomically", async () => {
    const { party, mail } = await source();
    const input = {
      ledgerPartyId: party.id,
      userId: ctx.actor.userId,
      mailboxId: mail.mailboxId,
      messageIds: [mail.id],
    };
    await expect(
      withTransaction(ctx.db, async (tx) => {
        await startMailImport(databaseForTransaction(tx), input);
        expect(
          await readJobs(databaseForTransaction(tx), {
            kind: "purchase.dispatch",
          }),
        ).toHaveLength(1);
        throw new Error("Synthetic admission rollback");
      }),
    ).rejects.toThrow("Synthetic admission rollback");
    expect(await dispatches()).toEqual([]);
    expect(await getDb(ctx.db).select().from(run)).toEqual([]);
    await withTransaction(ctx.db, async (tx) => {
      await startMailImport(databaseForTransaction(tx), input);
      expect(
        await readJobs(databaseForTransaction(tx), {
          kind: "purchase.dispatch",
        }),
      ).toHaveLength(1);
    });
    expect(await dispatches()).toHaveLength(1);
  });
  it("admits a source set once, with durable message ownership and no browser prerequisite", async () => {
    const { party, mail } = await source();
    const input = {
      ledgerPartyId: party.id,
      userId: ctx.actor.userId,
      mailboxId: mail.mailboxId,
      messageIds: [mail.id],
    };
    const first = await startMailImport(ctx.db, input);
    expect(first).toHaveLength(1);
    expect(await startMailImport(ctx.db, input)).toEqual(first);
    const [result] = first;
    if (!result) throw new Error("Research Run was not created");
    expect(await dispatches()).toHaveLength(1);
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
    const [started] = await startMailImport(ctx.db, {
      ledgerPartyId: party.id,
      userId: ctx.actor.userId,
      mailboxId: mail.mailboxId,
      messageIds: [mail.id],
      parentRunId,
    });
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
    const input = {
      ledgerPartyId: party.id,
      userId: ctx.actor.userId,
      mailboxId: mail.mailboxId,
      messageIds: [mail.id],
    };
    await expect(
      startMailImport(ctx.db, {
        ...input,
        expectedChecksums: [{ orderMailId: mail.id, checksum: "b".repeat(64) }],
      }),
    ).rejects.toThrow(/changed/);
    await expect(
      startMailImport(ctx.db, { ...input, userId: "synthetic-other-user" }),
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
    const input = {
      ledgerPartyId: party.id,
      userId: ctx.actor.userId,
      mailboxId: mail.mailboxId,
      messageIds: [mail.id],
    };
    const [first] = await startMailImport(ctx.db, input);
    if (!first) throw new Error("First research Run was not created");
    const overlapping = await startMailImport(ctx.db, {
      ...input,
      messageIds: [mail.id, second.id],
    });
    expect(overlapping).toHaveLength(2);
    expect(overlapping).toContainEqual(first);
    expect(await dispatches()).toHaveLength(2);
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

  it("does not relaunch retained historical mail after Gmail excluded or deleted it", async () => {
    const { party, mail } = await source();
    await getDb(ctx.db)
      .update(emailTable)
      .set({ status: "excluded", orderMailId: null })
      .where(eq(emailTable.orderMailId, mail.id));
    const before = await getDb(ctx.db).select().from(emailTable);
    const retainedBefore = await getDb(ctx.db).select().from(orderMail);
    await expect(
      startMailImport(ctx.db, {
        ledgerPartyId: party.id,
        userId: ctx.actor.userId,
        mailboxId: mail.mailboxId,
        messageIds: [mail.id],
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(await dispatches()).toEqual([]);
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
      "run_read",
      { action: "work_snapshot", runId: runShortcode.parse(runId) },
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
