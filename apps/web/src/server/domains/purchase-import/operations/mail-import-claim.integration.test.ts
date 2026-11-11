/**
 * Failures: a lifecycle notice bypasses package extraction merely because
 * its Purchase is imported; a confident
 * unrelated classification is not disposed of exactly as `purchase_import.mail_resolve`
 * `unrelated` would; a refund notice is settled without the coordinator; the
 * claimed Email arrives without its compact read; a repeated claim duplicates
 * a rule outcome; a first-page order match hides a cancellation on a later
 * page and is incorrectly settled without the coordinator; the claim omits
 * the sender's proven Vendor or the recorded Purchases its printed order id
 * names, so the coordinator spends a model call looking each up; an exact
 * carrier notice reaches the coordinator, invents a Purchase link or settles
 * with its package held for review.
 */
import type { ActorContext } from "@cubby/schemas/context";
import { runEntityId } from "@cubby/schemas/identifiers";
import type { PurchaseId, RunId } from "@cubby/schemas/identifiers";
import { preparePurchaseImportInput } from "@cubby/schemas/purchase-import";
import { runTargetOutcomeReceipt } from "@cubby/schemas/run-fields";
import { mailResearchRunInput } from "@cubby/schemas/run-fields";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq, inArray } from "drizzle-orm";
import { createRepoIdentity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { DecisionPort } from "~/server/ai/decision-model";
import { getDb } from "~/server/db/helpers";
import { run } from "~/server/db/schema";
import {
  entityExternalId,
  externalSource,
  emailClassificationObservation,
  email as emailTable,
  expense,
  importSourceClaim,
  importSourceOrder,
  orderMail,
  orderMailEvent,
  runOperation,
  shipment,
  purchase,
  vendor,
} from "~/server/db/schema";
import type { RetainedMail } from "~/server/domains/mail/repo/retained-mail";
import {
  cubbyToolResult,
  mailWriterOutcome,
} from "~/server/domains/purchase-agent/service/cubby-mcp";
import { storedMailOutcome } from "~/server/domains/purchase-import/repo/mail-outcome/outcome";
import { readMailProductCandidates } from "~/server/domains/purchase-import/repo/mail-rule-evidence";
import { insertOperation } from "~/server/domains/run/repo/run-operation";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { describeToolError } from "~/server/mcp/tools/tool-error";
import { activeEmailPurchaseDecision } from "~/server/testing/email-link.fixtures";
import {
  createProductIdentityFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

import { recordMailAttempt } from "../repo/mail-attempts";
import { MAIL_IMPORT_RULE_REVISION } from "../service/mail-import-rule";
import { preparePurchaseImport } from "./import-orders";
import { claimMailImportWork } from "./mail-import-claim";
import { resolveMail } from "./mail-tool";
import { retainedMailFixture } from "./order-import.fixtures";

const mailboxId = "synthetic-rule-mailbox";
const sender = "Synthetic Rule Shop <ship@rule-shop.example.test>";

const recipient = vi.fn<DecisionPort>(async () => ({
  answers: {
    selection: {
      type: "choice",
      choice: "c0",
      confidence: 0.97,
      probabilities: { c0: 0.97, c1: 0.01, c2: 0.01 },
    },
  },
}));

describe("Mail import claim", () => {
  const ctx = withTestDb();

  async function world() {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic rule member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const seller = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic Rule Shop",
      orderEmailSenders: ["ship@rule-shop.example.test"],
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      vendorId: seller.id,
      ledgerPartyId: party.id,
    });
    const order = async (orderId: string) => {
      const created = await createRepoIdentity(ctx, "purchase", {
        vendorId: seller.shortcode,
        vendorAccountId: account.shortcode,
        orderId,
      });
      const [row] = await getDb(ctx.db)
        .select()
        .from(purchase)
        .where(eq(purchase.id, created.entityId));
      if (!row) throw new Error("Synthetic Purchase fixture missing");
      return { ...row, shortcode: created.output.id };
    };
    const retain = async (
      messageId: string,
      subject: string,
      bodyText: string,
      from = sender,
    ) =>
      retainedMailFixture(ctx.db, {
        ledgerPartyId: party.id,
        mailboxId,
        messageId,
        sender: from,
        subject,
        checksum: await sha256Hex(`${subject}\n${bodyText}`),
        content: { snippet: null, bodyText, bodyHtml: null },
      });
    // An accepted import source: what makes a Purchase itemized for the rule.
    const itemize = async (purchaseId: PurchaseId, orderKey: string) => {
      const imported = await insertWithShortcode(ctx.db, "run", {
        purpose: "file_import",
        status: "completed",
        trigger: "manual",
        ledgerPartyId: party.id,
        actorUserId: ctx.actor.userId,
        actorName: party.name,
        actorEmail: "synthetic@example.test",
        actorLedgerPartyShortcode: party.shortcode,
        actorLedgerPartyName: party.name,
        actorLedgerPartyKind: "member",
      });
      const [claim] = await getDb(ctx.db)
        .insert(importSourceClaim)
        .values({
          ledgerPartyId: party.id,
          kind: "vendor_export",
          externalKey: orderKey,
          checksum: orderKey,
          firstRunId: imported.id,
          lastRunId: imported.id,
        })
        .returning({ id: importSourceClaim.id });
      if (!claim) throw new Error("Expected a source claim fixture");
      await getDb(ctx.db).insert(importSourceOrder).values({
        id: claim.id,
        sourceClaimId: claim.id,
        purchaseId,
        orderKey,
        checksum: orderKey,
        outputFingerprint: orderKey,
      });
    };
    return { party, seller, order, retain, itemize };
  }

  async function admit(
    party: {
      id: RetainedMail["ledgerPartyId"];
      name: string;
      shortcode: string;
    },
    sources: readonly RetainedMail[],
  ) {
    const owner = await insertWithShortcode(ctx.db, "run", {
      purpose: "mail_import",
      status: "running",
      trigger: "discovery",
      ledgerPartyId: party.id,
      actorUserId: ctx.actor.userId,
      actorName: party.name,
      actorEmail: "synthetic@example.test",
      actorLedgerPartyShortcode: party.shortcode,
      actorLedgerPartyName: party.name,
      actorLedgerPartyKind: "member",
      input: mailResearchRunInput.parse({
        kind: "mail_research",
        sources: sources.map((source) => ({
          orderMailId: source.id,
          checksum: source.rawChecksum,
        })),
      }),
    });
    await getDb(ctx.db)
      .update(emailTable)
      .set({ runId: owner.id, status: "researching" })
      .where(
        inArray(
          emailTable.orderMailId,
          sources.map((source) => source.id),
        ),
      );
    const pi: ActorContext = { ...ctx.actor, runId: owner.id as RunId };
    return { owner, pi };
  }

  const emailOf = async (source: RetainedMail) => {
    const [row] = await getDb(ctx.db)
      .select()
      .from(emailTable)
      .where(eq(emailTable.orderMailId, source.id));
    if (!row) throw new Error("Synthetic Email missing");
    return row;
  };

  async function linkRows(source: RetainedMail) {
    const events = await getDb(ctx.db)
      .select({ id: orderMailEvent.id, event: orderMailEvent.event })
      .from(orderMailEvent)
      .where(eq(orderMailEvent.orderMailId, source.id));
    const links = events.length
      ? await getDb(ctx.db)
          .select({
            decision: activeEmailPurchaseDecision.decision,
            evidenceChecksum: activeEmailPurchaseDecision.evidenceChecksum,
            proposedBy: activeEmailPurchaseDecision.proposedBy,
          })
          .from(activeEmailPurchaseDecision)
          .where(
            inArray(
              activeEmailPurchaseDecision.eventId,
              events.map((event) => event.id),
            ),
          )
      : [];
    const email = await emailOf(source);
    const outcomes = await getDb(ctx.db)
      .select({ result: runOperation.result })
      .from(runOperation)
      .where(eq(runOperation.kind, "target_outcome"));
    const target = outcomes
      .map(({ result }) => runTargetOutcomeReceipt.parse(result).target)
      .filter((row) => row.entityId === email.id)
      .map(({ state, outcome, warning, targetFingerprint }) => ({
        state,
        outcome,
        warning,
        fingerprint: targetFingerprint === source.rawChecksum,
      }));
    return {
      events: events.map(({ event }) => event),
      links,
      email: {
        status: email.status,
        classification: email.classification,
        classificationStage: email.classificationStage,
      },
      target,
    };
  }

  it("records an exact carrier notice without the coordinator and links only the Shipment's Purchase", async () => {
    const { party, order, retain } = await world();
    const fedex = "FedEx Tracking <TrackingUpdates@fedex.com>";
    const body = (number: string) => `Tracking details\nTracking ID\n${number}`;
    const unmatched = await retain(
      "carrier-unmatched",
      "Your shipment is on the way 100000000001",
      body("100000000001"),
      fedex,
    );
    const inexact = await retain(
      "carrier-inexact",
      "Part of your shipment is scheduled for delivery tomorrow 100000000003",
      body("100000000003"),
      fedex,
    );
    const first = await admit(party, [unmatched, inexact]);
    await getDb(ctx.db)
      .update(emailTable)
      .set({ classification: "related", classificationStage: "decision" })
      .where(eq(emailTable.runId, first.owner.id));

    expect(await claimMailImportWork(ctx.db, first.owner.id)).toMatchObject({
      kind: "email",
      email: { messageId: inexact.messageId },
    });
    expect((await emailOf(unmatched)).status).toBe("unsettled");
    expect((await linkRows(unmatched)).links).toEqual([]);
    expect((await emailOf(inexact)).status).toBe("researching");
    const packages = await getDb(ctx.db)
      .select({
        tracking: shipment.trackingNumber,
        purchase: shipment.purchaseId,
      })
      .from(shipment);
    expect(packages).toEqual([{ tracking: "100000000001", purchase: null }]);

    // A later notice for the same package links only the Purchase it holds.
    const target = await order("SYN-CARRIER");
    await getDb(ctx.db).update(shipment).set({ purchaseId: target.id });
    const later = await retain(
      "carrier-later",
      "Your shipment is scheduled for delivery tomorrow 100000000001",
      body("100000000001"),
      fedex,
    );
    const second = await admit(party, [later]);
    await getDb(ctx.db)
      .update(emailTable)
      .set({ classification: "related", classificationStage: "decision" })
      .where(eq(emailTable.runId, second.owner.id));

    expect(await claimMailImportWork(ctx.db, second.owner.id)).toEqual({
      kind: "none",
    });
    expect((await emailOf(later)).status).toBe("completed");
    expect((await linkRows(later)).links).toEqual([
      expect.objectContaining({ decision: "linked", proposedBy: "heuristic" }),
    ]);
  });

  // An exact link spends no coordinator, so it must be unambiguous and must
  // not drop the package evidence the coordinator would have extracted.
  it("links a tracked notice by its sender's exact order key with its package, leaving conflicting evidence to the coordinator", async () => {
    const { party, order, retain } = await world();
    const target = await order("#syn-4001");
    const other = await order("SYN-4002");
    const tracked = await retain(
      "exact-tracked",
      "Your order SYN-4001 has shipped",
      "Order #SYN-4001 is on its way via UPS. Tracking number: 1Z999AA10123456784",
    );
    // Its order key names one Purchase, its tracking another's package.
    const conflicting = await retain(
      "exact-conflicting",
      "Your order SYN-4002 has shipped",
      "Order #SYN-4002 is on its way via UPS. Tracking number: 1Z999AA10123456784",
    );
    const { owner } = await admit(party, [tracked, conflicting]);

    expect(await claimMailImportWork(ctx.db, owner.id)).toMatchObject({
      kind: "email",
      email: { messageId: conflicting.messageId },
    });
    expect(await linkRows(tracked)).toMatchObject({
      events: ["shipped"],
      links: [
        expect.objectContaining({
          decision: "linked",
          proposedBy: "heuristic",
        }),
      ],
      email: { status: "completed" },
    });
    expect(
      await getDb(ctx.db)
        .select({
          tracking: shipment.trackingNumber,
          purchase: shipment.purchaseId,
        })
        .from(shipment),
    ).toEqual([{ tracking: "1Z999AA10123456784", purchase: target.id }]);
    expect(await linkRows(conflicting)).toMatchObject({
      links: [],
      email: { status: "researching" },
    });
    expect(other.id).not.toBe(target.id);
    expect(await emailOf(tracked)).toMatchObject({
      orderKeys: expect.arrayContaining(["SYN-4001"]),
      trackingKeys: [{ carrier: "UPS", number: "1Z999AA10123456784" }],
      mailKeysChecksum: tracked.rawChecksum,
    });
  });

  // A notice that arrives before its order holds the order number on one
  // Purchase, so the confirmation later itemizes it instead of a second one.
  it("creates the empty Purchase a shipped notice's order names and links its package", async () => {
    const { party, seller, retain } = await world();
    const notice = await retain(
      "notice-first",
      "Your order SYN-5001 has shipped",
      "Order #SYN-5001 is on its way via UPS. Tracking number: 1Z999AA10123456791",
    );
    const { owner } = await admit(party, [notice]);
    await getDb(ctx.db)
      .update(emailTable)
      .set({ classification: "related", classificationStage: "decision" })
      .where(eq(emailTable.runId, owner.id));

    expect(await claimMailImportWork(ctx.db, owner.id)).toEqual({
      kind: "none",
    });
    const created = await getDb(ctx.db)
      .select({
        id: purchase.id,
        vendorId: purchase.vendorId,
        orderId: purchase.orderId,
        runId: purchase.runId,
      })
      .from(purchase)
      .where(eq(purchase.vendorId, seller.id));
    expect(created).toEqual([
      expect.objectContaining({ orderId: "SYN-5001", runId: owner.id }),
    ]);
    expect(
      await getDb(ctx.db)
        .select()
        .from(expense)
        .where(eq(expense.purchaseId, created[0]!.id)),
    ).toEqual([]);
    expect(await linkRows(notice)).toMatchObject({
      events: ["shipped"],
      links: [expect.objectContaining({ decision: "linked" })],
      email: { status: "completed" },
    });
    expect(
      await getDb(ctx.db)
        .select({
          tracking: shipment.trackingNumber,
          purchase: shipment.purchaseId,
        })
        .from(shipment),
    ).toEqual([{ tracking: "1Z999AA10123456791", purchase: created[0]!.id }]);
  });

  // A rule link must never pick a side of contradicting evidence or record
  // package states it cannot prove.
  it("leaves contradicting accounts, several packages and unrecognised tracking to the coordinator", async () => {
    const { party, seller, order, retain } = await world();
    const own = await order("SYN-5001");
    // The member's own exact notice links first and records its package.
    const seed = await retain(
      "rule-seed",
      "Your order SYN-5001 has shipped",
      "Order #SYN-5001 is on its way via UPS. Tracking number: 1Z999AA10123456784",
    );
    const neighbour = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic neighbouring member",
      kind: "member",
    });
    const neighbourAccount = await insertWithShortcode(
      ctx.db,
      "vendorAccount",
      {
        vendorId: seller.id,
        ledgerPartyId: neighbour.id,
      },
    );
    await createRepoIdentity(ctx, "purchase", {
      vendorId: seller.shortcode,
      vendorAccountId: neighbourAccount.shortcode,
      orderId: "SYN-5002",
    });
    // Tracking names this member's Purchase, the order number another member's.
    const contradicting = await retain(
      "rule-contradicting",
      "Your order SYN-5002 has shipped",
      "Order #SYN-5002 is on its way via UPS. Tracking number: 1Z999AA10123456784",
    );
    const twoPackages = await retain(
      "rule-two-packages",
      "Your order SYN-5001 has shipped",
      "Order #SYN-5001 ships in two boxes via UPS. Tracking numbers: 1Z999AA10123456784 and 1Z999AA10123456791",
    );
    const unknownCarrier = await retain(
      "rule-unknown-carrier",
      "Your order SYN-5001 has shipped",
      "Order #SYN-5001 is on its way via UPS. Tracking number: 1Z999AA10123456784. Customs tracking: LX1234567890CN",
    );
    // A separated reference no carrier format recognises is a second package.
    const separated = await retain(
      "rule-separated-reference",
      "Your order SYN-5001 has shipped",
      "Tracking: 1Z999AA10123456784. Second package tracking: AB12-3456-7890",
    );
    const separatedAcrossLines = await retain(
      "rule-separated-across-lines",
      "Your order SYN-5001 has shipped",
      "Tracking: 1Z999AA10123456784. Second package tracking:\nAB12-3456-7890",
    );
    const shortReference = await retain(
      "rule-short-reference",
      "Your order SYN-5001 has shipped",
      "Tracking: 1Z999AA10123456784. Second package tracking: AB-1234567",
    );
    const { owner, pi } = await admit(party, [
      seed,
      contradicting,
      twoPackages,
      unknownCarrier,
      separated,
      separatedAcrossLines,
      shortReference,
    ]);

    const sources = new Map(
      [
        contradicting,
        twoPackages,
        unknownCarrier,
        separated,
        separatedAcrossLines,
        shortReference,
      ].map((source) => [source.messageId, source]),
    );
    const claimed: string[] = [];
    for (;;) {
      const work = await claimMailImportWork(ctx.db, owner.id);
      if (work.kind === "none") break;
      claimed.push(work.email.messageId);
      // Each one reached the coordinator unlinked.
      expect(
        (await linkRows(sources.get(work.email.messageId)!)).links,
      ).toEqual([]);
      await resolveMail(
        ctx.db,
        {
          mailboxId,
          messageId: work.email.messageId,
          checksum: work.email.checksum,
          disposition: {
            kind: "unresolved",
            category: "identity_ambiguity",
            reason: "Synthetic contradicting package evidence.",
          },
        },
        pi,
      );
    }
    expect(claimed).toEqual([
      contradicting.messageId,
      twoPackages.messageId,
      unknownCarrier.messageId,
      separated.messageId,
      separatedAcrossLines.messageId,
      shortReference.messageId,
    ]);
    expect(await linkRows(seed)).toMatchObject({
      email: { status: "completed" },
    });
    expect(
      await getDb(ctx.db)
        .select({
          tracking: shipment.trackingNumber,
          purchase: shipment.purchaseId,
        })
        .from(shipment),
    ).toEqual([{ tracking: "1Z999AA10123456784", purchase: own.id }]);
  });

  it("claims an incomplete lifecycle read instead of settling its first-page match", async () => {
    const { party, seller, order, retain } = await world();
    const target = await order("SYN-3001");
    const recordedProduct = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic previously ordered mug",
        brandId: null,
        model: null,
      }),
      ctx.actor,
    );
    await createRepoIdentity(ctx, "expense", {
      name: "Synthetic mug",
      purchaseId: target.shortcode,
      productId: recordedProduct.id,
      trade: "other",
      cost: 12,
      date: "2026-09-20",
      lineKind: "principal",
      costType: "tools",
    });
    await getDb(ctx.db).insert(externalSource).values({
      slug: "synthetic-catalog",
      label: "Synthetic seller catalog",
      vendorId: seller.id,
      issuer: true,
    });
    const variants = [];
    for (const [index, name] of [
      "Synthetic blue mug",
      "Synthetic green mug",
    ].entries()) {
      const variant = await createProductIdentityFixture(
        ctx.db,
        makeProductInput({
          name,
          brandId: null,
          model: null,
        }),
        ctx.actor,
      );
      variants.push(variant.id);
      await getDb(ctx.db)
        .insert(entityExternalId)
        .values({
          entityKind: "product",
          entityId: variant.entityId,
          source: "synthetic-catalog",
          kind: index === 0 ? "asin" : "retailer_sku",
          externalId: "B012345678",
          isPrimary: true,
        });
    }
    const linkEvidence = await readMailProductCandidates(ctx.db, {
      ledgerPartyId: party.id,
      vendorId: seller.id,
      purchaseIds: [],
      links: [
        { href: "https://www.amazon.com/dp/B012345678", text: "Synthetic mug" },
        { href: "not a URL", text: "invalid" },
      ],
    });
    expect(linkEvidence.omitted).toBe(false);
    expect(
      linkEvidence.candidates.map((candidate) => candidate.productId).sort(),
    ).toEqual(variants.sort());
    expect(
      linkEvidence.candidates.every(
        (candidate) => candidate.basis.kind === "printed_identifier",
      ),
    ).toBe(true);

    const mail = await retain(
      "paged-cancellation",
      "Your order SYN-3001 has shipped",
      `Order #SYN-3001 shipped.\n${"Tracking details.\n".repeat(10000)}We cancelled the unavailable item.`,
    );
    const { owner } = await admit(party, [mail]);
    const claimed = await claimMailImportWork(ctx.db, owner.id);
    expect(claimed).toMatchObject({
      kind: "email",
      email: { messageId: mail.messageId },
      read: { content: { truncated: true, nextOffset: expect.any(Number) } },
      // First-page lookups still spare the coordinator its Vendor and
      // Purchase reads; only the deterministic settlement needs every page.
      known: {
        senderVendor: { id: seller.shortcode, name: seller.name },
        products: {
          omitted: false,
          candidates: [
            {
              productId: recordedProduct.id,
              basis: { kind: "recorded_order", purchaseId: target.shortcode },
            },
          ],
        },
        purchases: [
          {
            id: target.shortcode,
            orderId: "SYN-3001",
            vendorId: seller.shortcode,
            imported: false,
          },
        ],
      },
    });
    expect((await linkRows(mail)).events).toEqual([]);
    const [email] = await getDb(ctx.db)
      .select({ status: emailTable.status })
      .from(emailTable)
      .where(eq(emailTable.orderMailId, mail.id));
    expect(email?.status).toBe("researching");
    // Display/date edits are not new source evidence and cannot reset budgets.
    const version = z
      .object({ evidenceVersion: z.string() })
      .parse(claimed).evidenceVersion;
    await getDb(ctx.db)
      .update(purchase)
      .set({ date: "2026-09-02" })
      .where(eq(purchase.id, target.id));
    await getDb(ctx.db)
      .update(vendor)
      .set({ name: "Synthetic renamed shop" })
      .where(eq(vendor.id, seller.id));
    expect(
      z
        .object({ evidenceVersion: z.string() })
        .parse(await claimMailImportWork(ctx.db, owner.id)).evidenceVersion,
    ).toBe(version);
  });

  it("hands lifecycle evidence to the coordinator while settling confident unrelated Emails", async () => {
    const { party, seller, order, retain, itemize } = await world();
    const ruleTarget = await order("SYN-2001");
    await itemize(ruleTarget.id, "rule-order-SYN-2001");
    const controlTarget = await order("SYN-2002");
    const ruleShipped = await retain(
      "rule-shipped",
      "Your order SYN-2001 has shipped",
      "Order #SYN-2001 is on its way. Track your package.",
    );
    const controlShipped = await retain(
      "control-shipped",
      "Your order SYN-2002 has shipped",
      "Order #SYN-2002 is on its way. Track your package.",
    );
    // From a sender that proves no Vendor: a known Vendor's Email classified
    // unrelated still goes to the coordinator.
    const newsletter = await retain(
      "rule-newsletter",
      "Synthetic garden newsletter",
      "Seasonal planting tips from the synthetic garden club.",
      "Garden Club <club@garden-club.example.test>",
    );
    await getDb(ctx.db)
      .update(emailTable)
      .set({
        classification: "unrelated",
        classificationStage: "decision",
        classificationReason: "Synthetic newsletter",
      })
      .where(eq(emailTable.orderMailId, newsletter.id));
    const refund = await retain(
      "coordinator-refund",
      "Your refund for order SYN-2001",
      "Refund issued for order #SYN-2001: USD 4.00 returned to your card.",
    );
    const { owner, pi } = await admit(party, [
      ruleShipped,
      controlShipped,
      newsletter,
      refund,
    ]);

    // The coordinator's own link of an equivalent notice is the control.
    await resolveMail(
      ctx.db,
      {
        mailboxId,
        messageId: controlShipped.messageId,
        checksum: controlShipped.rawChecksum,
        disposition: {
          kind: "linked",
          event: "shipped",
          purchaseIds: [controlTarget.shortcode],
        },
      },
      pi,
      undefined,
      recipient,
    );

    const claimed: string[] = [];
    for (let claim = 0; claim < 4; claim += 1) {
      const work = await claimMailImportWork(ctx.db, owner.id);
      if (work.kind === "none") break;
      claimed.push(work.email.messageId);
      // The agent's tool step accepts only JSON: no `undefined` fields.
      expect(JSON.parse(JSON.stringify(work))).toStrictEqual(work);
      expect(work).toMatchObject({
        read: { messageId: work.email.messageId, boundToRun: true },
        known: {
          senderVendor: { id: seller.shortcode, name: seller.name },
          orderIds: expect.arrayContaining(["SYN-2001"]),
          purchases: [{ id: ruleTarget.shortcode, imported: true }],
        },
      });
      await resolveMail(
        ctx.db,
        {
          mailboxId,
          messageId: work.email.messageId,
          checksum: work.read!.checksum,
          disposition: {
            kind: "unresolved",
            category: "missing_evidence",
            reason: "Synthetic package or refund needs evidence review.",
          },
        },
        pi,
      );
      const receipts = await getDb(ctx.db)
        .select({ result: runOperation.result })
        .from(runOperation)
        .where(
          and(
            eq(runOperation.runId, owner.id),
            eq(runOperation.kind, "target_outcome"),
          ),
        );
      const retained = receipts.flatMap(({ result }) => {
        const parsed = storedMailOutcome.safeParse(result);
        return parsed.success &&
          parsed.data.mailOutcome.checksum === work.read!.checksum
          ? [parsed.data.mailOutcome.judgment]
          : [];
      });
      expect(retained).toContainEqual({
        kind: "unresolved",
        category: "missing_evidence",
        reason: "Synthetic package or refund needs evidence review.",
        waitingOn: null,
      });
    }
    expect(claimed).toEqual([ruleShipped.messageId, refund.messageId]);
    expect(await linkRows(ruleShipped)).toMatchObject({
      events: [],
      links: [],
      email: { status: "unsettled" },
    });

    const unrelated = await linkRows(newsletter);
    expect(unrelated).toMatchObject({
      events: [],
      email: {
        status: "completed",
        classification: "unrelated",
        classificationStage: "resolution",
      },
      target: [{ state: "completed", outcome: "verified", fingerprint: true }],
    });
    const newsletterEmail = await emailOf(newsletter);
    expect(newsletterEmail.contentClearedAt).not.toBeNull();
    const [cleared] = await getDb(ctx.db)
      .select({ content: orderMail.content })
      .from(orderMail)
      .where(eq(orderMail.id, newsletter.id));
    expect(cleared?.content.bodyText).toBeNull();
    const [resolution] = await getDb(ctx.db)
      .select()
      .from(emailClassificationObservation)
      .where(
        and(
          eq(emailClassificationObservation.emailId, newsletterEmail.id),
          eq(emailClassificationObservation.stage, "resolution"),
        ),
      );
    expect(resolution?.promptVersion).toBe(MAIL_IMPORT_RULE_REVISION);

    // A later claim finds nothing and repeats no rule outcome.
    const before = await Promise.all(
      [ruleShipped, newsletter].map((source) => linkRows(source)),
    );
    expect(await claimMailImportWork(ctx.db, owner.id)).toEqual({
      kind: "none",
    });
    expect(
      await Promise.all(
        [ruleShipped, newsletter].map((source) => linkRows(source)),
      ),
    ).toEqual(before);
    expect(recipient).toHaveBeenCalledTimes(1);
  });
  it("carries unchanged-evidence budgets into successor Runs and preserves replay at the limit", async () => {
    const { party, seller, order, retain } = await world();
    const target = await order("SYN-BUDGET-1");
    const wrongTarget = await order("SYN-WRONG-1");
    const source = await retain(
      "attempt-budget",
      "Synthetic order evidence",
      "Order SYN-BUDGET-1 placed 2026-01-02. Synthetic mug USD 12.00. Total USD 12.00.",
    );
    const first = await admit(party, [source]);
    async function claim(owner: typeof first.owner) {
      await getDb(ctx.db)
        .update(run)
        .set({ dispatchEventId: `synthetic-generation:${owner.id}` })
        .where(eq(run.id, owner.id));
      const result = await claimMailImportWork(ctx.db, owner.id);
      const parsed = z.object({ evidenceVersion: z.string() }).parse(result);
      await insertOperation(getDb(ctx.db), {
        runId: runEntityId.parse(owner.id),
        operationId: "synthetic-claim",
        kind: "claim_next_work",
        inputFingerprint: "synthetic",
        state: "completed",
        result,
      });
      return {
        mailboxId,
        messageId: source.messageId,
        checksum: source.rawChecksum,
        evidenceVersion: parsed.evidenceVersion,
      };
    }
    const evidence = await claim(first.owner);
    const request = {
      source: evidence,
      generation: `synthetic-generation:${first.owner.id}`,
      stage: "primary" as const,
      action: "admit" as const,
      identity: "initial",
      invocation: "initial-call",
      publicationPossible: false,
      proposal: {
        mail: {
          mailboxId,
          messageId: source.messageId,
          checksum: source.rawChecksum,
        },
        extraction: {
          status: "incomplete",
          reason: "Synthetic retained proposal",
        },
        products: [],
      },
    };
    expect(await recordMailAttempt(ctx.db, first.owner.id, request)).toEqual({
      kind: "admitted",
    });
    await recordMailAttempt(ctx.db, first.owner.id, {
      ...request,
      action: "exempt",
    });
    expect(
      await recordMailAttempt(ctx.db, first.owner.id, {
        ...request,
        invocation: "transport-retry",
      }),
    ).toEqual({ kind: "admitted" });

    const preparation = preparePurchaseImportInput.parse({
      _runExecution: {
        runId: first.owner.id,
        operationId: "synthetic-refused-prepare",
        generation: request.generation,
        itemOperationIds: ["synthetic-budget-item"],
      },
      orders: [
        {
          stableOrderId: "synthetic-budget-order",
          itemOperationId: "synthetic-budget-item",
          vendorId: seller.shortcode,
          targetPurchaseId: wrongTarget.shortcode,
          source: {
            kind: "mail_message",
            externalKey: `gmail:${mailboxId}:${source.messageId}`,
            checksum: source.rawChecksum,
          },
          evidenceChecksum: source.rawChecksum,
          extractionRevision: "synthetic@1",
          extraction: {
            status: "ready",
            candidate: {
              orderId: "SYN-BUDGET-1",
              orderedAt: "2026-01-02",
              merchant: seller.name,
              currency: "USD",
              printedGrandTotal: 12,
              lines: [
                { title: "Synthetic mug", amount: 12, lineKind: "principal" },
              ],
              payments: [],
              allShipmentsDelivered: false,
            },
          },
          lineIds: ["synthetic-budget-line"],
          primaryDocumentImageId: null,
          screenshotImageId: null,
        },
      ],
    });
    const decision: DecisionPort = async () => ({
      answers: {
        selection: {
          type: "choice",
          choice: "c0",
          confidence: 0.97,
          probabilities: { c0: 0.97, c1: 0.01, c2: 0.01 },
        },
      },
    });
    const refusal = await preparePurchaseImport(
      ctx.db,
      preparation,
      first.pi,
      decision,
    ).then(
      () => {
        throw new Error("Expected synthetic target refusal");
      },
      (error: unknown) => error,
    );
    expect(refusal).toMatchObject({
      message:
        "The reviewed Purchase target has a different vendor or order identity.",
    });
    const outcome = mailWriterOutcome({
      stage: "prepare",
      result: cubbyToolResult({
        isError: true,
        content: [],
        _meta: { "cubby/error": describeToolError(refusal) },
      }),
    });
    expect(outcome).toBe("invalid");
    await recordMailAttempt(ctx.db, first.owner.id, {
      ...request,
      action: outcome,
    });

    expect(
      await recordMailAttempt(ctx.db, first.owner.id, {
        ...request,
        identity: "repair",
      }),
    ).toEqual({ kind: "admitted" });
    const repaired = await preparePurchaseImport(
      ctx.db,
      {
        ...preparation,
        _runExecution: {
          ...preparation._runExecution,
          operationId: "synthetic-repaired-prepare",
        },
        orders: preparation.orders.map((item) => ({
          ...item,
          targetPurchaseId: target.shortcode,
        })),
      },
      first.pi,
      decision,
    );
    expect(repaired.orders).toMatchObject([
      {
        targetPurchaseId: target.shortcode,
        orderId: "SYN-BUDGET-1",
        lines: [{ amount: 12 }],
      },
    ]);

    expect(
      await recordMailAttempt(ctx.db, first.owner.id, {
        ...request,
        identity: "repair",
        action: "pending",
      }),
    ).toEqual({ kind: "admitted" });
    expect(
      await recordMailAttempt(ctx.db, first.owner.id, {
        ...request,
        identity: "repair",
      }),
    ).toEqual({ kind: "admitted" });
    expect(
      await recordMailAttempt(ctx.db, first.owner.id, {
        ...request,
        identity: "changed",
      }),
    ).toEqual({ kind: "pending" });
    // The live owner's claim carries its own pending proposal for exact replay.
    expect(await claimMailImportWork(ctx.db, first.owner.id)).toMatchObject({
      recovery: { tool: "import_extracted_order", arguments: request.proposal },
    });
    // A receipt hashed before `detail` left the identity still admits its replay.
    expect(
      await recordMailAttempt(ctx.db, first.owner.id, {
        ...request,
        identity: "repair-without-detail",
        legacyIdentity: "repair",
      }),
    ).toEqual({ kind: "admitted" });
    await recordMailAttempt(ctx.db, first.owner.id, {
      ...request,
      identity: "repair",
      action: "complete",
    });
    const malformed = {
      ...request,
      identity: "malformed",
      invocation: "malformed-1",
      stage: "escalation" as const,
    };
    expect(await recordMailAttempt(ctx.db, first.owner.id, malformed)).toEqual({
      kind: "admitted",
    });
    await recordMailAttempt(ctx.db, first.owner.id, {
      ...malformed,
      action: "invalid",
    });
    // Recovery of the same rejected call is not a fresh malformed submission.
    expect(await recordMailAttempt(ctx.db, first.owner.id, malformed)).toEqual({
      kind: "admitted",
    });
    expect(
      await recordMailAttempt(ctx.db, first.owner.id, {
        ...malformed,
        invocation: "malformed-2",
      }),
    ).toEqual({ kind: "exhausted" });
    await recordMailAttempt(ctx.db, first.owner.id, {
      ...request,
      identity: "repair",
      action: "pending",
    });
    const successor = await admit(party, [source]);
    expect(await claim(successor.owner)).toEqual(evidence);
    const retry = {
      ...request,
      generation: `synthetic-generation:${successor.owner.id}`,
      identity: "repair",
      publicationPossible: true,
    };
    expect(await recordMailAttempt(ctx.db, successor.owner.id, retry)).toEqual({
      kind: "pending",
    });
    await getDb(ctx.db)
      .update(run)
      .set({ status: "failed", retiredAt: null })
      .where(eq(run.id, first.owner.id));
    expect(await claimMailImportWork(ctx.db, successor.owner.id)).toMatchObject(
      {
        recovery: {
          tool: "import_extracted_order",
          arguments: request.proposal,
        },
      },
    );
    expect(
      await recordMailAttempt(ctx.db, successor.owner.id, {
        ...retry,
        identity: "changed",
      }),
    ).toEqual({ kind: "pending" });
    expect(await recordMailAttempt(ctx.db, successor.owner.id, retry)).toEqual({
      kind: "admitted",
    });
    expect(
      await recordMailAttempt(ctx.db, successor.owner.id, {
        ...retry,
        identity: "changed",
      }),
    ).toEqual({ kind: "pending" });
    await recordMailAttempt(ctx.db, successor.owner.id, {
      ...retry,
      action: "complete",
    });
    expect(
      await claimMailImportWork(ctx.db, successor.owner.id),
    ).not.toHaveProperty("recovery");
    expect(
      await recordMailAttempt(ctx.db, successor.owner.id, {
        ...request,
        generation: `synthetic-generation:${successor.owner.id}`,
        identity: "successor",
      }),
    ).toEqual({ kind: "exhausted" });
  });
  it("does not resolve a completed source unresolved on exhaustion", async () => {
    const { party, retain } = await world();
    const source = await retain(
      "completed-attempt",
      "Synthetic order",
      "Synthetic retained original",
    );
    const { pi } = await admit(party, [source]);
    await getDb(ctx.db)
      .update(emailTable)
      .set({ status: "completed" })
      .where(eq(emailTable.orderMailId, source.id));
    await expect(
      resolveMail(
        ctx.db,
        {
          mailboxId,
          messageId: source.messageId,
          checksum: source.rawChecksum,
          disposition: {
            kind: "unresolved",
            category: "unknown" as const,
            reason: "Synthetic attempt exhaustion",
          },
        },
        pi,
      ),
    ).rejects.toThrow("researching");
    expect(await emailOf(source)).toMatchObject({ status: "completed" });
  });
});
