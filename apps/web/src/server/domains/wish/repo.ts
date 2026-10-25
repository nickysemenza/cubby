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
import {
  wishPriceRangeOut,
  type WishPriceRange,
} from "@cubby/schemas/wish-fields";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { uniq } from "es-toolkit";

import type { Database, DrizzleTransaction } from "~/server/db";
import { productBrandNameSql } from "~/server/db/computed/product-brand-sql";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import {
  getDb,
  notDeleted,
  unwrapDb,
  withTransaction,
} from "~/server/db/helpers";
import type { ListReadIntent } from "~/server/db/helpers/query";
import { quotedTable } from "~/server/db/helpers/related";
import { entityLink, product, wish } from "~/server/db/schema";
import { effectiveProductPriceSql } from "~/server/domains/product/repo/pricing";
import { wishCandidateItems } from "~/server/entity-kernel/repo/detail-display-labels";
import {
  type MutationReceipt,
  defineMutationWriter,
} from "~/server/entity-kernel/repo/repository";
import {
  asActor,
  createEntityCrud,
  createEntityRowFetcher,
  defineRepository,
  listOn,
  listReadOn,
  onDb,
} from "~/server/entity-kernel/repo/repository";
import { createAppError } from "~/server/errors/app-error";
import { logAuditEntry } from "~/server/generic/audit-log/repo/audit-log";
import { loadDataQualities } from "~/server/generic/data-quality/repo/hydrate";
import {
  attachLinks,
  liveLinks,
  replaceLinkSet,
} from "~/server/generic/entity-links/repo/entity-links";
import { listScaffold } from "~/server/generic/list/repo/list";
import type { ListProjection } from "~/server/generic/list/repo/list-contracts";
import { type ListReadOptions } from "~/server/generic/list/repo/list-projection";
import { completeListReader } from "~/server/generic/list/repo/list-read-adapters";
import {
  resolveLiveShortcodes,
  resolveOrThrow,
} from "~/server/generic/shortcode/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { wishPriceRangeSql } from "./price-range";

type WishRow = typeof wish.$inferSelect;

const WISH_DELETE_EDGE_POLICY = {
  "EntityLink[wishCandidate].from": {
    code: "soft-delete-candidate-alternatives",
    effect: "soft-delete",
    description:
      "Deleting a wishlist item soft-deletes its candidate alternatives; the products themselves are unchanged.",
  },
} as const satisfies IncomingEdgePolicy<"wish", OperationDisposition>;
type CandidateRow = Pick<
  typeof product.$inferSelect,
  "id" | "shortcode" | "name" | "model" | "price" | "createdAt" | "updatedAt"
> & {
  brandName: string | null;
  wishId: WishId;
  inventoried: boolean;
  priceRange: WishPriceRange | null;
};

const candidateRowsForWishes = async (
  db: Database | DrizzleTransaction,
  wishIds: readonly WishId[],
): Promise<Map<WishId, CandidateRow[]>> => {
  if (wishIds.length === 0) return new Map();
  const candidates = unwrapDb(db)
    .select({
      wishId: entityLink.fromEntityId,
      id: product.id,
      shortcode: product.shortcode,
      name: product.name,
      brandName: productBrandNameSql(product.brandId).as("brandName"),
      model: product.model,
      price: sql<
        number | null
      >`${sql.raw(effectiveProductPriceSql(quotedTable(product)))}`.as("price"),
      createdAt: product.createdAt,
      updatedAt: product.updatedAt,
      // includes-installed: excluding installed rows would make the wish
      // list recommend re-buying a product already installed in the wall.
      inventoried: sql<boolean>`EXISTS (
        SELECT 1 FROM "InventoryEntry" ie
        WHERE ie."productId" = ${product.id} AND ie."deletedAt" IS NULL
      )`.as("inventoried"),
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
    .as("wish_candidates");
  const rows = await unwrapDb(db)
    .select({
      wishId: candidates.wishId,
      id: candidates.id,
      shortcode: candidates.shortcode,
      name: candidates.name,
      brandName: candidates.brandName,
      model: candidates.model,
      price: candidates.price,
      createdAt: candidates.createdAt,
      updatedAt: candidates.updatedAt,
      inventoried: candidates.inventoried,
      priceRange: wishPriceRangeSql(
        sql`${candidates.price}`,
        sql`${candidates.wishId}`,
      ),
    })
    .from(candidates)
    .orderBy(
      asc(candidates.brandName),
      asc(candidates.name),
      asc(candidates.model),
    );
  const byWish = new Map<WishId, CandidateRow[]>();
  for (const row of rows) {
    const wishId = parseEntityId("wish", row.wishId);
    const candidate = {
      ...row,
      wishId,
      inventoried: Boolean(row.inventoried),
    };
    byWish.set(wishId, [...(byWish.get(wishId) ?? []), candidate]);
  }
  return byWish;
};

const publicWishCandidates = (candidates: CandidateRow[]) =>
  candidates.map((candidate) => ({
    id: parseShortcodeFor("product", candidate.shortcode),
    name: candidate.name,
    brandName: candidate.brandName,
    model: candidate.model,
    price: candidate.price,
    inventoried: candidate.inventoried,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
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
    candidateItems: wishCandidateItems(publicCandidates),
    candidateCount: publicCandidates.length,
    priceRange: candidates[0]?.priceRange ?? null,
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

const wishRead = {
  media: true,
  bindings: (bind) => {
    const candidates = bind.batch(({ db, rows }) =>
      candidateRowsForWishes(
        db,
        rows.map((row) => row.id),
      ),
    );
    return [
      candidates.fields(
        wishListItemOut.pick({
          candidates: true,
          candidateItems: true,
          candidateCount: true,
          priceRange: true,
        }),
        (row, loaded) => {
          const alternatives = publicWishCandidates(loaded.get(row.id) ?? []);
          return {
            candidates: alternatives,
            candidateItems: wishCandidateItems(alternatives),
            candidateCount: alternatives.length,
            priceRange: loaded.get(row.id)?.[0]?.priceRange ?? null,
          };
        },
      ),
    ];
  },
} satisfies ListReadOptions<WishRow>;

/** The same aggregate used by page hydration, scoped to one wish for sorting/totals. */
const wishPriceRangeProjection = sql`(
    SELECT ${wishPriceRangeSql(sql.raw(effectiveProductPriceSql("p")))}
    FROM "EntityLink" wc
    JOIN "Product" p ON p."id" = wc."toEntityId" AND p."deletedAt" IS NULL
    WHERE wc."fromEntityId" = ${wish.id} AND wc."deletedAt" IS NULL AND wc."kind" = 'wishCandidate'
  )`;
const wishPriceLow = sql`(${wishPriceRangeProjection} ->> ${wishPriceRangeOut.keyof().enum.low})::double precision`;
const wishPriceHigh = sql`(${wishPriceRangeProjection} ->> ${wishPriceRangeOut.keyof().enum.high})::double precision`;
/** Midpoint of the range — the repo's deterministic sort key for ranged values. */
const wishPriceMid = sql`((${wishPriceLow} + ${wishPriceHigh}) / 2)`;

// A price range is an aggregate over candidates, not a column on `Wish`; a
// wish whose alternatives are all unpriced has no range at all.
const wishScaffold = listScaffold("wish", wish, {
  derived: {
    priceRange: wishPriceMid,
  },
});

/** The complete WHERE for this entity's list. `getEntityCounts` calls it with `{}` — see repo/dashboard.ts. */
export const buildWishWhere = (filters: WishFilters) =>
  wishScaffold.where(filters);

export const wishListRead = async (
  db: Database,
  filters: WishFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
  projection: ListProjection = { kind: "full" },
  readIntent: ListReadIntent = "page",
) => {
  return wishScaffold.read(
    db,
    { filters, sorts, pagination, projection, readIntent },
    {
      read: wishRead,
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
    .where(buildWishWhere(filters));
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
  fetchById: createEntityRowFetcher(wish),
  fromDB: async (db, row: WishRow) => (await hydrateWishes(db, [row]))[0]!,
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
    read: async (tx, id, data) =>
      data.candidateProductIds === undefined
        ? {}
        : {
            candidateProductIds: await candidateShortcodes(tx, id),
          },
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

export const createWish = defineMutationWriter({
  entity: "wish",
  read: async (
    receipt: MutationReceipt<"wish">,
    db: Database,
    _data: WishCreateInput,
    _actor: ActorContext,
  ) => ({
    output: await getWishByID(db, receipt.entityId),
    entityId: receipt.entityId,
  }),
  write: async (
    readOutput,
    db: Database,
    data: WishCreateInput,
    actor: ActorContext,
  ) => {
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
    return readOutput({ entityId: id });
  },
});

export const updateWish = defineMutationWriter({
  entity: "wish",
  read: async (
    receipt: MutationReceipt<"wish">,
    db: Database,
    _shortcode: WishShortcode,
    _data: WishUpdateData,
    _actor: ActorContext,
  ) => ({
    output: await getWishByID(db, receipt.entityId),
    entityId: receipt.entityId,
  }),
  write: async (
    readOutput,
    db: Database,
    shortcode: WishShortcode,
    data: WishUpdateData,
    actor: ActorContext,
  ) => {
    const id = await resolveOrThrow(db, "wish", shortcode);
    return wishCrud.update(db, id, data, actor, async (readDb, receipt) =>
      readOutput(receipt, async () => ({
        output: await wishCrud.getByID(readDb, id),
        entityId: id,
      })),
    );
  },
});

export const wishRepository = defineRepository("wish", {
  lifecycle: { delete: WISH_DELETE_EDGE_POLICY },
  get: onDb(getWishByShortcode),
  list: listOn(wishList),
  listRead: listReadOn(wishListRead),
  listSummary: (ctx, filters) => wishListSummary(ctx.db, filters),
  create: asActor(createWish),
  update: asActor(updateWish),
});
