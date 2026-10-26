import { generateShortcode } from "@cubby/shared";
import { eq, sql } from "drizzle-orm";
import { seedEmailLinkDecision } from "tooling/shared-assessment-fixtures";
import { withTestDb } from "tooling/test-setup";
import { expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import {
  email,
  importSourceClaim,
  importSourceOrder,
  orderMail,
  orderMailEvent,
} from "~/server/db/schema";
import { attachPurchaseProducts } from "~/server/domains/purchase/repo/purchase-products";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { getConnectedRecords } from "~/server/generic/entity-links/repo/connected-records";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import {
  createProductIdentityFixture,
  insertEntityFixtures,
  makeProductInput,
} from "~/server/testing/repo.fixtures";
const ctx = withTestDb();
// Mailbox-wide policy evaluation took 24 seconds at this size; evidence must scope candidates first.
it("keeps purchase evidence bounded against a large unrelated mailbox", async () => {
  const db = getDb(ctx.db);
  const party = await insertWithShortcode(ctx.db, "ledgerParty", {
    name: "Synthetic owner",
    kind: "member",
  });
  const vendor = await insertWithShortcode(ctx.db, "vendor", {
    name: "Synthetic supplier",
  });
  const account = await insertWithShortcode(ctx.db, "vendorAccount", {
    vendorId: vendor.id,
    ledgerPartyId: party.id,
  });
  const item = await createProductIdentityFixture(
    ctx.db,
    makeProductInput({ name: "Synthetic tool" }),
    ctx.actor,
  );
  const purchases = [];
  for (let i = 0; i < 3; i++) {
    const p = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      displayLabel: `Synthetic ${i}`,
    });
    await attachPurchaseProducts(ctx.db, p.id, [item.entityId], ctx.actor);
    purchases.push(p);
  }
  const otherParty = await insertWithShortcode(ctx.db, "ledgerParty", {
    name: "Synthetic other member",
    kind: "member",
  });
  await insertWithShortcode(ctx.db, "vendorAccount", {
    vendorId: vendor.id,
    ledgerPartyId: otherParty.id,
  });
  const codes = new Set<string>();
  while (codes.size < 5000) codes.add(generateShortcode("email"));
  const rows = await insertEntityFixtures(
    ctx.db,
    email,
    "email",
    [...codes].map((shortcode, i) => ({
      shortcode,
      ledgerPartyId: party.id,
      mailboxId: "synthetic-benchmark",
      messageId: `message-${i}`,
      checksum: "synthetic-checksum",
      subject: "Synthetic receipt",
      status: "completed",
    })),
  );
  const [original] = await db
    .insert(orderMail)
    .values({ ledgerPartyId: party.id, rawChecksum: "synthetic-checksum" })
    .returning();
  if (!original || !rows[0] || !purchases[0])
    throw new Error("Synthetic setup missing");
  await db
    .update(email)
    .set({ orderMailId: original.id })
    .where(eq(email.id, rows[0].id));
  const [event] = await db
    .insert(orderMailEvent)
    .values({
      orderMailId: original.id,
      event: "shipment",
      sourceKey: "synthetic:benchmark",
    })
    .returning();
  if (!event) throw new Error("Missing event");
  await seedEmailLinkDecision(ctx.db, {
    eventId: event.id,
    purchaseId: purchases[0].id,
    decision: "linked",
    evidenceChecksum: "synthetic-checksum",
    decidedByUserId: ctx.actor.userId,
  });
  const admitted = await ensureRun(ctx.db, ctx.actor, {
    purpose: "ai_suggest",
  });
  const unrelatedVendor = await insertWithShortcode(ctx.db, "vendor", {
    name: "Synthetic unrelated supplier",
  });
  const other = await insertWithShortcode(ctx.db, "purchase", {
    vendorId: unrelatedVendor.id,
    displayLabel: "Synthetic other purchase",
  });
  const claims = await db
    .insert(importSourceClaim)
    .values(
      [...codes].slice(1).map((_, i) => ({
        ledgerPartyId: party.id,
        kind: "mail_message",
        externalKey: `gmail:synthetic-benchmark:message-${i + 1}`,
        checksum: "synthetic-checksum",
        firstRunId: admitted,
        lastRunId: admitted,
      })),
    )
    .returning({ id: importSourceClaim.id });
  await db.insert(importSourceOrder).values(
    claims.map((c, i) => ({
      sourceClaimId: c.id,
      orderKey: `synthetic-${i}`,
      purchaseId: other.id,
      checksum: "synthetic-checksum",
      outputFingerprint: "synthetic-output",
    })),
  );
  await db.execute(sql`ANALYZE "Email"`);
  await db.execute(sql`ANALYZE "ImportSourceClaim"`);
  await db.execute(sql`ANALYZE "ImportSourceOrder"`);
  const started = performance.now();
  const page = await getConnectedRecords(ctx.db, {
    source: { entityKind: "product", entityId: item.id },
    viewKey: "source-emails",
    limit: 3,
  });
  expect(page.totalCount).toBe(1);
  expect(page.items[0]?.target.label).toBe("Synthetic receipt");
  expect(performance.now() - started).toBeLessThan(5000);
  // Both Vendor routes and Email-rooted inverses must scope acceptance before
  // joining records, rather than evaluating it for every unrelated Email.
  for (const entityKind of ["vendor", "vendorAccount"] as const) {
    const root = entityKind === "vendor" ? vendor : account;
    const forwardStarted = performance.now();
    const forward = await getConnectedRecords(ctx.db, {
      source: { entityKind, entityId: root.shortcode },
      viewKey: "entity:email",
      limit: 3,
    });
    expect(forward.totalCount).toBe(1);
    expect(forward.items[0]?.target.label).toBe("Synthetic receipt");
    expect(performance.now() - forwardStarted).toBeLessThan(5000);
  }
  for (const entityKind of ["purchase", "vendor", "vendorAccount"] as const) {
    const inverseStarted = performance.now();
    const inverse = await getConnectedRecords(ctx.db, {
      source: { entityKind: "email", entityId: rows[0].shortcode },
      viewKey: `entity:${entityKind}`,
      limit: 3,
    });
    expect(inverse.totalCount).toBe(1);
    expect(performance.now() - inverseStarted).toBeLessThan(5000);
  }
}, 60000);

it("keeps sender evidence in both directions scoped to the observing member's account", async () => {
  const db = getDb(ctx.db);
  const vendor = await insertWithShortcode(ctx.db, "vendor", {
    name: "Synthetic sender",
  });
  const members = [];
  for (const suffix of ["First", "Second"]) {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: `Synthetic ${suffix}`,
      kind: "member",
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      vendorId: vendor.id,
      ledgerPartyId: party.id,
    });
    const [original] = await db
      .insert(orderMail)
      .values({
        ledgerPartyId: party.id,
        vendorId: vendor.id,
        rawChecksum: "synthetic-sender",
      })
      .returning();
    if (!original) throw new Error("Missing synthetic original");
    const [message] = await insertEntityFixtures(ctx.db, email, "email", [
      {
        shortcode: generateShortcode("email"),
        ledgerPartyId: party.id,
        orderMailId: original.id,
        mailboxId: "synthetic-sender",
        messageId: suffix,
        checksum: "synthetic-sender",
        status: "completed",
        subject: `Synthetic ${suffix}`,
      },
    ]);
    if (!message) throw new Error("Missing synthetic Email");
    members.push({ account, message });
  }
  const vendorEmails = await getConnectedRecords(ctx.db, {
    source: { entityKind: "vendor", entityId: vendor.shortcode },
    viewKey: "entity:email",
    limit: 10,
  });
  expect(vendorEmails.totalCount).toBe(2);
  for (const { account, message } of members) {
    const accountEmails = await getConnectedRecords(ctx.db, {
      source: { entityKind: "vendorAccount", entityId: account.shortcode },
      viewKey: "entity:email",
      limit: 10,
    });
    expect(accountEmails.items.map((item) => item.target.entityId)).toEqual([
      message.shortcode,
    ]);
    const accounts = await getConnectedRecords(ctx.db, {
      source: { entityKind: "email", entityId: message.shortcode },
      viewKey: "entity:vendorAccount",
      limit: 10,
    });
    expect(accounts.items.map((item) => item.target.entityId)).toEqual([
      account.shortcode,
    ]);
  }
});
