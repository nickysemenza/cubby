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
  createProductFixture,
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
  const item = await createProductFixture(
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
  const codes = new Set<string>();
  while (codes.size < 5000) codes.add(generateShortcode("email"));
  const rows = await db
    .insert(email)
    .values(
      [...codes].map((shortcode, i) => ({
        shortcode,
        ledgerPartyId: party.id,
        mailboxId: "synthetic-benchmark",
        messageId: `message-${i}`,
        checksum: "synthetic-checksum",
        subject: "Synthetic receipt",
        status: "completed",
      })),
    )
    .returning({ id: email.id });
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
  const other = await insertWithShortcode(ctx.db, "purchase", {
    vendorId: vendor.id,
    displayLabel: "Synthetic other purchase",
  });
  const claims = await db
    .insert(importSourceClaim)
    .values(
      [...codes].map((_, i) => ({
        ledgerPartyId: party.id,
        kind: "mail_message",
        externalKey: `gmail:synthetic-benchmark:message-${i}`,
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
}, 60000);
