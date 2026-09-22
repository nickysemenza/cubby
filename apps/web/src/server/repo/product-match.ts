import { GTIN_SOURCE } from "@cubby/schemas/external-id";
import {
  type LedgerPartyId,
  type ProductId,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import type {
  ProductMatchSide,
  productMatchSideRole,
} from "@cubby/schemas/recommendations";
import { isMiscProduct } from "@cubby/shared";
import { and, asc, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { uniq } from "es-toolkit";
import type { z } from "zod";

import type { Database } from "~/server/db";
import {
  expense,
  image,
  inventoryEntry,
  ledgerParty,
  product,
  productCategory,
  productExternalId,
  productImage,
  purchase,
  purchaseProduct,
  vendor,
  vendorAccount,
} from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { loadInheritedProductOwners } from "~/server/repo/inventory";

/*
 * Raw, hand-qualified EXISTS predicates: an interpolated column renders
 * unqualified on a single-table select, which would silently correlate these
 * subqueries against their own tables.
 */
const HAS_LIVE_INVENTORY = sql.raw(`EXISTS (
  SELECT 1 FROM "InventoryEntry" pm_inv
  WHERE pm_inv."productId" = "Product"."id" AND pm_inv."deletedAt" IS NULL
)`);
const HAS_LIVE_PURCHASE_LINK = sql.raw(`EXISTS (
  SELECT 1 FROM "PurchaseProduct" pm_pp
  JOIN "Purchase" pm_pu ON pm_pu."id" = pm_pp."purchaseId" AND pm_pu."deletedAt" IS NULL
  WHERE pm_pp."productId" = "Product"."id" AND pm_pp."deletedAt" IS NULL
)`);
const HAS_LIVE_EXPENSE = sql.raw(`EXISTS (
  SELECT 1 FROM "Expense" pm_e
  WHERE pm_e."productId" = "Product"."id" AND pm_e."deletedAt" IS NULL
)`);

export interface ProductMatchPoolEntry {
  id: ProductId;
  name: string;
  rootCategoryId: string | null;
  createdAt: Date;
}

/**
 * The two sides of the match queue. `photo`: stocked, never bought (no
 * purchase line, no spend). `purchase`: on a live purchase — with or without
 * stock, since receiving the order may already have stocked it.
 */
export async function loadProductMatchPools(db: Database): Promise<{
  photo: ProductMatchPoolEntry[];
  purchase: ProductMatchPoolEntry[];
}> {
  const client = getDb(db);
  const [rows, categories] = await Promise.all([
    client
      .select({
        id: product.id,
        name: product.name,
        categoryId: product.categoryId,
        createdAt: product.createdAt,
        hasInventory: sql<boolean>`${HAS_LIVE_INVENTORY}`,
        hasPurchase: sql<boolean>`${HAS_LIVE_PURCHASE_LINK}`,
        hasExpense: sql<boolean>`${HAS_LIVE_EXPENSE}`,
      })
      .from(product)
      .where(
        and(
          notDeleted(product),
          or(sql`${HAS_LIVE_INVENTORY}`, sql`${HAS_LIVE_PURCHASE_LINK}`),
        ),
      ),
    loadCategoryRoots(db),
  ]);
  const photo: ProductMatchPoolEntry[] = [];
  const purchasePool: ProductMatchPoolEntry[] = [];
  for (const row of rows) {
    if (isMiscProduct(row.name)) continue;
    const entry = {
      id: row.id,
      name: row.name,
      rootCategoryId: row.categoryId
        ? (categories.get(row.categoryId) ?? null)
        : null,
      createdAt: row.createdAt,
    };
    if (row.hasPurchase) purchasePool.push(entry);
    else if (row.hasInventory && !row.hasExpense) photo.push(entry);
  }
  return { photo, purchase: purchasePool };
}

/** category id -> its top-level ancestor id (cycle- and depth-safe). */
async function loadCategoryRoots(db: Database): Promise<Map<string, string>> {
  const rows = await getDb(db)
    .select({ id: productCategory.id, parentId: productCategory.parentId })
    .from(productCategory)
    .where(notDeleted(productCategory));
  const parent = new Map(rows.map((row) => [row.id, row.parentId]));
  const roots = new Map<string, string>();
  for (const { id } of rows) {
    let current = id;
    const seen = new Set<string>();
    for (;;) {
      const next = parent.get(current);
      if (!next || seen.has(next) || !parent.has(next)) break;
      seen.add(current);
      current = next;
    }
    roots.set(id, current);
  }
  return roots;
}

export type LoadedMatchSide = ProductMatchSide & {
  entityId: ProductId;
  rootCategoryId: string | null;
  ownerPartyId: LedgerPartyId | null;
};

const individual = (kind: string) => kind === "member" || kind === "guest";

type MatchParty = {
  id: LedgerPartyId;
  shortcode: string;
  name: string;
};

const sideRole = (
  purchased: boolean,
  stockEntries: number,
  spent: boolean,
): z.infer<typeof productMatchSideRole> =>
  purchased ? "purchase" : stockEntries > 0 && !spent ? "photo" : "other";

/** The one explicit owner every live stock row names, if there is exactly one. */
function stockOwner(
  entries: ReadonlyArray<{
    ownershipMode: string;
    ownerLedgerPartyId: LedgerPartyId | null;
  }>,
  partyById: ReadonlyMap<LedgerPartyId, MatchParty>,
): MatchParty | null {
  if (entries.some((entry) => entry.ownershipMode !== "person")) return null;
  const owners = uniq(entries.map((entry) => entry.ownerLedgerPartyId));
  const [only] = owners;
  return owners.length === 1 && only ? (partyById.get(only) ?? null) : null;
}

const sideOwner = (
  role: z.infer<typeof productMatchSideRole>,
  owners: {
    stock: MatchParty | null;
    inherited: MatchParty | null;
    buyer: MatchParty | null;
  },
): MatchParty | null =>
  role === "purchase"
    ? (owners.inherited ?? owners.buyer ?? owners.stock)
    : (owners.stock ?? owners.inherited);

/**
 * Everything the review card shows for each product, plus the internal ids the
 * ranking compares. The owner is the explicit stock owner for a stocked
 * product, otherwise the purchase-inherited owner, otherwise the buyer on the
 * purchase's vendor account; null when none is determinable.
 */
export async function loadProductMatchSides(
  db: Database,
  productIds: readonly ProductId[],
): Promise<Map<ProductId, LoadedMatchSide>> {
  const ids = uniq(productIds);
  if (ids.length === 0) return new Map();
  const client = getDb(db);
  const [products, stock, latestPurchases, lines, spend, externalIds, roots] =
    await Promise.all([
      client
        .select({
          id: product.id,
          shortcode: product.shortcode,
          name: product.name,
          categoryId: product.categoryId,
          categoryName: productCategory.name,
        })
        .from(product)
        .leftJoin(
          productCategory,
          and(
            eq(productCategory.id, product.categoryId),
            notDeleted(productCategory),
          ),
        )
        .where(and(inArray(product.id, ids), notDeleted(product))),
      client
        .select({
          productId: inventoryEntry.productId,
          ownershipMode: inventoryEntry.ownershipMode,
          ownerLedgerPartyId: inventoryEntry.ownerLedgerPartyId,
        })
        .from(inventoryEntry)
        .where(
          and(
            inArray(inventoryEntry.productId, ids),
            notDeleted(inventoryEntry),
          ),
        ),
      client
        .selectDistinctOn([purchaseProduct.productId], {
          productId: purchaseProduct.productId,
          purchaseId: purchase.id,
          shortcode: purchase.shortcode,
          date: purchase.date,
          vendor: vendor.name,
          buyerPartyId: vendorAccount.ledgerPartyId,
        })
        .from(purchaseProduct)
        .innerJoin(
          purchase,
          and(
            eq(purchase.id, purchaseProduct.purchaseId),
            notDeleted(purchase),
          ),
        )
        .leftJoin(vendor, eq(vendor.id, purchase.vendorId))
        .leftJoin(
          vendorAccount,
          and(
            eq(vendorAccount.id, purchase.vendorAccountId),
            notDeleted(vendorAccount),
          ),
        )
        .where(
          and(
            inArray(purchaseProduct.productId, ids),
            notDeleted(purchaseProduct),
          ),
        )
        .orderBy(purchaseProduct.productId, desc(purchase.date)),
      client
        .select({
          productId: expense.productId,
          purchaseId: expense.purchaseId,
          name: expense.name,
        })
        .from(expense)
        .where(
          and(
            inArray(expense.productId, ids),
            isNotNull(expense.purchaseId),
            notDeleted(expense),
          ),
        ),
      client
        .select({ productId: expense.productId })
        .from(expense)
        .where(and(inArray(expense.productId, ids), notDeleted(expense)))
        .groupBy(expense.productId),
      client
        .select({
          productId: productExternalId.productId,
          source: productExternalId.source,
          externalId: productExternalId.externalId,
        })
        .from(productExternalId)
        .where(
          and(
            inArray(productExternalId.productId, ids),
            notDeleted(productExternalId),
          ),
        ),
      loadCategoryRoots(db),
    ]);

  const purchaseByProduct = new Map(
    latestPurchases.map((row) => [row.productId, row]),
  );
  const inherited = await loadInheritedProductOwners(db, [
    ...purchaseByProduct.keys(),
  ]);
  const explicitOwnerIds = uniq(
    stock.flatMap((row) =>
      row.ownershipMode === "person" && row.ownerLedgerPartyId
        ? [row.ownerLedgerPartyId]
        : [],
    ),
  );
  const buyerIds = uniq(
    latestPurchases.flatMap((row) =>
      row.buyerPartyId ? [row.buyerPartyId] : [],
    ),
  );
  const partyIds = uniq([...explicitOwnerIds, ...buyerIds]);
  const parties =
    partyIds.length === 0
      ? []
      : await client
          .select({
            id: ledgerParty.id,
            shortcode: ledgerParty.shortcode,
            name: ledgerParty.name,
            kind: ledgerParty.kind,
          })
          .from(ledgerParty)
          .where(
            and(inArray(ledgerParty.id, partyIds), notDeleted(ledgerParty)),
          );
  const partyById = new Map(
    parties.filter((row) => individual(row.kind)).map((row) => [row.id, row]),
  );
  const spent = new Set(spend.map((row) => row.productId));

  const out = new Map<ProductId, LoadedMatchSide>();
  for (const row of products) {
    const entries = stock.filter((entry) => entry.productId === row.id);
    const latest = purchaseByProduct.get(row.id);
    const role = sideRole(Boolean(latest), entries.length, spent.has(row.id));
    const owner = sideOwner(role, {
      stock: stockOwner(entries, partyById),
      inherited: inherited.get(row.id) ?? null,
      buyer: latest?.buyerPartyId
        ? (partyById.get(latest.buyerPartyId) ?? null)
        : null,
    });
    const ids = externalIds.filter((id) => id.productId === row.id);
    out.set(row.id, {
      entityId: row.id,
      id: parseShortcodeFor("product", row.shortcode),
      name: row.name,
      role,
      category: row.categoryName ?? null,
      rootCategoryId: row.categoryId
        ? (roots.get(row.categoryId) ?? null)
        : null,
      inventoryCount: entries.length,
      owner: owner
        ? {
            id: parseShortcodeFor("ledgerParty", owner.shortcode),
            name: owner.name,
          }
        : null,
      ownerPartyId: owner?.id ?? null,
      purchase: latest
        ? {
            id: parseShortcodeFor("purchase", latest.shortcode),
            date: latest.date,
            vendor: latest.vendor ?? null,
            line:
              lines.find(
                (line) =>
                  line.productId === row.id &&
                  line.purchaseId === latest.purchaseId,
              )?.name ?? null,
          }
        : null,
      gtins: ids
        .filter((id) => id.source === GTIN_SOURCE)
        .map((id) => id.externalId)
        .sort(),
      sources: uniq(ids.map((id) => id.source)).sort(),
    });
  }
  return out;
}

/** A product's live images in current display order, with what decides covers. */
export async function loadProductImageOrderFacts(
  db: Database,
  productId: ProductId,
) {
  return await getDb(db)
    .select({
      shortcode: image.shortcode,
      source: image.source,
      purpose: productImage.purpose,
    })
    .from(productImage)
    .innerJoin(
      image,
      and(eq(image.id, productImage.imageId), notDeleted(image)),
    )
    .where(and(eq(productImage.productId, productId), notDeleted(productImage)))
    .orderBy(
      asc(productImage.sortOrder),
      asc(productImage.createdAt),
      asc(productImage.id),
    );
}
