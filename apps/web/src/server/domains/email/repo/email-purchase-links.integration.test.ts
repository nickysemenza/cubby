import { buildActorContext } from "@cubby/schemas/context";
import { emailRelationshipResult } from "@cubby/schemas/email-relationship-facts";
import { parseShortcodeFor, userId } from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { insertFieldsFixture as insert } from "~/server/ai/fields/fields.fixtures";
import { getDb } from "~/server/db/helpers";
import { decision } from "~/server/db/kernel-schema";
import { emailReadSnapshot } from "~/server/db/read-snapshot-schema";
import {
  email,
  orderMailEvent,
  financialTransactionAllocation,
  expense,
} from "~/server/db/schema";
import { emailLinkDecisionsRead } from "~/server/domains/email/repo/email-decision-sql";
import { publishEmailLinkDecision } from "~/server/domains/email/repo/email-link-decision";
import { decideEmailPurchase } from "~/server/domains/purchase-import/repo/email-purchase-decision";
import { syntheticRetainedMail } from "~/server/domains/purchase-import/service/gmail/retained-mail.fixtures";
import { reconcileNow } from "~/server/kernel/api";

describe("Email Purchase link decisions", () => {
  const ctx = withTestDb();
  async function fixture() {
    const party = await insert(ctx.db, "ledgerParty", {
      name: "Synthetic link owner",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insert(ctx.db, "vendor", {
      name: "Synthetic link merchant",
    });
    const purchase = await insert(ctx.db, "purchase", {
      vendorId: vendor.id,
      orderId: "SYNTHETIC-ORDER",
    });
    const checksum = "e".repeat(64);
    const original = await syntheticRetainedMail(ctx.db, {
      ledgerPartyId: party.id,
      vendorId: vendor.id,
      mailboxId: "synthetic-mailbox",
      messageId: "synthetic-link-message",
      threadId: "synthetic-link-thread",
      sender: "orders@example.test",
      subject: "Synthetic order",
      receivedAt: new Date("2026-10-01T12:00:00Z"),
      rawChecksum: checksum,
      content: { bodyText: "Synthetic order", bodyHtml: null, snippet: null },
    });
    const [event] = await getDb(ctx.db)
      .insert(orderMailEvent)
      .values({
        orderMailId: original.id,
        event: "placed",
        orderId: "SYNTHETIC-ORDER",
        sourceKey: "synthetic-link-event",
      })
      .returning();
    const [mail] = await getDb(ctx.db)
      .select()
      .from(email)
      .where(eq(email.orderMailId, original.id));
    if (!event || !mail) throw new Error("Missing synthetic Email evidence");
    return { party, vendor, purchase, event, mail, checksum, original };
  }
  async function facts(id: string) {
    await reconcileNow(ctx.db, [{ kind: "emailState", key: id }]);
    const [row] = await getDb(ctx.db)
      .select()
      .from(emailReadSnapshot)
      .where(eq(emailReadSnapshot.entityId, id));
    return emailRelationshipResult.parse(row?.relationshipFacts);
  }
  const command = (
    f: Awaited<ReturnType<typeof fixture>>,
    choice: "linked" | "dismissed",
  ) => ({
    id: parseShortcodeFor("email", f.mail.shortcode),
    purchaseId: parseShortcodeFor("purchase", f.purchase.shortcode),
    expectedChecksum: f.checksum,
    decision: choice,
  });

  it("persists a member link across new evidence without creating spending", async () => {
    const f = await fixture();
    await decideEmailPurchase(ctx.db, command(f, "linked"), ctx.actor);
    expect(await facts(f.mail.id)).toMatchObject({
      linked: true,
      linkState: "linked",
      purchaseLinks: [{ purchaseId: f.purchase.shortcode, state: "linked" }],
    });
    await getDb(ctx.db)
      .update(orderMailEvent)
      .set({ supersededAt: new Date() })
      .where(eq(orderMailEvent.id, f.event.id));
    await getDb(ctx.db).insert(orderMailEvent).values({
      orderMailId: f.original.id,
      event: "shipped",
      orderId: "SYNTHETIC-OTHER",
      sourceKey: "synthetic-new-event",
    });
    expect(await facts(f.mail.id)).toMatchObject({
      linked: true,
      purchaseLinks: [{ purchaseId: f.purchase.shortcode, state: "linked" }],
    });
    expect(await getDb(ctx.db).select().from(expense)).toEqual([]);
    expect(
      await getDb(ctx.db).select().from(financialTransactionAllocation),
    ).toEqual([]);
  });
  it("keeps a dismissal when exact matching evidence reruns, and allows a later member link", async () => {
    const f = await fixture();
    await decideEmailPurchase(ctx.db, command(f, "dismissed"), ctx.actor);
    expect(await facts(f.mail.id)).toMatchObject({
      linked: false,
      linkState: "dismissed",
    });
    await decideEmailPurchase(ctx.db, command(f, "linked"), ctx.actor);
    expect(await facts(f.mail.id)).toMatchObject({
      linked: true,
      linkState: "linked",
    });
  });
  it("replays the same link publication without another decision", async () => {
    const f = await fixture();
    const input = {
      eventId: f.event.id,
      purchaseId: f.purchase.id,
      decision: "linked" as const,
      evidenceChecksum: f.checksum,
      decidedByUserId: ctx.actor.userId,
      proposedBy: "member" as const,
    };
    const first = await publishEmailLinkDecision(ctx.db, input);
    const before = await getDb(ctx.db).select().from(decision);
    expect((await publishEmailLinkDecision(ctx.db, input)).id).toBe(first.id);
    expect(await getDb(ctx.db).select().from(decision)).toEqual(before);
    expect(
      await getDb(ctx.db).select().from(emailLinkDecisionsRead),
    ).toHaveLength(1);
  });
  it("refuses a stale checksum and another member before recording intent", async () => {
    const f = await fixture();
    const before = await getDb(ctx.db).select().from(decision);
    await expect(
      decideEmailPurchase(
        ctx.db,
        { ...command(f, "linked"), expectedChecksum: "f".repeat(64) },
        ctx.actor,
      ),
    ).rejects.toThrow(/changed/);
    await expect(
      decideEmailPurchase(
        ctx.db,
        command(f, "linked"),
        buildActorContext(userId.parse("synthetic-other-member")),
      ),
    ).rejects.toThrow(/owner/);
    expect(await getDb(ctx.db).select().from(decision)).toEqual(before);
  });
});
