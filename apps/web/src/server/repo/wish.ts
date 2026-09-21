import type { ActorContext } from "@cubby/schemas/context";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
import {
  type ProductId,
  parseShortcodeFor,
  type WishId,
  type WishShortcode,
} from "@cubby/schemas/identifiers";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import type {
  WishCreateInput,
  WishFilters,
  WishListItemOut,
  WishOut,
  WishUpdateData,
} from "@cubby/schemas/wish";
import { wishPriceRange } from "@cubby/schemas/wish-fields";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { uniq } from "es-toolkit";

import type { Database, DrizzleTransaction } from "~/server/db";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import { product, wish, wishCandidate } from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { computeChanges, logAuditEntry } from "~/server/repo/audit-log";
import {
  auditDateWhereConditions,
  countWhere,
  executeListQueryWithCount,
  formatSearchTerm,
  getDb,
  lockAndValidateForDelete,
  notDeleted,
  unwrapDb,
  updateLiveAndReturn,
  withTransaction,
} from "~/server/repo/database-helpers";
import { withDisplayImages } from "~/server/repo/entity-display-image";
import { listScaffold } from "~/server/repo/list-scaffold";
import { categoryFeatureSql } from "~/server/repo/product-category-sql";
import {
  effectiveProductPriceSql,
  loadProductPricing,
  resolveProductPricing,
} from "~/server/repo/product/pricing";
import { relatedWhereConditions } from "~/server/repo/related-view";
import { removeEntity } from "~/server/repo/removal";
import {
  resolveAllOrThrow,
  resolveLiveShortcode,
  resolveLiveShortcodes,
  resolveOrThrow,
} from "~/server/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

type WishRow = typeof wish.$inferSelect;

export const WISH_DELETE_EDGE_POLICY = {
  "WishCandidate.wishId": {
    code: "soft-delete-tool-alternatives",
    effect: "soft-delete",
    description:
      "Deleting a wishlist item soft-deletes its candidate alternatives; the Tool products themselves are unchanged.",
  },
} as const satisfies IncomingEdgePolicy<"wish", OperationDisposition>;
type CandidateRow = {
  wishId: WishId;
  id: ProductId;
  shortcode: string;
  name: string;
  manufacturer: string;
  model: string | null;
  price: number | null;
  inventoried: boolean;
};

const candidateRowsForWishes = async (
  db: Database | DrizzleTransaction,
  wishIds: readonly WishId[],
): Promise<Map<WishId, CandidateRow[]>> => {
  if (wishIds.length === 0) return new Map();
  const rows = await unwrapDb(db)
    .select({
      wishId: wishCandidate.wishId,
      id: product.id,
      shortcode: product.shortcode,
      name: product.name,
      manufacturer: product.manufacturer,
      model: product.model,
      price: product.price,
      // includes-installed: excluding installed rows would make the wish
      // list recommend re-buying a product already installed in the wall.
      inventoried: sql<boolean>`EXISTS (
        SELECT 1 FROM "InventoryEntry" ie
        WHERE ie."productId" = ${product.id} AND ie."deletedAt" IS NULL
      )`,
    })
    .from(wishCandidate)
    .innerJoin(product, eq(product.id, wishCandidate.productId))
    .where(
      and(
        inArray(wishCandidate.wishId, [...wishIds]),
        notDeleted(wishCandidate),
        notDeleted(product),
      ),
    )
    .orderBy(asc(product.manufacturer), asc(product.name), asc(product.model));
  const pricing = await loadProductPricing(db, rows);
  const byWish = new Map<WishId, CandidateRow[]>();
  for (const row of rows) {
    const candidate = {
      ...row,
      inventoried: Boolean(row.inventoried),
      price:
        pricing.get(row.id)?.effectivePrice ??
        resolveProductPricing(row.price).effectivePrice,
    };
    byWish.set(row.wishId, [...(byWish.get(row.wishId) ?? []), candidate]);
  }
  return byWish;
};

const toWishOut = (row: WishRow, candidates: CandidateRow[]): WishOut => {
  const publicCandidates = candidates.map((candidate) => ({
    id: parseShortcodeFor("product", candidate.shortcode),
    name: candidate.name,
    manufacturer: candidate.manufacturer,
    model: candidate.model,
    price: candidate.price,
    inventoried: candidate.inventoried,
  }));
  return {
    id: parseShortcodeFor("wish", row.shortcode),
    name: row.name,
    notes: row.notes,
    acquiredAt: row.acquiredAt,
    candidates: publicCandidates,
    candidateCount: publicCandidates.length,
    priceRange: wishPriceRange(publicCandidates),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
};

const hydrateWishes = async (
  db: Database | DrizzleTransaction,
  rows: WishRow[],
): Promise<WishOut[]> => {
  const candidates = await candidateRowsForWishes(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => toWishOut(row, candidates.get(row.id) ?? []));
};

// The candidate subqueries use a SQL alias (`p`), so keep their field refs raw
// rather than interpolate `product.name` (which would retain Product's table
// name instead of the alias).
const candidateProductSearch = (term: string) => {
  const pattern = `%${term}%`;
  return sql`(p."name" ILIKE ${pattern} OR p."manufacturer" ILIKE ${pattern} OR p."model" ILIKE ${pattern})`;
};

/**
 * Low / high effective price across a wish's live candidate alternatives.
 *
 * `effectiveProductPriceSql` is the SQL twin of the `explicit ?? derived` rule
 * `candidateRowsForWishes` applies in TS through `loadProductPricing`, so the
 * footer totals and the per-row ranges the client derives agree by
 * construction. Unpriced candidates drop out of MIN/MAX rather than counting
 * as $0 — same rule as `wishPriceRange` on the client — and a wish with no
 * priced candidate at all aggregates to NULL, which the outer sums COALESCE
 * away.
 *
 * Both soft-delete guards are load-bearing: emptying a wish soft-deletes its
 * WishCandidate rows, so a subquery without them would price alternatives the
 * user already removed.
 */
const candidatePriceAggregate = (fn: "min" | "max") => sql`(
    SELECT ${sql.raw(fn)}(${sql.raw(effectiveProductPriceSql("p"))})
    FROM "WishCandidate" wc
    JOIN "Product" p ON p."id" = wc."productId" AND p."deletedAt" IS NULL
    WHERE wc."wishId" = ${wish.id} AND wc."deletedAt" IS NULL
  )`;

const wishPriceLow = candidatePriceAggregate("min");
const wishPriceHigh = candidatePriceAggregate("max");
/** Midpoint of the range — the repo's deterministic sort key for ranged values. */
const wishPriceMid = sql`((${wishPriceLow} + ${wishPriceHigh}) / 2)`;

/**
 * Sorts the generic column path can't produce — a price range is an aggregate
 * over candidates, not a column on `Wish`. NULLS LAST in both directions is the
 * house convention (see `buildOrderBy`); here nulls are real, since a wish
 * whose alternatives are all unpriced has no range at all.
 */
const resolveWishSort = (sort: SortParams) => {
  if (sort.orderBy !== "priceRange") return null;
  return [
    sort.direction === "asc"
      ? sql`${wishPriceMid} asc nulls last`
      : sql`${wishPriceMid} desc nulls last`,
  ];
};

const wishScaffold = listScaffold("wish", wish);

/** The complete WHERE for this entity's list. `getEntityCounts` calls it with `{}` — see repo/dashboard.ts. */
export const buildWishWhere = async (
  db: Database | DrizzleTransaction,
  filters: WishFilters,
) => {
  const candidateProductIds = filters.candidateProductId
    ? Array.isArray(filters.candidateProductId)
      ? filters.candidateProductId
      : [filters.candidateProductId]
    : undefined;
  // Resolved to uuids up front, same idiom as `expense/lookup.ts`'s
  // `toUuids`: matching the raw shortcode STRING against `p.shortcode`
  // compares byte-for-byte, so a lowercase code would silently match nothing
  // instead of being canonicalized — the #591 bug class, guarded generically
  // by `shortcode.integration.test.ts`. `resolveLiveShortcodes` also means an
  // unknown/malformed/soft-deleted code resolves to nothing rather than
  // throwing, matching every other filter here.
  const candidateProductUuids = candidateProductIds
    ? [
        ...(
          await resolveLiveShortcodes(db, candidateProductIds, "product")
        ).values(),
      ]
    : undefined;
  const candidateFilter = candidateProductUuids
    ? candidateProductUuids.length > 0
      ? sql`EXISTS (
        SELECT 1 FROM "WishCandidate" wc
        JOIN "Product" p ON p."id" = wc."productId" AND p."deletedAt" IS NULL
        WHERE wc."wishId" = ${wish.id}
          AND wc."deletedAt" IS NULL
          AND p."id" IN (${sql.join(
            candidateProductUuids.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})
      )`
      : // A candidateProductId WAS supplied but none of it resolved to a live
        // product — must match nothing, not drop the constraint (same
        // requested-but-unresolved handling `expense/lookup.ts` uses for
        // `productId`/`vendorId`/`purchaseId`).
        sql`false`
    : undefined;
  const search = filters.search
    ? or(
        formatSearchTerm(wish.name, filters.search),
        formatSearchTerm(wish.notes, filters.search),
        sql`EXISTS (
          SELECT 1 FROM "WishCandidate" wc
          JOIN "Product" p ON p."id" = wc."productId" AND p."deletedAt" IS NULL
          WHERE wc."wishId" = ${wish.id}
            AND wc."deletedAt" IS NULL
            AND ${candidateProductSearch(filters.search)}
        )`,
      )
    : undefined;
  // The name/notes/candidate search is an OR across columns (see `search`
  // above), not the per-column AND a declared stored predicate would apply —
  // so it goes in via `computed` instead, alongside `acquired` (a declared
  // stored boolean over the nullable `acquiredAt`, applied by
  // `wishScaffold.where` before the conditions below).
  return wishScaffold.where(filters, [
    candidateFilter,
    search,
    // `wishFilterFields` spreads both of these, and the manifest renders their
    // controls — so omitting either here is the same manifest/server drift this
    // entity's UI work set out to remove, just pointing the other way (the UI
    // sends a filter the server silently ignores). Every other related-view
    // source repo applies both.
    ...auditDateWhereConditions(wish, filters),
    ...relatedWhereConditions("wish", filters, wish.id),
  ]);
};

export const wishList = async (
  db: Database,
  filters: WishFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
): Promise<{
  data: WishListItemOut[];
  count: number;
  sums: { priceLow: number; priceHigh: number };
}> => {
  const where = await buildWishWhere(db, filters);
  const { take, skip } = wishScaffold.page(pagination);
  // Footer totals over the WHOLE filtered set, not the loaded page. Summing the
  // returned rows instead would quietly under-report the moment the wishlist
  // outgrows one page — a wrong number is worse than no number.
  const [{ data: rows, count }, [totals]] = await Promise.all([
    executeListQueryWithCount(
      getDb(db)
        .select()
        .from(wish)
        .where(where)
        .orderBy(
          ...wishScaffold.orderBy(sorts, { resolve: resolveWishSort }, filters),
        )
        .limit(take)
        .offset(skip),
      countWhere(db, wish, where),
    ),
    getDb(db)
      .select({
        priceLow: sql<number>`COALESCE(sum(${wishPriceLow}), 0)::double precision`,
        priceHigh: sql<number>`COALESCE(sum(${wishPriceHigh}), 0)::double precision`,
      })
      .from(wish)
      .where(where),
  ]);
  const hydrated = await hydrateWishes(db, rows);
  // Display images key on the row uuid; hydrated rows already carry the
  // public shortcode as `id`, so pair each raw row with its output.
  const paired = rows.map((row, index) => ({
    id: row.id,
    out: hydrated[index]!,
  }));
  return {
    data: await withDisplayImages(db, "wish", paired, (entry) => entry.out),
    count,
    sums: {
      priceLow: Number(totals?.priceLow ?? 0),
      priceHigh: Number(totals?.priceHigh ?? 0),
    },
  };
};

const getWishByID = async (db: Database, id: WishId): Promise<WishOut> => {
  const row = await getDb(db).query.wish.findFirst({
    where: and(eq(wish.id, id), notDeleted(wish)),
  });
  if (!row) throw createAppError("WISH_NOT_FOUND", `Wish not found: ${id}`);
  return (await hydrateWishes(db, [row]))[0]!;
};

export const getWishByShortcode = async (
  db: Database,
  shortcode: string,
): Promise<WishOut | null> => {
  const id = await resolveLiveShortcode(db, shortcode, "wish");
  return id ? getWishByID(db, id) : null;
};

async function resolveToolProductIds(
  tx: DrizzleTransaction,
  shortcodes: readonly string[],
): Promise<ProductId[]> {
  const codes = uniq(shortcodes);
  const resolved = await resolveLiveShortcodes(tx, codes, "product");
  if (resolved.size !== codes.length) {
    throw createAppError(
      "PRODUCT_NOT_FOUND",
      "Every Wishlist candidate must be a live Tool Product.",
    );
  }
  const ids = codes.map((code) => resolved.get(code)!);
  const tools = await tx.query.product.findMany({
    where: and(
      inArray(product.id, ids),
      categoryFeatureSql(sql`${product.categoryId}`, "tools"),
      notDeleted(product),
    ),
    columns: { id: true },
  });
  if (tools.length !== ids.length) {
    throw createAppError(
      "PRODUCT_NOT_FOUND",
      "Every Wishlist candidate must have category Tools.",
    );
  }
  return ids;
}

export const createWish = async (
  db: Database,
  data: WishCreateInput,
  actor: ActorContext,
): Promise<{ output: WishOut; entityId: WishId }> => {
  const id = await withTransaction(db, async (tx) => {
    const productIds = await resolveToolProductIds(
      tx,
      data.candidateProductIds,
    );
    const created = await insertWithShortcode(tx, "wish", {
      name: data.name,
      notes: data.notes,
    });
    if (productIds.length) {
      await tx
        .insert(wishCandidate)
        .values(
          productIds.map((productId) => ({ wishId: created.id, productId })),
        );
    }
    await logAuditEntry(tx, actor, {
      entityType: "wish",
      entityId: created.id,
      action: "create",
    });
    return created.id;
  });
  return { output: await getWishByID(db, id), entityId: id };
};

const candidateShortcodes = async (tx: DrizzleTransaction, id: WishId) => {
  const rows = await tx
    .select({ shortcode: product.shortcode })
    .from(wishCandidate)
    .innerJoin(product, eq(product.id, wishCandidate.productId))
    .where(
      and(
        eq(wishCandidate.wishId, id),
        notDeleted(wishCandidate),
        notDeleted(product),
      ),
    )
    .orderBy(asc(product.shortcode));
  return rows.map((row) => row.shortcode);
};

export const updateWish = async (
  db: Database,
  shortcode: WishShortcode,
  data: WishUpdateData,
  actor: ActorContext,
): Promise<{ output: WishOut; entityId: WishId }> => {
  const id = await resolveOrThrow(db, "wish", shortcode);
  await withTransaction(db, async (tx) => {
    const before = await tx.query.wish.findFirst({
      where: and(eq(wish.id, id), notDeleted(wish)),
    });
    if (!before)
      throw createAppError("WISH_NOT_FOUND", `Wish not found: ${shortcode}`);
    const beforeCandidates = await candidateShortcodes(tx, id);
    let afterCandidates = beforeCandidates;
    if (data.candidateProductIds !== undefined) {
      const nextIds = await resolveToolProductIds(tx, data.candidateProductIds);
      const currentRows = await tx.query.wishCandidate.findMany({
        where: and(eq(wishCandidate.wishId, id), notDeleted(wishCandidate)),
        columns: { productId: true },
      });
      const currentIds = new Set(currentRows.map((row) => row.productId));
      const nextIdSet = new Set(nextIds);
      const now = new Date();
      const removeIds = [...currentIds].filter(
        (productId) => !nextIdSet.has(productId),
      );
      if (removeIds.length) {
        await tx
          .update(wishCandidate)
          .set({ deletedAt: now })
          .where(
            and(
              eq(wishCandidate.wishId, id),
              inArray(wishCandidate.productId, removeIds),
              notDeleted(wishCandidate),
            ),
          );
      }
      const addIds = nextIds.filter((productId) => !currentIds.has(productId));
      if (addIds.length) {
        await tx
          .insert(wishCandidate)
          .values(addIds.map((productId) => ({ wishId: id, productId })));
      }
      afterCandidates = await candidateShortcodes(tx, id);
    }
    const acquiredAt =
      data.acquired === undefined
        ? undefined
        : data.acquired
          ? (before.acquiredAt ?? new Date())
          : null;
    const updated = await updateLiveAndReturn(
      tx,
      wish,
      {
        name: data.name,
        notes: data.notes,
        acquiredAt,
        updatedAt:
          data.candidateProductIds === undefined &&
          acquiredAt === undefined &&
          data.name === undefined &&
          data.notes === undefined
            ? undefined
            : new Date(),
      },
      id,
    );
    const changes = computeChanges(
      { ...before, candidateProductIds: beforeCandidates },
      { ...updated, candidateProductIds: afterCandidates },
      [...entityFieldModels.wish.audit],
    );
    if (changes)
      await logAuditEntry(tx, actor, {
        entityType: "wish",
        entityId: id,
        action: "update",
        changes,
      });
  });
  return { output: await getWishByID(db, id), entityId: id };
};

export const deleteWishes = async (
  db: Database,
  shortcodes: WishShortcode[],
  actor: ActorContext,
): Promise<{ deleted: number }> => {
  const ids = await resolveAllOrThrow(db, "wish", shortcodes);
  return await withTransaction(db, async (tx) => {
    await lockAndValidateForDelete(tx, wish, ids, "Wish");
    const { deleted } = await removeEntity(tx, {
      entity: "wish",
      ids,
      removal: "soft",
      actor,
      children: [
        {
          table: wishCandidate,
          parentColumns: [wishCandidate.wishId],
          auditKey: "cascadedCandidates",
        },
      ],
    });
    return { deleted };
  });
};
