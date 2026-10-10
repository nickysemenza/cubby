import { sha256Hex } from "@cubby/shared/sha256";
import type { Page } from "@playwright/test";
import * as schema from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { getFixtureDb, ensureMemberParty } from "./fixtures-core";

/** A synthetic recognized email with one exact Purchase candidate. */
export async function seedVendorMailReviewPrerequisite(
  page: Page,
  name: string,
) {
  const db = getFixtureDb();
  const member = await ensureMemberParty(page, name);
  const vendor = await insertWithShortcode(db, "vendor", { name });
  const purchase = await insertWithShortcode(db, "purchase", {
    vendorId: vendor.id,
    orderId: "SYN-ORDER-1001",
    date: "2026-09-10",
    statedTotal: 48,
  });
  await insertWithShortcode(db, "purchase", {
    vendorId: vendor.id,
    orderId: "SYN-OTHER-2002",
    date: "2026-09-09",
    statedTotal: 19,
  });
  await insertWithShortcode(db, "purchase", {
    vendorId: vendor.id,
    orderId: "SYN-OTHER-3003",
    date: "2026-09-08",
    statedTotal: 48,
  });
  const bodyText =
    "Synthetic Outfitters. Order SYN-ORDER-1001. Printed total 48 USD.";
  const checksum = await sha256Hex(bodyText);
  const [mail] = await getDb(db)
    .insert(schema.orderMail)
    .values({
      ledgerPartyId: member.id,
      mailboxId: `synthetic-review-mailbox-${member.id}`,
      content: { bodyText, bodyHtml: null, snippet: null },
      vendorId: vendor.id,
      messageId: `synthetic-message-${crypto.randomUUID()}`,
      threadId: `synthetic-thread-${crypto.randomUUID()}`,
      sender: "Synthetic Outfitters <orders@example.test>",
      subject: "Synthetic order receipt",
      receivedAt: new Date("2026-09-10T15:00:00.000Z"),
      rawChecksum: checksum,
    })
    .returning();
  if (!mail) throw new Error("Synthetic mail was not saved");
  await getDb(db)
    .insert(schema.orderMailEvent)
    .values({
      orderMailId: mail.id,
      event: "placed",
      orderId: "SYN-ORDER-1001",
      amount: 48,
      currency: "USD",
      sourceKey: `classified:${checksum}:0`,
    });
  return { vendor, purchase, mail };
}

/** Saved originals with an actual body checksum and shared mailbox ledger. */
export async function seedUnimportedOrderMail(
  page: Page,
  name: string,
  count = 1,
) {
  const db = getFixtureDb();
  const member = await ensureMemberParty(page, name);
  const vendor = await insertWithShortcode(db, "vendor", { name });
  const itemTitle = `Synthetic herb packet from ${name}`;
  const events: Array<{
    eventId: string;
    orderMailId: typeof schema.orderMail.$inferSelect.id;
    checksum: string;
    orderId: string;
  }> = [];
  for (let index = 1; index <= count; index += 1) {
    const orderId = `SYN-CONFIRM-${index}`;
    const bodyText = `${name}. Order ${orderId}. ${itemTitle}, SKU HERB-1, qty 1, $5.00. Ordered 2026-09-10. Grand total $5.00 USD.`;
    const checksum = await sha256Hex(bodyText);
    const [mail] = await getDb(db)
      .insert(schema.orderMail)
      .values({
        ledgerPartyId: member.id,
        vendorId: vendor.id,
        mailboxId: `synthetic-mailbox-${member.id}`,
        messageId: `synthetic-confirmation-${crypto.randomUUID()}`,
        sender: "orders@example.test",
        subject:
          index === 1
            ? "Synthetic itemized confirmation"
            : `Synthetic itemized confirmation ${index}`,
        receivedAt: new Date("2026-09-10T15:00:00Z"),
        rawChecksum: checksum,
        content: { snippet: null, bodyHtml: null, bodyText },
      })
      .returning();
    if (!mail) throw new Error("Synthetic confirmation was not saved");
    await getDb(db).insert(schema.mailboxMessage).values({
      ledgerPartyId: member.id,
      mailboxId: mail.mailboxId,
      messageId: mail.messageId,
      checksum,
      classification: "related",
      classificationVersion: "synthetic-positive-source-v1",
      status: "pending",
      orderMailId: mail.id,
    });
    const [event] = await getDb(db)
      .insert(schema.orderMailEvent)
      .values({
        orderMailId: mail.id,
        event: "placed",
        orderId,
        amount: 5,
        currency: "USD",
        sourceKey: `synthetic:${mail.id}`,
      })
      .returning();
    if (!event) throw new Error("Synthetic event was not saved");
    events.push({ eventId: event.id, orderMailId: mail.id, checksum, orderId });
  }
  const [first] = events;
  if (!first) throw new Error("Synthetic confirmation was not seeded");
  return {
    vendor,
    member,
    itemTitle,
    eventId: first.eventId,
    checksum: first.checksum,
    events,
  };
}
