import { buildActorContext } from "@cubby/schemas/context";
import { emailRelationshipResult } from "@cubby/schemas/email-relationship-facts";
import { parseShortcodeFor, userId } from "@cubby/schemas/identifiers";
import { asc, eq, like, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { insertFieldsFixture as insert } from "~/server/ai/fields/fields.fixtures";
import { getDb } from "~/server/db/helpers";
import { decision, scopeDirty } from "~/server/db/kernel-schema";
import { emailReadSnapshot } from "~/server/db/read-snapshot-schema";
import {
  email,
  purchase,
  orderMailEvent,
  financialTransactionAllocation,
  expense,
} from "~/server/db/schema";
import {
  emailLinkDecisionHistoryReadForDecision,
  emailLinkDecisionHistorySql,
  emailLinkDecisionsForPurchasesSql,
  emailLinkDecisionsRead,
  emailLinkDecisionsReadForDecision,
  emailLinkDecisionsReadForEmail,
  emailLinkDecisionsReadForOrderMail,
} from "~/server/domains/email/repo/email-decision-sql";
import { publishEmailLinkDecision } from "~/server/domains/email/repo/email-link-write";
import { emailPredictionEvidence } from "~/server/domains/email/repo/email-state";
import { setMemberLoginParty } from "~/server/domains/ledger-party/repo/member-login";
import { decideEmailPurchase } from "~/server/domains/purchase-import/repo/email-purchase-decision";
import { emitEmailRunAssignment } from "~/server/domains/purchase-import/repo/mail-run-kernel";
import { syntheticRetainedMail } from "~/server/domains/purchase-import/service/gmail/retained-mail.fixtures";
import {
  mergePurchases,
  deletePurchases,
} from "~/server/domains/purchase/repo/purchase";
import {
  append,
  decide,
  evidenceRow,
  reconcileNow,
  recordSubject,
} from "~/server/kernel/api";

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
  /** Each scoped read returns exactly the household projection's rows for its scope. */
  async function expectScopedLinksMatch() {
    const q = getDb(ctx.db);
    const all = await q
      .select()
      .from(emailLinkDecisionsRead)
      .orderBy(asc(emailLinkDecisionsRead.id));
    expect(all.length).toBeGreaterThan(0);
    for (const row of all) {
      const owner = emailLinkDecisionsReadForDecision(sql`${row.id}`);
      expect(await q.select().from(owner).where(eq(owner.id, row.id))).toEqual([
        row,
      ]);
    }
    const slots = await q
      .select({ id: decision.id, subject: decision.subject })
      .from(decision)
      .where(like(decision.field, "link:%"));
    for (const subject of new Set(slots.map((slot) => slot.subject))) {
      if (!subject.startsWith("email:")) continue;
      const ids = new Set(
        slots.filter((slot) => slot.subject === subject).map(({ id }) => id),
      );
      const links = emailLinkDecisionsReadForEmail(
        sql`${subject.slice(6)}::uuid`,
      );
      expect(await q.select().from(links).orderBy(asc(links.id))).toEqual(
        all.filter((row) => ids.has(row.id)),
      );
    }
    const events = await q.select().from(orderMailEvent);
    for (const orderMailId of new Set(events.map((e) => e.orderMailId))) {
      const ids = new Set(
        events.filter((e) => e.orderMailId === orderMailId).map(({ id }) => id),
      );
      const links = emailLinkDecisionsReadForOrderMail(
        sql`${orderMailId}::uuid`,
      );
      expect(
        (await q.select().from(links).orderBy(asc(links.id))).filter(
          (row) => row.eventId && ids.has(row.eventId),
        ),
      ).toEqual(all.filter((row) => row.eventId && ids.has(row.eventId)));
    }
    // Merged-away ids project nothing; survivors carry their aliases' links.
    for (const { id } of await q.select({ id: purchase.id }).from(purchase)) {
      const scoped = await q.execute<{ id: string }>(
        sql`SELECT id FROM ${emailLinkDecisionsForPurchasesSql(sql`SELECT ${id}::uuid AS id`)} p ORDER BY id`,
      );
      expect(scoped.rows.map((row) => row.id)).toEqual(
        all.filter((row) => row.purchaseId === id).map((row) => row.id),
      );
    }
    const history = await q.execute<{
      id: string;
      active: boolean;
      status: string;
    }>(sql`SELECT id, active, status FROM ${emailLinkDecisionHistorySql} h`);
    expect(history.rows.length).toBeGreaterThan(0);
    for (const row of history.rows) {
      const receipt = emailLinkDecisionHistoryReadForDecision(sql`${row.id}`);
      expect(
        await q
          .select({
            id: receipt.id,
            active: receipt.active,
            status: receipt.status,
          })
          .from(receipt)
          .where(eq(receipt.id, row.id)),
      ).toEqual([row]);
    }
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
    await deletePurchases(
      ctx.db,
      [parseShortcodeFor("purchase", f.purchase.shortcode)],
      ctx.actor,
    );
    expect(
      (await getDb(ctx.db).select().from(emailLinkDecisionsRead))[0],
    ).toMatchObject({ active: false });
    const replacement = await insert(ctx.db, "purchase", {
      vendorId: f.vendor.id,
      orderId: "SYNTHETIC-REPLACEMENT",
    });
    await decideEmailPurchase(
      ctx.db,
      {
        ...command(f, "linked"),
        purchaseId: parseShortcodeFor("purchase", replacement.shortcode),
      },
      ctx.actor,
    );
    expect(await facts(f.mail.id)).toMatchObject({
      linked: true,
      purchaseLinks: [{ purchaseId: replacement.shortcode, state: "linked" }],
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
    const survivor = await insert(ctx.db, "purchase", {
      vendorId: f.vendor.id,
    });
    await mergePurchases(
      ctx.db,
      {
        keepId: parseShortcodeFor("purchase", survivor.shortcode),
        mergeIds: [parseShortcodeFor("purchase", f.purchase.shortcode)],
      },
      ctx.actor,
    );
    expect(
      (await getDb(ctx.db).select().from(emailLinkDecisionsRead))[0],
    ).toMatchObject({
      purchaseId: survivor.id,
      decision: "dismissed",
      active: true,
    });
    await expectScopedLinksMatch();
    const survivorCommand = {
      ...command(f, "linked"),
      purchaseId: parseShortcodeFor("purchase", survivor.shortcode),
    };
    await decideEmailPurchase(ctx.db, survivorCommand, ctx.actor);
    expect(await facts(f.mail.id)).toMatchObject({
      linked: true,
      linkState: "linked",
    });
    await decideEmailPurchase(
      ctx.db,
      { ...survivorCommand, decision: "dismissed" },
      ctx.actor,
    );
    expect(await facts(f.mail.id)).toMatchObject({
      linked: false,
      linkState: "dismissed",
    });
  });
  it("keeps a dismissal on its event when another Email now holds the original, alone or batched", async () => {
    const f = await fixture();
    const dismissal = await publishEmailLinkDecision(ctx.db, {
      eventId: f.event.id.toUpperCase(),
      purchaseId: f.purchase.id,
      decision: "dismissed",
      evidenceChecksum: f.checksum,
      decidedByUserId: ctx.actor.userId,
      proposedBy: null,
    });
    const [stored] = await getDb(ctx.db)
      .select({ value: decision.value })
      .from(decision)
      .where(eq(decision.id, dismissal.id));
    expect(stored?.value).toMatchObject({ eventId: f.event.id });
    const other = await syntheticRetainedMail(ctx.db, {
      ledgerPartyId: f.party.id,
      vendorId: f.vendor.id,
      mailboxId: "synthetic-mailbox",
      messageId: "synthetic-holder-message",
      threadId: "synthetic-holder-thread",
      sender: "orders@example.test",
      subject: "Synthetic order copy",
      receivedAt: new Date("2026-10-01T12:00:00Z"),
      rawChecksum: "d".repeat(64),
      content: { bodyText: "Synthetic copy", bodyHtml: null, snippet: null },
    });
    const [holder] = await getDb(ctx.db)
      .select()
      .from(email)
      .where(eq(email.orderMailId, other.id));
    await getDb(ctx.db)
      .update(email)
      .set({ orderMailId: null })
      .where(eq(email.id, f.mail.id));
    await getDb(ctx.db)
      .update(email)
      .set({ orderMailId: f.original.id })
      .where(eq(email.id, holder!.id));
    for (const keys of [[holder!.id], [f.mail.id, holder!.id]]) {
      await reconcileNow(
        ctx.db,
        keys.map((key) => ({ kind: "emailState", key })),
      );
      const [row] = await getDb(ctx.db)
        .select()
        .from(emailReadSnapshot)
        .where(eq(emailReadSnapshot.entityId, holder!.id));
      expect(
        emailRelationshipResult.parse(row?.relationshipFacts).purchaseLinks,
      ).toEqual([]);
    }
    await expectScopedLinksMatch();
  });
  it("dirties only the Email whose own inputs changed", async () => {
    const f = await fixture();
    const other = await syntheticRetainedMail(ctx.db, {
      ledgerPartyId: f.party.id,
      vendorId: f.vendor.id,
      mailboxId: "synthetic-mailbox",
      messageId: "synthetic-second-message",
      threadId: "synthetic-second-thread",
      sender: "orders@example.test",
      subject: "Synthetic second order",
      receivedAt: new Date("2026-10-02T12:00:00Z"),
      rawChecksum: "d".repeat(64),
      content: { bodyText: "Synthetic second", bodyHtml: null, snippet: null },
    });
    const [second] = await getDb(ctx.db)
      .select()
      .from(email)
      .where(eq(email.orderMailId, other.id));
    if (!second) throw new Error("Missing second synthetic Email");
    const keys: string[] = [f.mail.id, second.id];
    const dirty = async () =>
      (
        await getDb(ctx.db)
          .select({ key: scopeDirty.scopeKey })
          .from(scopeDirty)
          .where(eq(scopeDirty.scopeKind, "emailState"))
      )
        .map((row) => row.key)
        .filter((key) => keys.includes(key));
    await reconcileNow(
      ctx.db,
      keys.map((key) => ({ kind: "emailState", key })),
    );
    expect(await dirty()).toEqual([]);
    await append(ctx.db, [
      evidenceRow(emailPredictionEvidence, {
        emailId: second.id,
        checksum: second.checksum,
        classification: "unrelated",
        stage: "rule",
        reason: "Synthetic newsletter",
        classificationVersion: "synthetic-v2",
        application: "applied",
      }),
    ]);
    expect(await dirty()).toEqual([second.id]);
    await reconcileNow(ctx.db, [{ kind: "emailState", key: second.id }]);
    const [published] = await getDb(ctx.db)
      .select({ classification: email.classification })
      .from(email)
      .where(eq(email.id, second.id));
    expect(published?.classification).toBe("unrelated");
    expect(await dirty()).toEqual([]);

    // Another Email's link decision on this Email's order event changes the
    // suggestions this Email respects.
    await decide(ctx.db, ctx.actor, [
      {
        channel: "assignment",
        kind: "set",
        subject: recordSubject("email", second.id),
        field: `link:${f.purchase.id}`,
        value: { decision: "dismissed", eventId: f.event.id },
      },
    ]);
    expect((await dirty()).sort()).toEqual([f.mail.id, second.id].sort());
    await reconcileNow(
      ctx.db,
      keys.map((key) => ({ kind: "emailState", key })),
    );
    // A Run assignment changes the Run an import outcome reads.
    await emitEmailRunAssignment(ctx.db, [f.mail.id]);
    expect(await dirty()).toEqual([f.mail.id]);
    await reconcileNow(ctx.db, [{ kind: "emailState", key: f.mail.id }]);
    // Unlinking the owner's login changes who owns the Email.
    await setMemberLoginParty(ctx.db, ctx.actor.userId, null, ctx.actor);
    expect((await dirty()).sort()).toEqual([f.mail.id, second.id].sort());
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
    expect(
      (
        await publishEmailLinkDecision(ctx.db, {
          ...input,
          eventId: input.eventId.toUpperCase(),
        })
      ).id,
    ).toBe(first.id);
    expect(await getDb(ctx.db).select().from(decision)).toEqual(before);
    expect(
      await getDb(ctx.db).select().from(emailLinkDecisionsRead),
    ).toHaveLength(1);
    const second = await insert(ctx.db, "purchase", {
      vendorId: f.vendor.id,
      orderId: "SYNTHETIC-SECOND",
    });
    const [event] = await getDb(ctx.db)
      .insert(orderMailEvent)
      .values({
        orderMailId: f.original.id,
        event: "placed",
        orderId: "SYNTHETIC-SECOND",
        sourceKey: "synthetic-second-event",
      })
      .returning();
    await publishEmailLinkDecision(ctx.db, {
      ...input,
      eventId: event!.id,
      purchaseId: second.id,
    });
    const links = await getDb(ctx.db).select().from(emailLinkDecisionsRead);
    expect(
      links
        .filter((row) => row.active)
        .map((row) => row.purchaseId)
        .sort(),
    ).toEqual([f.purchase.id, second.id].sort());
    // The Decision writer stores uuid subjects and link fields canonically.
    const [ref] = await decide(ctx.db, ctx.actor, [
      {
        channel: "assignment",
        kind: "set",
        subject: `email:${f.mail.id.toUpperCase()}`,
        field: `link:${second.id.toUpperCase()}`,
        value: { ...input, eventId: event!.id, purchaseId: second.id },
      },
    ]);
    expect(
      await getDb(ctx.db)
        .select({ subject: decision.subject, field: decision.field })
        .from(decision)
        .where(eq(decision.id, ref!.id)),
    ).toEqual([{ subject: `email:${f.mail.id}`, field: `link:${second.id}` }]);
    await expectScopedLinksMatch();
    await getDb(ctx.db)
      .update(email)
      .set({ deletedAt: new Date() })
      .where(eq(email.id, f.mail.id));
    const detached = await getDb(ctx.db).select().from(emailLinkDecisionsRead);
    expect(detached).toHaveLength(2);
    expect(detached.every((row) => !row.active && row.emailId === null)).toBe(
      true,
    );
    await expectScopedLinksMatch();
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
