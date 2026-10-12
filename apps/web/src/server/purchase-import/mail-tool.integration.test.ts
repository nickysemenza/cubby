import {
  MAIL_ATTACHMENT_MAX_BYTES,
  mailResolveInput,
} from "@cubby/schemas/mailbox-research";
/**
 * Failures: search reaches a mailbox the member never connected, follows a
 * page into another mailbox, pages without Spam/Trash exclusion, or advances
 * mailbox coverage (also after an upstream 429); revoked Gmail authorization
 * surfaces as a crash instead of a reconnect result; `mail.read` returns
 * another message's attachment, loses the original once storage moves to its
 * Image, serves changed bytes, or truncates an oversized original; an
 * unrelated disposition deletes an original a Purchase still depends on, a
 * disposal lost after the disposition commits is never retried, or a replay
 * fails once the original is gone; a cancelled, retired or deleted Mail import
 * Run still reads, resolves, or spends on search.
 */
import { mailResearchRunInput } from "@cubby/schemas/run-fields";
import { sha256Hex } from "@cubby/shared/sha256";
import { fromPartial } from "@total-typescript/shoehorn";
import { and, eq, inArray } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it, vi } from "vitest";

import { wrapAiGatewayError } from "~/server/ai/gateway-error";
import { account } from "~/server/db/auth.schema";
import {
  emailClassificationObservation,
  importSourceClaim,
  importSourceOrder,
  mailboxCursor,
  email as emailTable,
  orderMail,
  purchase,
  orderMailAttachment,
  orderMailCandidateDecision,
  orderMailEvent,
  run,
  financialAccount,
  financialTransaction,
  financialTransactionAllocation,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import {
  readRetainedMail,
  retainedMailJoin,
} from "~/server/repo/retained-mail";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import * as s3 from "~/server/utils/s3";

import { loadMailAttachmentOriginal } from "./gmail/attachment-original";
import type { OrderMailAttachmentStorage } from "./gmail/attachment-storage";
import { disposeUnrelatedOriginals } from "./gmail/persistence";
import * as gmail from "./gmail/provider";
import { GmailAuthorizationError } from "./gmail/tokens";
import * as routing from "./gmail/triage-model";
import { GmailApiError, type GmailProvider } from "./gmail/types";
import { readMail, resolveMail, searchMail, settleMail } from "./mail-tool";
import { retainedMailFixture } from "./order-import.fixtures";

const mailboxId = "synthetic-mailbox";
const receiptBytes = new TextEncoder().encode(
  "%PDF-1.4\nSynthetic kettle: XL copper variant\n%%EOF\n",
);

describe("public mail tool", () => {
  const ctx = withTestDb();
  afterEach(() => vi.restoreAllMocks());

  const member = () =>
    insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic mail member",
      kind: "member",
      userId: ctx.actor.userId,
    });

  const connect = (accountId: string) =>
    getDb(ctx.db).insert(account).values({
      id: crypto.randomUUID(),
      accountId,
      providerId: "google",
      userId: ctx.actor.userId,
      updatedAt: new Date(),
    });

  it("atomically links a combined lifecycle Email to every Purchase and replays without duplicate evidence", async () => {
    const party = await member();
    const source = await retainedMailFixture(ctx.db, {
      ledgerPartyId: party.id,
      mailboxId,
      messageId: "synthetic-combined-refund",
      sender: "credits@bank.example.test",
      subject: "Combined merchant credit",
      receivedAt: new Date("2026-10-07T12:00:00Z"),
      checksum: await sha256Hex("Synthetic combined credit"),
      content: {
        snippet: "Synthetic combined credit",
        bodyText: "Synthetic combined credit",
        bodyHtml: null,
      },
    });
    if (!source) throw new Error("Synthetic source unavailable");
    const seller = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic combined-credit seller",
    });
    const purchases = await Promise.all(
      ["FIRST", "SECOND"].map((orderId) =>
        insertWithShortcode(ctx.db, "purchase", {
          vendorId: seller.id,
          orderId,
        }),
      ),
    );
    const input = mailResolveInput.parse({
      mailboxId,
      messageId: source.messageId,
      checksum: source.rawChecksum,
      disposition: {
        kind: "linked",
        event: "refunded",
        purchaseIds: purchases.map((row) => row.shortcode),
      },
    });
    const secondPurchase = purchases[1];
    if (!secondPurchase) throw new Error("Synthetic second Purchase missing");
    const resolve = () => resolveMail(ctx.db, input, ctx.actor);
    await expect(
      resolveMail(ctx.db, { ...input, checksum: "f".repeat(64) }, ctx.actor),
    ).rejects.toThrow("changed");
    await getDb(ctx.db)
      .insert(orderMailEvent)
      .values({
        orderMailId: source.id,
        event: "refunded",
        sourceKey: "synthetic-dismissal",
      })
      .returning()
      .then(async ([event]) => {
        if (!event) throw new Error("Synthetic event missing");
        await getDb(ctx.db).insert(orderMailCandidateDecision).values({
          eventId: event.id,
          purchaseId: secondPurchase.id,
          decision: "dismissed",
          evidenceChecksum: source.rawChecksum,
          decidedByUserId: ctx.actor.userId,
        });
      });
    await expect(resolve()).rejects.toThrow("dismissed");
    expect(
      await getDb(ctx.db)
        .select()
        .from(orderMailEvent)
        .where(eq(orderMailEvent.orderMailId, source.id)),
    ).toHaveLength(1);
    await getDb(ctx.db)
      .delete(orderMailCandidateDecision)
      .where(eq(orderMailCandidateDecision.purchaseId, secondPurchase.id));
    await getDb(ctx.db)
      .delete(orderMailEvent)
      .where(eq(orderMailEvent.sourceKey, "synthetic-dismissal"));
    await expect(resolve()).resolves.toMatchObject({
      status: "completed",
      purchaseIds: expect.arrayContaining(
        purchases.map((row) => row.shortcode),
      ),
    });
    await expect(resolve()).resolves.toMatchObject({ status: "completed" });
    const events = await getDb(ctx.db)
      .select()
      .from(orderMailEvent)
      .where(eq(orderMailEvent.orderMailId, source.id));
    expect(events).toHaveLength(2);
    const decisions = await getDb(ctx.db)
      .select()
      .from(orderMailCandidateDecision)
      .where(
        inArray(
          orderMailCandidateDecision.eventId,
          events.map((row) => row.id),
        ),
      );
    expect(new Set(decisions.map((row) => row.purchaseId))).toEqual(
      new Set(purchases.map((row) => row.id)),
    );
    expect(decisions).toHaveLength(2);
    const account = await insertWithShortcode(ctx.db, "financialAccount", {
      name: "Synthetic refund account",
      identity: {
        kind: "credit_card",
        issuer: "Synthetic bank",
        network: "amex",
      },
      ledgerPartyId: party.id,
    });
    const refunds = await Promise.all(
      purchases.map((_row, i) =>
        insertWithShortcode(ctx.db, "financialTransaction", {
          accountId: account.id,
          amount: i === 0 ? -3 : -7,
          kind: "refund",
          status: "posted",
          transactionDate: "2026-10-07",
          postedDate: "2026-10-07",
        }),
      ),
    );
    await getDb(ctx.db)
      .insert(financialTransactionAllocation)
      .values(
        refunds.map((row, i) => {
          const purchased = purchases[i];
          if (!purchased) throw new Error("Synthetic refund Purchase missing");
          return {
            transactionId: row.id,
            purchaseId: purchased.id,
            amount: row.amount,
          };
        }),
      );
    const financialBefore = await getDb(ctx.db)
      .select()
      .from(financialTransaction);
    const allocationBefore = await getDb(ctx.db)
      .select()
      .from(financialTransactionAllocation);
    const accountBefore = await getDb(ctx.db).select().from(financialAccount);
    const reviewedInput = {
      ...input,
      disposition: {
        ...input.disposition,
        settlement: {
          refundAmount: -10,
          associations: refunds.map((row) => ({
            transactionId: row.shortcode,
            reviewedAccountId: account.shortcode,
            sourceAccountLabel: "Account ending 54321",
            reviewReason:
              "Member confirmed the source label belongs to this account; original merchant orders and posted refunds establish both legs.",
          })),
        },
      },
    };
    await expect(
      resolveMail(
        ctx.db,
        fromPartial<Parameters<typeof resolveMail>[1]>(reviewedInput),
        ctx.actor,
      ),
    ).resolves.toMatchObject({
      financialAssociations: expect.arrayContaining(
        refunds.map((row) =>
          expect.objectContaining({
            transactionId: row.shortcode,
            reviewedAccountId: account.shortcode,
          }),
        ),
      ),
    });
    await expect(
      resolveMail(
        ctx.db,
        fromPartial<Parameters<typeof resolveMail>[1]>(reviewedInput),
        ctx.actor,
      ),
    ).resolves.toMatchObject({ status: "completed" });
    expect(await getDb(ctx.db).select().from(financialTransaction)).toEqual(
      financialBefore,
    );
    expect(
      await getDb(ctx.db).select().from(financialTransactionAllocation),
    ).toEqual(allocationBefore);
    expect(await getDb(ctx.db).select().from(financialAccount)).toEqual(
      accountBefore,
    );
    const partialSource = await retainedMailFixture(ctx.db, {
      ledgerPartyId: party.id,
      mailboxId,
      messageId: "synthetic-fixed-review",
      checksum: await sha256Hex("Synthetic credit of three dollars"),
      content: {
        snippet: "Synthetic credit of three dollars",
        bodyText: "Synthetic credit of three dollars",
        bodyHtml: null,
      },
    });
    if (!partialSource) throw new Error("Synthetic partial source missing");
    const firstPurchase = purchases[0];
    const firstReview = reviewedInput.disposition.settlement.associations[0];
    if (!firstPurchase || !firstReview)
      throw new Error("Synthetic first review missing");
    const fixedInput = mailResolveInput.parse({
      ...reviewedInput,
      messageId: partialSource.messageId,
      checksum: partialSource.rawChecksum,
      disposition: {
        kind: "linked",
        event: "refunded",
        purchaseIds: [firstPurchase.shortcode],
        settlement: { refundAmount: -3, associations: [firstReview] },
      },
    });
    await resolveMail(ctx.db, fixedInput, ctx.actor);
    await expect(
      resolveMail(
        ctx.db,
        mailResolveInput.parse({
          ...reviewedInput,
          messageId: partialSource.messageId,
          checksum: partialSource.rawChecksum,
        }),
        ctx.actor,
      ),
    ).rejects.toThrow("different reviewed refund set");
    const readInput = { mailboxId, messageId: source.messageId };
    const codes = purchases.map((row) => row.shortcode).sort();
    const acceptedRun = await insertWithShortcode(ctx.db, "run", {
      purpose: "file_import",
      trigger: "manual",
      status: "completed",
      ledgerPartyId: party.id,
      actorUserId: ctx.actor.userId,
      actorName: "Synthetic accepted member",
      actorEmail: "mail@example.test",
      actorLedgerPartyShortcode: party.shortcode,
      actorLedgerPartyName: party.name,
      actorLedgerPartyKind: "member",
    });
    const [acceptedClaim] = await getDb(ctx.db)
      .insert(importSourceClaim)
      .values({
        ledgerPartyId: party.id,
        kind: "mail_message",
        externalKey: `gmail:${mailboxId}:${source.messageId}`,
        checksum: source.rawChecksum,
        firstRunId: acceptedRun.id,
        lastRunId: acceptedRun.id,
      })
      .returning();
    if (!acceptedClaim) throw new Error("Synthetic accepted source missing");
    const [acceptedOrder] = await getDb(ctx.db)
      .insert(importSourceOrder)
      .values({
        sourceClaimId: acceptedClaim.id,
        orderKey: "synthetic-review-handle",
        purchaseId: secondPurchase.id,
        checksum: source.rawChecksum,
        outputFingerprint: "0".repeat(64),
      })
      .returning();
    if (!acceptedOrder) throw new Error("Synthetic accepted order missing");
    const beforeDeletion = await readMail(ctx.db, readInput, ctx.actor);
    expect(beforeDeletion).toHaveProperty("acceptedSourceOrders", [
      {
        sourceOrderId: acceptedOrder.id,
        purchaseId: secondPurchase.shortcode,
        purchaseDeleted: false,
        source: {
          kind: "mail_message",
          externalKey: acceptedClaim.externalKey,
          checksum: source.rawChecksum,
        },
      },
    ]);
    expect(beforeDeletion).toMatchObject({
      purchaseIds: codes,
      purchaseAssociations: codes.map((purchaseId) => ({
        purchaseId,
        purchaseDeleted: false,
      })),
    });
    await getDb(ctx.db)
      .update(purchase)
      .set({ deletedAt: new Date() })
      .where(eq(purchase.id, secondPurchase.id));
    expect(await readMail(ctx.db, readInput, ctx.actor)).toMatchObject({
      purchaseIds: codes,
      acceptedSourceOrders: [
        {
          sourceOrderId: acceptedOrder.id,
          purchaseId: secondPurchase.shortcode,
          purchaseDeleted: true,
          source: {
            kind: "mail_message",
            externalKey: acceptedClaim.externalKey,
            checksum: source.rawChecksum,
          },
        },
      ],
      purchaseAssociations: codes.map((purchaseId) => ({
        purchaseId,
        purchaseDeleted: purchaseId === secondPurchase.shortcode,
      })),
    });
  });

  describe("search", () => {
    async function fixture() {
      const party = await member();
      await connect(mailboxId);
      // Pi searches under its Mail import Run; classification spends against it.
      const importRun = await insertWithShortcode(ctx.db, "run", {
        purpose: "mail_import",
        status: "running",
        trigger: "manual",
        ledgerPartyId: party.id,
        actorUserId: ctx.actor.userId,
        actorName: party.name,
        actorEmail: "mail@example.test",
        actorLedgerPartyShortcode: party.shortcode,
        actorLedgerPartyName: party.name,
        actorLedgerPartyKind: "member",
      });
      const actor = { ...ctx.actor, runId: importRun.id };
      vi.spyOn(routing, "productionMailTriage").mockReturnValue(
        async (content) =>
          content.includes("Synthetic promotion") ? "unrelated" : "related",
      );
      const list = vi.fn<GmailProvider["listMessages"]>(
        async ({ pageToken }) =>
          pageToken
            ? { messages: [{ id: "synthetic-second" }] }
            : {
                messages: [
                  { id: "synthetic-first" },
                  { id: "synthetic-negative" },
                  { id: "synthetic-trash" },
                ],
                nextPageToken: "synthetic-google-page",
              },
      );
      const provider = fromPartial<GmailProvider>({
        listMessages: list,
        getMessage: async (id: string) => ({
          id,
          labelIds: id === "synthetic-trash" ? ["TRASH"] : ["INBOX"],
          internalDate: "1790856000000",
          snippet: "Synthetic receipt",
          payload: {
            mimeType: "text/plain",
            headers: [
              { name: "From", value: "orders@shop.example.test" },
              {
                name: "Subject",
                value:
                  id === "synthetic-negative"
                    ? "Synthetic promotion"
                    : "Synthetic order receipt",
              },
            ],
            body: {
              data: Buffer.from(
                "One synthetic copper kettle. Total USD 24.",
              ).toString("base64url"),
            },
          },
        }),
      });
      const providers = vi
        .spyOn(gmail, "gmailProviderForUser")
        .mockResolvedValue(provider);
      const input = { query: "synthetic copper kettle" };
      return { party, actor, list, providers, input };
    }

    const cursors = () => getDb(ctx.db).select().from(mailboxCursor);

    it("refuses a mailbox not connected to this member, also with a borrowed page token, before fetching", async () => {
      const f = await fixture();
      await expect(
        searchMail(
          ctx.db,
          { ...f.input, mailboxId: "synthetic-foreign-mailbox" },
          f.actor,
        ),
      ).rejects.toThrow(/not connected/u);
      await expect(
        searchMail(
          ctx.db,
          {
            ...f.input,
            mailboxId: "synthetic-foreign-mailbox",
            pageToken: "synthetic-google-page",
          },
          f.actor,
        ),
      ).rejects.toThrow(/not connected/u);
      expect(f.providers).not.toHaveBeenCalled();
      // Two connected mailboxes and none named: the caller must choose.
      await connect("synthetic-second-mailbox");
      expect(await searchMail(ctx.db, f.input, f.actor)).toMatchObject({
        status: "mailbox_required",
        mailboxes: expect.arrayContaining([
          mailboxId,
          "synthetic-second-mailbox",
        ]),
        messages: [],
      });
      expect(f.providers).not.toHaveBeenCalled();
      // A page token only ever continues against the mailbox the caller names.
      await searchMail(
        ctx.db,
        {
          ...f.input,
          mailboxId: "synthetic-second-mailbox",
          pageToken: "synthetic-google-page",
        },
        f.actor,
      );
      expect(f.providers).toHaveBeenCalledWith(
        ctx.db,
        ctx.actor.userId,
        "synthetic-second-mailbox",
      );
      expect(await cursors()).toEqual([]);
    });

    it("returns reconnect-required for revoked Gmail authorization without retaining mail", async () => {
      const f = await fixture();
      f.providers.mockRejectedValueOnce(
        new GmailAuthorizationError("Synthetic revoked Gmail authorization"),
      );
      expect(await searchMail(ctx.db, f.input, f.actor)).toEqual({
        status: "gmail_reconnect_required",
        mailboxes: [mailboxId],
        messages: [],
        nextPageToken: null,
      });
      f.list.mockRejectedValueOnce(
        new GmailApiError({ status: 401, message: "Synthetic expired token" }),
      );
      expect(await searchMail(ctx.db, f.input, f.actor)).toMatchObject({
        status: "gmail_reconnect_required",
      });
      expect(await getDb(ctx.db).select().from(emailTable)).toEqual([]);
      expect(await getDb(ctx.db).select().from(orderMail)).toEqual([]);
    });

    it("pages scoped history excluding Spam and Trash without advancing mailbox coverage", async () => {
      const f = await fixture();
      const first = await searchMail(ctx.db, f.input, f.actor);
      expect(f.list).toHaveBeenCalledWith({
        query: "(synthetic copper kettle) -in:spam -in:trash",
        maxResults: 25,
      });
      expect(first).toMatchObject({
        status: "ok",
        nextPageToken: "synthetic-google-page",
      });
      // Only retained originals come back; Trash and negatives are not readable.
      expect(first.messages.map((row) => row.messageId)).toEqual([
        "synthetic-first",
      ]);
      const second = await searchMail(
        ctx.db,
        { ...f.input, pageToken: "synthetic-google-page" },
        f.actor,
      );
      expect(f.list).toHaveBeenLastCalledWith({
        query: "(synthetic copper kettle) -in:spam -in:trash",
        maxResults: 25,
        pageToken: "synthetic-google-page",
      });
      expect(second).toMatchObject({
        status: "ok",
        nextPageToken: null,
        messages: [{ messageId: "synthetic-second", status: "pending" }],
      });
      expect(await cursors()).toEqual([]);
      const originals = await getDb(ctx.db)
        .select({ messageId: emailTable.messageId })
        .from(orderMail)
        .innerJoin(emailTable, retainedMailJoin)
        .where(eq(orderMail.ledgerPartyId, f.party.id));
      expect(originals.map((row) => row.messageId).sort()).toEqual([
        "synthetic-first",
        "synthetic-second",
      ]);
      const ledger = await getDb(ctx.db)
        .select({
          messageId: emailTable.messageId,
          classification: emailTable.classification,
          status: emailTable.status,
          orderMailId: emailTable.orderMailId,
        })
        .from(emailTable)
        .where(eq(emailTable.ledgerPartyId, f.party.id));
      expect(ledger).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            messageId: "synthetic-negative",
            classification: "unrelated",
            status: "completed",
            orderMailId: null,
          }),
          expect.objectContaining({
            messageId: "synthetic-trash",
            status: "excluded",
            orderMailId: null,
          }),
        ]),
      );
    });

    it("never moves coverage or retains mail when Gmail or classification fails upstream with 429", async () => {
      const f = await fixture();
      f.list.mockRejectedValueOnce(
        new GmailApiError({ status: 429, message: "Synthetic Gmail quota" }),
      );
      await expect(searchMail(ctx.db, f.input, f.actor)).rejects.toThrow(
        "Synthetic Gmail quota",
      );
      vi.mocked(routing.productionMailTriage).mockReturnValue(async () => {
        throw wrapAiGatewayError(
          new Error("Synthetic quota"),
          {
            model: "synthetic-model",
            provider: "openai",
            route: "openai-responses",
            feature: "mail-classification",
            operation: "classify",
          },
          {
            status: 429,
            statusText: "Too Many Requests",
            body: "Synthetic upstream refusal",
            retryAfter: "45",
          },
        );
      });
      await expect(searchMail(ctx.db, f.input, f.actor)).rejects.toThrow(
        "Synthetic upstream refusal",
      );
      expect(await cursors()).toEqual([]);
      expect(await getDb(ctx.db).select().from(orderMail)).toEqual([]);
    });

    it("lets a member without a Run search with rules only, retaining candidates for the caller to settle", async () => {
      const f = await fixture();
      const relevance = vi.spyOn(routing, "productionMailRelevance");
      const found = await searchMail(ctx.db, f.input, ctx.actor);
      // No paid classification: the caller owns judgment.
      expect(routing.productionMailTriage).not.toHaveBeenCalled();
      expect(relevance).not.toHaveBeenCalled();
      expect(found.messages.map((row) => row.messageId).sort()).toEqual([
        "synthetic-first",
        "synthetic-negative",
      ]);
      const ledger = await getDb(ctx.db)
        .select({
          messageId: emailTable.messageId,
          classification: emailTable.classification,
          classificationStage: emailTable.classificationStage,
          status: emailTable.status,
          orderMailId: emailTable.orderMailId,
        })
        .from(emailTable)
        .where(eq(emailTable.ledgerPartyId, f.party.id));
      expect(ledger).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            messageId: "synthetic-first",
            classification: "uncertain",
            classificationStage: "rule",
            status: "pending",
            orderMailId: expect.any(String),
          }),
          // Spam and Trash are the free rule's negatives: never retained.
          expect.objectContaining({
            messageId: "synthetic-trash",
            status: "excluded",
            orderMailId: null,
          }),
        ]),
      );
      const [first] = await readRetainedMail(ctx.db, {
        ledgerPartyIds: [f.party.id],
        mailboxId,
        messageId: "synthetic-first",
      });
      if (!first) throw new Error("Synthetic candidate was not retained");
      await resolveMail(
        ctx.db,
        {
          mailboxId,
          messageId: first.messageId,
          checksum: first.rawChecksum,
          disposition: { kind: "unrelated", reason: "Not a purchase" },
        },
        ctx.actor,
      );
      expect(
        await getDb(ctx.db)
          .select({
            id: orderMail.id,
            checksum: orderMail.rawChecksum,
            content: orderMail.content,
          })
          .from(orderMail)
          .where(eq(orderMail.id, first.id)),
      ).toMatchObject([
        {
          id: first.id,
          checksum: first.rawChecksum,
          content: { bodyText: null, bodyHtml: null },
        },
      ]);
      expect(
        await getDb(ctx.db)
          .select({
            classification: emailTable.classification,
            orderMailId: emailTable.orderMailId,
          })
          .from(emailTable)
          .where(eq(emailTable.messageId, "synthetic-first")),
      ).toEqual([{ classification: "unrelated", orderMailId: first.id }]);
      expect(await cursors()).toEqual([]);
    });

    // Regression: a member's search re-saved every match as `uncertain`,
    // downgrading an Email whose Relevance was already decided under an older
    // classification version.
    it("keeps an existing Relevance decision, its stage and retained content, retaining only new matches as uncertain", async () => {
      const f = await fixture();
      const related = await retainedMailFixture(ctx.db, {
        ledgerPartyId: f.party.id,
        messageId: "synthetic-first",
        checksum: await sha256Hex("synthetic-first-earlier-capture"),
        bodyText: "Synthetic earlier capture",
      });
      await getDb(ctx.db)
        .update(emailTable)
        .set({ classificationStage: "jev", status: "completed" })
        .where(eq(emailTable.messageId, "synthetic-first"));
      await insertWithShortcode(ctx.db, "email", {
        ledgerPartyId: f.party.id,
        mailboxId,
        messageId: "synthetic-negative",
        checksum: await sha256Hex("synthetic-negative-earlier-capture"),
        classification: "unrelated",
        classificationStage: "resolution",
        classificationReason: "Member resolution",
        classificationVersion: "synthetic-v1",
        status: "completed",
      });
      // An expired, disposed search match is not a decision: refinding it
      // retains its content again.
      const cleared = await retainedMailFixture(ctx.db, {
        ledgerPartyId: f.party.id,
        messageId: "synthetic-cleared",
        checksum: await sha256Hex("synthetic-cleared-earlier-capture"),
        content: { snippet: null, bodyText: null, bodyHtml: null },
      });
      await getDb(ctx.db)
        .update(emailTable)
        .set({
          classification: "uncertain",
          classificationStage: "rule",
          searchOrigin: "member_search",
          searchExpiresAt: new Date("2026-01-01T00:00:00Z"),
          contentClearedAt: new Date("2026-01-01T00:00:00Z"),
        })
        .where(eq(emailTable.messageId, "synthetic-cleared"));
      f.list.mockResolvedValueOnce({
        messages: [
          { id: "synthetic-first" },
          { id: "synthetic-negative" },
          { id: "synthetic-second" },
          { id: "synthetic-cleared" },
        ],
      });
      await searchMail(ctx.db, f.input, ctx.actor);
      const ledger = await getDb(ctx.db)
        .select({
          messageId: emailTable.messageId,
          classification: emailTable.classification,
          classificationStage: emailTable.classificationStage,
          status: emailTable.status,
          orderMailId: emailTable.orderMailId,
          searchExpiresAt: emailTable.searchExpiresAt,
        })
        .from(emailTable)
        .where(eq(emailTable.ledgerPartyId, f.party.id));
      expect(ledger).toEqual(
        expect.arrayContaining([
          {
            messageId: "synthetic-first",
            classification: "related",
            classificationStage: "jev",
            status: "completed",
            orderMailId: related.id,
            searchExpiresAt: null,
          },
          {
            messageId: "synthetic-negative",
            classification: "unrelated",
            classificationStage: "resolution",
            status: "completed",
            orderMailId: null,
            searchExpiresAt: null,
          },
          expect.objectContaining({
            messageId: "synthetic-second",
            classification: "uncertain",
            classificationStage: "rule",
            searchExpiresAt: expect.any(Date),
          }),
        ]),
      );
      const [kept] = await readRetainedMail(ctx.db, {
        ledgerPartyIds: [f.party.id],
        orderMailIds: [related.id],
      });
      expect(kept).toMatchObject({
        rawChecksum: related.rawChecksum,
        content: { bodyText: "Synthetic earlier capture" },
      });
      const [refound] = await getDb(ctx.db)
        .select({
          classification: emailTable.classification,
          contentClearedAt: emailTable.contentClearedAt,
          searchExpiresAt: emailTable.searchExpiresAt,
          orderMailId: emailTable.orderMailId,
        })
        .from(emailTable)
        .where(eq(emailTable.messageId, "synthetic-cleared"));
      expect(refound).toMatchObject({
        classification: "uncertain",
        contentClearedAt: null,
        orderMailId: cleared.id,
      });
      expect(refound?.searchExpiresAt?.getTime()).toBeGreaterThan(Date.now());
      const [retained] = await readRetainedMail(ctx.db, {
        ledgerPartyIds: [f.party.id],
        orderMailIds: [cleared.id],
      });
      expect(retained?.content.bodyText).toContain("synthetic copper kettle");
    });
  });

  describe("read attachment originals", () => {
    async function fixture(bytes: Uint8Array = receiptBytes) {
      const party = await member();
      const mail = await retainedMailFixture(ctx.db, {
        ledgerPartyId: party.id,
        mailboxId,
        messageId: "synthetic-attachment-message",
        sender: "receipts@example.test",
        subject: "Your original receipt",
        receivedAt: new Date("2026-10-01T12:00:00Z"),
        checksum: "a".repeat(64),
        content: {
          snippet: null,
          bodyText: "The variant is only in the attached receipt.",
          bodyHtml: null,
        },
      });
      if (!mail) throw new Error("Synthetic mail missing");
      const [attachment] = await getDb(ctx.db)
        .insert(orderMailAttachment)
        .values({
          orderMailId: mail.id,
          providerAttachmentId: "synthetic-receipt-part",
          filename: "receipt.pdf",
          mimeType: "application/pdf",
          checksum: await sha256Hex(bytes),
          pendingObjectKey: "synthetic/private/original-receipt",
        })
        .returning();
      if (!attachment) throw new Error("Synthetic attachment missing");
      const originals = new Map([[attachment.pendingObjectKey!, bytes]]);
      const reads = vi
        .spyOn(s3, "getS3Object")
        .mockImplementation(async (key) => {
          const value = originals.get(key);
          return value
            ? new Response(Buffer.from(value))
            : new Response("missing", { status: 404, statusText: "Not Found" });
        });
      const input = {
        mailboxId,
        messageId: mail.messageId,
        attachmentId: attachment.providerAttachmentId,
      };
      return { party, mail, attachment, originals, reads, input, bytes };
    }

    it("returns an attachment original's bytes", async () => {
      const f = await fixture();
      const receivedAt = new Date("2026-10-02T15:00:00Z");
      await getDb(ctx.db)
        .update(emailTable)
        .set({
          sender: "canonical@example.test",
          subject: "Canonical Email receipt",
          receivedAt,
          threadId: "canonical-thread",
        })
        .where(eq(emailTable.orderMailId, f.mail.id));
      const read = await readMail(ctx.db, f.input, ctx.actor);
      expect(read).toMatchObject({
        sender: "canonical@example.test",
        subject: "Canonical Email receipt",
        receivedAt: receivedAt.toISOString(),
        threadId: "canonical-thread",
      });
      expect(read.originalAttachment).toEqual({
        attachmentId: "synthetic-receipt-part",
        filename: "receipt.pdf",
        mimeType: "application/pdf",
        checksum: f.attachment.checksum,
        dataBase64: Buffer.from(f.bytes).toString("base64"),
      });
      expect(JSON.stringify(read)).not.toContain(f.attachment.pendingObjectKey);
      await getDb(ctx.db)
        .update(emailTable)
        .set({ sender: null, subject: null, receivedAt: null, threadId: null })
        .where(eq(emailTable.orderMailId, f.mail.id));
      expect(await readMail(ctx.db, f.input, ctx.actor)).toMatchObject({
        sender: null,
        subject: null,
        receivedAt: null,
        threadId: null,
        originalAttachment: read.originalAttachment,
      });
      const otherOwner = await insertWithShortcode(ctx.db, "ledgerParty", {
        name: "Other retained Email owner",
        kind: "guest",
      });
      await getDb(ctx.db)
        .update(emailTable)
        .set({ ledgerPartyId: otherOwner.id })
        .where(eq(emailTable.orderMailId, f.mail.id));
      await expect(readMail(ctx.db, f.input, ctx.actor)).rejects.toThrow(
        /retained Email/iu,
      );
    });

    it("rejects another retained message's attachment reference before reading bytes", async () => {
      const f = await fixture();
      const other = await retainedMailFixture(ctx.db, {
        ledgerPartyId: f.party.id,
        mailboxId,
        messageId: "synthetic-other-source",
        sender: "other@example.test",
        subject: "Other source",
        receivedAt: new Date(),
        checksum: "b".repeat(64),
        content: { snippet: null, bodyText: "Other source", bodyHtml: null },
      });
      if (!other) throw new Error("Synthetic other mail missing");
      const [foreign] = await getDb(ctx.db)
        .insert(orderMailAttachment)
        .values({
          orderMailId: other.id,
          providerAttachmentId: "synthetic-other-part",
          filename: "other.pdf",
          mimeType: "application/pdf",
          checksum: f.attachment.checksum,
          pendingObjectKey: "synthetic/private/other-original",
        })
        .returning();
      if (!foreign) throw new Error("Synthetic foreign attachment missing");
      await expect(
        readMail(
          ctx.db,
          { ...f.input, attachmentId: foreign.providerAttachmentId },
          ctx.actor,
        ),
      ).rejects.toThrow(/does not belong/u);
      await expect(
        loadMailAttachmentOriginal(ctx.db, {
          orderMailId: f.mail.id,
          attachmentRef: foreign.id,
        }),
      ).rejects.toThrow(/does not belong/u);
      expect(f.reads).not.toHaveBeenCalled();
    });

    it("reads the same original after attachment storage moved to its linked Image", async () => {
      const f = await fixture();
      const linked = await insertWithShortcode(ctx.db, "image", {
        key: "synthetic/private/linked-receipt-original",
        filename: "receipt.pdf",
        size: f.bytes.byteLength,
        contentType: "application/pdf",
        status: "UPLOADED",
        sha256: f.attachment.checksum,
      });
      await getDb(ctx.db)
        .update(orderMailAttachment)
        .set({ pendingObjectKey: null, imageId: linked.id })
        .where(eq(orderMailAttachment.id, f.attachment.id));
      f.originals.clear();
      f.originals.set(linked.key, f.bytes);
      const read = await readMail(ctx.db, f.input, ctx.actor);
      expect(read.originalAttachment?.dataBase64).toBe(
        Buffer.from(f.bytes).toString("base64"),
      );
      expect(f.reads.mock.calls.map(([key]) => key)).toEqual([linked.key]);
    });

    it("rejects bytes that no longer match the retained checksum", async () => {
      const f = await fixture();
      f.originals.set(
        f.attachment.pendingObjectKey!,
        new TextEncoder().encode("Changed synthetic original"),
      );
      await expect(readMail(ctx.db, f.input, ctx.actor)).rejects.toThrow(
        /checksum changed/u,
      );
    });

    it("refuses an oversized original instead of truncating it", async () => {
      const f = await fixture(new Uint8Array(MAIL_ATTACHMENT_MAX_BYTES + 1));
      await expect(readMail(ctx.db, f.input, ctx.actor)).rejects.toThrow(
        /byte|size|limit|exceed/iu,
      );
    });
  });

  describe("resolve unrelated", () => {
    async function fixture() {
      const party = await member();
      const content = "Synthetic message later judged unrelated";
      const source = await retainedMailFixture(ctx.db, {
        ledgerPartyId: party.id,
        mailboxId,
        messageId: "synthetic-message",
        sender: "orders@shop.example.test",
        subject: content,
        receivedAt: new Date("2026-10-07T12:00:00Z"),
        checksum: await sha256Hex(content),
        content: { snippet: content, bodyText: content, bodyHtml: null },
      });
      if (!source) throw new Error("Synthetic source unavailable");
      await getDb(ctx.db)
        .insert(orderMailAttachment)
        .values({
          orderMailId: source.id,
          providerAttachmentId: "synthetic-protected-part",
          filename: "receipt.pdf",
          mimeType: "application/pdf",
          checksum: "c".repeat(64),
          pendingObjectKey: "synthetic/private/protected-original",
        });
      const seller = await insertWithShortcode(ctx.db, "vendor", {
        name: "Synthetic protected seller",
      });
      const positive = await insertWithShortcode(ctx.db, "purchase", {
        vendorId: seller.id,
        orderId: "PROTECTED-ORDER",
      });
      const importRun = await insertWithShortcode(ctx.db, "run", {
        purpose: "mail_import",
        status: "completed",
        trigger: "manual",
        ledgerPartyId: party.id,
        actorUserId: ctx.actor.userId,
        actorName: party.name,
        actorEmail: "mail@example.test",
        actorLedgerPartyShortcode: party.shortcode,
        actorLedgerPartyName: party.name,
        actorLedgerPartyKind: "member",
      });
      const deleted: string[] = [];
      const storage = fromPartial<OrderMailAttachmentStorage>({
        delete: async (key: string) => {
          deleted.push(key);
        },
      });
      const resolve = () =>
        resolveMail(
          ctx.db,
          {
            mailboxId,
            messageId: source.messageId,
            checksum: source.rawChecksum,
            disposition: { kind: "unrelated", reason: "Marketing only" },
          },
          ctx.actor,
          storage,
        );
      return {
        party,
        source,
        seller,
        positive,
        importRun,
        deleted,
        storage,
        resolve,
      };
    }

    async function expectOriginalKept(f: Awaited<ReturnType<typeof fixture>>) {
      expect(
        await getDb(ctx.db)
          .select({ id: orderMail.id })
          .from(orderMail)
          .where(eq(orderMail.id, f.source.id)),
      ).toEqual([{ id: f.source.id }]);
      expect(
        await getDb(ctx.db)
          .select({ id: orderMailAttachment.id })
          .from(orderMailAttachment)
          .where(eq(orderMailAttachment.orderMailId, f.source.id)),
      ).toHaveLength(1);
      expect(f.deleted).toEqual([]);
      const [message] = await getDb(ctx.db)
        .select({ orderMailId: emailTable.orderMailId })
        .from(emailTable)
        .where(
          and(
            eq(emailTable.mailboxId, mailboxId),
            eq(emailTable.messageId, f.source.messageId),
          ),
        );
      expect(message).toEqual({ orderMailId: f.source.id });
    }

    it.each(["current", "historical", "alias"] as const)(
      "keeps an original an independently associated positive Purchase uses (source identity: %s)",
      async (identity) => {
        const f = await fixture();
        const canonicalKey = `gmail:${mailboxId}:${f.source.messageId}`;
        const claimValues = (externalKey: string) => ({
          ledgerPartyId: f.party.id,
          kind: "mail_message",
          externalKey,
          checksum: f.source.rawChecksum,
          firstRunId: f.importRun.id,
          lastRunId: f.importRun.id,
        });
        const [root] = await getDb(ctx.db)
          .insert(importSourceClaim)
          .values(claimValues(canonicalKey))
          .returning();
        if (!root) throw new Error("Synthetic canonical source unavailable");
        let claim = root;
        if (identity !== "current") {
          const [mapped] = await getDb(ctx.db)
            .insert(importSourceClaim)
            .values({
              ...claimValues(
                identity === "historical"
                  ? `gmail:${f.source.messageId}:order:PROTECTED-ORDER`
                  : "synthetic:historical-message-original",
              ),
              canonicalClaimId: root.id,
            })
            .returning();
          if (!mapped) throw new Error("Synthetic mapped source unavailable");
          claim = mapped;
        }
        await getDb(ctx.db)
          .insert(importSourceOrder)
          .values({
            sourceClaimId: claim.id,
            orderKey: `${f.seller.id}/order/PROTECTED-ORDER`,
            purchaseId: f.positive.id,
            checksum: f.source.rawChecksum,
            outputFingerprint: "synthetic-positive",
          });
        await f.resolve();
        await expectOriginalKept(f);
        expect(
          await getDb(ctx.db).select().from(importSourceOrder),
        ).toHaveLength(1);
        expect(
          await getDb(ctx.db)
            .select({ id: importSourceClaim.id })
            .from(importSourceClaim),
        ).toHaveLength(identity === "current" ? 1 : 2);
      },
    );

    it("preserves the previous prediction before a member settlement appends a resolution", async () => {
      const f = await fixture();
      await getDb(ctx.db)
        .update(emailTable)
        .set({
          classification: "related",
          classificationStage: null,
          classificationReason: null,
          classificationVersion: "synthetic-previous-version",
        })
        .where(eq(emailTable.orderMailId, f.source.id));
      await settleMail(ctx.db, {
        mail: f.source,
        importRunId: null,
        status: "completed",
        classification: "unrelated",
        detail: "Synthetic reviewed marketing",
      });
      const rows = await getDb(ctx.db)
        .select()
        .from(emailClassificationObservation);
      expect(rows).toHaveLength(2);
      expect(rows.find((row) => row.stage === null)).toMatchObject({
        checksum: f.source.rawChecksum,
        classification: "related",
        reason: null,
        classificationVersion: "synthetic-previous-version",
        model: null,
      });
      expect(rows.find((row) => row.stage === "resolution")).toMatchObject({
        checksum: f.source.rawChecksum,
        classification: "unrelated",
        reason: "Synthetic reviewed marketing",
        model: null,
      });
    });

    it("retries a disposal lost after disposition, preserving original shell and history while clearing bytes", async () => {
      const f = await fixture();
      const outage = fromPartial<OrderMailAttachmentStorage>({
        delete: async () => {
          throw new Error("Synthetic storage outage");
        },
      });
      await expect(
        resolveMail(
          ctx.db,
          {
            mailboxId,
            messageId: f.source.messageId,
            checksum: f.source.rawChecksum,
            disposition: { kind: "unrelated", reason: "Marketing only" },
          },
          ctx.actor,
          outage,
        ),
      ).rejects.toBeInstanceOf(Error);
      const [retired] = await getDb(ctx.db)
        .select()
        .from(orderMailAttachment)
        .where(eq(orderMailAttachment.orderMailId, f.source.id));
      expect(retired).toMatchObject({
        pendingObjectKey: null,
        pendingDeleteKeys: ["synthetic/private/protected-original"],
        checksum: "c".repeat(64),
      });
      const [cleared] = await getDb(ctx.db)
        .select()
        .from(orderMail)
        .where(eq(orderMail.id, f.source.id));
      expect(cleared).toMatchObject({
        rawChecksum: f.source.rawChecksum,
        content: { bodyText: null, bodyHtml: null },
      });
      expect(f.deleted).toEqual([]);

      await disposeUnrelatedOriginals(ctx.db, f.storage);
      expect(f.deleted).toEqual(["synthetic/private/protected-original"]);
      expect(
        await getDb(ctx.db)
          .select({ id: orderMail.id })
          .from(orderMail)
          .where(eq(orderMail.id, f.source.id)),
      ).toEqual([{ id: f.source.id }]);
      const [shell] = await getDb(ctx.db)
        .select()
        .from(orderMail)
        .where(eq(orderMail.id, f.source.id));
      expect(shell).toMatchObject({
        rawChecksum: f.source.rawChecksum,
        content: { bodyText: null, bodyHtml: null },
      });
      const [attachment] = await getDb(ctx.db)
        .select()
        .from(orderMailAttachment)
        .where(eq(orderMailAttachment.orderMailId, f.source.id));
      expect(attachment).toMatchObject({
        checksum: "c".repeat(64),
        pendingObjectKey: null,
        pendingDeleteKeys: [],
      });

      await expect(f.resolve()).resolves.toEqual({
        mailboxId,
        messageId: f.source.messageId,
        status: "completed",
        disposition: "unrelated",
        purchaseIds: [],
        financialAssociations: [],
      });
    });

    it("keeps an original a reviewed Purchase link still uses", async () => {
      const f = await fixture();
      const [event] = await getDb(ctx.db)
        .insert(orderMailEvent)
        .values({
          orderMailId: f.source.id,
          event: "shipped",
          orderId: "PROTECTED-ORDER",
          sourceKey: "synthetic:reviewed-shipment",
        })
        .returning();
      if (!event) throw new Error("Synthetic event unavailable");
      await getDb(ctx.db).insert(orderMailCandidateDecision).values({
        eventId: event.id,
        purchaseId: f.positive.id,
        decision: "linked",
        evidenceChecksum: f.source.rawChecksum,
        decidedByUserId: ctx.actor.userId,
      });
      await f.resolve();
      await expectOriginalKept(f);
      expect(
        await getDb(ctx.db).select().from(orderMailCandidateDecision),
      ).toHaveLength(1);
    });
  });

  describe("member transient original fallback", () => {
    it.each(["missing", "unrelated", "cleared"])(
      "refetches the exact member Email with %s retained content without writing a new original",
      async (mode) => {
        const party = await member();
        await connect(mailboxId);
        const source =
          mode === "missing"
            ? null
            : await retainedMailFixture(ctx.db, {
                ledgerPartyId: party.id,
                mailboxId,
                messageId: "fallback-message",
                checksum: "b".repeat(64),
              });
        if (source)
          await getDb(ctx.db)
            .update(emailTable)
            .set({
              classification: mode === "unrelated" ? "unrelated" : "related",
              contentClearedAt: mode === "cleared" ? new Date() : null,
            })
            .where(eq(emailTable.orderMailId, source.id));
        else
          await insertWithShortcode(ctx.db, "email", {
            ledgerPartyId: party.id,
            mailboxId,
            messageId: "fallback-message",
            checksum: "b".repeat(64),
            classification: "unrelated",
            status: "completed",
          });
        const originals = await getDb(ctx.db).select().from(orderMail);
        const emails = await getDb(ctx.db).select().from(emailTable);
        const getMessage = vi.fn<GmailProvider["getMessage"]>(async (id) => ({
          id,
          payload: {
            mimeType: "text/plain",
            body: {
              data: Buffer.from("Fresh synthetic transient body").toString(
                "base64url",
              ),
            },
          },
        }));
        const provider = fromPartial<GmailProvider>({ getMessage });
        vi.spyOn(gmail, "gmailProviderForUser").mockResolvedValue(provider);
        const result = await readMail(
          ctx.db,
          { mailboxId, messageId: "fallback-message" },
          ctx.actor,
        );
        expect(result).toMatchObject({
          boundToRun: false,
          content: { bodyText: "Fresh synthetic transient body" },
        });
        expect(getMessage).toHaveBeenCalledExactlyOnceWith("fallback-message");
        expect(await getDb(ctx.db).select().from(orderMail)).toEqual(originals);
        expect(await getDb(ctx.db).select().from(emailTable)).toEqual(emails);
      },
    );
    it("keeps admitted Run reads on frozen retained bytes without asking Gmail even when metadata is cleared", async () => {
      const party = await member();
      await connect(mailboxId);
      const source = await retainedMailFixture(ctx.db, {
        ledgerPartyId: party.id,
        mailboxId,
        messageId: "frozen-message",
        checksum: "d".repeat(64),
      });
      const owner = await insertWithShortcode(ctx.db, "run", {
        purpose: "mail_import",
        status: "running",
        trigger: "manual",
        ledgerPartyId: party.id,
        actorUserId: ctx.actor.userId,
        actorName: party.name,
        actorEmail: "synthetic@example.test",
        actorLedgerPartyShortcode: party.shortcode,
        actorLedgerPartyName: party.name,
        actorLedgerPartyKind: "member",
        input: mailResearchRunInput.parse({
          kind: "mail_research",
          sources: [{ orderMailId: source.id, checksum: source.rawChecksum }],
        }),
      });
      await getDb(ctx.db)
        .update(emailTable)
        .set({
          runId: owner.id,
          status: "researching",
          contentClearedAt: new Date(),
        })
        .where(eq(emailTable.orderMailId, source.id));
      const provider = vi.spyOn(gmail, "gmailProviderForUser");
      const result = await readMail(
        ctx.db,
        { mailboxId, messageId: source.messageId },
        { ...ctx.actor, runId: owner.id },
      );
      expect(result).toMatchObject({
        boundToRun: true,
        checksum: source.rawChecksum,
        content: source.content,
      });
      expect(provider).not.toHaveBeenCalled();
    });
  });

  describe("a delegated Mail import Run", () => {
    it.each([
      ["cancelled", { status: "failed", failureCode: "user_cancelled" }],
      ["retired", { retiredAt: new Date() }],
      ["deleted", { deletedAt: new Date() }],
    ] as const)(
      "refuses read, resolve and search once it is %s",
      async (_, fence) => {
        const party = await member();
        await connect(mailboxId);
        const mail = await retainedMailFixture(ctx.db, {
          ledgerPartyId: party.id,
          messageId: "fenced-message",
          checksum: "f".repeat(64),
          mailboxId,
        });
        const importRun = await insertWithShortcode(ctx.db, "run", {
          purpose: "mail_import",
          status: "running",
          trigger: "manual",
          ledgerPartyId: party.id,
          actorUserId: ctx.actor.userId,
          actorName: party.name,
          actorEmail: "mail@example.test",
          actorLedgerPartyShortcode: party.shortcode,
          actorLedgerPartyName: party.name,
          actorLedgerPartyKind: "member",
        });
        await getDb(ctx.db)
          .update(run)
          .set({
            input: mailResearchRunInput.parse({
              kind: "mail_research",
              sources: [{ orderMailId: mail.id, checksum: mail.rawChecksum }],
            }),
          })
          .where(eq(run.id, importRun.id));
        await getDb(ctx.db)
          .update(emailTable)
          .set({ runId: importRun.id, status: "researching" })
          .where(eq(emailTable.orderMailId, mail.id));
        await getDb(ctx.db)
          .update(run)
          .set(fence)
          .where(eq(run.id, importRun.id));
        const actor = { ...ctx.actor, runId: importRun.id };
        const providers = vi.spyOn(gmail, "gmailProviderForUser");
        const ref = { mailboxId, messageId: mail.messageId };

        await expect(readMail(ctx.db, ref, actor)).rejects.toThrow(
          /no longer running/,
        );
        await expect(
          resolveMail(
            ctx.db,
            {
              ...ref,
              checksum: mail.rawChecksum,
              disposition: { kind: "unrelated", reason: "Marketing only" },
            },
            actor,
          ),
        ).rejects.toThrow(/no longer running/);
        await expect(
          searchMail(ctx.db, { query: "synthetic" }, actor),
        ).rejects.toThrow(/no longer running/);
        expect(providers).not.toHaveBeenCalled();
        const [message] = await getDb(ctx.db)
          .select({
            classification: emailTable.classification,
            status: emailTable.status,
            orderMailId: emailTable.orderMailId,
          })
          .from(emailTable)
          .where(eq(emailTable.messageId, mail.messageId));
        expect(message).toEqual({
          classification: "related",
          status: "researching",
          orderMailId: mail.id,
        });
      },
    );
  });
});
