import type { ActorContext } from "@cubby/schemas/context";
/** Vendor spend is derived only from `SUM(Expense.cost)` through live purchases. */
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type {
  ImpactItem,
  OperationDisposition,
} from "@cubby/schemas/entity-integrity";
import {
  type ImageShortcode,
  type PurchaseId,
  parseEntityId,
  parseShortcodeFor,
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
  VendorMergeSummaryOut,
  VendorOptionsOut,
  VendorOut,
  VendorUpdateData,
} from "@cubby/schemas/vendor";
import { vendorSortableFields } from "@cubby/schemas/vendor";
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";

import type { Database, DrizzleClient, DrizzleTransaction } from "~/server/db";
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
import { logAuditEntry } from "~/server/repo/audit-log";
import {
  auditDateWhereConditions,
  buildOrderBy,
  buildSearchConditions,
  correlated,
  countWhere,
  formatSearchTerm,
  getDb,
  type ListReadIntent,
  lockAndValidateForDelete,
  notDeleted,
  rangeConditions,
  unwrapDb,
  withTransaction,
} from "~/server/repo/database-helpers";
import { patchEntityRows } from "~/server/repo/entity-patch";
import { reapUnreferencedImages } from "~/server/repo/image";
import {
  displayableImageSql,
  displayableImageWhere,
} from "~/server/repo/image-displayability";
import { countByTarget, impact, present } from "~/server/repo/impact";
import {
  assertDistinctMergeTargets,
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
import { getR2PublicUrl } from "~/server/utils/r2-public-url";

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
    id: image.shortcode,
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
  id: parseShortcodeFor("vendor", row.shortcode),
  name: row.name,
  website: row.website,
  orderUrlTemplate: row.orderUrlTemplate,
  notes: row.notes,
  purchaseCount: Number(row.purchaseCount),
  spend: Number(row.spend),
  latestPurchaseDate: row.latestPurchaseDate,
  logo: row.logo && {
    ...row.logo,
    id: parseShortcodeFor("image", row.logo.id),
    url: getR2PublicUrl(row.logo.key),
  },
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/** The complete WHERE for this entity's list. `getEntityCounts` calls it with `{}` — see repo/dashboard.ts. */
export const buildVendorWhereClause = (filters: VendorFilters) =>
  buildSearchConditions(
    vendor,
    [],
    [
      ...auditDateWhereConditions(vendor, filters),
      ...rangeConditions(vendorPurchaseCount, filters, "purchaseCount"),
      ...rangeConditions(vendorSpend, filters, "spend"),
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
  readIntent: ListReadIntent = "page",
): Promise<{
  data: VendorOut[];
  count: number;
  sums: { spend: number; purchaseCount: number };
}> => {
  const whereClause = buildVendorWhereClause(filters);
  if (readIntent === "count") {
    return {
      data: [],
      count: await countWhere(db, vendor, whereClause),
      sums: { spend: 0, purchaseCount: 0 },
    };
  }
  const { take, skip } = buildTakeSkip(pagination);

  // Footer totals cover the filtered set, not only the loaded page.
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
    readIntent === "sample"
      ? Promise.resolve([{ spend: 0, purchaseCount: 0 }])
      : getDb(db)
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

export const getVendorByShortcode = async (
  db: Database,
  shortcode: string,
): Promise<VendorOut | null> => {
  const id = await resolveLiveShortcode(db, shortcode, "vendor");
  return id ? getVendorByID(db, parseEntityId("vendor", id)) : null;
};

export const vendorOptions = async (
  db: Database,
): Promise<VendorOptionsOut> => {
  const rows = await getDb(db)
    .select({
      shortcode: vendor.shortcode,
      name: vendor.name,
      count: vendorPurchaseCount,
      logoKey: image.key,
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
    id: parseShortcodeFor("vendor", row.shortcode),
    name: row.name,
    count: Number(row.count),
    logo: row.logoKey ? { url: getR2PublicUrl(row.logoKey) } : null,
  }));
};

/** Race-safe exact-name lookup; near-duplicates require an explicit merge. */
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

export const updateVendor = async (
  db: Database,
  shortcode: VendorShortcode,
  data: VendorUpdateData,
  actor: ActorContext,
): Promise<{ output: VendorOut; entityId: VendorId }> => {
  const id = await resolveOrThrow(db, "vendor", shortcode);

  await patchEntityRows(
    db,
    actor,
    {
      entity: "vendor",
      table: vendor,
      fields: entityFieldModels.vendor.audit,
    },
    [id],
    { ...data, name: data.name?.trim() },
  );

  return { output: await getVendorByID(db, id), entityId: id };
};

/** Row locking serializes logo replacement; shared old images are preserved. */
export const replaceVendorLogo = async (
  db: Database,
  input: {
    id: VendorShortcode;
    expectedWebsite: string;
    image: Omit<typeof image.$inferInsert, "id" | "status" | "shortcode">;
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

      const created = await insertWithShortcode(tx, "image", {
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
          logoImageId: { from: before.logoImageId, to: created.shortcode },
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

type VendorMergePlan = {
  deletedIds: VendorShortcode[];
  repointed: Array<{ id: PurchaseId; vendorId: VendorId }>;
  folded: Array<{
    deadId: PurchaseId;
    survivorId: PurchaseId;
    vendorId: VendorId;
  }>;
  carried: { website?: string; notes?: string; logoImageId?: string };
};

/** Plan same-order folds before repointing through the partial unique index. */
const planVendorMerge = async (
  dbClient: DrizzleClient | DrizzleTransaction,
  keepId: VendorId,
  losers: VendorId[],
): Promise<VendorMergePlan> => {
  // Carry vendor-level identity the keeper is missing. Same rule as
  // `foldChargeInto`: fill a field the survivor DOESN'T have, never overwrite.
  // Without this, merging the row that HAS the website into the row with more
  // history silently discards it — which is the common shape, because the
  // better-populated duplicate is rarely the one with more charges. The real
  // first case was `B&H` (website, 1 charge) vs `B&H Photo` (none, 4 charges).
  const [keeperRow] = await dbClient
    .select({
      website: vendor.website,
      notes: vendor.notes,
      logoImageId: vendor.logoImageId,
    })
    .from(vendor)
    .where(eq(vendor.id, keepId))
    .limit(1);
  const loserRows = await dbClient
    .select({
      shortcode: vendor.shortcode,
      website: vendor.website,
      notes: vendor.notes,
      logoImageId: vendor.logoImageId,
    })
    .from(vendor)
    .where(inArray(vendor.id, losers));
  const deletedIds = loserRows.map((r) =>
    parseShortcodeFor("vendor", r.shortcode),
  );

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

  const allPurchases = await dbClient
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

  return { deletedIds, repointed, folded, carried };
};

/**
 * Folds same-order charges before repointing vendors. Null order IDs never
 * collide; the keeper's existing charge wins each non-null order slot.
 */
export const mergeVendors = async (
  db: Database,
  input: { keepId: VendorShortcode; mergeIds: VendorShortcode[] },
  actor: ActorContext,
): Promise<{
  vendor: VendorOut;
  detachedImageKeys: string[];
  mergeSummary: VendorMergeSummaryOut;
}> => {
  const { keepId, loserIds: losers } = await resolveMergeTargets(db, {
    entity: "vendor",
    keepId: input.keepId,
    mergeIds: input.mergeIds,
  });
  let planSummary: Omit<VendorMergeSummaryOut, "keepId"> | undefined;

  const detachedImageKeys = await withTransaction(db, async (tx) => {
    await lockAndValidateForDelete(tx, vendor, [keepId, ...losers], "Vendor");

    const plan = await planVendorMerge(tx, keepId, losers);
    planSummary = {
      deletedIds: plan.deletedIds,
      merged: 0,
      purchasesRepointed: plan.repointed.length,
      purchasesFolded: plan.folded.length,
      carriedFields: Object.keys(plan.carried),
    };

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

    type VendorMergeSurvivorChanges = {
      mergedFrom: { from: null; to: VendorId[] };
      carriedOver?: { from: null; to: VendorMergePlan["carried"] };
      foldedCharges?: { from: null; to: PurchaseId[] };
    };
    const survivorChanges: VendorMergeSurvivorChanges = {
      mergedFrom: { from: null, to: losers },
    };
    if (Object.keys(plan.carried).length > 0) {
      survivorChanges.carriedOver = { from: null, to: plan.carried };
    }
    if (plan.folded.length > 0) {
      survivorChanges.foldedCharges = {
        from: null,
        to: plan.folded.map((entry) => entry.deadId),
      };
    }

    const { removed } = await finalizeMerge(tx, {
      entity: "vendor",
      table: vendor,
      keepId,
      loserIds: losers,
      removal: "soft",
      actor,
      survivorChanges,
    });
    planSummary.merged = removed;

    return (await reapUnreferencedImages(tx, loserLogos)).deletedKeys;
  });

  const output = await getVendorByID(db, keepId);
  return {
    vendor: output,
    detachedImageKeys,
    mergeSummary: { keepId: output.id, ...planSummary! },
  };
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
 * The blocking count is `countByTarget` over `Purchase.vendorId` rather than a
 * hand-rolled groupBy, so a single query names both the total and which
 * vendors have live charges.
 */
export const deleteVendors = async (
  db: Database,
  shortcodes: VendorShortcode[],
  actor: ActorContext,
): Promise<{
  detachedImageKeys: string[];
  deletedImageShortcodes: ImageShortcode[];
  deleted: number;
}> => {
  if (shortcodes.length === 0) {
    return {
      detachedImageKeys: [],
      deletedImageShortcodes: [],
      deleted: 0,
    };
  }

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
    const { deleted } = await removeEntity(tx, {
      entity: "vendor",
      ids,
      removal: "soft",
      actor,
    });
    const reaped = await reapUnreferencedImages(tx, logoIds);
    return {
      detachedImageKeys: reaped.deletedKeys,
      deletedImageShortcodes: reaped.deletedShortcodes,
      deleted,
    };
  });
};

export const previewMergeVendors = async (
  db: Database | DrizzleTransaction,
  input: { keepId: VendorId; mergeIds: VendorId[] },
): Promise<{
  blockers: ImpactItem[];
  changes: ImpactItem[];
  sideEffects: ImpactItem[];
}> => {
  const { keepId } = input;
  assertDistinctMergeTargets("vendor", keepId, input.mergeIds);
  const losers = input.mergeIds;
  if (losers.length === 0)
    return { blockers: [], changes: [], sideEffects: [] };

  const dbClient = unwrapDb(db);
  const plan = await planVendorMerge(dbClient, keepId, losers);

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
