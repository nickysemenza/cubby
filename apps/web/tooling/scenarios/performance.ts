import { randomUUID, createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { generateShortcode, type ShortcodeType } from "@cubby/shared";
import { parseEntityId } from "@cubby/schemas/identifiers";
import type { SearchableEntity } from "@cubby/schemas/search";
import type { UserId } from "@cubby/schemas/identifiers";
import { mailResearchRunInput } from "@cubby/schemas/run-fields";
import type { Database } from "~/server/db";
import {
  getDb,
  withTransaction,
  databaseForTransaction,
} from "~/server/db/helpers";
import {
  ledgerParty,
  orderMail,
  product,
  inventoryEntry,
  purchase,
  expense,
  vendor,
  location,
  entityLink,
  entityIdentity,
  run,
  email,
} from "~/server/db/schema";
import { writeOutcomeReceipts } from "~/server/domains/purchase-import/service/run-outcome.fixtures";
import {
  logAuditEntries,
  type AuditEntryInput,
} from "~/server/generic/audit-log/repo/audit-log";
import { refreshSearchDocuments } from "~/server/generic/search/repo/search-document";
import { linkValues } from "~/server/generic/entity-links/repo/entity-links";
import { buildKernelContext } from "./context";

async function batches<T, Result>(
  rows: T[],
  write: (batch: T[]) => PromiseLike<Result>,
) {
  for (let offset = 0; offset < rows.length; offset += 500)
    await write(rows.slice(offset, offset + 500));
}

const optionsSchema = z.object({
  bundles: z.number().int().min(1).max(1000).default(1000),
});

/** Optional local pack: one household's repeated purchase/research history.
 * Call only through the guarded dev pack runner or an isolated test lease.
 * This never dispatches providers and never copies production records.
 */
export async function seedPerformanceCorpus(
  db: Database,
  userId: UserId,
  options: z.input<typeof optionsSchema> = {},
) {
  const { bundles } = optionsSchema.parse(options);
  const context = buildKernelContext(db, userId);
  const [member] = await getDb(db)
    .select()
    .from(ledgerParty)
    .where(eq(ledgerParty.userId, userId))
    .limit(1);
  if (!member) throw new Error("Seed the synthetic household member first");
  // Volume fixtures materialize a known graph, rather than replaying interactive
  // commands. Keep identity constraints, audit and search projections intact.
  const usedCodes = new Set(
    (
      await getDb(db)
        .select({ code: entityIdentity.shortcode })
        .from(entityIdentity)
    ).map((row) => row.code),
  );
  function identity<K extends ShortcodeType>(kind: K) {
    let shortcode = generateShortcode(kind);
    while (usedCodes.has(shortcode)) shortcode = generateShortcode(kind);
    usedCodes.add(shortcode);
    return { id: parseEntityId(kind, randomUUID()), shortcode };
  }
  const audits: AuditEntryInput[] = [];
  const refs: { entityKind: SearchableEntity; entityId: string }[] = [];
  function created(kind: SearchableEntity, id: string) {
    audits.push({ entityKind: kind, entityId: id, action: "create" });
    refs.push({ entityKind: kind, entityId: id });
  }
  const supplier = {
    ...identity("vendor"),
    name: "Synthetic performance supplier",
  };
  const shelf = {
    ...identity("location"),
    name: "Synthetic performance shelf",
    type: "room" as const,
  };
  created("vendor", supplier.id);
  created("location", shelf.id);
  const products: (typeof product.$inferInsert)[] = [];
  const inventory: (typeof inventoryEntry.$inferInsert)[] = [];
  const purchases: (typeof purchase.$inferInsert)[] = [];
  const expenses: (typeof expense.$inferInsert)[] = [];
  const links: (typeof entityLink.$inferInsert)[] = [];
  const mails: (typeof orderMail.$inferInsert)[] = [];
  const runs: (typeof run.$inferInsert)[] = [];
  const emails: (typeof email.$inferInsert)[] = [];
  const receipts: Parameters<typeof writeOutcomeReceipts>[1][number][] = [];
  for (let bundle = 0; bundle < bundles; bundle++) {
    const label = `Synthetic performance ${String(bundle + 1).padStart(4, "0")}`;
    const bundleProducts = [];
    for (const [index, role] of [
      "kit",
      "inner kit",
      "part",
      "priced sibling",
      "sold item",
      "unpriced stock",
    ].entries()) {
      const row = {
        ...identity("product"),
        name: `${label} ${role}`,
        manufacturer: "Synthetic Works",
        price: index === 3 ? 5 : null,
        expectedQuantity: null,
        model: null,
      };
      products.push(row);
      bundleProducts.push(row);
      created("product", row.id);
    }
    const [kit, inner, part, sibling, sold, unpriced] = bundleProducts;
    if (!kit || !inner || !part || !sibling || !sold || !unpriced)
      throw new Error("Incomplete performance kit");
    links.push(
      linkValues("productComponent", kit.id, inner.id, 2),
      linkValues("productComponent", kit.id, sibling.id, 1),
      linkValues("productComponent", inner.id, part.id, 4),
    );
    audits.push(
      {
        entityKind: "product",
        entityId: kit.id,
        action: "update",
        changes: {
          componentProductIds: {
            from: [],
            to: [inner.shortcode, sibling.shortcode],
          },
        },
      },
      {
        entityKind: "product",
        entityId: inner.id,
        action: "update",
        changes: { componentProductIds: { from: [], to: [part.shortcode] } },
      },
    );
    for (const item of [part, unpriced]) {
      const row = {
        ...identity("inventory"),
        productId: item.id,
        locationId: shelf.id,
        amountValue: 1,
        amountUnit: "each",
      };
      inventory.push(row);
      created("inventory", row.id);
    }
    const order = {
      ...identity("purchase"),
      vendorId: supplier.id,
      orderId: `SYNTHETIC-PERF-${bundle + 1}`,
      date: "2026-01-15",
      statedTotal: 120,
    };
    purchases.push(order);
    created("purchase", order.id);
    // Nested inherited price, signed exits, refunds, and future work all take
    // different ledger branches; the unpriced stocked SKU has no acquisition.
    for (let line = 0; line < 12; line++) {
      const row = {
        ...identity("expense"),
        name: `${label} line ${line + 1}`,
        purchaseId: order.id,
        productId:
          line === 0 ? kit.id : line === 1 || line === 2 ? sold.id : sibling.id,
        productQuantity: line === 2 ? -3 : 1,
        cost: line === 2 ? -10 : 10,
        date: "2026-01-15",
        future: line === 11,
        trade: "other" as const,
        costType: "materials" as const,
        lineKind: "principal" as const,
      };
      expenses.push(row);
      created("expense", row.id);
    }
    for (let message = 0; message < 8; message++) {
      const bodyText = `${label} invented receipt ${message + 1}. Order SYNTHETIC-PERF-${bundle + 1}. Total 120 USD.`;
      const checksum = createHash("sha256").update(bodyText).digest("hex");
      const mail = {
        id: randomUUID(),
        ledgerPartyId: member.id,
        vendorId: supplier.id,
        rawChecksum: checksum,
        content: { bodyText, bodyHtml: null, snippet: bodyText },
      };
      mails.push(mail);
      const historical = message < 5;
      const historicalRun = historical
        ? ({
            ...identity("run"),
            purpose: "mail_import",
            trigger: "manual",
            status: "completed",
            ledgerPartyId: member.id,
            actorUserId: userId,
            actorName: member.name,
            actorEmail: "member@example.test",
            actorLedgerPartyShortcode: member.shortcode,
            actorLedgerPartyName: member.name,
            actorLedgerPartyKind: "member",
            input: mailResearchRunInput.parse({
              kind: "mail_research",
              sources: [{ orderMailId: mail.id, checksum }],
            }),
            startedAt: new Date("2026-01-15T12:00:00Z"),
            endedAt: new Date("2026-01-15T12:01:00Z"),
          } satisfies typeof run.$inferInsert)
        : null;
      if (historicalRun) runs.push(historicalRun);
      const messageRow = {
        ...identity("email"),
        ledgerPartyId: member.id,
        orderMailId: mail.id,
        runId: historicalRun?.id ?? null,
        mailboxId: "synthetic-performance-mailbox",
        messageId: `synthetic-performance-${bundle}-${message}`,
        sender: "Synthetic supplier <orders@example.test>",
        subject: `${label} receipt ${message + 1}`,
        receivedAt: new Date("2026-01-15T12:00:00Z"),
        checksum,
        classification: historical ? "related" : "uncertain",
        classificationStage: "rule",
        classificationVersion: "synthetic-performance/v1",
        status: historical ? "completed" : "blocked",
      } satisfies typeof email.$inferInsert;
      emails.push(messageRow);
      if (historicalRun)
        receipts.push({
          runId: historicalRun.id,
          entityKind: "email",
          entityId: messageRow.id,
          workKey: mail.id,
          targetFingerprint: checksum,
          state: "completed",
          outcome: "verified",
          completedAt: new Date("2026-01-15T12:01:00Z"),
          diff: {},
        });
    }
  }
  await withTransaction(db, async (tx) => {
    await tx.insert(vendor).values(supplier);
    await tx.insert(location).values(shelf);
    await batches(products, (rows) => tx.insert(product).values(rows));
    await batches(links, (rows) => tx.insert(entityLink).values(rows));
    await batches(inventory, (rows) => tx.insert(inventoryEntry).values(rows));
    await batches(purchases, (rows) => tx.insert(purchase).values(rows));
    await batches(expenses, (rows) => tx.insert(expense).values(rows));
    await batches(mails, (rows) => tx.insert(orderMail).values(rows));
    await batches(runs, (rows) => tx.insert(run).values(rows));
    await batches(emails, (rows) => tx.insert(email).values(rows));
    await batches(receipts, (rows) =>
      writeOutcomeReceipts(databaseForTransaction(tx), rows),
    );
    await batches(audits, (rows) =>
      logAuditEntries(tx, context.actorContext, rows),
    );
    // Immediate reads must see the new volume, rather than waiting for autoanalyze.
    await tx.execute(
      sql`ANALYZE ${product}, ${entityLink}, ${inventoryEntry}, ${purchase}, ${expense}, ${orderMail}, ${run}, ${email}, ${entityIdentity}`,
    );
    await batches(refs, (rows) => refreshSearchDocuments(tx, rows));
  });
}
