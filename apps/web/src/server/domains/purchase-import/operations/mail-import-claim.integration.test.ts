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
import { runTargetOutcomeReceipt } from "@cubby/schemas/run-fields";
import { mailResearchRunInput } from "@cubby/schemas/run-fields";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq, inArray } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { DecisionPort } from "~/server/ai/decision-model";
import { getDb } from "~/server/db/helpers";
import { run } from "~/server/db/schema";
import {
  emailClassificationObservation,
  email as emailTable,
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
import { insertOperation } from "~/server/domains/run/repo/run-operation";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { activeEmailPurchaseDecision } from "~/server/testing/email-link.fixtures";

import { recordMailAttempt } from "../repo/mail-attempts";
import { MAIL_IMPORT_RULE_REVISION } from "../service/mail-import-rule";
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
    const order = (orderId: string) =>
      insertWithShortcode(ctx.db, "purchase", {
        vendorId: seller.id,
        vendorAccountId: account.id,
        orderId,
      });
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
    expect((await emailOf(unmatched)).status).toBe("blocked");
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

  it("claims an incomplete lifecycle read instead of settling its first-page match", async () => {
    const { party, seller, order, retain } = await world();
    const target = await order("SYN-3001");
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
            reason: "Synthetic package or refund needs evidence review.",
          },
        },
        pi,
      );
    }
    expect(claimed).toEqual([ruleShipped.messageId, refund.messageId]);
    expect(await linkRows(ruleShipped)).toMatchObject({
      events: [],
      links: [],
      email: { status: "blocked" },
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
    const { party, retain } = await world();
    const source = await retain(
      "attempt-budget",
      "Synthetic order evidence",
      "Incomplete synthetic order evidence",
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

    expect(
      await recordMailAttempt(ctx.db, first.owner.id, {
        ...request,
        identity: "repair",
      }),
    ).toEqual({ kind: "admitted" });
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
    expect(
      await recordMailAttempt(ctx.db, first.owner.id, {
        ...malformed,
        invocation: "malformed-2",
      }),
    ).toEqual({ kind: "exhausted" });
    const successor = await admit(party, [source]);
    expect(await claim(successor.owner)).toEqual(evidence);
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
            reason: "Synthetic attempt exhaustion",
          },
        },
        pi,
      ),
    ).rejects.toThrow("researching");
    expect(await emailOf(source)).toMatchObject({ status: "completed" });
  });
});
