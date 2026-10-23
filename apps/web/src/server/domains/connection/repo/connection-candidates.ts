import type { EntityRef } from "@cubby/schemas/entity";
import type { ConnectionCandidate } from "@cubby/schemas/entity-connections";
import { manufacturerSource } from "@cubby/schemas/external-id";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { and, eq, isNull, sql } from "drizzle-orm";

import { isUnknownBrandName } from "~/lib/brand-name-utils";
import type { Database } from "~/server/db";
import { actualExpense } from "~/server/db/computed/expense-aggregate-sql";
import { productBrandNameSql } from "~/server/db/computed/product-brand-sql";
import { getDb, notDeleted } from "~/server/db/helpers";
import {
  entityLink,
  expense,
  product,
  purchase,
  financialTransaction,
} from "~/server/db/schema";
import { effectiveExpenseSpendingCategorySql } from "~/server/domains/expense/repo/expense-category-resolution";
import { suggestFinancialTransferPairs } from "~/server/domains/financial-transaction/repo/financial-transfer-pairing";
import { suggestProjectTools } from "~/server/domains/project/repo/tools";
import { expenseAcquisitionPairPredicate } from "~/server/domains/purchase/repo/purchase-products";
import { listPurchaseSettlementCandidates } from "~/server/domains/purchase/repo/purchase-settlement-candidates";
import { classificationPolicySql } from "~/server/domains/spending-category/repo/classification-field-policy";
import { liveLinks } from "~/server/generic/entity-links/repo/entity-links";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

import { retrieveEmailConnectionCandidates } from "./email-connections";

const evidence = (reasons: string[], unknowns: string[] = []) => ({
  reasons,
  unknowns,
  contradictions: [],
});

/** Each family starts from a concrete endpoint; title matching retrieves only. */
export async function retrieveConnectionCandidates(
  db: Database,
  source: EntityRef,
): Promise<ConnectionCandidate[]> {
  const result: ConnectionCandidate[] = [];
  if (source.entityKind === "email" || source.entityKind === "purchase")
    result.push(...(await retrieveEmailConnectionCandidates(db, source)));
  if (source.entityKind === "product") {
    const id = await resolveOrThrow(db, "product", source.entityId);
    const [item] = await getDb(db)
      .select({ name: product.name })
      .from(product)
      .where(and(eq(product.id, id), notDeleted(product)));
    if (!item) return [];
    const linked = await getDb(db)
      .select({ code: purchase.shortcode })
      .from(entityLink)
      .innerJoin(
        purchase,
        and(eq(purchase.id, entityLink.fromEntityId), notDeleted(purchase)),
      )
      .where(
        and(
          liveLinks("purchaseProduct"),
          eq(entityLink.toEntityId, id),
          eq(entityLink.acquisitionConfirmed, false),
        ),
      )
      .orderBy(purchase.id)
      .limit(20);
    for (const row of linked)
      result.push({
        relation: "product-purchase",
        source,
        target: { entityKind: "purchase", entityId: row.code },
        label: "Confirm retrospective acquisition",
        evidence: evidence(
          ["Existing Product identity link to this Purchase"],
          [
            "Acquisition is not confirmed; this link alone proves no acquisition, delivery or quantity",
          ],
        ),
      });
    const charges = await getDb(db)
      .select({ code: expense.shortcode })
      .from(expense)
      .where(
        and(
          notDeleted(expense),
          isNull(expense.productId),
          actualExpense(),
          eq(expense.lineKind, "principal"),
          expenseAcquisitionPairPredicate(sql`true`),
          sql`NOT ${classificationPolicySql("spendingCategory.productExpectation", "productId", "not_allowed", effectiveExpenseSpendingCategorySql('"Expense"'))}`,
          sql`${item.name.trim().length >= 4} AND position(lower(${item.name.trim()}) in lower(${expense.name})) > 0`,
        ),
      )
      .orderBy(expense.date, expense.id)
      .limit(20);
    for (const row of charges)
      result.push({
        relation: "product-expense",
        source,
        target: { entityKind: "expense", entityId: row.code },
        label: "Review acquisition expense",
        evidence: evidence(
          ["Expense title retrieved using this Product name"],
          [
            "Title similarity does not prove Product identity or acquisition; inspect the source document",
          ],
        ),
      });
  }
  if (source.entityKind === "purchase") {
    const id = await resolveOrThrow(db, "purchase", source.entityId);
    const rows = await getDb(db)
      .select({ code: product.shortcode })
      .from(entityLink)
      .innerJoin(
        product,
        and(eq(product.id, entityLink.toEntityId), notDeleted(product)),
      )
      .where(
        and(
          liveLinks("purchaseProduct"),
          eq(entityLink.fromEntityId, id),
          eq(entityLink.acquisitionConfirmed, false),
        ),
      )
      .orderBy(product.id)
      .limit(20);
    for (const row of rows)
      result.push({
        relation: "product-purchase",
        source: { entityKind: "product", entityId: row.code },
        target: source,
        label: "Confirm retrospective acquisition",
        evidence: evidence(
          ["Existing Product identity link to this Purchase"],
          [
            "Acquisition is not confirmed; this link alone proves no acquisition, delivery or quantity",
          ],
        ),
      });
    result.push(...(await settlementCandidates(db, source)));
  }
  if (source.entityKind === "financialTransaction") {
    const id = await resolveOrThrow(
      db,
      "financialTransaction",
      source.entityId,
    );
    const [transaction] = await getDb(db)
      .select({
        date: sql<
          string | null
        >`coalesce(${financialTransaction.postedDate}, ${financialTransaction.transactionDate})`,
      })
      .from(financialTransaction)
      .where(
        and(eq(financialTransaction.id, id), notDeleted(financialTransaction)),
      );
    if (transaction?.date) {
      const orders = await getDb(db)
        .select({ code: purchase.shortcode })
        .from(purchase)
        .where(
          and(
            notDeleted(purchase),
            sql`abs(${purchase.date}::date-${transaction.date}::date)<=45`,
          ),
        )
        .orderBy(
          sql`abs(${purchase.date}::date-${transaction.date}::date)`,
          purchase.id,
        )
        .limit(10);
      for (const row of orders)
        result.push(
          ...(
            await settlementCandidates(db, {
              entityKind: "purchase",
              entityId: row.code,
            })
          ).filter((p) => p.source.entityId === source.entityId),
        );
    }
    const transfers = await suggestFinancialTransferPairs(db, {
      transactionIds: [
        parseShortcodeFor("financialTransaction", source.entityId),
      ],
      maxDateDistanceDays: 5,
      maxCandidatesPerTransaction: 3,
    });
    for (const group of transfers.suggestions)
      for (const candidate of group.candidates)
        result.push({
          relation: "transaction-transfer",
          source: {
            entityKind: "financialTransaction",
            entityId: candidate.outflowTransactionId,
          },
          target: {
            entityKind: "financialTransaction",
            entityId: candidate.inflowTransactionId,
          },
          label: "Review transfer pair",
          evidence: evidence(candidate.reasons, [
            "Equal and opposite values do not prove a transfer; existing domain ownership and evidence checks decide acceptance",
          ]),
        });
  }
  if (source.entityKind === "project") {
    const tools = await suggestProjectTools(
      db,
      await resolveOrThrow(db, "project", source.entityId),
    );
    for (const tool of tools.items.slice(0, 20))
      result.push({
        relation: "project-tool",
        source,
        target: { entityKind: "product", entityId: tool.productId },
        label: "Review tool usage",
        evidence: evidence(tool.reasons, [
          "Acquisition or shared trade is not proof the tool was used on this Project",
        ]),
      });
  }
  return result;
}

async function settlementCandidates(
  db: Database,
  target: EntityRef,
): Promise<ConnectionCandidate[]> {
  const rows = await listPurchaseSettlementCandidates(
    db,
    parseShortcodeFor("purchase", target.entityId),
  );
  const result: ConnectionCandidate[] = [];
  for (const row of rows.slice(0, 10)) {
    const id = await resolveOrThrow(
      db,
      "financialTransaction",
      row.transactionId,
    );
    const [transaction] = await getDb(db)
      .select({
        kind: financialTransaction.kind,
        allocated: sql<boolean>`EXISTS (SELECT 1 FROM "FinancialTransactionAllocation" a WHERE a."transactionId"="FinancialTransaction".id AND a."deletedAt" IS NULL)`,
      })
      .from(financialTransaction)
      .where(
        and(eq(financialTransaction.id, id), notDeleted(financialTransaction)),
      );
    if (!transaction || transaction.allocated || row.conflicts.length) continue;
    result.push({
      relation:
        transaction.kind === "refund"
          ? "transaction-refund"
          : "transaction-purchase",
      source: {
        entityKind: "financialTransaction",
        entityId: row.transactionId,
      },
      target,
      label: "Review settlement connection",
      evidence: evidence(
        [
          ...(row.exactAmount ? ["Exact stated amount"] : []),
          ...(row.nearAmount ? ["Amount within one cent"] : []),
          ...(row.merchantMatches ? ["Merchant text overlaps Vendor"] : []),
          `Dates differ by ${row.days} days`,
        ],
        [
          "Amount, date and merchant similarity do not prove settlement identity",
          "Only unallocated transactions are offered; partial allocation requires the existing allocation editor",
        ],
      ),
    });
  }
  return result;
}

export async function expenseConnectionEligible(db: Database, code: string) {
  const [row] = await getDb(db)
    .select({ id: expense.id })
    .from(expense)
    .where(
      and(
        eq(expense.shortcode, code),
        isNull(expense.productId),
        eq(expense.lineKind, "principal"),
        expenseAcquisitionPairPredicate(sql`true`),
        sql`NOT ${classificationPolicySql("spendingCategory.productExpectation", "productId", "not_allowed", effectiveExpenseSpendingCategorySql('"Expense"'))}`,
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** Shorter brandName values match too many ordinary line words. */
const MIN_KNOWN_BRAND_LENGTH = 3;

/** A Product's brand slug; null when its brandName is unspecified. */
const brandSlug = (brandName: string | null): string | null =>
  !brandName || isUnknownBrandName(brandName)
    ? null
    : manufacturerSource(brandName);

/**
 * Known brands: live Products' specified `brandName` values as
 * `manufacturerSource` slugs. Matching happens on the slugs in
 * `otherBrandNamed` (NFKD-folded, so "Nestlé" and "Nestle" agree); there is
 * no SQL prefilter that could disagree with them.
 */
export async function knownBrandSlugs(db: Database): Promise<Set<string>> {
  const rows = await getDb(db)
    .selectDistinct({ brandName: productBrandNameSql(product.brandId) })
    .from(product)
    .where(notDeleted(product));
  const brands = new Set<string>();
  for (const { brandName } of rows) {
    const slug = brandSlug(brandName);
    if (slug && slug.length >= MIN_KNOWN_BRAND_LENGTH) brands.add(slug);
  }
  return brands;
}

/**
 * The known brand other than the Product's own that an Expense line names,
 * on slug word boundaries, so the line cannot be that Product's acquisition
 * however similar its text embeds. Null when the Product is unbranded, the
 * line also names the Product's own brand, or it names no known brand.
 */
export function otherBrandNamed(
  line: string,
  productManufacturer: string | null,
  brands: ReadonlySet<string>,
): string | null {
  const own = brandSlug(productManufacturer);
  if (!own) return null;
  const words = `-${manufacturerSource(line) ?? ""}-`;
  if (words.includes(`-${own}-`)) return null;
  for (const brand of brands)
    if (brand !== own && words.includes(`-${brand}-`)) return brand;
  return null;
}

/** The brand-bearing text of an acquisition endpoint: Product brandName or Expense line. */
export async function acquisitionBrandText(
  db: Database,
  ref: EntityRef,
): Promise<string | null> {
  if (ref.entityKind === "product") {
    const [row] = await getDb(db)
      .select({ text: productBrandNameSql(product.brandId) })
      .from(product)
      .where(eq(product.shortcode, ref.entityId))
      .limit(1);
    return row?.text ?? null;
  }
  const [row] = await getDb(db)
    .select({ text: expense.name })
    .from(expense)
    .where(eq(expense.shortcode, ref.entityId))
    .limit(1);
  return row?.text ?? null;
}

/** Notes are currently absent from SearchDocument; bridge only one concrete source. */
export async function retrieveAcquisitionNotes(
  db: Database,
  source: EntityRef,
  text: { name: string; notes: string },
): Promise<EntityRef[]> {
  const result: EntityRef[] = [];
  if (source.entityKind === "product" && text.name.trim().length >= 3) {
    const orders = await getDb(db)
      .select({ code: purchase.shortcode })
      .from(purchase)
      .where(
        and(
          notDeleted(purchase),
          sql`position(lower(${text.name}) in lower(coalesce(${purchase.notes},'')))>0`,
        ),
      )
      .orderBy(purchase.id)
      .limit(10);
    for (const row of orders)
      result.push({ entityKind: "purchase", entityId: row.code });
    const charges = await getDb(db)
      .select({ code: expense.shortcode })
      .from(expense)
      .where(
        and(
          notDeleted(expense),
          sql`position(lower(${text.name}) in lower(coalesce(${expense.notes},'')))>0`,
        ),
      )
      .orderBy(expense.id)
      .limit(10);
    for (const row of charges)
      result.push({ entityKind: "expense", entityId: row.code });
  } else if (text.notes.trim().length >= 3) {
    const items = await getDb(db)
      .select({ code: product.shortcode })
      .from(product)
      .where(
        and(
          notDeleted(product),
          sql`length(${product.name})>=3 AND position(lower(${product.name}) in lower(${text.notes}))>0`,
        ),
      )
      .orderBy(product.id)
      .limit(10);
    for (const row of items)
      result.push({ entityKind: "product", entityId: row.code });
  }
  return result;
}

export async function acquisitionPairEligible(
  db: Database,
  productCode: string,
  purchaseCode: string,
) {
  const productId = await resolveOrThrow(db, "product", productCode);
  const purchaseId = await resolveOrThrow(db, "purchase", purchaseCode);
  const [confirmed] = await getDb(db)
    .select({ id: entityLink.id })
    .from(entityLink)
    .where(
      and(
        liveLinks("purchaseProduct"),
        eq(entityLink.fromEntityId, purchaseId),
        eq(entityLink.toEntityId, productId),
        eq(entityLink.acquisitionConfirmed, true),
      ),
    )
    .limit(1);
  if (confirmed) return false;
  const [acquired] = await getDb(db)
    .select({ id: expense.id })
    .from(expense)
    .where(
      expenseAcquisitionPairPredicate(
        sql`${expense.purchaseId}=${purchaseId} AND ${expense.productId}=${productId}`,
      ),
    )
    .limit(1);
  return acquired === undefined;
}
