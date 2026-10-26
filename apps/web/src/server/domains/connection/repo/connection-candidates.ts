import type { EntityRef } from "@cubby/schemas/entity";
import type { ConnectionCandidate } from "@cubby/schemas/entity-connections";
import { manufacturerSource } from "@cubby/schemas/external-id";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import { isUnknownBrandName } from "~/lib/brand-name-utils";
import type { Database } from "~/server/db";
import { actualExpense } from "~/server/db/computed/expense-aggregate-sql";
import { productBrandNameSql } from "~/server/db/computed/product-brand-sql";
import { getDb, notDeleted } from "~/server/db/helpers";
import { outer, quotedTable, related } from "~/server/db/helpers/related";
import {
  entityLink,
  expense,
  product,
  purchase,
  financialTransaction,
  financialTransactionAllocation,
} from "~/server/db/schema";
import { effectiveExpenseSpendingCategorySql } from "~/server/domains/expense/repo/expense-category-resolution";
import { suggestFinancialTransferPairs } from "~/server/domains/financial-transaction/repo/financial-transfer-pairing";
import { suggestProjectTools } from "~/server/domains/project/repo/tools";
import { expenseAcquisitionPairPredicate } from "~/server/domains/purchase/repo/purchase-products";
import { listPurchasesSettlementCandidates } from "~/server/domains/purchase/repo/purchase-settlement-candidates";
import { classificationPolicySql } from "~/server/domains/spending-category/repo/classification-field-policy";
import { liveLinks } from "~/server/generic/entity-links/repo/entity-links";
import {
  resolveAllOrThrow,
  resolveOrThrow,
} from "~/server/generic/shortcode/repo/shortcode-resolver";

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
          sql`NOT ${classificationPolicySql("spendingCategory.productExpectation", "productId", "not_allowed", effectiveExpenseSpendingCategorySql(quotedTable(expense)))}`,
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
  if (source.entityKind === "financialTransaction")
    result.push(
      ...((await retrieveFinancialConnectionCandidatePage(db, [source])).get(
        source.entityId,
      ) ?? []),
    );
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
  return (
    (await settlementCandidatePage(db, [target])).get(target.entityId) ?? []
  );
}

/** Preserve each Purchase's ranked top ten before eligibility filtering. */
async function settlementCandidatePage(
  db: Database,
  targets: readonly EntityRef[],
) {
  const rows = await listPurchasesSettlementCandidates(
    db,
    targets.map((target) => parseShortcodeFor("purchase", target.entityId)),
  );
  const codes = [
    ...new Set(
      [...rows.values()].flatMap((values) =>
        values.slice(0, 10).map((row) => row.transactionId),
      ),
    ),
  ];
  const transactions = codes.length
    ? await getDb(db)
        .select({
          code: financialTransaction.shortcode,
          kind: financialTransaction.kind,
          allocated: related(
            financialTransactionAllocation,
            (a) => sql`${a.transactionId} = ${outer(financialTransaction.id)}`,
          ).exists(),
        })
        .from(financialTransaction)
        .where(
          and(
            inArray(financialTransaction.shortcode, codes),
            notDeleted(financialTransaction),
          ),
        )
    : [];
  const byCode = new Map(transactions.map((row) => [row.code, row]));
  return new Map(
    targets.map((target) => {
      const candidates: ConnectionCandidate[] = [];
      for (const row of (rows.get(target.entityId) ?? []).slice(0, 10)) {
        const transaction = byCode.get(row.transactionId);
        if (!transaction || transaction.allocated || row.conflicts.length)
          continue;
        candidates.push({
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
      return [target.entityId, candidates];
    }),
  );
}

/** Nearby purchases, settlement ranks and transfer policy are shared by the page. */
export async function retrieveFinancialConnectionCandidatePage(
  db: Database,
  sources: readonly EntityRef[],
) {
  const out = new Map<string, ConnectionCandidate[]>(
    sources.map((source) => [source.entityId, []]),
  );
  if (!sources.length) return out;
  const codes = sources.map((source) =>
    parseShortcodeFor("financialTransaction", source.entityId),
  );
  const requested = alias(financialTransaction, "t");
  const nearbyPurchase = alias(purchase, "p");
  const result = await getDb(db).execute(sql`
    SELECT t.shortcode AS source, nearby.shortcode AS target
    FROM "FinancialTransaction" t
    CROSS JOIN LATERAL (
      SELECT p.shortcode FROM "Purchase" p
      WHERE ${notDeleted(nearbyPurchase)}
        AND abs(p.date::date-coalesce(t."postedDate", t."transactionDate")::date)<=45
      ORDER BY abs(p.date::date-coalesce(t."postedDate", t."transactionDate")::date), p.id LIMIT 10
    ) nearby
    WHERE ${inArray(sql`t.shortcode`, codes)} AND ${notDeleted(requested)}
    ORDER BY t.id`);
  const edges = z
    .array(z.object({ source: z.string(), target: z.string() }))
    .parse(result.rows);
  const targets: EntityRef[] = [
    ...new Set(edges.map((edge) => edge.target)),
  ].map((entityId) => ({ entityKind: "purchase", entityId }));
  const settlements = await settlementCandidatePage(db, targets);
  for (const edge of edges)
    out
      .get(edge.source)
      ?.push(
        ...(settlements.get(edge.target) ?? []).filter(
          (candidate) => candidate.source.entityId === edge.source,
        ),
      );
  const transfers = await suggestFinancialTransferPairs(db, {
    transactionIds: codes,
    maxDateDistanceDays: 5,
    maxCandidatesPerTransaction: 3,
  });
  for (const group of transfers.suggestions)
    for (const candidate of group.candidates)
      out.get(group.transactionId)?.push({
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
  return out;
}

/** The Expense codes still eligible for an acquisition connection, in one statement. */
export async function eligibleConnectionExpenses(
  db: Database,
  codes: readonly string[],
): Promise<Set<string>> {
  const shortcodes = new Map(
    codes.map((code) => [parseShortcodeFor("expense", code), code] as const),
  );
  if (shortcodes.size === 0) return new Set();
  const rows = await getDb(db)
    .select({ shortcode: expense.shortcode })
    .from(expense)
    .where(
      and(
        inArray(expense.shortcode, [...shortcodes.keys()]),
        isNull(expense.productId),
        eq(expense.lineKind, "principal"),
        expenseAcquisitionPairPredicate(sql`true`),
        sql`NOT ${classificationPolicySql("spendingCategory.productExpectation", "productId", "not_allowed", effectiveExpenseSpendingCategorySql(quotedTable(expense)))}`,
      ),
    );
  return new Set(
    rows.flatMap(({ shortcode }) => {
      const code = shortcodes.get(parseShortcodeFor("expense", shortcode));
      return code === undefined ? [] : [code];
    }),
  );
}

export async function expenseConnectionEligible(db: Database, code: string) {
  return (await eligibleConnectionExpenses(db, [code])).has(code);
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
export const acquisitionBrandKey = (ref: EntityRef) =>
  `${ref.entityKind}:${ref.entityId}`;

/** `acquisitionBrandText` for many refs: one statement per entity kind. */
export async function acquisitionBrandTexts(
  db: Database,
  refs: readonly EntityRef[],
): Promise<Map<string, string | null>> {
  const texts = new Map<string, string | null>(
    refs.map((ref) => [acquisitionBrandKey(ref), null]),
  );
  const codes = (kind: string) => [
    ...new Set(
      refs.filter((ref) => ref.entityKind === kind).map((ref) => ref.entityId),
    ),
  ];
  const products = codes("product");
  const expenses = codes("expense");
  const [productRows, expenseRows] = await Promise.all([
    products.length
      ? getDb(db)
          .select({
            code: product.shortcode,
            text: productBrandNameSql(product.brandId),
          })
          .from(product)
          .where(inArray(product.shortcode, products))
      : [],
    expenses.length
      ? getDb(db)
          .select({ code: expense.shortcode, text: expense.name })
          .from(expense)
          .where(inArray(expense.shortcode, expenses))
      : [],
  ]);
  for (const row of productRows)
    texts.set(`product:${row.code}`, row.text ?? null);
  for (const row of expenseRows)
    texts.set(`expense:${row.code}`, row.text ?? null);
  return texts;
}

export async function acquisitionBrandText(
  db: Database,
  ref: EntityRef,
): Promise<string | null> {
  return (
    (await acquisitionBrandTexts(db, [ref])).get(acquisitionBrandKey(ref)) ??
    null
  );
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

export const acquisitionPairKey = (productCode: string, purchaseCode: string) =>
  `${productCode}:${purchaseCode}`;

/**
 * The Product/Purchase pairs with no recorded acquisition (no confirmed link
 * and no acquisition Expense), keyed by `acquisitionPairKey`, in two
 * statements for any number of pairs.
 */
export async function eligibleAcquisitionPairs(
  db: Database,
  pairs: readonly { productCode: string; purchaseCode: string }[],
): Promise<Set<string>> {
  if (pairs.length === 0) return new Set();
  const productCodes = [...new Set(pairs.map((pair) => pair.productCode))];
  const purchaseCodes = [...new Set(pairs.map((pair) => pair.purchaseCode))];
  const [productIds, purchaseIds] = await Promise.all([
    resolveAllOrThrow(db, "product", productCodes),
    resolveAllOrThrow(db, "purchase", purchaseCodes),
  ]);
  // Link endpoints are untyped uuids; key by the plain id string.
  const productById = new Map<string, string>(
    productIds.map((id, index) => [id, productCodes[index]!]),
  );
  const purchaseById = new Map<string, string>(
    purchaseIds.map((id, index) => [id, purchaseCodes[index]!]),
  );
  const recorded = new Set<string>();
  const [confirmed, acquired] = await Promise.all([
    getDb(db)
      .select({
        purchaseId: entityLink.fromEntityId,
        productId: entityLink.toEntityId,
      })
      .from(entityLink)
      .where(
        and(
          liveLinks("purchaseProduct"),
          inArray(entityLink.fromEntityId, purchaseIds),
          inArray(entityLink.toEntityId, productIds),
          eq(entityLink.acquisitionConfirmed, true),
        ),
      ),
    getDb(db)
      .select({ purchaseId: expense.purchaseId, productId: expense.productId })
      .from(expense)
      .where(
        expenseAcquisitionPairPredicate(
          and(
            inArray(expense.purchaseId, purchaseIds),
            inArray(expense.productId, productIds),
          ) ?? sql`false`,
        ),
      ),
  ]);
  for (const row of [...confirmed, ...acquired]) {
    const productCode = row.productId && productById.get(row.productId);
    const purchaseCode = row.purchaseId && purchaseById.get(row.purchaseId);
    if (productCode && purchaseCode)
      recorded.add(acquisitionPairKey(productCode, purchaseCode));
  }
  return new Set(
    pairs
      .map((pair) => acquisitionPairKey(pair.productCode, pair.purchaseCode))
      .filter((key) => !recorded.has(key)),
  );
}

export async function acquisitionPairEligible(
  db: Database,
  productCode: string,
  purchaseCode: string,
) {
  return (
    await eligibleAcquisitionPairs(db, [{ productCode, purchaseCode }])
  ).has(acquisitionPairKey(productCode, purchaseCode));
}
