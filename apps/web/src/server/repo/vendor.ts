/**
 * Vendor repository — the roster of places money goes.
 *
 * `Vendor ──< Purchase ──< Expense`. This table exists because `vendor` used to
 * be free text repeated on every ledger row, which left a vendor's own
 * documents and metadata with nowhere to live and made the ledger's Vendor
 * picklist an exact-string match over a `GROUP BY`.
 *
 * No money is stored or summed here. `vendorOut.spend` is a correlated rollup
 * over the vendor's live purchases' live expenses — `SUM(expense.cost)`, the one
 * place spend ever comes from.
 */

import type { ActorContext } from "@cubby/schemas/context";
import type {
  ImpactItem,
  OperationDisposition,
} from "@cubby/schemas/entity-integrity";
import {
  type PurchaseId,
  unsafeVendorId,
  unsafeVendorShortcode,
  type VendorId,
  type VendorShortcode,
} from "@cubby/schemas/identifiers";
import {
  buildTakeSkip,
  type PaginationParams,
  type SortParams,
} from "@cubby/schemas/pagination";
import type {
  VendorCreateInput,
  VendorFilters,
  VendorOptionsOut,
  VendorOut,
  VendorUpdateInput,
} from "@cubby/schemas/vendor";
import { vendorSortableFields } from "@cubby/schemas/vendor";
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { Database, DrizzleTransaction } from "~/server/db";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import {
  expense,
  financialTransactionAllocation,
  image,
  purchase,
  purchaseImage,
  vendor,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { computeChanges, logAuditEntry } from "~/server/repo/audit-log";
import {
  auditDateWhereConditions,
  buildOrderBy,
  buildPartialUpdateValues,
  buildSearchConditions,
  correlated,
  countWhere,
  formatSearchTerm,
  getDb,
  insertAndReturn,
  lockAndValidateForDelete,
  notDeleted,
  updateLiveAndReturn,
  withTransaction,
} from "~/server/repo/database-helpers";
import { reapUnreferencedImages } from "~/server/repo/image";
import {
  displayableImageSql,
  displayableImageWhere,
} from "~/server/repo/image-displayability";
import { countByTarget, impact, present } from "~/server/repo/impact";
import {
  finalizeMerge,
  planSlotCollisions,
  repointEdge,
  resolveMergeTargets,
} from "~/server/repo/merge";
import { foldChargeInto } from "~/server/repo/purchase";
import { relatedWhereConditions } from "~/server/repo/related-view";
import { removeEntity } from "~/server/repo/removal";
import {
  resolveAllOrThrow,
  resolveLiveShortcode,
  resolveOrThrow,
} from "~/server/repo/shortcode-resolver";
import {
  findOrCreateWithShortcode,
  insertWithShortcode,
} from "~/server/repo/shortcode-utils";

export const VENDOR_DELETE_EDGE_POLICY = {
  "Purchase.vendorId": {
    code: "block-live-purchase",
    effect: "block",
    description:
      "A vendor with purchases still pointing at it can't be deleted — those purchases are load-bearing history.",
  },
} as const satisfies IncomingEdgePolicy<"vendor", OperationDisposition>;

export const VENDOR_MERGE_EDGE_POLICY = {
  "Purchase.vendorId": {
    code: "repoint-or-fold-by-order",
    // `move-dedupe`, not `repoint`: re-pointing is only the non-colliding half.
    // Charges that collide on the same order id are folded — moved onto the
    // survivor and soft-deleted — which is the same shape
    // `PurchaseImage.purchaseId` classifies as `move-dedupe` in purchase.ts.
    // Calling it `repoint` understated the destructive half of the operation.
    effect: "move-dedupe",
    description:
      "A merged vendor's purchases re-point onto the surviving vendor; purchases that collide on the same order id are folded into one instead.",
  },
} as const satisfies IncomingEdgePolicy<"vendor", OperationDisposition>;

/**
 * `purchaseCount` and `spend`, as correlated scalar subqueries rather than a
 * `GROUP BY` join.
 *
 * Two reasons for subqueries over joins: the count query for pagination stays
 * untouched, and summing expenses through a join would multiply the vendor row
 * by its purchases and then by their expenses — the classic fan-out double-count.
 * Nesting keeps each aggregate independent.
 *
 * Both guard `deletedAt` at BOTH levels. A soft-deleted charge's expenses must
 * not reach a vendor's spend, and an emptied charge (expenses deleted, charge
 * kept) must read as zero rather than as its old total.
 *
 * Hand-qualified raw SQL wrapped in `correlated()` — see its doc comment in
 * `database-helpers/query.ts`. This file is where that trap showed its loud
 * face: interpolated columns emitted `WHERE "vendorId" = "id"`, which made
 * `/vendors` fail outright with `column reference "id" is ambiguous` and made
 * `vendorOptions` silently count 0.
 */
const vendorPurchaseCount = correlated<number>(
  `(SELECT count(*)::int FROM "Purchase" p
     WHERE p."vendorId" = "Vendor"."id" AND p."deletedAt" IS NULL)`,
);

const vendorSpend = correlated<number>(
  `(SELECT COALESCE(sum(e."cost"), 0)::double precision
      FROM "Expense" e
      INNER JOIN "Purchase" p
        ON p."id" = e."purchaseId" AND p."deletedAt" IS NULL
     WHERE p."vendorId" = "Vendor"."id" AND e."deletedAt" IS NULL)`,
);

const vendorLatestPurchaseDate = correlated<string | null>(
  `(SELECT max(p."date") FROM "Purchase" p
     WHERE p."vendorId" = "Vendor"."id" AND p."deletedAt" IS NULL)`,
);

/** Whether the direct logo FK currently resolves to an image the UI can draw. */
const vendorHasDisplayableLogo = sql<boolean>`EXISTS (
  SELECT 1 FROM "Image" logo
  WHERE logo."id" = ${sql.raw('"Vendor"."logoImageId"')}
    AND logo."deletedAt" IS NULL
    AND ${displayableImageSql("logo")}
)`;

const vendorColumns = {
  id: vendor.id,
  shortcode: vendor.shortcode,
  name: vendor.name,
  website: vendor.website,
  orderUrlTemplate: vendor.orderUrlTemplate,
  notes: vendor.notes,
  createdAt: vendor.createdAt,
  updatedAt: vendor.updatedAt,
  purchaseCount: vendorPurchaseCount,
  spend: vendorSpend,
  latestPurchaseDate: vendorLatestPurchaseDate,
  logo: {
    id: image.id,
    url: image.url,
    key: image.key,
    filename: image.filename,
    size: image.size,
    contentType: image.contentType,
    status: image.status,
    width: image.width,
    height: image.height,
    detectedContentType: image.detectedContentType,
    sha256: image.sha256,
    renderStatus: image.renderStatus,
    storageStatus: image.storageStatus,
    verifiedAt: image.verifiedAt,
    createdAt: image.createdAt,
    updatedAt: image.updatedAt,
  },
} as const;

type VendorRow = {
  id: VendorId;
  shortcode: string;
  name: string;
  website: string | null;
  orderUrlTemplate: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  purchaseCount: number;
  spend: number;
  latestPurchaseDate: string | null;
  logo: {
    id: string;
    url: string;
    key: string;
    filename: string;
    size: number;
    contentType: string;
    status: "PENDING" | "UPLOADED" | "FAILED";
    width: number | null;
    height: number | null;
    detectedContentType: string | null;
    sha256: string | null;
    renderStatus: "unverified" | "verified" | "failed" | null;
    storageStatus:
      | "unverified"
      | "available"
      | "missing"
      | "metadata_mismatch"
      | null;
    verifiedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  } | null;
};

const dbVendorToAPI = (row: VendorRow): VendorOut => ({
  id: unsafeVendorShortcode(row.shortcode),
  name: row.name,
  website: row.website,
  orderUrlTemplate: row.orderUrlTemplate,
  notes: row.notes,
  purchaseCount: Number(row.purchaseCount),
  // `sum()` comes back as a string over the wire on some drivers even when the
  // column is double precision; Number() is the same defensive coercion
  // product/mappers.ts applies to its own aggregates.
  spend: Number(row.spend),
  latestPurchaseDate: row.latestPurchaseDate,
  logo: row.logo,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const buildVendorWhereClause = (filters: VendorFilters) =>
  buildSearchConditions(
    vendor,
    [],
    [
      ...auditDateWhereConditions(vendor, filters),
      filters.purchaseCountMin !== undefined
        ? sql`${vendorPurchaseCount} >= ${filters.purchaseCountMin}`
        : undefined,
      filters.purchaseCountMax !== undefined
        ? sql`${vendorPurchaseCount} <= ${filters.purchaseCountMax}`
        : undefined,
      filters.spendMin !== undefined
        ? sql`${vendorSpend} >= ${filters.spendMin}`
        : undefined,
      filters.spendMax !== undefined
        ? sql`${vendorSpend} <= ${filters.spendMax}`
        : undefined,
      filters.latestPurchaseDatePresenceFilter === "has"
        ? sql`${vendorLatestPurchaseDate} IS NOT NULL`
        : filters.latestPurchaseDatePresenceFilter === "none"
          ? sql`${vendorLatestPurchaseDate} IS NULL`
          : undefined,
      filters.latestPurchaseDateFrom
        ? sql`${vendorLatestPurchaseDate} >= ${filters.latestPurchaseDateFrom}`
        : undefined,
      filters.latestPurchaseDateTo
        ? sql`${vendorLatestPurchaseDate} <= ${filters.latestPurchaseDateTo}`
        : undefined,
      filters.logoPresenceFilter === "has"
        ? sql`${vendorHasDisplayableLogo}`
        : filters.logoPresenceFilter === "none"
          ? sql`NOT ${vendorHasDisplayableLogo}`
          : undefined,
      ...relatedWhereConditions("vendor", filters, vendor.id),
      filters.search
        ? or(
            formatSearchTerm(vendor.name, filters.search),
            formatSearchTerm(vendor.notes, filters.search),
            formatSearchTerm(vendor.website, filters.search),
          )
        : undefined,
    ],
  );

/**
 * Sorts the generic column path can't produce — the two rollups above aren't
 * columns on `Vendor`. NULLS LAST in both directions is the house convention
 * (see `buildOrderBy`), though neither aggregate is ever null: `count(*)` and
 * the `COALESCE`d sum both floor at 0.
 */
const resolveVendorSort = (sort: SortParams) => {
  const dir = sort.direction === "asc" ? asc : desc;
  if (sort.orderBy === "purchaseCount") return [dir(vendorPurchaseCount)];
  if (sort.orderBy === "spend") return [dir(vendorSpend)];
  if (sort.orderBy === "latestPurchaseDate")
    return [dir(vendorLatestPurchaseDate)];
  return null;
};

export const vendorList = async (
  db: Database,
  filters: VendorFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
): Promise<{
  data: VendorOut[];
  count: number;
  sums: { spend: number; purchaseCount: number };
}> => {
  const whereClause = buildVendorWhereClause(filters);
  const { take, skip } = buildTakeSkip(pagination);

  // Footer totals over the WHOLE filtered set, not the loaded page. Summing the
  // returned rows instead would quietly under-report the moment the roster
  // outgrows one page — a wrong number is worse than no number.
  const [rows, count, [totals]] = await Promise.all([
    getDb(db)
      .select(vendorColumns)
      .from(vendor)
      .leftJoin(
        image,
        and(
          eq(image.id, vendor.logoImageId),
          notDeleted(image),
          displayableImageWhere,
        ),
      )
      .where(whereClause)
      .orderBy(
        ...buildOrderBy(vendor, sorts, [...vendorSortableFields], {
          resolve: resolveVendorSort,
        }),
      )
      .limit(take)
      .offset(skip),
    countWhere(db, vendor, whereClause),
    getDb(db)
      .select({
        spend: sql<number>`COALESCE(sum(${vendorSpend}), 0)::double precision`,
        purchaseCount: sql<number>`COALESCE(sum(${vendorPurchaseCount}), 0)::int`,
      })
      .from(vendor)
      .where(whereClause),
  ]);

  return {
    data: rows.map(dbVendorToAPI),
    count,
    sums: {
      spend: Number(totals?.spend ?? 0),
      purchaseCount: Number(totals?.purchaseCount ?? 0),
    },
  };
};

export const getVendorByID = async (
  db: Database,
  id: VendorId,
): Promise<VendorOut> => {
  const [row] = await getDb(db)
    .select(vendorColumns)
    .from(vendor)
    .leftJoin(
      image,
      and(
        eq(image.id, vendor.logoImageId),
        notDeleted(image),
        displayableImageWhere,
      ),
    )
    .where(and(eq(vendor.id, id), notDeleted(vendor)))
    .limit(1);
  if (!row) {
    throw createAppError("VENDOR_NOT_FOUND", `Vendor not found: ${id}`);
  }
  return dbVendorToAPI(row);
};

/**
 * Get full vendor details by shortcode. Returns null if the code doesn't
 * resolve to a live vendor.
 */
export const getVendorByShortcode = async (
  db: Database,
  shortcode: string,
): Promise<VendorOut | null> => {
  const id = await resolveLiveShortcode(db, shortcode, "vendor");
  return id ? getVendorByID(db, unsafeVendorId(id)) : null;
};

/**
 * The vendor picklist — every live vendor with how many live charges point at
 * it, ranked by frequency then alphabetically. Feeds the ledger's Vendor filter
 * and the purchase form's combobox.
 *
 * Unlike its free-text predecessor (`expenseVendorOptions`, a `GROUP BY vendor`
 * over the ledger), this lists vendors that exist but have no charges yet —
 * which is correct now that a vendor is a row you can create before you spend
 * anything at it.
 */
export const vendorOptions = async (
  db: Database,
): Promise<VendorOptionsOut> => {
  const rows = await getDb(db)
    .select({
      shortcode: vendor.shortcode,
      name: vendor.name,
      count: vendorPurchaseCount,
      logoUrl: image.url,
    })
    .from(vendor)
    .leftJoin(
      image,
      and(
        eq(image.id, vendor.logoImageId),
        notDeleted(image),
        displayableImageWhere,
      ),
    )
    .where(notDeleted(vendor))
    .orderBy(desc(vendorPurchaseCount), asc(vendor.name));

  return rows.map((row) => ({
    id: unsafeVendorShortcode(row.shortcode),
    name: row.name,
    count: Number(row.count),
    logo: row.logoUrl ? { url: row.logoUrl } : null,
  }));
};

/**
 * Resolve a vendor NAME to a row, creating it if this is the first time money
 * went there. The import hot path: `createExpense` still accepts `vendor` as a
 * plain string, and this is what keeps that true — MCP, quick-add and the
 * purchase-import skill never learned about vendor ids.
 *
 * Race-free via `findOrCreate`, whose `where` must match the unique index that
 * backs the race — here the partial-unique on `name` where live. Two concurrent
 * imports naming the same new vendor therefore produce one row, not a 500.
 *
 * Names are matched EXACTLY, not case-insensitively. Folding case here would
 * silently merge a genuine "3M" / "3m" distinction on first sight; near-
 * duplicates are a merge decision, and merging is a user action.
 */
export const findOrCreateVendor = async (
  db: Database | DrizzleTransaction,
  name: string,
): Promise<VendorId> => {
  const trimmed = name.trim();
  const { row } = await findOrCreateWithShortcode(db, "vendor", {
    where: and(eq(vendor.name, trimmed), notDeleted(vendor)),
    values: () => ({
      name: trimmed,
    }),
  });
  return row.id;
};

export const createVendor = async (
  db: Database,
  data: VendorCreateInput,
  actor: ActorContext,
): Promise<{ output: VendorOut; entityId: VendorId }> => {
  const id = await withTransaction(db, async (tx) => {
    const created = await insertWithShortcode(tx, "vendor", {
      name: data.name.trim(),
      website: data.website,
      orderUrlTemplate: data.orderUrlTemplate,
      notes: data.notes,
    });
    await logAuditEntry(tx, actor, {
      entityType: "vendor",
      entityId: created.id,
      action: "create",
    });
    return created.id;
  });
  return { output: await getVendorByID(db, id), entityId: id };
};

const VENDOR_AUDIT_FIELDS = [
  "name",
  "website",
  "orderUrlTemplate",
  "notes",
] as const;

export const updateVendor = async (
  db: Database,
  input: VendorUpdateInput,
  actor: ActorContext,
): Promise<{ output: VendorOut; entityId: VendorId }> => {
  const { data } = input;
  const id = await resolveOrThrow(db, "vendor", input.id);

  await withTransaction(db, async (tx) => {
    const before = await tx.query.vendor.findFirst({
      where: and(eq(vendor.id, id), notDeleted(vendor)),
    });
    if (!before) {
      throw createAppError("VENDOR_NOT_FOUND", `Vendor not found: ${id}`);
    }

    const after = await updateLiveAndReturn(
      tx,
      vendor,
      buildPartialUpdateValues({
        name: data.name?.trim(),
        website: data.website,
        orderUrlTemplate: data.orderUrlTemplate,
        notes: data.notes,
      }),
      id,
    );

    const changes = computeChanges(before, after, [...VENDOR_AUDIT_FIELDS]);
    if (changes) {
      await logAuditEntry(tx, actor, {
        entityType: "vendor",
        entityId: id,
        action: "update",
        changes,
      });
    }
  });

  return { output: await getVendorByID(db, id), entityId: id };
};

/**
 * Replace one vendor's direct logo relation with a freshly verified Image.
 *
 * The vendor row lock serializes concurrent fetch clicks. The old image is
 * reaped only after the FK moves, through the same global reference check used
 * by vendor merge/delete, so a logo shared with another vendor survives.
 */
export const replaceVendorLogo = async (
  db: Database,
  input: {
    id: VendorShortcode;
    expectedWebsite: string;
    image: Omit<typeof image.$inferInsert, "id" | "status">;
  },
  actor: ActorContext,
): Promise<{
  output: VendorOut;
  entityId: VendorId;
  detachedImageKeys: string[];
}> => {
  const { entityId, detachedImageKeys } = await withTransaction(
    db,
    async (tx) => {
      const entityId = await resolveOrThrow(tx, "vendor", input.id);
      const [before] = await tx
        .select({
          website: vendor.website,
          logoImageId: vendor.logoImageId,
        })
        .from(vendor)
        .where(and(eq(vendor.id, entityId), notDeleted(vendor)))
        .for("update");
      if (!before) {
        throw createAppError(
          "VENDOR_NOT_FOUND",
          `Vendor not found: ${input.id}`,
        );
      }
      if (before.website !== input.expectedWebsite) {
        throw createAppError(
          "VENDOR_STALE",
          "Vendor website changed while its logo was being fetched. Try again.",
        );
      }

      const created = await insertAndReturn(tx, image, {
        ...input.image,
        status: "UPLOADED",
        targetType: "vendor",
        targetId: entityId,
      });
      await tx
        .update(vendor)
        .set({ logoImageId: created.id })
        .where(eq(vendor.id, entityId));
      await logAuditEntry(tx, actor, {
        entityType: "vendor",
        entityId,
        action: "update",
        changes: {
          logoImageId: { from: before.logoImageId, to: created.id },
        },
      });

      const detachedImageKeys = before.logoImageId
        ? (await reapUnreferencedImages(tx, [before.logoImageId])).deletedKeys
        : [];
      return { entityId, detachedImageKeys };
    },
  );

  return {
    output: await getVendorByID(db, entityId),
    entityId,
    detachedImageKeys,
  };
};

/** What `mergeVendors` (and `previewMergeVendors`) does with one live charge. */
type VendorMergePlan = {
  /** Live purchases that simply adopt `keepId` — no same-order collision. */
  repointed: Array<{ id: PurchaseId; vendorId: VendorId }>;
  /** Live purchases folded into a same-order survivor (dead -> survivor pairs). */
  folded: Array<{
    deadId: PurchaseId;
    survivorId: PurchaseId;
    vendorId: VendorId;
  }>;
  /** Fields the keeper is missing that a source vendor would fill. */
  carried: { website?: string; notes?: string; logoImageId?: string };
};

/**
 * The read-only plan behind `mergeVendors`: which of the losers' charges get
 * folded into a same-order survivor vs. simply re-pointed, and which of the
 * keeper's empty fields get filled from a source. Pulled out so
 * `previewMergeVendors` computes the SAME survivor-per-order-id resolution the
 * mutation is about to execute — the two must not be able to disagree about
 * which charges fold.
 *
 * See `mergeVendors`' own doc for why the partial-unique `(vendorId, orderId)`
 * index forces this: two of the merged vendors holding a charge with the same
 * non-null order id can't both survive a re-point, so one folds into the
 * other. The keeper's own charge always wins the survivor slot when it has
 * one; order-less charges (`orderId IS NULL`) never collide and are always
 * re-pointed, never folded.
 */
const planVendorMerge = async (
  tx: DrizzleTransaction,
  keepId: VendorId,
  losers: VendorId[],
): Promise<VendorMergePlan> => {
  // Carry vendor-level identity the keeper is missing. Same rule as
  // `foldChargeInto`: fill a field the survivor DOESN'T have, never overwrite.
  // Without this, merging the row that HAS the website into the row with more
  // history silently discards it — which is the common shape, because the
  // better-populated duplicate is rarely the one with more charges. The real
  // first case was `B&H` (website, 1 charge) vs `B&H Photo` (none, 4 charges).
  const [keeperRow] = await tx
    .select({
      website: vendor.website,
      notes: vendor.notes,
      logoImageId: vendor.logoImageId,
    })
    .from(vendor)
    .where(eq(vendor.id, keepId))
    .limit(1);
  const loserRows = await tx
    .select({
      website: vendor.website,
      notes: vendor.notes,
      logoImageId: vendor.logoImageId,
    })
    .from(vendor)
    .where(inArray(vendor.id, losers));

  const carried: VendorMergePlan["carried"] = {};
  if (keeperRow?.website == null) {
    const found = loserRows.find((r) => r.website != null)?.website;
    if (found != null) carried.website = found;
  }
  if (keeperRow?.notes == null) {
    const found = loserRows.find((r) => r.notes != null)?.notes;
    if (found != null) carried.notes = found;
  }
  if (keeperRow?.logoImageId == null) {
    const found = loserRows.find((r) => r.logoImageId != null)?.logoImageId;
    if (found != null) carried.logoImageId = found;
  }

  // Every live charge across the merge set, so collisions can be resolved
  // against the whole group rather than pairwise.
  const allPurchases = await tx
    .select({
      id: purchase.id,
      vendorId: purchase.vendorId,
      orderId: purchase.orderId,
    })
    .from(purchase)
    .where(
      and(
        inArray(purchase.vendorId, [keepId, ...losers]),
        notDeleted(purchase),
      ),
    );

  // One survivor per order id, resolved over the whole merge set. The shared
  // `planSlotCollisions` encodes the two rules this needs: the keeper's own
  // charge wins its slot (so visible ids stay stable), and an order-less charge
  // (`orderId IS NULL`) can never collide because the unique index is partial.
  const slotted = planSlotCollisions({
    keeperRows: allPurchases.filter((p) => p.vendorId === keepId),
    loserRows: allPurchases.filter((p) => p.vendorId !== keepId),
    slotKey: (p) => p.orderId,
  });

  const folded: VendorMergePlan["folded"] = slotted.absorb.flatMap(
    ({ into, rows }) =>
      rows.map((row) => ({
        deadId: row.id,
        survivorId: into.id,
        vendorId: row.vendorId,
      })),
  );
  const repointed = slotted.repoint.map((p) => ({
    id: p.id,
    vendorId: p.vendorId,
  }));

  return { repointed, folded, carried };
};

/**
 * Fold duplicate vendors into one — `Amazon` / `amazon` / `Amazon.com`.
 *
 * This exists because `findOrCreateVendor` matches names EXACTLY (see its note on
 * why case-folding on the write path would be worse), so an importer that meets a
 * new spelling mints a new roster row. Nothing on the write path can safely decide
 * two spellings are the same vendor; a human can, and this is how they say so.
 *
 * **The subtle part is the partial-unique `(vendorId, orderId)` index on
 * `Purchase`.** Re-pointing every loser's charges at the keeper collides whenever
 * two of the merged vendors hold a charge with the SAME non-null order id — which
 * is not an edge case here, it's the signature of the exact duplication being
 * fixed (the same Amazon order imported twice under two spellings). Those two
 * charges are one charge, so they get folded: the loser's expenses and documents
 * move to the survivor and the loser charge is soft-deleted, rather than
 * re-pointed into a constraint violation. `planVendorMerge` computes which
 * charges those are; `previewMergeVendors` below reads the same plan.
 *
 * Grouping is over the WHOLE merge set, not just keeper-vs-loser, so two losers
 * colliding with each other are handled too. The keeper's own charge always wins
 * the survivor slot when it has one, so ids the user can already see stay stable.
 *
 * Order-less charges (`orderId IS NULL`) are never folded — `(vendorId, null)`
 * isn't unique and two undated cash runs to one vendor are two real charges. They
 * all re-point and coexist, exactly as they do under one vendor today.
 */
export const mergeVendors = async (
  db: Database,
  input: { keepId: VendorShortcode; mergeIds: VendorShortcode[] },
  actor: ActorContext,
): Promise<{ output: VendorOut; detachedImageKeys: string[] }> => {
  const { keepId, loserIds: losers } = await resolveMergeTargets(db, {
    entity: "vendor",
    keepId: input.keepId,
    mergeIds: input.mergeIds,
  });
  if (losers.length === 0) {
    return { output: await getVendorByID(db, keepId), detachedImageKeys: [] };
  }

  const detachedImageKeys = await withTransaction(db, async (tx) => {
    await lockAndValidateForDelete(tx, vendor, [keepId, ...losers], "Vendor");

    const plan = await planVendorMerge(tx, keepId, losers);

    if (Object.keys(plan.carried).length > 0) {
      await tx.update(vendor).set(plan.carried).where(eq(vendor.id, keepId));
    }

    for (const fold of plan.folded) {
      await foldChargeInto(tx, fold.deadId, fold.survivorId, actor);
    }

    // Everything still live moves to the keeper. The doomed charges are already
    // soft-deleted, so `liveOnly` is what keeps this from re-introducing the
    // collision the fold just resolved.
    await repointEdge(tx, "vendor", "Purchase.vendorId", {
      from: losers,
      to: keepId,
      liveOnly: true,
    });

    // Vendor logos are direct references rather than child rows. Clear losers
    // before tombstoning them so a logo that was not carried to the keeper is
    // eligible for the same shared-reference reap as an ordinary vendor delete.
    const loserLogos = (
      await tx
        .select({ logoImageId: vendor.logoImageId })
        .from(vendor)
        .where(inArray(vendor.id, losers))
    ).flatMap((row) => (row.logoImageId ? [row.logoImageId] : []));
    await tx
      .update(vendor)
      .set({ logoImageId: null })
      .where(inArray(vendor.id, losers));

    await finalizeMerge(tx, {
      entity: "vendor",
      table: vendor,
      keepId,
      loserIds: losers,
      removal: "soft",
      actor,
      survivorChanges: {
        mergedFrom: { from: null, to: losers },
        ...(Object.keys(plan.carried).length > 0
          ? { carriedOver: { from: null, to: plan.carried } }
          : {}),
        ...(plan.folded.length > 0
          ? {
              foldedCharges: {
                from: null,
                to: plan.folded.map((d) => d.deadId),
              },
            }
          : {}),
      },
    });

    return (await reapUnreferencedImages(tx, loserLogos)).deletedKeys;
  });

  return { output: await getVendorByID(db, keepId), detachedImageKeys };
};

/**
 * Soft-delete vendors, refusing while live charges still reference them —
 * mirroring `PROJECT_HAS_EXPENSES` one level up the chain. A vendor with
 * charges is load-bearing history: dropping it would leave every one of those
 * charges resolving `vendorName` to null, which reads as "no vendor recorded"
 * and is a lie.
 *
 * The re-point paths are `mergePurchases` (one vendor's charges) and
 * `mergeVendors` (two spellings of one vendor) — never a cascading delete.
 *
 * The blocking count is `countByTarget` over `Purchase.vendorId` — the same
 * call `previewDeleteVendors` makes — rather than a hand-rolled groupBy, so
 * the two can't disagree about which vendors have live charges.
 */
export const deleteVendors = async (
  db: Database,
  shortcodes: VendorShortcode[],
  actor: ActorContext,
): Promise<{ detachedImageKeys: string[] }> => {
  if (shortcodes.length === 0) return { detachedImageKeys: [] };

  const ids = await resolveAllOrThrow(db, "vendor", shortcodes);

  return await withTransaction(db, async (tx) => {
    await lockAndValidateForDelete(tx, vendor, ids, "Vendor");

    const blocking = await countByTarget(tx, purchase, purchase.vendorId, ids);

    if (Object.keys(blocking).length > 0) {
      const detail = Object.entries(blocking)
        .map(([vendorId, n]) => `${vendorId} (${n})`)
        .join(", ");
      throw createAppError(
        "VENDOR_HAS_PURCHASES",
        `Cannot delete a vendor with purchases still pointing at it: ${detail}. Move or delete those purchases first.`,
      );
    }

    // A logo is a direct FK, not a gallery join row, so collect it before the
    // vendor is tombstoned. Reaping uses every image incoming edge, preserving
    // an intentionally shared image rather than assuming logo exclusivity.
    const logoRows = await tx
      .select({ logoImageId: vendor.logoImageId })
      .from(vendor)
      .where(inArray(vendor.id, ids));
    const logoIds = logoRows.flatMap((row) =>
      row.logoImageId ? [row.logoImageId] : [],
    );

    await tx
      .update(vendor)
      .set({ logoImageId: null })
      .where(inArray(vendor.id, ids));
    await removeEntity(tx, { entity: "vendor", ids, removal: "soft", actor });
    const reaped = await reapUnreferencedImages(tx, logoIds);
    return { detachedImageKeys: reaped.deletedKeys };
  });
};

/**
 * What `deleteVendors` would do to the given vendors, without doing it.
 *
 * Reads the SAME `VENDOR_DELETE_EDGE_POLICY` and the same `countByTarget` call
 * the mutation's own blocking check makes, so the preview can't claim a delete
 * will succeed that the guard above then refuses.
 *
 * Advisory only. `deleteVendors` still re-runs the check inside its own
 * transaction; nothing here is a lock or a permission.
 */
export const previewDeleteVendors = async (
  db: Database,
  ids: VendorId[],
): Promise<{
  blockers: ImpactItem[];
  changes: ImpactItem[];
  sideEffects: ImpactItem[];
}> => {
  if (ids.length === 0) return { blockers: [], changes: [], sideEffects: [] };

  const dbClient = getDb(db);
  const byTargetId = await countByTarget(
    dbClient,
    purchase,
    purchase.vendorId,
    ids,
  );

  const blockers = present([
    impact({
      disposition: VENDOR_DELETE_EDGE_POLICY["Purchase.vendorId"],
      edgeKey: "Purchase.vendorId",
      label: "purchases still pointing at this vendor",
      byTargetId,
    }),
  ]);

  // No cascade (vendor delete is block-only) and no side effect: neither
  // `Vendor` nor `Purchase` is in the embedding pipeline (see `deletePurchases`'
  // own doc), and nothing else recomputes off a vendor delete.
  return { blockers, changes: [], sideEffects: [] };
};

/**
 * What `mergeVendors` would do to the given vendors, without doing it.
 *
 * Reads the SAME `planVendorMerge` the mutation is about to execute, so the
 * repointed/folded split and the field carry-over can't disagree between the
 * two. `VENDOR_MERGE_EDGE_POLICY` only declares one edge (`Purchase.vendorId`,
 * `repoint`); the fold is the SAME edge's `move-dedupe` refinement for charges
 * that collide on a shared order id, given its own disposition here since the
 * policy record (one entry per edge) has nowhere else to carry it. The
 * transitive expense/document moves those folds cause, the source vendors
 * removed, and the keeper's field carry-over aren't `Vendor` edges at all
 * (they're a `Purchase`/`PurchaseImage` consequence and the merge's own
 * row-removal), so they're reported as `sideEffects` rather than tied to a
 * declared edge key.
 *
 * Advisory only. `mergeVendors` still recomputes the same plan inside its own
 * transaction; nothing here is a lock or a permission.
 */
export const previewMergeVendors = async (
  db: Database,
  input: { keepId: VendorId; mergeIds: VendorId[] },
): Promise<{
  blockers: ImpactItem[];
  changes: ImpactItem[];
  sideEffects: ImpactItem[];
}> => {
  const { keepId } = input;
  const losers = input.mergeIds.filter((id) => id !== keepId);
  if (losers.length === 0)
    return { blockers: [], changes: [], sideEffects: [] };

  const dbClient = getDb(db);
  // Same cast the product preview makes to hand a plain client to a helper
  // typed for `DrizzleTransaction` — see `previewDeleteProducts`.
  const plan = await planVendorMerge(
    dbClient as unknown as DrizzleTransaction,
    keepId,
    losers,
  );

  const repointedByVendor: Record<string, number> = {};
  for (const p of plan.repointed) {
    repointedByVendor[p.vendorId] = (repointedByVendor[p.vendorId] ?? 0) + 1;
  }
  const foldedByVendor: Record<string, number> = {};
  for (const f of plan.folded) {
    foldedByVendor[f.vendorId] = (foldedByVendor[f.vendorId] ?? 0) + 1;
  }

  const changes = present([
    impact({
      disposition: VENDOR_MERGE_EDGE_POLICY["Purchase.vendorId"],
      edgeKey: "Purchase.vendorId",
      label: "purchases re-pointed to the keeper",
      byTargetId: repointedByVendor,
    }),
    impact({
      disposition: {
        code: "fold-live-purchase-by-order",
        effect: "move-dedupe",
        description:
          "A merged vendor's purchase that collides on the same order id as another purchase in the merge set is folded into the survivor instead of re-pointed.",
      },
      edgeKey: "Purchase.vendorId",
      label: "purchases folded into a same-order survivor",
      byTargetId: foldedByVendor,
    }),
  ]);

  // Transitive counts: what each fold moves, re-keyed from the folded
  // purchase's own id back to the loser vendor it came from so every item in
  // this preview reads at the same "target = merge id" granularity.
  const foldedPurchaseIds = plan.folded.map((f) => f.deadId);
  const byVendorFromPurchase = (counts: Record<string, number>) => {
    const out: Record<string, number> = {};
    for (const f of plan.folded) {
      const n = counts[f.deadId];
      if (n) out[f.vendorId] = (out[f.vendorId] ?? 0) + n;
    }
    return out;
  };
  const expenseMoveCounts = await countByTarget(
    dbClient,
    expense,
    expense.purchaseId,
    foldedPurchaseIds,
  );
  const imageMoveCounts = await countByTarget(
    dbClient,
    purchaseImage,
    purchaseImage.purchaseId,
    foldedPurchaseIds,
  );
  const transactionMoveCounts = await countByTarget(
    dbClient,
    financialTransactionAllocation,
    financialTransactionAllocation.purchaseId,
    foldedPurchaseIds,
  );

  const sideEffects = present([
    impact({
      disposition: {
        code: "transitive-expense-repoint",
        effect: "repoint",
        description:
          "Expenses on a folded purchase move onto the surviving purchase along with it.",
      },
      label: "expenses moved by a fold",
      byTargetId: byVendorFromPurchase(expenseMoveCounts),
    }),
    impact({
      disposition: {
        code: "transitive-document-move-dedupe",
        effect: "move-dedupe",
        description:
          "Documents on a folded purchase move onto the surviving purchase, skipping any already filed there.",
      },
      label: "documents moved by a fold",
      byTargetId: byVendorFromPurchase(imageMoveCounts),
    }),
    impact({
      disposition: {
        code: "transitive-financial-transaction-repoint",
        effect: "repoint",
        description:
          "Financial settlement entries on a folded purchase move onto the surviving purchase.",
      },
      label: "financial transactions moved by a fold",
      byTargetId: byVendorFromPurchase(transactionMoveCounts),
    }),
    impact({
      disposition: {
        code: "soft-delete-source-vendor",
        effect: "soft-delete",
        description: "The merged-away vendor rows are soft-deleted.",
      },
      label: "source vendors removed",
      byTargetId: Object.fromEntries(losers.map((id) => [id, 1])),
    }),
    Object.keys(plan.carried).length > 0
      ? impact({
          disposition: {
            code: "carry-empty-vendor-fields",
            effect: "preserve",
            description:
              "The keeper's empty website/notes fields are filled in from a source vendor being merged away.",
          },
          label: "keeper fields filled from a source",
          byTargetId: { [keepId]: Object.keys(plan.carried).length },
        })
      : null,
  ]);

  return { blockers: [], changes, sideEffects };
};
