import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { purchase as purchaseTable, vendorAccount } from "~/server/db/schema";
import {
  assessment,
  assessmentEmailLink,
  email,
  importSourceClaim,
  importSourceOrder,
  orderMail,
  orderMailEvent,
} from "~/server/db/schema";
import { decideEmailPurchase } from "~/server/domains/purchase-import/repo/email-purchase-decision";
import { syntheticRetainedMail } from "~/server/domains/purchase-import/service/gmail/retained-mail.fixtures";
import { connectionSourceFingerprint } from "~/server/domains/run/repo/connection-refresh";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { kernelCtx } from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { reviewAssessment } from "~/server/generic/assessment/repo/assessment-review";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { retrieveConnectionCandidates } from "./connection-candidates";
import {
  publishEntityConnection,
  readEntityConnections,
} from "./entity-connections";

// Failure modes: discovery grants operational link authority; inverse discovery
// misses retained events; subject similarity invents identity; a changed checksum
// or superseded event applies; foreign members/agents bypass mail.resolve;
// a failed outer transaction leaks a link and a retry applies twice.
describe("fresh retained Email connection recommendations", () => {
  const ctx = withTestDb();
  async function fixture() {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic connection member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic connection merchant",
    });
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      orderId: "SYNTHETIC-CONNECTION",
      date: "2026-10-01",
      statedTotal: 24,
    });
    const original = await syntheticRetainedMail(ctx.db, {
      ledgerPartyId: party.id,
      mailboxId: "synthetic-connection-mailbox",
      messageId: "synthetic-connection-message",
      vendorId: vendor.id,
      sender: "orders@example.test",
      subject: "Synthetic connection receipt",
      receivedAt: new Date("2026-10-01T12:00:00Z"),
      rawChecksum: "a".repeat(64),
      content: { bodyText: "Synthetic receipt", bodyHtml: null, snippet: null },
    });
    const [event] = await getDb(ctx.db)
      .insert(orderMailEvent)
      .values({
        orderMailId: original.id,
        event: "placed",
        orderId: purchase.orderId,
        sourceKey: "synthetic-connection-event",
      })
      .returning();
    const [message] = await getDb(ctx.db)
      .select()
      .from(email)
      .where(eq(email.orderMailId, original.id));
    if (!event || !message) throw new Error("Synthetic retained Email missing");
    const source = {
      entityKind: "email" as const,
      entityId: message.shortcode,
    };
    const target = {
      entityKind: "purchase" as const,
      entityId: purchase.shortcode,
    };
    return { original, event, message, source, target, purchase };
  }

  it("retrieves both endpoints, publishes pending only, and keeps UUID dependencies private", async () => {
    const f = await fixture();
    const candidates = await retrieveConnectionCandidates(ctx.db, f.source);
    expect(candidates).toHaveLength(1);
    expect(await retrieveConnectionCandidates(ctx.db, f.target)).toEqual(
      candidates,
    );
    const candidate = candidates[0];
    if (!candidate) throw new Error("Missing synthetic candidate");
    const proposal = await publishEntityConnection(ctx.db, candidate);
    expect(proposal).toMatchObject({
      relation: "email-purchase",
      source: f.source,
      target: f.target,
      integration: { kind: "connection-review" },
    });
    expect(JSON.stringify(proposal)).not.toContain(f.original.id);
    expect(JSON.stringify(proposal)).not.toContain(f.event.id);
    expect(await getDb(ctx.db).select().from(assessmentEmailLink)).toEqual([]);
    expect(await getDb(ctx.db).select().from(orderMailEvent)).toHaveLength(1);
    expect(await getDb(ctx.db).select().from(orderMail)).toHaveLength(1);
    expect(
      (await readEntityConnections(ctx.db, f.target)).map(
        (p) => p.review.assessmentId,
      ),
    ).toContain(proposal.review.assessmentId);
    const [stored] = await getDb(ctx.db)
      .select()
      .from(assessment)
      .where(eq(assessment.id, proposal.review.assessmentId));
    expect(stored?.evidence).toMatchObject({
      basis: {
        dependencies: {
          originalId: f.original.id,
          eventId: f.event.id,
          expectedChecksum: f.message.checksum,
        },
      },
    });
  });

  it("invalidates negative discovery when retained event or checksum evidence changes", async () => {
    const f = await fixture();
    const before = await Promise.all([
      connectionSourceFingerprint(ctx.db, f.source),
      connectionSourceFingerprint(ctx.db, f.target),
    ]);
    await getDb(ctx.db)
      .update(orderMailEvent)
      .set({ orderId: "SYNTHETIC-CORRECTED" })
      .where(eq(orderMailEvent.id, f.event.id));
    const changed = await Promise.all([
      connectionSourceFingerprint(ctx.db, f.source),
      connectionSourceFingerprint(ctx.db, f.target),
    ]);
    expect(changed[0]).not.toBe(before[0]);
    expect(changed[1]).not.toBe(before[1]);
    await getDb(ctx.db)
      .update(orderMail)
      .set({ rawChecksum: "b".repeat(64) })
      .where(eq(orderMail.id, f.original.id));
    expect(await connectionSourceFingerprint(ctx.db, f.source)).not.toBe(
      changed[0],
    );
  });

  it("invalidates negative discovery after account assignment and ownership corrections", async () => {
    const f = await fixture();
    const foreign = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic other account member",
      kind: "member",
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      vendorId: f.purchase.vendorId,
      ledgerPartyId: foreign.id,
    });
    await getDb(ctx.db)
      .update(purchaseTable)
      .set({ vendorAccountId: account.id })
      .where(eq(purchaseTable.id, f.purchase.id));
    expect(await retrieveConnectionCandidates(ctx.db, f.source)).toEqual([]);
    const before = await Promise.all([
      connectionSourceFingerprint(ctx.db, f.source),
      connectionSourceFingerprint(ctx.db, f.target),
    ]);
    await getDb(ctx.db)
      .update(vendorAccount)
      .set({ ledgerPartyId: f.message.ledgerPartyId })
      .where(eq(vendorAccount.id, account.id));
    const owned = await Promise.all([
      connectionSourceFingerprint(ctx.db, f.source),
      connectionSourceFingerprint(ctx.db, f.target),
    ]);
    expect(owned[0]).not.toBe(before[0]);
    expect(owned[1]).not.toBe(before[1]);
    expect(await retrieveConnectionCandidates(ctx.db, f.source)).toHaveLength(
      1,
    );
    await getDb(ctx.db)
      .update(purchaseTable)
      .set({ vendorAccountId: null })
      .where(eq(purchaseTable.id, f.purchase.id));
    const unassigned = await Promise.all([
      connectionSourceFingerprint(ctx.db, f.source),
      connectionSourceFingerprint(ctx.db, f.target),
    ]);
    expect(unassigned[0]).not.toBe(owned[0]);
    expect(unassigned[1]).not.toBe(owned[1]);
    await getDb(ctx.db)
      .update(vendorAccount)
      .set({ deletedAt: new Date() })
      .where(eq(vendorAccount.id, account.id));
    expect(await connectionSourceFingerprint(ctx.db, f.source)).not.toBe(
      unassigned[0],
    );
  });

  it("rejects subject-only retrieval and superseded events", async () => {
    const f = await fixture();
    await getDb(ctx.db)
      .update(orderMailEvent)
      .set({ orderId: "SYNTHETIC-OTHER", amount: null })
      .where(eq(orderMailEvent.id, f.event.id));
    expect(await retrieveConnectionCandidates(ctx.db, f.source)).toEqual([]);
    await getDb(ctx.db)
      .update(orderMailEvent)
      .set({ orderId: "SYNTHETIC-CONNECTION", supersededAt: new Date() })
      .where(eq(orderMailEvent.id, f.event.id));
    expect(await retrieveConnectionCandidates(ctx.db, f.target)).toEqual([]);
  });

  it("retains the Vendor, amount and date fallback when an order ID is absent", async () => {
    const f = await fixture();
    await getDb(ctx.db)
      .update(orderMailEvent)
      .set({ orderId: null, amount: 24 })
      .where(eq(orderMailEvent.id, f.event.id));
    expect(await retrieveConnectionCandidates(ctx.db, f.source)).toHaveLength(
      1,
    );
    await getDb(ctx.db)
      .update(orderMailEvent)
      .set({ amount: 25 })
      .where(eq(orderMailEvent.id, f.event.id));
    expect(await retrieveConnectionCandidates(ctx.db, f.source)).toEqual([]);
  });

  it.each(["checksum", "event"] as const)(
    "refuses changed %s evidence and omits stale proposals",
    async (change) => {
      const f = await fixture();
      const [candidate] = await retrieveConnectionCandidates(ctx.db, f.source);
      if (!candidate) throw new Error("Missing synthetic candidate");
      const proposal = await publishEntityConnection(ctx.db, candidate);
      if (change === "checksum")
        await getDb(ctx.db)
          .update(orderMail)
          .set({ rawChecksum: "b".repeat(64) })
          .where(eq(orderMail.id, f.original.id));
      else
        await getDb(ctx.db)
          .update(orderMailEvent)
          .set({ supersededAt: new Date() })
          .where(eq(orderMailEvent.id, f.event.id));
      expect(await readEntityConnections(ctx.db, f.source)).toEqual([]);
      await expect(
        reviewAssessment(ctx.db, kernelCtx(ctx), {
          assessmentId: proposal.review.assessmentId,
          operationId: "synthetic-stale-email",
          intent: "apply",
          verdict: "correct",
          expectedFingerprint: proposal.fingerprint,
        }),
      ).rejects.toThrow(/changed|stale|retained/i);
      expect(await getDb(ctx.db).select().from(assessmentEmailLink)).toEqual(
        [],
      );
    },
  );

  it("rolls back authority with its caller and replays the generic application receipt", async () => {
    const f = await fixture();
    const [candidate] = await retrieveConnectionCandidates(ctx.db, f.target);
    if (!candidate) throw new Error("Missing synthetic candidate");
    const proposal = await publishEntityConnection(ctx.db, candidate);
    const command = {
      assessmentId: proposal.review.assessmentId,
      operationId: "synthetic-email-accept",
      intent: "apply" as const,
      verdict: "correct" as const,
      expectedFingerprint: proposal.fingerprint,
    };
    await expect(
      withTransactionDatabase(ctx.db, async (db) => {
        await reviewAssessment(db, { ...kernelCtx(ctx), db }, command);
        throw new Error("synthetic rollback");
      }),
    ).rejects.toThrow("synthetic rollback");
    expect(await getDb(ctx.db).select().from(assessmentEmailLink)).toEqual([]);
    const receipt = await reviewAssessment(ctx.db, kernelCtx(ctx), command);
    expect(receipt.applied).toBe(true);
    expect(await reviewAssessment(ctx.db, kernelCtx(ctx), command)).toEqual(
      receipt,
    );
    expect(
      await getDb(ctx.db).select().from(assessmentEmailLink),
    ).toMatchObject([{ eventId: f.event.id, decision: "linked" }]);
    expect(await retrieveConnectionCandidates(ctx.db, f.source)).toEqual([]);
  });

  it("preserves the domain member and agent guards", async () => {
    const f = await fixture();
    const [candidate] = await retrieveConnectionCandidates(ctx.db, f.source);
    if (!candidate) throw new Error("Missing synthetic candidate");
    const proposal = await publishEntityConnection(ctx.db, candidate);
    const run = {
      id: await ensureRun(ctx.db, ctx.actor, {
        purpose: "ai_suggest",
        trigger: "manual",
        status: "running",
      }),
    };
    const command = {
      assessmentId: proposal.review.assessmentId,
      operationId: "synthetic-agent-email",
      intent: "apply" as const,
      verdict: "correct" as const,
      expectedFingerprint: proposal.fingerprint,
    };
    const context = kernelCtx(ctx);
    await expect(
      reviewAssessment(
        ctx.db,
        { ...context, actorContext: { ...ctx.actor, runId: run.id } },
        command,
      ),
    ).rejects.toThrow(/mail.resolve|member/i);
    const foreign = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic other member",
      kind: "member",
    });
    await getDb(ctx.db)
      .update(email)
      .set({ ledgerPartyId: foreign.id })
      .where(eq(email.id, f.message.id));
    await getDb(ctx.db)
      .update(orderMail)
      .set({ ledgerPartyId: foreign.id })
      .where(eq(orderMail.id, f.original.id));
    const foreignProposal = await publishEntityConnection(ctx.db, candidate);
    await expect(
      reviewAssessment(ctx.db, context, {
        ...command,
        assessmentId: foreignProposal.review.assessmentId,
        expectedFingerprint: foreignProposal.fingerprint,
        operationId: "synthetic-foreign-email",
      }),
    ).rejects.toThrow(/owner/i);
    expect(await getDb(ctx.db).select().from(assessmentEmailLink)).toEqual([]);
  });

  it("omits accepted import sources and invalidates a recommendation accepted since publication", async () => {
    const f = await fixture();
    const [candidate] = await retrieveConnectionCandidates(ctx.db, f.source);
    if (!candidate) throw new Error("Missing synthetic candidate");
    const proposal = await publishEntityConnection(ctx.db, candidate);
    const run = {
      id: await ensureRun(ctx.db, ctx.actor, {
        purpose: "mail_import",
        trigger: "manual",
        status: "running",
      }),
    };
    const [claim] = await getDb(ctx.db)
      .insert(importSourceClaim)
      .values({
        ledgerPartyId: f.message.ledgerPartyId,
        kind: "mail_message",
        externalKey: `${f.message.provider}:${f.message.mailboxId}:${f.message.messageId}`,
        checksum: f.message.checksum,
        firstRunId: run.id,
        lastRunId: run.id,
      })
      .returning();
    if (!claim) throw new Error("Missing synthetic accepted claim");
    await getDb(ctx.db).insert(importSourceOrder).values({
      sourceClaimId: claim.id,
      orderKey: "synthetic-accepted-connection",
      purchaseId: f.purchase.id,
      checksum: f.message.checksum,
      outputFingerprint: "synthetic-accepted-output",
    });
    expect(await retrieveConnectionCandidates(ctx.db, f.source)).toEqual([]);
    expect(await readEntityConnections(ctx.db, f.target)).toEqual([]);
    await expect(
      reviewAssessment(ctx.db, kernelCtx(ctx), {
        assessmentId: proposal.review.assessmentId,
        operationId: "synthetic-accepted-stale",
        intent: "apply",
        verdict: "correct",
        expectedFingerprint: proposal.fingerprint,
      }),
    ).rejects.toThrow(/changed|stale/i);
    expect(await getDb(ctx.db).select().from(assessmentEmailLink)).toEqual([]);
  });

  it("replaces only the selected event's prior reviewed link through the domain writer", async () => {
    const f = await fixture();
    const merchant = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic previous merchant",
    });
    const previous = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: merchant.id,
      orderId: "SYNTHETIC-PREVIOUS",
    });
    const [untouchedEvent] = await getDb(ctx.db)
      .insert(orderMailEvent)
      .values({
        orderMailId: f.original.id,
        event: "shipped",
        orderId: "SYNTHETIC-PREVIOUS",
        sourceKey: "synthetic-second-event",
      })
      .returning();
    if (!untouchedEvent) throw new Error("Missing synthetic second event");
    await decideEmailPurchase(
      ctx.db,
      {
        id: parseShortcodeFor("email", f.source.entityId),
        purchaseId: parseShortcodeFor("purchase", previous.shortcode),
        expectedChecksum: f.message.checksum,
        decision: "linked",
      },
      ctx.actor,
      { eventId: f.event.id, originalId: f.original.id },
    );
    await decideEmailPurchase(
      ctx.db,
      {
        id: parseShortcodeFor("email", f.source.entityId),
        purchaseId: parseShortcodeFor("purchase", previous.shortcode),
        expectedChecksum: f.message.checksum,
        decision: "linked",
      },
      ctx.actor,
      { eventId: untouchedEvent.id, originalId: f.original.id },
    );
    const [candidate] = await retrieveConnectionCandidates(ctx.db, f.source);
    if (!candidate) throw new Error("Missing synthetic replacement candidate");
    expect(candidate.label).toBe("Replace reviewed Email purchase link");
    expect(candidate.evidence.contradictions).toEqual([]);
    expect(candidate.evidence.reasons).toContain(
      `Acceptance replaces this event's reviewed link to ${previous.shortcode}`,
    );
    const proposal = await publishEntityConnection(ctx.db, candidate);
    await reviewAssessment(ctx.db, kernelCtx(ctx), {
      assessmentId: proposal.review.assessmentId,
      operationId: "synthetic-replace-email",
      intent: "apply",
      verdict: "correct",
      expectedFingerprint: proposal.fingerprint,
    });
    const active = await getDb(ctx.db).select().from(assessmentEmailLink);
    expect(active).toHaveLength(2);
    expect(active.find((row) => row.eventId === f.event.id)).toMatchObject({
      purchaseId: expect.any(String),
      decision: "linked",
    });
    expect(
      active.find((row) => row.eventId === f.event.id)?.purchaseId,
    ).not.toBe(previous.id);
    expect(
      active.find((row) => row.eventId === untouchedEvent.id),
    ).toMatchObject({ purchaseId: previous.id, decision: "linked" });
  });
});
