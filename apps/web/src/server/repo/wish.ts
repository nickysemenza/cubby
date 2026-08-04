import type { ActorContext } from "@cubby/schemas/context";
import type {
  ImpactItem,
  OperationDisposition,
} from "@cubby/schemas/entity-integrity";
import {
  type ProductId,
  unsafeProductId,
  unsafeProductShortcode,
  unsafeWishId,
  unsafeWishShortcode,
  type WishId,
  type WishShortcode,
} from "@cubby/schemas/identifiers";
import {
  buildTakeSkip,
  type PaginationParams,
  type SortParams,
} from "@cubby/schemas/pagination";
import type {
  WishCreateInput,
  WishFilters,
  WishOut,
  WishUpdateInput,
} from "@cubby/schemas/wish";
import { wishSortableFields } from "@cubby/schemas/wish";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { uniq } from "es-toolkit";
import type { Database, DrizzleTransaction } from "~/server/db";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import { product, wish, wishCandidate } from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { computeChanges, logAuditEntry } from "~/server/repo/audit-log";
import {
  auditDateWhereConditions,
  buildOrderBy,
  countWhere,
  formatSearchTerm,
  getDb,
  lockAndValidateForDelete,
  notDeleted,
  unwrapDb,
  updateLiveAndReturn,
  withTransaction,
} from "~/server/repo/database-helpers";
import { softDeleteEntityEmbeddingsTx } from "~/server/repo/entity-embedding-cleanup";
import { countByTarget, impact, present } from "~/server/repo/impact";
import {
  loadProductPricing,
  resolveProductPricing,
} from "~/server/repo/product/pricing";
import { relatedWhereConditions } from "~/server/repo/related-view";
import {
  resolveLiveShortcode,
  resolveLiveShortcodes,
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

const toWishOut = (row: WishRow, candidates: CandidateRow[]): WishOut => ({
  id: unsafeWishShortcode(row.shortcode),
  name: row.name,
  notes: row.notes,
  acquiredAt: row.acquiredAt,
  candidates: candidates.map((candidate) => ({
    id: unsafeProductShortcode(candidate.shortcode),
    name: candidate.name,
    manufacturer: candidate.manufacturer,
    model: candidate.model,
    price: candidate.price,
    inventoried: candidate.inventoried,
  })),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

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

const buildWishWhere = (filters: WishFilters) => {
  const candidateProductIds = filters.candidateProductId
    ? Array.isArray(filters.candidateProductId)
      ? filters.candidateProductId
      : [filters.candidateProductId]
    : undefined;
  const candidateFilter = candidateProductIds
    ? sql`EXISTS (
        SELECT 1 FROM "WishCandidate" wc
        JOIN "Product" p ON p."id" = wc."productId" AND p."deletedAt" IS NULL
        WHERE wc."wishId" = ${wish.id}
          AND wc."deletedAt" IS NULL
          AND p."shortcode" IN (${sql.join(
            candidateProductIds.map((id) => sql`${id}`),
            sql`, `,
          )})
      )`
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
  return and(
    notDeleted(wish),
    filters.acquired === undefined
      ? undefined
      : filters.acquired
        ? sql`${wish.acquiredAt} IS NOT NULL`
        : sql`${wish.acquiredAt} IS NULL`,
    candidateFilter,
    search,
    // `wishFilterFields` spreads both of these, and the manifest renders their
    // controls — so omitting either here is the same manifest/server drift this
    // entity's UI work set out to remove, just pointing the other way (the UI
    // sends a filter the server silently ignores). Every other related-view
    // source repo applies both.
    ...auditDateWhereConditions(wish, filters),
    ...relatedWhereConditions("wish", filters, wish.id),
  );
};

export const wishList = async (
  db: Database,
  filters: WishFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
): Promise<{ data: WishOut[]; count: number }> => {
  const where = buildWishWhere(filters);
  const { take, skip } = buildTakeSkip(pagination);
  const [rows, count] = await Promise.all([
    getDb(db)
      .select()
      .from(wish)
      .where(where)
      .orderBy(...buildOrderBy(wish, sorts, [...wishSortableFields]))
      .limit(take)
      .offset(skip),
    countWhere(db, wish, where),
  ]);
  return { data: await hydrateWishes(db, rows), count };
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
  return id ? getWishByID(db, unsafeWishId(id)) : null;
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
  const ids = codes.map((code) => unsafeProductId(resolved.get(code)!));
  const tools = await tx.query.product.findMany({
    where: and(
      inArray(product.id, ids),
      eq(product.category, "tools"),
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
  input: WishUpdateInput,
  actor: ActorContext,
): Promise<{ output: WishOut; entityId: WishId }> => {
  const resolved = await resolveLiveShortcode(db, input.id, "wish");
  if (!resolved)
    throw createAppError("WISH_NOT_FOUND", `Wish not found: ${input.id}`);
  const id = unsafeWishId(resolved);
  await withTransaction(db, async (tx) => {
    const before = await tx.query.wish.findFirst({
      where: and(eq(wish.id, id), notDeleted(wish)),
    });
    if (!before)
      throw createAppError("WISH_NOT_FOUND", `Wish not found: ${input.id}`);
    const beforeCandidates = await candidateShortcodes(tx, id);
    let afterCandidates = beforeCandidates;
    if (input.data.candidateProductIds !== undefined) {
      const nextIds = await resolveToolProductIds(
        tx,
        input.data.candidateProductIds,
      );
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
      input.data.acquired === undefined
        ? undefined
        : input.data.acquired
          ? (before.acquiredAt ?? new Date())
          : null;
    const updated = await updateLiveAndReturn(
      tx,
      wish,
      {
        name: input.data.name,
        notes: input.data.notes,
        acquiredAt,
        updatedAt:
          input.data.candidateProductIds === undefined &&
          acquiredAt === undefined &&
          input.data.name === undefined &&
          input.data.notes === undefined
            ? undefined
            : new Date(),
      },
      id,
    );
    const changes = computeChanges(
      { ...before, candidateProductIds: beforeCandidates },
      { ...updated, candidateProductIds: afterCandidates },
      ["name", "notes", "acquiredAt", "candidateProductIds"],
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
): Promise<void> => {
  const ids = await Promise.all(
    shortcodes.map(async (shortcode) => {
      const id = await resolveLiveShortcode(db, shortcode, "wish");
      if (!id)
        throw createAppError("WISH_NOT_FOUND", `Wish not found: ${shortcode}`);
      return unsafeWishId(id);
    }),
  );
  await withTransaction(db, async (tx) => {
    await lockAndValidateForDelete(tx, wish, ids, "Wish");
    const now = new Date();
    await tx
      .update(wishCandidate)
      .set({ deletedAt: now })
      .where(
        and(inArray(wishCandidate.wishId, ids), notDeleted(wishCandidate)),
      );
    await tx
      .update(wish)
      .set({ deletedAt: now })
      .where(and(inArray(wish.id, ids), notDeleted(wish)));
    await softDeleteEntityEmbeddingsTx(tx, "wish", ids);
    for (const id of ids)
      await logAuditEntry(tx, actor, {
        entityType: "wish",
        entityId: id,
        action: "delete",
      });
  });
};

/** Advisory impact for the owned candidate rows soft-deleted with a wish. */
export const previewDeleteWishes = async (
  db: Database,
  ids: WishId[],
): Promise<{ blockers: ImpactItem[]; changes: ImpactItem[] }> => {
  if (ids.length === 0) return { blockers: [], changes: [] };
  return {
    blockers: [],
    changes: present([
      impact({
        disposition: WISH_DELETE_EDGE_POLICY["WishCandidate.wishId"],
        edgeKey: "WishCandidate.wishId",
        label: "Tool alternatives",
        byTargetId: await countByTarget(
          getDb(db),
          wishCandidate,
          wishCandidate.wishId,
          ids,
        ),
      }),
    ]),
  };
};
