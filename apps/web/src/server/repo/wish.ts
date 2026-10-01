import type { ActorContext } from "@cubby/schemas/context";
import type { DataQuality } from "@cubby/schemas/data-quality";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
import {
  type ProductId,
  parseEntityId,
  parseShortcodeFor,
  type WishId,
  type WishShortcode,
} from "@cubby/schemas/identifiers";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import type {
  WishCreateInput,
  WishFilters,
  WishOut,
  WishUpdateData,
} from "@cubby/schemas/wish";
import { wishListItemOut } from "@cubby/schemas/wish";
import { wishPriceRange } from "@cubby/schemas/wish-fields";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { uniq } from "es-toolkit";

import type { Database, DrizzleTransaction } from "~/server/db";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import { entityLink, product, wish } from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { logAuditEntry } from "~/server/repo/audit-log";
import { loadDataQualities } from "~/server/repo/data-quality/hydrate";
import {
  formatSearchTerm,
  getDb,
  notDeleted,
  unwrapDb,
  withTransaction,
} from "~/server/repo/database-helpers";
import {
  attachLinks,
  liveLinks,
  replaceLinkSet,
} from "~/server/repo/entity-links";
import { listScaffold } from "~/server/repo/list";
import {
  listGroupFields,
  hydrateListRead,
  loadListGroup,
  type ListProjection,
} from "~/server/repo/list-projection";
import {
  effectiveProductPriceSql,
  loadProductPricing,
  resolveProductPricing,
} from "~/server/repo/product/pricing";
import {
  asActor,
  createEntityCrud,
  defineRepository,
  listOn,
  listReadOn,
  onDb,
} from "~/server/repo/repository";
import {
  resolveLiveShortcodes,
  resolveOrThrow,
} from "~/server/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { completeListReader } from "./list-read-adapters";

type WishRow = typeof wish.$inferSelect;

const WISH_DELETE_EDGE_POLICY = {
  "EntityLink[wishCandidate].from": {
    code: "soft-delete-candidate-alternatives",
    effect: "soft-delete",
    description:
      "Deleting a wishlist item soft-deletes its candidate alternatives; the products themselves are unchanged.",
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
      wishId: entityLink.fromEntityId,
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
    .from(entityLink)
    .innerJoin(product, eq(product.id, entityLink.toEntityId))
    .where(
      and(
        inArray(entityLink.fromEntityId, [...wishIds]),
        liveLinks("wishCandidate"),
        notDeleted(product),
      ),
    )
    .orderBy(asc(product.manufacturer), asc(product.name), asc(product.model));
  const pricing = await loadProductPricing(db, rows);
  const byWish = new Map<WishId, CandidateRow[]>();
  for (const row of rows) {
    const wishId = parseEntityId("wish", row.wishId);
    const candidate = {
      ...row,
      wishId,
      inventoried: Boolean(row.inventoried),
      price:
        pricing.get(row.id)?.effectivePrice ??
        resolveProductPricing(row.price).effectivePrice,
    };
    byWish.set(wishId, [...(byWish.get(wishId) ?? []), candidate]);
  }
  return byWish;
};

const publicWishCandidates = (candidates: CandidateRow[]) =>
  candidates.map((candidate) => ({
    id: parseShortcodeFor("product", candidate.shortcode),
    name: candidate.name,
    manufacturer: candidate.manufacturer,
    model: candidate.model,
    price: candidate.price,
    inventoried: candidate.inventoried,
  }));

const toWishOut = (
  row: WishRow,
  candidates: CandidateRow[],
  dataQuality: DataQuality,
): WishOut => {
  const publicCandidates = publicWishCandidates(candidates);
  return {
    id: parseShortcodeFor("wish", row.shortcode),
    name: row.name,
    notes: row.notes,
    acquiredAt: row.acquiredAt,
    candidates: publicCandidates,
    candidateCount: publicCandidates.length,
    priceRange: wishPriceRange(publicCandidates),
    dataQuality,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
};

const hydrateWishes = async (
  db: Database | DrizzleTransaction,
  rows: WishRow[],
): Promise<WishOut[]> => {
  const [candidates, dataQualities] = await Promise.all([
    candidateRowsForWishes(
      db,
      rows.map((row) => row.id),
    ),
    loadDataQualities(
      db,
      "wish",
      rows.map((row) => row.id),
    ),
  ]);
  return rows.map((row) =>
    toWishOut(
      row,
      candidates.get(row.id) ?? [],
      // SAFETY: `row` came from `rows`, which `dataQualities` was loaded for.
      dataQualities.get(row.id)!,
    ),
  );
};

const hydrateWishesRead = (
  db: Database,
  rows: WishRow[],
  projection: ListProjection,
) =>
  hydrateListRead(db, "wish", rows, projection, {
    media: true,
    load: () =>
      loadListGroup(projection, ["relations", "derived"], () =>
        candidateRowsForWishes(
          db,
          rows.map((row) => row.id),
        ),
      ),
    mapRow: (row, { loaded: candidates }) => {
      const alternatives = publicWishCandidates(candidates?.get(row.id) ?? []);
      return {
        ...row,
        id: parseShortcodeFor("wish", row.shortcode),
        ...listGroupFields(projection, ["relations", "derived"], () => ({
          candidates: alternatives,
          candidateCount: alternatives.length,
          priceRange: wishPriceRange(alternatives),
        })),
      };
    },
  });

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
 * `wishCandidate` links, so a subquery without them would price alternatives the
 * user already removed.
 */
const candidatePriceAggregate = (fn: "min" | "max") => sql`(
    SELECT ${sql.raw(fn)}(${sql.raw(effectiveProductPriceSql("p"))})
    FROM "EntityLink" wc
    JOIN "Product" p ON p."id" = wc."toEntityId" AND p."deletedAt" IS NULL
    WHERE wc."fromEntityId" = ${wish.id} AND wc."deletedAt" IS NULL AND wc."kind" = 'wishCandidate'
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
        SELECT 1 FROM "EntityLink" wc
        JOIN "Product" p ON p."id" = wc."toEntityId" AND p."deletedAt" IS NULL
        WHERE wc."fromEntityId" = ${wish.id}
          AND wc."deletedAt" IS NULL AND wc."kind" = 'wishCandidate'
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
          SELECT 1 FROM "EntityLink" wc
          JOIN "Product" p ON p."id" = wc."toEntityId" AND p."deletedAt" IS NULL
          WHERE wc."fromEntityId" = ${wish.id}
            AND wc."deletedAt" IS NULL AND wc."kind" = 'wishCandidate'
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
  ]);
};

export const wishListRead = async (
  db: Database,
  filters: WishFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
  projection: ListProjection = { kind: "full" },
) => {
  const where = await buildWishWhere(db, filters);
  return wishScaffold.list(
    db,
    { filters, sorts, pagination, projection },
    {
      where,
      resolveSort: resolveWishSort,
      hydrate: (rows) => hydrateWishesRead(db, rows, projection),
    },
  );
};

export const wishListSummary = async (db: Database, filters: WishFilters) => {
  const [totals] = await getDb(db)
    .select({
      priceLow: sql<number>`COALESCE(sum(${wishPriceLow}), 0)::double precision`,
      priceHigh: sql<number>`COALESCE(sum(${wishPriceHigh}), 0)::double precision`,
    })
    .from(wish)
    .where(await buildWishWhere(db, filters));
  return {
    priceLow: Number(totals?.priceLow ?? 0),
    priceHigh: Number(totals?.priceHigh ?? 0),
  };
};

export const wishList = completeListReader(
  wishListItemOut,
  wishListRead,
  wishListSummary,
);

const candidateShortcodes = async (
  tx: Database | DrizzleTransaction,
  id: WishId,
) => {
  const rows = await unwrapDb(tx)
    .select({ shortcode: product.shortcode })
    .from(entityLink)
    .innerJoin(product, eq(product.id, entityLink.toEntityId))
    .where(
      and(
        eq(entityLink.fromEntityId, id),
        liveLinks("wishCandidate"),
        notDeleted(product),
      ),
    )
    .orderBy(asc(product.shortcode));
  return rows.map((row) => row.shortcode);
};

const wishCrud = createEntityCrud({
  entity: "wish",
  table: wish,
  fetchById: (db, id) =>
    unwrapDb(db).query.wish.findFirst({
      where: and(eq(wish.id, id), notDeleted(wish)),
    }),
  fromDB: async (db, row) => (await hydrateWishes(db, [row]))[0]!,
  toUpdate: (data: WishUpdateData, before) => {
    const acquiredAt =
      data.acquired === undefined
        ? undefined
        : data.acquired
          ? (before.acquiredAt ?? new Date())
          : null;
    return {
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
    };
  },
  auditUpdateFields: [...entityFieldModels.wish.audit],
  // The candidate set is a link set, not a column, but it is audited as the
  // `candidateProductIds` field.
  relations: {
    read: async (tx, id) => ({
      candidateProductIds: await candidateShortcodes(tx, id),
    }),
    write: async (tx, id, data) => {
      if (data.candidateProductIds === undefined) return;
      await replaceLinkSet(
        tx,
        "wishCandidate",
        id,
        await resolveCandidateProductIds(tx, data.candidateProductIds),
      );
    },
  },
});
const getWishByID = wishCrud.getByID;
const getWishByShortcode = wishCrud.getByShortcode;

/** Any live Product can be a wish candidate — the only requirement is that it
 * exists and is live. */
async function resolveCandidateProductIds(
  tx: Database | DrizzleTransaction,
  shortcodes: readonly string[],
): Promise<ProductId[]> {
  const codes = uniq(shortcodes);
  const resolved = await resolveLiveShortcodes(tx, codes, "product");
  if (resolved.size !== codes.length) {
    throw createAppError(
      "PRODUCT_NOT_FOUND",
      "Every Wishlist candidate must be a live Product.",
    );
  }
  return codes.map((code) => resolved.get(code)!);
}

export const createWish = async (
  db: Database,
  data: WishCreateInput,
  actor: ActorContext,
): Promise<{ output: WishOut; entityId: WishId }> => {
  const id = await withTransaction(db, async (tx) => {
    const productIds = await resolveCandidateProductIds(
      tx,
      data.candidateProductIds,
    );
    const created = await insertWithShortcode(tx, "wish", {
      name: data.name,
      notes: data.notes,
    });
    await attachLinks(
      tx,
      "wishCandidate",
      productIds.map((productId) => ({ from: created.id, to: productId })),
    );
    await logAuditEntry(tx, actor, {
      entityKind: "wish",
      entityId: created.id,
      action: "create",
    });
    return created.id;
  });
  return { output: await getWishByID(db, id), entityId: id };
};

export const updateWish = async (
  db: Database,
  shortcode: WishShortcode,
  data: WishUpdateData,
  actor: ActorContext,
): Promise<{ output: WishOut; entityId: WishId }> => {
  const id = await resolveOrThrow(db, "wish", shortcode);
  return { output: await wishCrud.update(db, id, data, actor), entityId: id };
};

export const wishRepository = defineRepository("wish", {
  lifecycle: { delete: WISH_DELETE_EDGE_POLICY },
  get: onDb(getWishByShortcode),
  list: listOn(wishList),
  listRead: listReadOn(wishListRead),
  listSummary: (ctx, filters) => wishListSummary(ctx.db, filters),
  create: asActor(createWish),
  update: asActor(updateWish),
});
