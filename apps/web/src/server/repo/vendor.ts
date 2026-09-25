/** Vendor spend is derived only from `SUM(Expense.cost)` through live purchases. */

import type { ActorContext } from "@cubby/schemas/context";
import type { DataQuality } from "@cubby/schemas/data-quality";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
import {
  type PurchaseId,
  parseEntityId,
  parseShortcodeFor,
  type VendorId,
  type VendorShortcode,
} from "@cubby/schemas/identifiers";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import type {
  VendorCreateInput,
  VendorFilters,
  VendorMergeSummaryOut,
  VendorOptionsOut,
  VendorOut,
  VendorUpdateData,
} from "@cubby/schemas/vendor";
import {
  vendorAgentHints,
  vendorOrderEvidence,
} from "@cubby/schemas/vendor-import-fields";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  lte,
  sql,
} from "drizzle-orm";

import type { Database, DrizzleClient, DrizzleTransaction } from "~/server/db";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import { entityAttachment, image, purchase, vendor } from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { logAuditEntry } from "~/server/repo/audit-log";
import { loadDataQualities } from "~/server/repo/data-quality";
import {
  correlated,
  countWhere,
  getDb,
  type ListReadIntent,
  lockAndValidateForDelete,
  notDeleted,
  rangeConditions,
  withTransaction,
} from "~/server/repo/database-helpers";
import { patchEntityRows } from "~/server/repo/entity-patch";
import { reapUnreferencedImages } from "~/server/repo/image";
import {
  displayableImageSql,
  displayableImageWhere,
} from "~/server/repo/image-displayability";
import { listScaffold } from "~/server/repo/list-scaffold";
import {
  finalizeMerge,
  planSlotCollisions,
  repointEdge,
  resolveMergeTargets,
} from "~/server/repo/merge";
import { foldChargeInto } from "~/server/repo/purchase";
import { relatedWhereConditions } from "~/server/repo/related-view";
import { applyMergePolicy, policyDelete } from "~/server/repo/removal";
import {
  resolveLiveShortcode,
  resolveOrThrow,
} from "~/server/repo/shortcode-resolver";
import {
  findOrCreateWithShortcode,
  insertWithShortcode,
} from "~/server/repo/shortcode-utils";
import {
  replaceSingularAttachment,
  singularAttachmentImageIds,
} from "~/server/repo/singular-attachment";
import { getR2PublicUrl } from "~/server/utils/r2-public-url";

export const VENDOR_DELETE_EDGE_POLICY = {
  "FinancialAccount.providerVendorId": {
    code: "block-stored-value-accounts",
    effect: "block",
    description:
      "A stored-value account retains the vendor that owes its balance.",
  },
  "ImportRun.vendorId": {
    code: "block-import-runs",
    effect: "block",
    description: "Import history retains the vendor it processed.",
  },
  "VendorAccount.vendorId": {
    code: "block-vendor-accounts",
    effect: "block",
    description: "Vendor accounts retain their configured vendor.",
  },
  "ImportHunt.vendorId": {
    code: "block-import-hunts",
    effect: "block",
    description: "Import hunts retain their routed vendor.",
  },
  "MerchantVendorRule.vendorId": {
    code: "block-merchant-rules",
    effect: "block",
    description: "Confirmed merchant rules retain their vendor.",
  },
  "OrderMail.vendorId": {
    code: "block-order-mail",
    effect: "block",
    description: "Normalized order mail retains its classified vendor.",
  },
  "Purchase.vendorId": {
    code: "block-live-purchase",
    effect: "block",
    description:
      "A vendor with purchases still pointing at it can't be deleted — those purchases are load-bearing history.",
  },
  "EntityAttachment.subjectEntityId": {
    code: "cascade-delete-attachment",
    effect: "soft-delete",
    description:
      "The logo association is soft-deleted with the vendor; the image is reaped when nothing else uses it.",
  },
} as const satisfies IncomingEdgePolicy<"vendor", OperationDisposition>;

export const VENDOR_MERGE_EDGE_POLICY = {
  "FinancialAccount.providerVendorId": {
    code: "block-stored-value-accounts",
    effect: "block",
    description:
      "Stored-value accounts must be reassigned explicitly before merging vendors; each provider and owner holds at most one live balance.",
  },
  "ImportRun.vendorId": {
    code: "block-import-runs",
    effect: "block",
    description: "Historical import runs prevent an ambiguous vendor merge.",
  },
  "VendorAccount.vendorId": {
    code: "block-vendor-accounts",
    effect: "block",
    description:
      "Vendor accounts must be reassigned explicitly before merging vendors.",
  },
  "ImportHunt.vendorId": {
    code: "block-import-hunts",
    effect: "block",
    description: "Historical import hunts prevent an ambiguous vendor merge.",
  },
  "MerchantVendorRule.vendorId": {
    code: "block-merchant-rules",
    effect: "block",
    description:
      "Confirmed merchant rules must be reconciled before merging vendors.",
  },
  "OrderMail.vendorId": {
    code: "block-order-mail",
    effect: "block",
    description: "Classified order mail prevents an ambiguous vendor merge.",
  },
  "Purchase.vendorId": {
    code: "repoint-or-fold-by-order",
    effect: "move-dedupe",
    description:
      "A merged vendor's purchases re-point onto the surviving vendor; purchases that collide on the same order id are folded into one instead.",
  },
  "EntityAttachment.subjectEntityId": {
    code: "carry-logo",
    effect: "repoint",
    description:
      "A loser's logo becomes the survivor's when the survivor has none; any other loser logo is detached and reaped unless shared.",
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

export async function getVendorCoverage(
  db: Database,
  input: { vendorId: VendorShortcode; from: string; to: string },
) {
  const vendorId = await resolveOrThrow(db, "vendor", input.vendorId);
  const vendorRow = await getVendorByShortcode(db, input.vendorId);
  if (!vendorRow) {
    throw createAppError(
      "VENDOR_NOT_FOUND",
      `Vendor ${input.vendorId} not found`,
    );
  }
  const rows = await getDb(db)
    .selectDistinct({ orderId: purchase.orderId })
    .from(purchase)
    .where(
      and(
        eq(purchase.vendorId, vendorId),
        notDeleted(purchase),
        gte(purchase.date, input.from),
        lte(purchase.date, input.to),
        isNotNull(purchase.orderId),
      ),
    )
    .orderBy(asc(purchase.orderId));
  return {
    vendor: { id: vendorRow.id, name: vendorRow.name },
    latestPurchaseDate: vendorRow.latestPurchaseDate,
    from: input.from,
    to: input.to,
    orderIds: rows.flatMap((row) => (row.orderId == null ? [] : [row.orderId])),
  };
}

const vendorHasDisplayableLogo = sql<boolean>`EXISTS (
  SELECT 1 FROM "EntityAttachment" logo_att
  JOIN "Image" logo ON logo."id" = logo_att."imageId"
  WHERE logo_att."subjectEntityId" = ${sql.raw('"Vendor"."id"')}
    AND logo_att."role" = 'logo'
    AND logo_att."deletedAt" IS NULL
    AND logo."deletedAt" IS NULL
    AND ${displayableImageSql("logo")}
)`;

/** The vendor's live logo attachment, for a left join ahead of `image`. */
const vendorLogoAttachment = and(
  eq(entityAttachment.subjectEntityId, vendor.id),
  eq(entityAttachment.role, "logo"),
  notDeleted(entityAttachment),
);

const vendorColumns = {
  id: vendor.id,
  shortcode: vendor.shortcode,
  name: vendor.name,
  website: vendor.website,
  orderUrlTemplate: vendor.orderUrlTemplate,
  orderEvidence: vendor.orderEvidence,
  orderEmailSenders: vendor.orderEmailSenders,
  browserDomains: vendor.browserDomains,
  returnWindowDays: vendor.returnWindowDays,
  agentHints: vendor.agentHints,
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
    useOriginal: image.useOriginal,
    verifiedAt: image.verifiedAt,
    source: image.source,
    sourcePageUrl: image.sourcePageUrl,
    sourceAssetUrl: image.sourceAssetUrl,
    sourceName: image.sourceName,
    capturedAt: image.capturedAt,
    capturedAtOffsetMinutes: image.capturedAtOffsetMinutes,
    captureLocation: image.captureLocation,
    capturePlaceName: image.capturePlaceName,
    captureDeviceLabel: image.captureDeviceLabel,
    capturedByPartyId: image.capturedByPartyId,
    captureAttribution: image.captureAttribution,
    provenanceEvidence: image.provenanceEvidence,
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
  orderEvidence: string | null;
  orderEmailSenders: string[];
  browserDomains: string[];
  returnWindowDays: number | null;
  agentHints: unknown;
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
    useOriginal: boolean;
    verifiedAt: Date | null;
    source: "own" | "catalog" | "unknown" | "screenshot" | null;
    sourcePageUrl: string | null;
    sourceAssetUrl: string | null;
    sourceName: string | null;
    capturedAt: Date | null;
    capturedAtOffsetMinutes: number | null;
    captureLocation: {
      lat: number;
      lng: number;
      altitude?: number;
      horizontalAccuracy?: number;
    } | null;
    capturePlaceName: string | null;
    captureDeviceLabel: string | null;
    capturedByPartyId: string | null;
    captureAttribution: "none" | "derived" | "ambiguous" | "confirmed" | null;
    provenanceEvidence: {
      basis:
        | "manual"
        | "sighting"
        | "import-url"
        | "exif"
        | "analysis"
        | "filename";
      ruleId?: string;
      detail?: string;
    } | null;
    createdAt: Date;
    updatedAt: Date;
  } | null;
};

const dbVendorToAPI = (
  row: VendorRow,
  dataQuality: DataQuality,
): VendorOut => ({
  id: parseShortcodeFor("vendor", row.shortcode),
  name: row.name,
  website: row.website,
  orderUrlTemplate: row.orderUrlTemplate,
  orderEvidence: vendorOrderEvidence.nullable().parse(row.orderEvidence),
  orderEmailSenders: row.orderEmailSenders,
  browserDomains: row.browserDomains,
  returnWindowDays: row.returnWindowDays,
  agentHints: vendorAgentHints.parse(row.agentHints),
  notes: row.notes,
  purchaseCount: Number(row.purchaseCount),
  spend: Number(row.spend),
  latestPurchaseDate: row.latestPurchaseDate,
  logo: row.logo && {
    ...row.logo,
    source: row.logo.source ?? "unknown",
    id: parseShortcodeFor("image", row.logo.id),
    url: getR2PublicUrl(row.logo.key),
    // Not resolved here: this select has no join to LedgerParty for a
    // shortcode or a name — a vendor logo is never a member's own photo.
    capturedByPartyId: null,
    capturedByName: null,
    captureAttribution: row.logo.captureAttribution ?? "none",
  },
  dataQuality,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const vendorScaffold = listScaffold("vendor", vendor);

/** The complete WHERE for this entity's list. `getEntityCounts` calls it with `{}` — see repo/dashboard.ts. */
export const buildVendorWhereClause = (filters: VendorFilters) =>
  vendorScaffold.where(filters, [
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
  ]);

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
  const { take, skip } = vendorScaffold.page(pagination);

  // Footer totals cover the filtered set, not only the loaded page.
  const [rows, count, [totals]] = await Promise.all([
    getDb(db)
      .select(vendorColumns)
      .from(vendor)
      .leftJoin(entityAttachment, vendorLogoAttachment)
      .leftJoin(
        image,
        and(
          eq(image.id, entityAttachment.imageId),
          notDeleted(image),
          displayableImageWhere,
        ),
      )
      .where(whereClause)
      .orderBy(
        ...vendorScaffold.orderBy(
          sorts,
          { resolve: resolveVendorSort },
          filters,
        ),
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

  const dataQualities = await loadDataQualities(
    db,
    "vendor",
    rows.map((row) => row.id),
  );
  return {
    // SAFETY: `row` came from `rows`, which `dataQualities` was loaded for.
    data: rows.map((row) => dbVendorToAPI(row, dataQualities.get(row.id)!)),
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
    .leftJoin(entityAttachment, vendorLogoAttachment)
    .leftJoin(
      image,
      and(
        eq(image.id, entityAttachment.imageId),
        notDeleted(image),
        displayableImageWhere,
      ),
    )
    .where(and(eq(vendor.id, id), notDeleted(vendor)))
    .limit(1);
  if (!row) {
    throw createAppError("VENDOR_NOT_FOUND", `Vendor not found: ${id}`);
  }
  const dataQualities = await loadDataQualities(db, "vendor", [row.id]);
  // SAFETY: `row` was just fetched live by id, so its quality was evaluated.
  return dbVendorToAPI(row, dataQualities.get(row.id)!);
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
    .leftJoin(entityAttachment, vendorLogoAttachment)
    .leftJoin(
      image,
      and(
        eq(image.id, entityAttachment.imageId),
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
      orderEvidence: data.orderEvidence,
      orderEmailSenders: data.orderEmailSenders,
      browserDomains: data.browserDomains,
      returnWindowDays: data.returnWindowDays,
      agentHints: data.agentHints,
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
        .select({ website: vendor.website })
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
      });
      const { previousImageId } = await replaceSingularAttachment(
        tx,
        entityId,
        "logo",
        created.id,
      );
      await logAuditEntry(tx, actor, {
        entityType: "vendor",
        entityId,
        action: "update",
        changes: {
          logoImageId: { from: previousImageId, to: created.shortcode },
        },
      });

      const detachedImageKeys = previousImageId
        ? (await reapUnreferencedImages(tx, [previousImageId])).deletedKeys
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
    .select({ website: vendor.website, notes: vendor.notes })
    .from(vendor)
    .where(eq(vendor.id, keepId))
    .limit(1);
  const loserRows = await dbClient
    .select({
      id: vendor.id,
      shortcode: vendor.shortcode,
      website: vendor.website,
      notes: vendor.notes,
    })
    .from(vendor)
    .where(inArray(vendor.id, losers));
  const logos = await singularAttachmentImageIds(
    dbClient,
    [keepId, ...losers],
    "logo",
  );
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
  if (!logos.has(keepId)) {
    const found = loserRows
      .map((row) => logos.get(row.id))
      .find((imageId) => imageId !== undefined);
    if (found !== undefined) carried.logoImageId = found;
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

    const { logoImageId: carriedLogo, ...carriedColumns } = plan.carried;
    if (Object.keys(carriedColumns).length > 0) {
      await tx.update(vendor).set(carriedColumns).where(eq(vendor.id, keepId));
    }

    const loserLogos: string[] = [];
    await applyMergePolicy(tx, {
      entity: "vendor",
      policy: VENDOR_MERGE_EDGE_POLICY,
      keepId,
      loserIds: losers,
      liveOnly: true,
      overrides: {
        "Purchase.vendorId": async () => {
          for (const fold of plan.folded)
            await foldChargeInto(tx, fold.deadId, fold.survivorId, actor);
          // Everything still live moves to the keeper. The doomed charges are
          // already soft-deleted, so `liveOnly` keeps this from re-introducing
          // the collision the fold just resolved.
          await repointEdge(tx, "vendor", "Purchase.vendorId", {
            from: losers,
            to: keepId,
            liveOnly: true,
          });
        },
        // Detach every loser logo before tombstoning, then give the survivor
        // the carried one, so a logo that was not carried is eligible for the
        // same shared-reference reap as an ordinary vendor delete.
        "EntityAttachment.subjectEntityId": async () => {
          for (const loserId of losers) {
            const { previousImageId } = await replaceSingularAttachment(
              tx,
              loserId,
              "logo",
              null,
            );
            if (previousImageId) loserLogos.push(previousImageId);
          }
          if (carriedLogo)
            await replaceSingularAttachment(tx, keepId, "logo", carriedLogo);
        },
      },
    });

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
 * A vendor delete is its declared policy: live purchases, accounts and import
 * provenance block it; its logo attachment goes with it (ADR 0006).
 */
export const deleteVendors = policyDelete("vendor", VENDOR_DELETE_EDGE_POLICY);
