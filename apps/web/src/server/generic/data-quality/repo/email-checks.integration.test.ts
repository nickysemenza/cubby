import { parseEntityId } from "@cubby/schemas/identifiers";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { orderMail, orderMailAttachment } from "~/server/db/schema";
import { listEmailsRead } from "~/server/domains/email/repo/email";
import { resolveMail } from "~/server/domains/purchase-import/mail-tool";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { loadDataQualities } from "./hydrate";

// Email pipeline gaps are Relevance-conditional, and their correlated SQL must
// stay bound to the scored Email: another Email's attachment or completed
// import Run must never satisfy this Email's check.
// A reviewed link to an existing Purchase must not demand another extraction.
describe("Email data quality", () => {
  const ctx = withTestDb();

  it("settles automated negatives and keeps related checks bound to their own original and import", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic quality member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const shell = async (bodyText: string | null) =>
      (
        await getDb(ctx.db)
          .insert(orderMail)
          .values({
            ledgerPartyId: party.id,
            rawChecksum: "c".repeat(64),
            content: { snippet: null, bodyText, bodyHtml: null },
          })
          .returning()
      )[0]!;
    const email = (
      messageId: string,
      fields: Partial<
        Parameters<typeof insertWithShortcode<"email">>[2] & object
      >,
    ) =>
      insertWithShortcode(ctx.db, "email", {
        ledgerPartyId: party.id,
        provider: "gmail",
        mailboxId: "synthetic-quality-mailbox",
        messageId,
        checksum: "c".repeat(64),
        classification: "related",
        classificationStage: "decision",
        status: "pending",
        ...fields,
      });
    const other = await shell(null);
    await getDb(ctx.db)
      .insert(orderMailAttachment)
      .values({
        orderMailId: other.id,
        providerAttachmentId: "synthetic-other-attachment",
        filename: "other.pdf",
        mimeType: "application/pdf",
        checksum: "d".repeat(64),
        pendingObjectKey: "synthetic/other.pdf",
      });
    await insertWithShortcode(ctx.db, "run", {
      ledgerPartyId: party.id,
      actorUserId: ctx.actor.userId,
      actorName: "Synthetic member",
      actorEmail: "member@example.test",
      actorLedgerPartyShortcode: party.shortcode,
      actorLedgerPartyName: party.name,
      actorLedgerPartyKind: party.kind,
      purpose: "mail_import",
      trigger: "manual",
      status: "completed",
      input: {
        kind: "mail_research",
        sources: [{ orderMailId: other.id, checksum: "c".repeat(64) }],
      },
    });
    const unrelated = await email("synthetic-unrelated", {
      classification: "unrelated",
      status: "completed",
    });
    const emptyShell = await shell(null);
    const related = await email("synthetic-related", {
      orderMailId: emptyShell.id,
    });
    const retained = await email("synthetic-retained", {
      orderMailId: (await shell("Synthetic order body")).id,
    });
    const linked = await email("synthetic-linked", {
      orderMailId: (await shell("Synthetic existing-order confirmation")).id,
      classificationStage: "resolution",
      status: "completed",
    });
    const seller = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic existing-order vendor",
    });
    const order = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: seller.id,
      orderId: "synthetic-existing-order",
    });
    await resolveMail(
      ctx.db,
      {
        mailboxId: linked.mailboxId,
        messageId: linked.messageId,
        checksum: linked.checksum,
        disposition: {
          kind: "linked",
          event: "confirmation",
          purchaseIds: [order.shortcode],
        },
      },
      ctx.actor,
    );

    const id = (row: { id: string }) => parseEntityId("email", row.id);
    const qualities = await loadDataQualities(ctx.db, "email", [
      id(unrelated),
      id(related),
      id(retained),
      id(linked),
    ]);
    const gaps = (row: { id: string }) =>
      qualities
        .get(id(row))
        ?.gaps.map((gap) => gap.check)
        .sort();
    expect(gaps(unrelated)).toEqual([]);
    expect(gaps(related)).toEqual([
      "email_not_imported",
      "email_original_missing",
      "email_preview_missing",
      "email_relevance_unreviewed",
    ]);
    expect(gaps(retained)).toEqual([
      "email_not_imported",
      "email_preview_missing",
      "email_relevance_unreviewed",
    ]);
    expect(gaps(linked)).toEqual([]);

    const reviewQueue = await listEmailsRead(
      ctx.db,
      { dataGap: ["email_relevance_unreviewed"] },
      [],
      { pageIndex: 0, pageSize: 10 },
    );
    expect(reviewQueue.data.map((row) => row.id)).not.toContain(
      unrelated.shortcode,
    );

    const missingOriginal = await listEmailsRead(
      ctx.db,
      { dataGap: ["email_original_missing"] },
      [],
      { pageIndex: 0, pageSize: 10 },
    );
    expect(missingOriginal.data.map((row) => row.id)).toEqual([
      related.shortcode,
    ]);
  });
});
