/**
 * Failures: a rule-settled lifecycle notice writes different rows than the
 * coordinator's `mail.resolve` link, publishes no gradable rule Assessment,
 * skips the Run target outcome, or still reaches the coordinator; a confident
 * unrelated classification is not disposed of exactly as `mail.resolve`
 * `unrelated` would; a refund notice is settled without the coordinator; the
 * claimed Email arrives without its compact read; a repeated claim duplicates
 * a rule outcome.
 */
import type { ActorContext } from "@cubby/schemas/context";
import type { RunId } from "@cubby/schemas/identifiers";
import { runTargetOutcomeReceipt } from "@cubby/schemas/run-fields";
import { mailResearchRunInput } from "@cubby/schemas/run-fields";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq, inArray } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import type { DecisionPort } from "~/server/ai/decision-model";
import { getDb } from "~/server/db/helpers";
import {
  assessment,
  assessmentEmailLink,
  emailClassificationObservation,
  email as emailTable,
  orderMail,
  orderMailEvent,
  runOperation,
  vendorAccount,
} from "~/server/db/schema";
import type { RetainedMail } from "~/server/domains/mail/repo/retained-mail";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

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
    ) =>
      retainedMailFixture(ctx.db, {
        ledgerPartyId: party.id,
        mailboxId,
        messageId,
        sender,
        subject,
        checksum: await sha256Hex(`${subject}\n${bodyText}`),
        content: { snippet: null, bodyText, bodyHtml: null },
      });
    return { party, seller, order, retain };
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
            decision: assessmentEmailLink.decision,
            evidenceChecksum: assessmentEmailLink.evidenceChecksum,
            proposedBy: assessmentEmailLink.proposedBy,
          })
          .from(assessmentEmailLink)
          .where(
            inArray(
              assessmentEmailLink.eventId,
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

  it("settles same-Vendor lifecycle and confident unrelated Emails without the coordinator, as mail.resolve does", async () => {
    const { party, seller, order, retain } = await world();
    const ruleTarget = await order("SYN-2001");
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
    const newsletter = await retain(
      "rule-newsletter",
      "Synthetic garden newsletter",
      "Seasonal planting tips from the synthetic garden club.",
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
        remaining: 1,
        read: {
          messageId: refund.messageId,
          checksum: refund.rawChecksum,
          boundToRun: true,
          content: { bodyText: expect.stringContaining("Refund issued") },
        },
      });
      await resolveMail(
        ctx.db,
        {
          mailboxId,
          messageId: refund.messageId,
          checksum: refund.rawChecksum,
          disposition: {
            kind: "unresolved",
            reason: "Synthetic refund awaits member review.",
          },
        },
        pi,
      );
    }
    expect(claimed).toEqual([refund.messageId]);

    const rule = await linkRows(ruleShipped);
    const control = await linkRows(controlShipped);
    expect(rule).toEqual({
      ...control,
      links: control.links.map((link) => ({
        ...link,
        evidenceChecksum: ruleShipped.rawChecksum,
        proposedBy: "heuristic",
      })),
    });
    expect(rule).toMatchObject({
      events: ["shipped"],
      links: [{ decision: "linked" }],
      email: { status: "completed", classification: "related" },
      target: [{ state: "completed", outcome: "verified", fingerprint: true }],
    });
    const [ruleEvent] = await getDb(ctx.db)
      .select({ orderId: orderMailEvent.orderId })
      .from(orderMailEvent)
      .where(eq(orderMailEvent.orderMailId, ruleShipped.id));
    expect(ruleEvent?.orderId).toBe("SYN-2001");
    const linkAssessments = await getDb(ctx.db)
      .select({ subject: assessment.subject, producer: assessment.producer })
      .from(assessment)
      .where(eq(assessment.family, "email_link"));
    expect(
      linkAssessments.find(
        ({ subject }) =>
          (subject as { purchaseId?: string }).purchaseId === ruleTarget.id,
      )?.producer,
    ).toEqual({
      kind: "rule",
      model: null,
      revision: MAIL_IMPORT_RULE_REVISION,
      runId: owner.id,
      evaluationId: null,
    });
    expect(
      await getDb(ctx.db)
        .select({ id: vendorAccount.id })
        .from(vendorAccount)
        .where(eq(vendorAccount.vendorId, seller.id)),
    ).toHaveLength(1);

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
    const [relevance] = await getDb(ctx.db)
      .select({ producer: assessment.producer })
      .from(assessment)
      .where(
        eq(assessment.publicationKey, `email-observation:${resolution?.id}`),
      );
    expect(relevance?.producer).toEqual({
      kind: "rule",
      model: null,
      revision: MAIL_IMPORT_RULE_REVISION,
      runId: owner.id,
      evaluationId: null,
    });

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
});
