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
  vendorAccount,
  financialAccount,
  financialTransaction,
  financialTransactionAllocation,
  importSourceClaim,
  importSourceOrder,
  spendingCategory,
  productCategory,
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
  const bodyBytes = 32768;
  // Distinct blocks keep the raw profile out of line. Repeated prose models
  // compression too; both reuse bounded padding instead of per-record entropy.
  const hashBlocks = Array.from(
    { length: Math.ceil(bodyBytes / 64) },
    (_, index) =>
      createHash("sha256")
        .update(`Synthetic content block ${index}`)
        .digest("hex"),
  );
  const rawPadding = hashBlocks.join("").slice(0, bodyBytes);
  const prosePadding = hashBlocks
    .map(
      (hash) =>
        `Synthetic supplier delivery information. This paragraph is invented for local performance fixtures. Reference ${hash}. Synthetic terms and packaging details follow.\n`,
    )
    .join("")
    .slice(0, bodyBytes);
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
  // Settlement, routing and import-claim predicates read accounts, tenders,
  // allocations and accepted source orders; one supplier without them leaves
  // those correlated paths unexercised at volume.
  const suppliers = [0, 1, 2, 3].map((index) => ({
    ...identity("vendor"),
    name:
      index === 0
        ? "Synthetic performance supplier"
        : `Synthetic performance supplier ${index + 1}`,
  }));
  const supplier = suppliers[0]!;
  const sourceAccounts = suppliers.map((row) => ({
    ...identity("vendorAccount"),
    vendorId: row.id,
    ledgerPartyId: member.id,
  }));
  const tenders = [0, 1].map((index) => ({
    ...identity("financialAccount"),
    name: `Synthetic performance tender ${index + 1}`,
    identity: { kind: "cash" as const },
    ledgerPartyId: member.id,
  }));
  const spending = {
    ...identity("spendingCategory"),
    name: "Synthetic performance supplies",
  };
  const parentCategory = {
    ...identity("productCategory"),
    name: "Synthetic performance goods",
    spendingCategoryMode: "mapped" as const,
    spendingCategoryId: spending.id,
  };
  const childCategory = {
    ...identity("productCategory"),
    name: "Synthetic performance parts",
    parentId: parentCategory.id,
  };
  const shelf = {
    ...identity("location"),
    name: "Synthetic performance shelf",
    type: "room" as const,
  };
  for (const row of suppliers) created("vendor", row.id);
  for (const row of tenders) created("financialAccount", row.id);
  // Not searchable: audit history only.
  for (const [entityKind, entityId] of [
    ...sourceAccounts.map((row) => ["vendorAccount", row.id] as const),
    ["spendingCategory", spending.id] as const,
    ["productCategory", parentCategory.id] as const,
    ["productCategory", childCategory.id] as const,
  ])
    audits.push({ entityKind, entityId, action: "create" });
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
  const transactions: (typeof financialTransaction.$inferInsert)[] = [];
  const allocations: (typeof financialTransactionAllocation.$inferInsert)[] =
    [];
  const claims: (typeof importSourceClaim.$inferInsert)[] = [];
  const sourceOrders: (typeof importSourceOrder.$inferInsert)[] = [];
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
        categoryId: index >= 3 ? childCategory.id : null,
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
    // A fifth of orders have no source account and route through their Run.
    const accountIndex = bundle % 4;
    const sourceAccount =
      bundle % 5 === 0 ? null : sourceAccounts[accountIndex]!;
    const order = {
      ...identity("purchase"),
      vendorId: suppliers[accountIndex]!.id,
      vendorAccountId: sourceAccount?.id ?? null,
      orderId: `SYNTHETIC-PERF-${bundle + 1}`,
      date: "2026-01-15",
      statedTotal: 120,
      spendingCategoryId: bundle % 3 === 0 ? spending.id : null,
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
    // Incurred lines total 90: settled, mismatched, pending, split and
    // unsettled orders each take a different settlement branch.
    const tenderId = tenders[bundle % 2]!.id;
    const settlement = {
      0: [],
      1: [{ status: "posted", amount: 90 }],
      2: [{ status: "posted", amount: 85 }],
      3: [{ status: "pending", amount: 90 }],
      4: [
        { status: "posted", amount: 45 },
        { status: "posted", amount: 45 },
      ],
    }[(bundle % 5) as 0 | 1 | 2 | 3 | 4];
    for (const charge of settlement) {
      const row = {
        ...identity("financialTransaction"),
        accountId: tenderId,
        kind: "purchase",
        status: charge.status,
        amount: charge.amount,
        transactionDate: "2026-01-16",
        postedDate: charge.status === "posted" ? "2026-01-17" : null,
        merchant: `${label} supplier charge`,
      };
      transactions.push(row);
      created("financialTransaction", row.id);
      allocations.push({
        transactionId: row.id,
        purchaseId: order.id,
        amount: charge.amount,
      });
    }
    for (let message = 0; message < 8; message++) {
      const snippet = `${label} invented receipt ${message + 1}. Order SYNTHETIC-PERF-${bundle + 1}. Total 120 USD.`;
      const body = `${snippet}\n${message % 4 === 0 ? rawPadding : prosePadding}`;
      const original =
        message % 4 === 0
          ? { snippet, bodyText: body, bodyHtml: null }
          : message % 4 === 2
            ? {
                snippet: " ",
                bodyText: null,
                bodyHtml: `<article><p>${body.replaceAll("\n", "</p><p>")}</p></article>`,
              }
            : { snippet: null, bodyText: body, bodyHtml: null };
      const checksum = createHash("sha256")
        .update(
          JSON.stringify([
            original.snippet,
            original.bodyText,
            original.bodyHtml,
          ]),
        )
        .digest("hex");
      const cleared = message % 4 === 3;
      const content = cleared
        ? { snippet: null, bodyText: null, bodyHtml: null }
        : original;
      const mail = {
        id: randomUUID(),
        ledgerPartyId: member.id,
        vendorId: supplier.id,
        rawChecksum: checksum,
        content,
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
        contentClearedAt: cleared ? new Date("2026-01-16T12:00:00Z") : null,
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
    const firstRun = runs.at(-5);
    if (!firstRun?.id) throw new Error("Incomplete performance mail history");
    const firstRunId = firstRun.id;
    if (!sourceAccount) Object.assign(order, { runId: firstRunId });
    if (bundle % 2 === 0) {
      const claim = {
        id: randomUUID(),
        ledgerPartyId: member.id,
        vendorAccountId: sourceAccount?.id ?? null,
        kind: "mail_message",
        externalKey: `synthetic-performance-claim-${bundle}`,
        checksum: `synthetic-performance-claim-${bundle}`,
        firstRunId,
        lastRunId: firstRunId,
      };
      claims.push(claim);
      sourceOrders.push({
        sourceClaimId: claim.id,
        orderKey: `synthetic-performance/order/${bundle}`,
        purchaseId: order.id,
        checksum: `synthetic-performance-order-${bundle}`,
        outputFingerprint: `synthetic-performance-output-${bundle}`,
      });
    }
    // Failed history keeps the Run attention branch populated at volume.
    runs.push({
      ...identity("run"),
      purpose: "mail_import",
      trigger: "manual",
      status: "failed",
      ledgerPartyId: member.id,
      vendorAccountId: sourceAccount?.id ?? null,
      actorUserId: userId,
      actorName: member.name,
      actorEmail: "member@example.test",
      actorLedgerPartyShortcode: member.shortcode,
      actorLedgerPartyName: member.name,
      actorLedgerPartyKind: "member",
      input: firstRun.input,
      startedAt: new Date("2026-01-16T12:00:00Z"),
      endedAt: new Date("2026-01-16T12:01:00Z"),
    });
  }
  await withTransaction(db, async (tx) => {
    await tx.insert(vendor).values(suppliers);
    await tx.insert(vendorAccount).values(sourceAccounts);
    await tx.insert(financialAccount).values(tenders);
    await tx.insert(spendingCategory).values(spending);
    await tx.insert(productCategory).values(parentCategory);
    await tx.insert(productCategory).values(childCategory);
    await tx.insert(location).values(shelf);
    await batches(products, (rows) => tx.insert(product).values(rows));
    await batches(links, (rows) => tx.insert(entityLink).values(rows));
    await batches(inventory, (rows) => tx.insert(inventoryEntry).values(rows));
    // Run-routed Purchases reference their Run.
    await batches(runs, (rows) => tx.insert(run).values(rows));
    await batches(purchases, (rows) => tx.insert(purchase).values(rows));
    await batches(expenses, (rows) => tx.insert(expense).values(rows));
    await batches(mails, (rows) => tx.insert(orderMail).values(rows));
    await batches(emails, (rows) => tx.insert(email).values(rows));
    await batches(transactions, (rows) =>
      tx.insert(financialTransaction).values(rows),
    );
    await batches(allocations, (rows) =>
      tx.insert(financialTransactionAllocation).values(rows),
    );
    await batches(claims, (rows) => tx.insert(importSourceClaim).values(rows));
    await batches(sourceOrders, (rows) =>
      tx.insert(importSourceOrder).values(rows),
    );
    await batches(receipts, (rows) =>
      writeOutcomeReceipts(databaseForTransaction(tx), rows),
    );
    await batches(audits, (rows) =>
      logAuditEntries(tx, context.actorContext, rows),
    );
    // Immediate reads must see the new volume, rather than waiting for autoanalyze.
    await tx.execute(
      sql`ANALYZE ${product}, ${entityLink}, ${inventoryEntry}, ${purchase}, ${expense}, ${orderMail}, ${run}, ${email}, ${entityIdentity}, ${financialTransaction}, ${financialTransactionAllocation}, ${importSourceClaim}, ${importSourceOrder}`,
    );
    await batches(refs, (rows) => refreshSearchDocuments(tx, rows));
  });
}
