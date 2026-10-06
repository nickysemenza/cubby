import type { ProductId, PurchaseId, RunId } from "@cubby/schemas/identifiers";
import { and, eq, ne } from "drizzle-orm";

import type { Database } from "~/server/db";
import {
  auditLog,
  expense,
  product,
  purchase,
  vendorAccount,
} from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";

import { productEnrichmentTarget } from "./product-enrichment-target";
import { startTargetedRun } from "./run-service";
import { dispatchStartedRun } from "./targeted-run";

/**
 * After a mail import commits, start one `product_enrichment` run for the
 * Products that import created, each starting at the product page the email
 * linked. Browser commands need a browsing account, so a mail-only account
 * (browser sync off or disabled) starts nothing; those Products wait until
 * the member turns sync on. An occupied account is skipped, not queued, the
 * same refusal a manual start gets.
 *
 * Runs after the import transaction; a crash between the commit and this call
 * leaves the Products unenriched until the next pass picks them up.
 */
export async function startPostImportEnrichment(
  db: Database,
  input: {
    parentRunId: RunId;
    purchaseId: PurchaseId;
    /** The import's validated lines; a line's `productUrl` is its start page. */
    lines: readonly { title: string; productUrl?: string }[];
  },
) {
  const database = getDb(db);
  const [owner] = await database
    .select({
      vendorId: purchase.vendorId,
      vendorAccountId: vendorAccount.id,
      ledgerPartyId: vendorAccount.ledgerPartyId,
    })
    .from(purchase)
    .innerJoin(
      vendorAccount,
      and(
        eq(vendorAccount.id, purchase.vendorAccountId),
        eq(vendorAccount.browserSyncEnabled, true),
        ne(vendorAccount.status, "disabled"),
        notDeleted(vendorAccount),
      ),
    )
    .where(and(eq(purchase.id, input.purchaseId), notDeleted(purchase)))
    .limit(1);
  if (!owner) return null;

  // Products this import created (its audit trail), by the line that named them.
  const createdRows = await database
    .selectDistinct({ productId: product.id, title: expense.name })
    .from(expense)
    .innerJoin(
      product,
      and(eq(product.id, expense.productId), notDeleted(product)),
    )
    .innerJoin(
      auditLog,
      and(
        eq(auditLog.entityId, product.id),
        eq(auditLog.entityKind, "product"),
        eq(auditLog.action, "create"),
        eq(auditLog.runId, input.parentRunId),
      ),
    )
    .where(and(eq(expense.purchaseId, input.purchaseId), notDeleted(expense)));
  // Only a title one line uses names one Product's page; a shared title is
  // skipped rather than guessed. A Product two lines name (one SKU, two
  // titles) is targeted once, and only when both lines agree on its page.
  const titleCount = new Map<string, number>();
  for (const line of input.lines)
    titleCount.set(line.title, (titleCount.get(line.title) ?? 0) + 1);
  const pageFor = new Map(
    input.lines.flatMap((line) =>
      line.productUrl && titleCount.get(line.title) === 1
        ? [[line.title, line.productUrl] as const]
        : [],
    ),
  );
  const pagesByProduct = new Map<ProductId, Set<string>>();
  for (const row of createdRows) {
    const page = pageFor.get(row.title);
    if (!page) continue;
    const pages = pagesByProduct.get(row.productId) ?? new Set<string>();
    pages.add(page);
    pagesByProduct.set(row.productId, pages);
  }
  const created = [...pagesByProduct].flatMap(([productId, pages]) =>
    pages.size === 1 ? [{ productId, startUrl: [...pages][0]! }] : [],
  );
  if (created.length === 0) return null;

  const targets = await Promise.all(
    created.map(async (row) => ({
      kind: "product" as const,
      productId: row.productId,
      vendorAccountId: owner.vendorAccountId,
      sourceExternalKey: row.startUrl,
      targetFingerprint:
        (await productEnrichmentTarget(database, row.productId))?.fingerprint ??
        "",
    })),
  );
  const started = await startTargetedRun(db, {
    ledgerPartyId: owner.ledgerPartyId,
    purpose: "product_enrichment",
    vendorId: owner.vendorId,
    vendorAccountId: owner.vendorAccountId,
    trigger: "discovery",
    input: { kind: "post_import_enrichment", parentRunId: input.parentRunId },
    targets,
  });
  if (!started.created || !started.run.dispatchEventId) return null;
  await dispatchStartedRun(db, {
    id: started.run.id,
    eventId: started.run.dispatchEventId,
    purpose: started.run.purpose,
  });
  return started.run;
}
