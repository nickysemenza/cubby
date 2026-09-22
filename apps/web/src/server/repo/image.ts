import type { ActorContext } from "@cubby/schemas/context";
import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
import { generatedEntitySort } from "@cubby/schemas/entity-sort";
/** Image data boundary: derive association and cascade behavior from INCOMING_EDGES.image. */
import type {
  EntityRef,
  ImageId,
  ImageShortcode,
  ProductId,
  ProjectId,
  RecipeId,
} from "@cubby/schemas/identifiers";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import type {
  AttachableImageEntity,
  ImageAssociation,
  ImageListFilters,
  ImageHashIndex,
  SetPerceptualHashesInput,
  SetPerceptualHashesOutput,
  ImageUpdateInput,
  ImageWithEntity,
  ProductImagePurpose,
} from "@cubby/schemas/image";
import { attachableImageEntityId } from "@cubby/schemas/image";
import type { PurchaseDocumentKind } from "@cubby/schemas/purchase";
import type { SearchableEntityRef } from "@cubby/schemas/search";
import {
  aliasedTable,
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  lt,
  not,
  or,
  type SQL,
  type GetColumnData,
  sql,
} from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { match } from "ts-pattern";

import type { Database, DrizzleClient, DrizzleTransaction } from "~/server/db";
import type {
  IncomingEdgeKey,
  IncomingEdgePolicy,
} from "~/server/db/entity-incoming-edges";
import {
  imageDerivative,
  imageDescriptionCorrection,
  imageProcessingOrphan,
  imageProcessingAttempt,
  imageProcessingJob,
} from "~/server/db/image-processing-schema";
import {
  cookbook,
  gardenEntry,
  gardenEntryImage,
  image,
  importHunt,
  importPreparedOrder,
  importRunTarget,
  location,
  locationImage,
  meal,
  mealImage,
  orderMailAttachment,
  product,
  productImage,
  project,
  projectImage,
  purchase,
  purchaseImage,
  recipe,
  recipeImage,
  task,
  taskImage,
  vendor,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { logAuditEntry } from "~/server/repo/audit-log";
import { touchDataQualityTargets } from "~/server/repo/data-quality";
import {
  associatePendingImages,
  auditDateWhereConditions,
  buildOrderBy,
  buildSearchConditions,
  countWhere,
  executeListQueryWithCount,
  getDb,
  imageJoinBindings,
  type ImageJoinBinding,
  type ImageJoinTable,
  isNotDeleted,
  type ListReadIntent,
  nextImageSortOrder,
  notDeleted,
  updateAndReturn,
  withTransaction,
} from "~/server/repo/database-helpers";
import { declaredFilterPredicates } from "~/server/repo/declared-filter-predicates";
import { softDeleteEntitySearchArtifactsTx } from "~/server/repo/entity-embedding-cleanup";
import { displayableImageWhere } from "~/server/repo/image-displayability";
import {
  resolveAllPresent,
  resolveOrThrow,
  resolveShortcode,
} from "~/server/repo/shortcode-resolver";
import {
  generateUniqueShortcode,
  insertWithShortcode,
} from "~/server/repo/shortcode-utils";
import { getR2PublicUrl } from "~/server/utils/r2-public-url";

import { loadImageRepresentations } from "./image-processing";
import {
  imageProcessingIssueFilter,
  loadImageProcessingIssues,
} from "./image-processing-issues";
import {
  findDirectImageSearchOwnerRefs,
  refreshCapturedImageSearchOwnerRefs,
  refreshDirectImageOwnerSearchDocuments,
} from "./search-document";

/** A gallery target's discriminator and branded private ID travel together. */
export type AttachableImageRef = Extract<
  EntityRef,
  { entity: AttachableImageEntity }
>;

const attachExistingWithBinding = async <
  TTable extends ImageJoinTable,
  TParentColumn extends PgColumn,
>(
  tx: DrizzleTransaction,
  binding: ImageJoinBinding<TTable, TParentColumn>,
  parentId: GetColumnData<TParentColumn>,
  imageId: ImageId,
  sortOrder: number | undefined,
): Promise<boolean> => {
  const joinTable: ImageJoinTable = binding.table;
  const existing = await tx
    .select({
      id: sql<string>`${joinTable.id}`,
      deletedAt: sql<Date | null>`${joinTable.deletedAt}`,
    })
    .from(joinTable)
    .where(
      and(eq(binding.parentIdColumn, parentId), eq(joinTable.imageId, imageId)),
    )
    .orderBy(desc(joinTable.updatedAt), desc(joinTable.id));
  if (existing.some((row) => row.deletedAt === null)) return true;
  const now = new Date();
  const order = sortOrder ?? (await nextImageSortOrder(tx, binding, parentId));
  if (sortOrder !== undefined) {
    // SAFETY: the manifest binding guarantees these dynamic columns exist on every gallery join table.
    await tx
      .update(joinTable)
      .set({ sortOrder: sql`${joinTable.sortOrder} + 1` } as never)
      .where(
        and(
          eq(binding.parentIdColumn, parentId),
          sql`${joinTable.sortOrder} >= ${order}`,
          sql`${joinTable.deletedAt} IS NULL`,
        ),
      );
  }
  const detached = existing.find((row) => row.deletedAt !== null);
  if (detached) {
    // SAFETY: the manifest binding guarantees these dynamic columns exist on every gallery join table.
    await tx
      .update(joinTable)
      .set({ deletedAt: null, updatedAt: now, sortOrder: order } as never)
      .where(
        and(
          sql`${joinTable.id} = ${detached.id}`,
          isNotNull(joinTable.deletedAt),
        ),
      );
  } else {
    await tx
      .insert(binding.table)
      .values(binding.insertRow(parentId, imageId, order));
  }
  return false;
};

/** Attach an existing uploaded image without moving or re-uploading its bytes. */
export const attachExistingImageToEntity = async (
  db: Database,
  input: {
    imageId: ImageShortcode;
    targetId: string;
    sortOrder?: number;
    purpose?: ProductImagePurpose;
  },
  actor: ActorContext,
): Promise<{ reused: boolean }> => {
  const imageId = await resolveOrThrow(db, "image", input.imageId);
  const target = await resolveShortcode(db, input.targetId);
  if (!target || !attachableImageEntityId.safeParse(input.targetId).success) {
    throw createAppError(
      "IMAGE_ATTACH_FAILED",
      `Target ${input.targetId} is not a live gallery record`,
    );
  }
  // SAFETY: target shortcode validation restricts the resolved live ref to the gallery roster.
  const entity = target as AttachableImageRef;

  const attached = await withTransaction(db, async (tx) => {
    await lockAttachableEntity(tx, entity);
    const [source] = await tx
      .select({ status: image.status })
      .from(image)
      .where(and(eq(image.id, imageId), notDeleted(image)))
      .for("update");
    if (!source || source.status !== "UPLOADED") {
      throw createAppError(
        "IMAGE_ATTACH_FAILED",
        `Image ${input.imageId} is not a live uploaded image`,
      );
    }

    const now = new Date();
    const reused = await match(entity)
      .with({ entity: "product" }, ({ id }) =>
        attachExistingWithBinding(
          tx,
          imageJoinBindings.product,
          id,
          imageId,
          input.sortOrder,
        ),
      )
      .with({ entity: "location" }, ({ id }) =>
        attachExistingWithBinding(
          tx,
          imageJoinBindings.location,
          id,
          imageId,
          input.sortOrder,
        ),
      )
      .with({ entity: "recipe" }, ({ id }) =>
        attachExistingWithBinding(
          tx,
          imageJoinBindings.recipe,
          id,
          imageId,
          input.sortOrder,
        ),
      )
      .with({ entity: "project" }, ({ id }) =>
        attachExistingWithBinding(
          tx,
          imageJoinBindings.project,
          id,
          imageId,
          input.sortOrder,
        ),
      )
      .with({ entity: "purchase" }, ({ id }) =>
        attachExistingWithBinding(
          tx,
          imageJoinBindings.purchase,
          id,
          imageId,
          input.sortOrder,
        ),
      )
      .with({ entity: "gardenEntry" }, ({ id }) =>
        attachExistingWithBinding(
          tx,
          imageJoinBindings.gardenEntry,
          id,
          imageId,
          input.sortOrder,
        ),
      )
      .with({ entity: "meal" }, ({ id }) =>
        attachExistingWithBinding(
          tx,
          imageJoinBindings.meal,
          id,
          imageId,
          input.sortOrder,
        ),
      )
      .with({ entity: "task" }, ({ id }) =>
        attachExistingWithBinding(
          tx,
          imageJoinBindings.task,
          id,
          imageId,
          input.sortOrder,
        ),
      )
      .exhaustive();

    const purposeChanged =
      entity.entity === "product" && input.purpose !== undefined;
    if (purposeChanged) {
      await tx
        .update(productImage)
        .set({ purpose: input.purpose })
        .where(
          and(
            eq(productImage.productId, entity.id),
            eq(productImage.imageId, imageId),
            notDeleted(productImage),
          ),
        );
    }

    if (!reused || purposeChanged) {
      await touchAttachableEntity(tx, entity, now);
      await logAuditEntry(tx, actor, {
        entityType: entity.entity,
        entityId: entity.id,
        action: "update",
        changes: {
          images: purposeChanged
            ? {
                from: [],
                to: [{ imageId: input.imageId, purpose: input.purpose }],
              }
            : { from: [], to: [input.imageId] },
        },
      });
    }
    return { reused };
  });
  // The gallery association changes the direct owner set of the image's
  // description and correction text. Refresh after commit so search only sees
  // a live attachment.
  await refreshDirectImageOwnerSearchDocuments(db, imageId);
  return attached;
};

export const createPendingImageRecord = async (
  db: Database,
  {
    key,
    filename,
    contentType,
    size,
    perceptualHash,
    sourceFingerprint,
    width,
    height,
    source,
    sourcePageUrl,
    sourceAssetUrl,
    sourceName,
  }: {
    key: string;
    filename: string;
    contentType: string;
    size: number;
    perceptualHash?: string;
    sourceFingerprint?: { hash: string; aspectRatio: number };
    width?: number;
    height?: number;
    source?: "own" | "catalog" | "unknown";
    sourcePageUrl?: string | null;
    sourceAssetUrl?: string | null;
    sourceName?: string | null;
  },
) => {
  // `insertWithShortcode`, not a bare insert: Image now carries a public `IMG-`
  // id, and minting is what turns a row into something addressable.
  return await insertWithShortcode(db, "image", {
    key,
    filename,
    size,
    contentType,
    status: "PENDING",
    perceptualHash,
    sourceFingerprint,
    width,
    height,
    source,
    sourcePageUrl,
    sourceAssetUrl,
    sourceName,
  });
};

export const createUploadedImageRecord = async (
  db: Database | DrizzleTransaction,
  params: {
    key: string;
    filename: string;
    contentType: string;
    size: number;
    width?: number | null;
    height?: number | null;
    detectedContentType?: string | null;
    sha256?: string | null;
    renderStatus?: "unverified" | "verified" | "failed" | null;
    storageStatus?:
      | "unverified"
      | "available"
      | "missing"
      | "metadata_mismatch"
      | null;
    verifiedAt?: Date | null;
    targetType?: string | null;
    targetId?: string | null;
    idempotencyKey?: string | null;
    source?: "own" | "catalog" | "unknown";
    sourcePageUrl?: string | null;
    sourceAssetUrl?: string | null;
    sourceName?: string | null;
  },
) => {
  return await insertWithShortcode(db, "image", {
    ...params,
    status: "UPLOADED",
  });
};

export const getImageHashIndex = async (
  db: Database,
): Promise<ImageHashIndex> => {
  const rows = await getDb(db).query.image.findMany({
    where: and(
      eq(image.status, "UPLOADED"),
      notDeleted(image),
      displayableImageWhere,
    ),
    orderBy: [desc(image.createdAt), desc(image.id)],
    with: imageEntityRelations,
  });
  return {
    algorithmRevision: 1,
    items: rows.map((row) => ({
      id: parseShortcodeFor("image", row.shortcode),
      perceptualHash: row.perceptualHash,
      sourceFingerprint: row.sourceFingerprint,
      width: row.width,
      height: row.height,
      directOwnerShortcodes: imageWithRelationsToAPI(row).associations.map(
        ({ entityId }) => entityId,
      ),
    })),
    repair: rows
      .filter((row) => row.perceptualHash === null)
      .map((row) => ({
        id: parseShortcodeFor("image", row.shortcode),
        url: getR2PublicUrl(row.key),
      })),
  };
};

export const setImagePerceptualHashes = async (
  db: Database,
  input: SetPerceptualHashesInput,
): Promise<SetPerceptualHashesOutput> => {
  const requested = new Map(
    input.items.map((item) => [item.id, item.perceptualHash] as const),
  );
  if (requested.size === 0) return { items: [], unavailable: [] };

  return withTransaction(db, async (tx) => {
    const codes = [...requested.keys()];
    const eligible = await tx
      .select({
        id: image.id,
        shortcode: image.shortcode,
        perceptualHash: image.perceptualHash,
      })
      .from(image)
      .where(
        and(
          inArray(image.shortcode, codes),
          eq(image.status, "UPLOADED"),
          notDeleted(image),
          displayableImageWhere,
        ),
      )
      .for("update");

    const fillable = eligible.filter((row) => row.perceptualHash === null);
    if (fillable.length > 0) {
      const cases = fillable.map(
        (row) =>
          sql`when ${image.id} = ${row.id} then ${requested.get(parseShortcodeFor("image", row.shortcode))!}`,
      );
      await tx
        .update(image)
        .set({
          perceptualHash: sql<string>`case ${sql.join(cases, sql.raw(" "))} else ${image.perceptualHash} end`,
        })
        .where(
          inArray(
            image.id,
            fillable.map((row) => row.id),
          ),
        );
    }

    if (eligible.length === 0) {
      return { items: [], unavailable: codes };
    }
    const canonical = await tx
      .select({
        shortcode: image.shortcode,
        perceptualHash: image.perceptualHash,
      })
      .from(image)
      .where(
        inArray(
          image.id,
          eligible.map((row) => row.id),
        ),
      );
    const byCode = new Map(
      canonical.map((row) => [
        parseShortcodeFor("image", row.shortcode),
        row.perceptualHash,
      ]),
    );
    return {
      items: codes.flatMap((id) => {
        const perceptualHash = byCode.get(id);
        return perceptualHash ? [{ id, perceptualHash }] : [];
      }),
      unavailable: codes.filter((id) => !byCode.has(id)),
    };
  });
};

const imageIntegrityFields = (imageData: typeof image.$inferSelect) => ({
  useOriginal: imageData.useOriginal,
  width: imageData.width,
  height: imageData.height,
  detectedContentType: imageData.detectedContentType,
  sha256: imageData.sha256,
  renderStatus: imageData.renderStatus,
  storageStatus: imageData.storageStatus,
  verifiedAt: imageData.verifiedAt,
});

type ImageWithRelations = typeof image.$inferSelect & {
  productImages: Array<{
    productId: string;
    product: { name: string; shortcode: string; deletedAt: Date | null };
  }>;
  locationImages: Array<{
    locationId: string;
    location: { name: string; shortcode: string; deletedAt: Date | null };
  }>;
  recipeImages: Array<{
    recipeId: string;
    recipe: { name: string; shortcode: string; deletedAt: Date | null };
  }>;
  projectImages: Array<{
    projectId: string;
    project: { name: string; shortcode: string; deletedAt: Date | null };
  }>;
  purchaseImages: Array<{
    purchaseId: string;
    purchase: {
      orderId: string | null;
      displayLabel: string | null;
      shortcode: string;
      deletedAt: Date | null;
    };
  }>;
  gardenEntryImages: Array<{
    gardenEntryId: string;
    gardenEntry: {
      kind: string;
      observedOn: string;
      shortcode: string;
      deletedAt: Date | null;
      location: { name: string };
    };
  }>;
  mealImages: Array<{
    mealId: string;
    meal: {
      name: string | null;
      date: string;
      shortcode: string;
      deletedAt: Date | null;
    };
  }>;
  taskImages: Array<{
    taskId: string;
    task: { name: string; shortcode: string; deletedAt: Date | null };
  }>;
  cookbookCovers: Array<{
    name: string;
    shortcode: string;
    deletedAt: Date | null;
  }>;
  vendorLogos: Array<{
    name: string;
    shortcode: string;
    deletedAt: Date | null;
  }>;
};

// Mirrors `GARDEN_ENTRY_KIND_LABELS` in `~/server/repo/garden` (private
// there).
const GARDEN_ENTRY_ASSOCIATION_KIND_LABELS = {
  note: "Note",
  harvest: "Harvest",
} satisfies Record<string, string>;

function isGardenEntryAssociationKindLabel(
  kind: string,
): kind is keyof typeof GARDEN_ENTRY_ASSOCIATION_KIND_LABELS {
  return kind in GARDEN_ENTRY_ASSOCIATION_KIND_LABELS;
}

/**
 * Transform image with pre-loaded relations to API format.
 * Expects relations to be loaded via `with` clause - no additional queries.
 * Note: Soft-deleted join table records filtered at query time, but we still check entity deletedAt.
 */
const imageWithRelationsToAPI = (
  imageData: ImageWithRelations,
): ImageWithEntity => {
  const associations: ImageAssociation[] = [
    ...imageData.productImages
      .filter(({ product }) => isNotDeleted(product))
      .map(({ product }) => ({
        entityType: "product" as const,
        entityId: product.shortcode,
        entityName: product.name,
        role: "attachment" as const,
      })),
    ...imageData.locationImages
      .filter(({ location }) => isNotDeleted(location))
      .map(({ location }) => ({
        entityType: "location" as const,
        entityId: location.shortcode,
        entityName: location.name,
        role: "attachment" as const,
      })),
    ...imageData.recipeImages
      .filter(({ recipe }) => isNotDeleted(recipe))
      .map(({ recipe }) => ({
        entityType: "recipe" as const,
        entityId: recipe.shortcode,
        entityName: recipe.name,
        role: "attachment" as const,
      })),
    ...imageData.projectImages
      .filter(({ project }) => isNotDeleted(project))
      .map(({ project }) => ({
        entityType: "project" as const,
        entityId: project.shortcode,
        entityName: project.name,
        role: "attachment" as const,
      })),
    ...imageData.purchaseImages
      .filter(({ purchase }) => isNotDeleted(purchase))
      .map(({ purchase }) => ({
        entityType: "purchase" as const,
        entityId: purchase.shortcode,
        // Best-effort echo of `displayName` (`purchaseLabel(...)` in
        // `~/lib/purchase-label`): this join carries no vendor name or date,
        // so the "vendor + date" / "vendor alone" rungs of that ladder aren't
        // reproducible here. What IS reproducible — orderId, optionally
        // suffixed with a nonblank displayLabel, else displayLabel alone —
        // is kept as-is.
        entityName:
          (purchase.orderId
            ? purchase.displayLabel?.trim()
              ? `${purchase.orderId} (${purchase.displayLabel.trim()})`
              : purchase.orderId
            : purchase.displayLabel?.trim()) ?? purchase.shortcode,
        role: "attachment" as const,
      })),
    ...imageData.gardenEntryImages
      .filter(({ gardenEntry }) => isNotDeleted(gardenEntry))
      .map(({ gardenEntry }) => ({
        entityType: "gardenEntry" as const,
        entityId: gardenEntry.shortcode,
        // `displayName`'s rule ("<Kind> · <date> · <location>"), computed
        // inline rather than imported: `gardenEntryDisplayName` in
        // `~/server/repo/garden` is private to that module.
        entityName: `${isGardenEntryAssociationKindLabel(gardenEntry.kind) ? GARDEN_ENTRY_ASSOCIATION_KIND_LABELS[gardenEntry.kind] : gardenEntry.kind} · ${gardenEntry.observedOn} · ${gardenEntry.location.name}`,
        role: "attachment" as const,
      })),
    ...imageData.mealImages
      .filter(({ meal }) => isNotDeleted(meal))
      .map(({ meal }) => ({
        entityType: "meal" as const,
        entityId: meal.shortcode,
        // Matches `displayName` exactly (`name?.trim() || date`); both
        // columns are already local to this row, no join needed.
        entityName: meal.name?.trim() || meal.date,
        role: "attachment" as const,
      })),
    ...imageData.taskImages
      .filter(({ task }) => isNotDeleted(task))
      .map(({ task }) => ({
        entityType: "task" as const,
        entityId: task.shortcode,
        entityName: task.name,
        role: "attachment" as const,
      })),
    ...imageData.cookbookCovers.filter(isNotDeleted).map((book) => ({
      entityType: "cookbook" as const,
      entityId: book.shortcode,
      entityName: book.name,
      role: "cover" as const,
    })),
    ...imageData.vendorLogos.filter(isNotDeleted).map((logoVendor) => ({
      entityType: "vendor" as const,
      entityId: logoVendor.shortcode,
      entityName: logoVendor.name,
      role: "logo" as const,
    })),
  ];
  const legacyAssociation = associations.find(
    ({ entityType }) => entityType !== "cookbook" && entityType !== "vendor",
  );
  const legacyEntityType = legacyAssociation
    ? match(legacyAssociation.entityType)
        .with("product", () => "PRODUCT" as const)
        .with("location", () => "LOCATION" as const)
        .with("recipe", () => "RECIPE" as const)
        .with("project", () => "PROJECT" as const)
        .with("purchase", () => "PURCHASE" as const)
        .with("gardenEntry", () => "GARDENENTRY" as const)
        .with("meal", () => "MEAL" as const)
        .with("task", () => "TASK" as const)
        .with("cookbook", "vendor", () => null)
        .exhaustive()
    : null;

  return {
    id: parseShortcodeFor("image", imageData.shortcode),
    url: getR2PublicUrl(imageData.key),
    key: imageData.key,
    filename: imageData.filename,
    size: imageData.size,
    contentType: imageData.contentType,
    status: imageData.status,
    ...imageIntegrityFields(imageData),
    source: imageData.source,
    sourcePageUrl: imageData.sourcePageUrl,
    sourceAssetUrl: imageData.sourceAssetUrl,
    sourceName: imageData.sourceName,
    createdAt: imageData.createdAt,
    updatedAt: imageData.updatedAt,
    entityType: legacyEntityType,
    entityId:
      legacyEntityType && legacyAssociation
        ? attachableImageEntityId.parse(legacyAssociation.entityId)
        : null,
    entityName: legacyAssociation?.entityName ?? null,
    associations: associations.sort(
      (a, b) =>
        a.entityType.localeCompare(b.entityType) ||
        a.entityName.localeCompare(b.entityName) ||
        a.entityId.localeCompare(b.entityId),
    ),
  };
};

/** Shared relation config for loading entity associations with soft-delete filtering */
const imageEntityRelations = {
  productImages: {
    where: notDeleted(productImage),
    with: {
      product: {
        columns: { name: true, shortcode: true, deletedAt: true },
      },
    },
    columns: { productId: true },
  },
  locationImages: {
    where: notDeleted(locationImage),
    with: {
      location: {
        columns: { name: true, shortcode: true, deletedAt: true },
      },
    },
    columns: { locationId: true },
  },
  recipeImages: {
    where: notDeleted(recipeImage),
    with: {
      recipe: {
        columns: { name: true, shortcode: true, deletedAt: true },
      },
    },
    columns: { recipeId: true },
  },
  projectImages: {
    where: notDeleted(projectImage),
    with: {
      project: {
        columns: { name: true, shortcode: true, deletedAt: true },
      },
    },
    columns: { projectId: true },
  },
  purchaseImages: {
    where: notDeleted(purchaseImage),
    with: {
      purchase: {
        columns: {
          orderId: true,
          displayLabel: true,
          shortcode: true,
          deletedAt: true,
        },
      },
    },
    columns: { purchaseId: true },
  },
  gardenEntryImages: {
    where: notDeleted(gardenEntryImage),
    with: {
      gardenEntry: {
        columns: {
          kind: true,
          observedOn: true,
          shortcode: true,
          deletedAt: true,
        },
        with: {
          location: { columns: { name: true } },
        },
      },
    },
    columns: { gardenEntryId: true },
  },
  mealImages: {
    where: notDeleted(mealImage),
    with: {
      meal: {
        columns: { name: true, date: true, shortcode: true, deletedAt: true },
      },
    },
    columns: { mealId: true },
  },
  taskImages: {
    where: notDeleted(taskImage),
    with: {
      task: {
        columns: { name: true, shortcode: true, deletedAt: true },
      },
    },
    columns: { taskId: true },
  },
  cookbookCovers: {
    where: notDeleted(cookbook),
    columns: { name: true, shortcode: true, deletedAt: true },
  },
  vendorLogos: {
    where: notDeleted(vendor),
    columns: { name: true, shortcode: true, deletedAt: true },
  },
} as const;

type ImageReferenceLiveness = "active" | "any-fk";

/**
 * The SQL form of the exhaustive incoming-edge set used by image deletion.
 *
 * `active` answers whether an image still renders through a live join row;
 * direct foreign keys remain references even when their owner is tombstoned.
 * `any-fk` answers the stricter question required before hard-deleting a
 * PENDING image: a tombstoned join row still holds an FK that PostgreSQL will
 * enforce. Keeping the distinction here prevents the maintenance detectors
 * from materializing every edge merely to make the same decision in JavaScript.
 */
const imageReferenceCondition = (
  db: Database,
  outerImage: typeof image,
  liveness: ImageReferenceLiveness,
): SQL => {
  const dbc = getDb(db);
  const joinReferenceWhere = (imageId: PgColumn, activeWhere: SQL) =>
    and(
      eq(imageId, outerImage.id),
      liveness === "active" ? activeWhere : undefined,
    );
  const byEdge = {
    // Processing children are cascade metadata, not user ownership. The hard
    // delete path below clears them after it locks the original image.
    "ImageProcessingJob.imageId": sql`FALSE`,
    "ImageDerivative.imageId": sql`FALSE`,
    "ImageDescriptionCorrection.imageId": sql`FALSE`,
    // A run worklist row records history, never ownership of the image.
    "ImportRunTarget.imageId": sql`FALSE`,
    "ImportPreparedOrder.primaryDocumentImageId": exists(
      dbc
        .select({ one: sql`1` })
        .from(importPreparedOrder)
        .where(eq(importPreparedOrder.primaryDocumentImageId, outerImage.id)),
    ),
    "ImportPreparedOrder.screenshotImageId": exists(
      dbc
        .select({ one: sql`1` })
        .from(importPreparedOrder)
        .where(eq(importPreparedOrder.screenshotImageId, outerImage.id)),
    ),
    "ImportHunt.receiptImageId": exists(
      dbc
        .select({ one: sql`1` })
        .from(importHunt)
        .where(eq(importHunt.receiptImageId, outerImage.id)),
    ),
    "OrderMailAttachment.imageId": exists(
      dbc
        .select({ one: sql`1` })
        .from(orderMailAttachment)
        .where(joinReferenceWhere(orderMailAttachment.imageId, sql`TRUE`)),
    ),
    // includes-deleted: direct FKs remain live constraints after their parent
    // is tombstoned, so reference membership must match hard-delete safety.
    "Cookbook.coverImageId": exists(
      dbc
        .select({ one: sql`1` })
        .from(cookbook)
        .where(eq(cookbook.coverImageId, outerImage.id)),
    ),
    // includes-deleted: same direct-FK rule as Cookbook.coverImageId above.
    "Vendor.logoImageId": exists(
      dbc
        .select({ one: sql`1` })
        .from(vendor)
        .where(eq(vendor.logoImageId, outerImage.id)),
    ),
    "ProductImage.imageId": exists(
      dbc
        .select({ one: sql`1` })
        .from(productImage)
        .where(
          joinReferenceWhere(productImage.imageId, notDeleted(productImage)),
        ),
    ),
    "LocationImage.imageId": exists(
      dbc
        .select({ one: sql`1` })
        .from(locationImage)
        .where(
          joinReferenceWhere(locationImage.imageId, notDeleted(locationImage)),
        ),
    ),
    "RecipeImage.imageId": exists(
      dbc
        .select({ one: sql`1` })
        .from(recipeImage)
        .where(
          joinReferenceWhere(recipeImage.imageId, notDeleted(recipeImage)),
        ),
    ),
    "ProjectImage.imageId": exists(
      dbc
        .select({ one: sql`1` })
        .from(projectImage)
        .where(
          joinReferenceWhere(projectImage.imageId, notDeleted(projectImage)),
        ),
    ),
    "PurchaseImage.imageId": exists(
      dbc
        .select({ one: sql`1` })
        .from(purchaseImage)
        .where(
          joinReferenceWhere(purchaseImage.imageId, notDeleted(purchaseImage)),
        ),
    ),
    "GardenEntryImage.imageId": exists(
      dbc
        .select({ one: sql`1` })
        .from(gardenEntryImage)
        .where(
          joinReferenceWhere(
            gardenEntryImage.imageId,
            notDeleted(gardenEntryImage),
          ),
        ),
    ),
    "MealImage.imageId": exists(
      dbc
        .select({ one: sql`1` })
        .from(mealImage)
        .where(joinReferenceWhere(mealImage.imageId, notDeleted(mealImage))),
    ),
    "TaskImage.imageId": exists(
      dbc
        .select({ one: sql`1` })
        .from(taskImage)
        .where(joinReferenceWhere(taskImage.imageId, notDeleted(taskImage))),
    ),
  } satisfies Record<IncomingEdgeKey<"image">, SQL>;

  return or(...Object.values(byEdge))!;
};

const activeImageReferenceCondition = (
  db: Database,
  outerImage: typeof image,
) => imageReferenceCondition(db, outerImage, "active");

const anyForeignKeyImageReferenceCondition = (
  db: Database,
  outerImage: typeof image,
) => imageReferenceCondition(db, outerImage, "any-fk");

const cullablePendingImageWhere = (db: Database, cutoffDate: Date) =>
  and(
    eq(image.status, "PENDING"),
    lt(image.createdAt, cutoffDate),
    // Any reference, including a tombstoned join-row owner, protects this hard
    // delete. PostgreSQL still enforces that FK even though no page renders it.
    not(anyForeignKeyImageReferenceCondition(db, image)),
  );

/**
 * The `imageList` predicate. Takes `outerImage` as a parameter — not just
 * `image` — because `imageList` below calls this twice: once against the
 * aliased table the relational `findMany` selects through, once against the
 * root table for the plain-count query. Exported so `getEntityCounts` can call
 * `buildImageWhere(db, {})` and get the list's REAL population rather than a
 * hand-restated copy that can drift from it.
 *
 * Routed through `buildSearchConditions` (like every other list) rather than a
 * hand-built `and(...)`, which is a deliberate behavior change: the old
 * `buildWhere` here started from an EMPTY conditions array with NO soft-delete
 * predicate at all, so `imageList({})` would have returned soft-deleted images
 * too. `buildSearchConditions` supplies `notDeleted` for free, closing that gap.
 * Verified impact is ZERO rows today (0 of 5738 images have `deletedAt` set,
 * since `deleteImages` hard-deletes rather than soft-deletes) — `Image` is
 * still declared `softDeletedAt()`, so this closes a latent gap rather than
 * changing any observable result.
 */
// Not on `listScaffold`: the predicate is built twice against two spellings
// of the table (`outerImage`), and the scaffold binds one table per entity.
export const buildImageWhere = (
  db: Database,
  filters: ImageListFilters,
  outerImage: typeof image = image,
): SQL | undefined => {
  let referencePresence: SQL | undefined;
  if (filters.referencePresenceFilter) {
    const referenced = activeImageReferenceCondition(db, outerImage);
    referencePresence =
      filters.referencePresenceFilter === "has" ? referenced : not(referenced);
  }

  return buildSearchConditions(
    outerImage,
    [],
    [
      // `filename` (text) and `status` (multiselect) are declared stored
      // filters — passed `outerImage` so the aliased-table row query and the
      // unaliased count query each resolve their own columns.
      ...declaredFilterPredicates("image", outerImage, filters),
      ...auditDateWhereConditions(outerImage, filters),
      referencePresence,
      imageProcessingIssueFilter(outerImage, filters.processingIssue),
      filters.uploadedAgeHoursMin !== undefined
        ? sql`${outerImage.createdAt} < now() - (${filters.uploadedAgeHoursMin} * interval '1 hour')`
        : undefined,
    ],
  );
};

export const imageList = async (
  db: Database,
  filters: ImageListFilters,
  sorts: Array<{ orderBy: string; direction: "asc" | "desc" }>,
  pagination: { pageIndex: number; pageSize: number },
  readIntent: ListReadIntent = "page",
) => {
  const dbClient = getDb(db);
  const whereClause = buildImageWhere(
    db,
    filters,
    aliasedTable(image, "image"),
  );
  const countWhereClause = buildImageWhere(db, filters, image);

  const orderByClause = buildOrderBy(image, sorts, [
    ...generatedEntitySort.image.fields,
  ]);

  const take = pagination.pageSize;
  const skip = pagination.pageIndex * pagination.pageSize;

  const { data: images, count } = await executeListQueryWithCount({
    kind: readIntent,
    rows: () =>
      dbClient.query.image.findMany({
        where: whereClause,
        orderBy: orderByClause,
        limit: take,
        offset: skip,
        with: imageEntityRelations,
      }),
    count: () => countWhere(db, image, countWhereClause),
  });

  const representations = await loadImageRepresentations(
    db,
    images.map((item) => item.shortcode),
  );
  const processingIssues = await loadImageProcessingIssues(
    db,
    images.map((item) => item.shortcode),
  );
  const processedImages = images.map((item) => ({
    ...imageWithRelationsToAPI(item),
    representations: representations.get(item.shortcode),
    processingIssue: processingIssues.get(item.shortcode) ?? null,
  }));

  return {
    data: processedImages,
    count,
  };
};

export const getImageById = async (
  db: Database,
  imageId: string,
): Promise<ImageWithEntity> => {
  const imageRecord = await getDb(db).query.image.findFirst({
    where: eq(image.id, imageId),
    with: imageEntityRelations,
  });

  if (!imageRecord) {
    throw createAppError("IMAGE_NOT_FOUND", "Image not found");
  }

  return {
    ...imageWithRelationsToAPI(imageRecord),
    representations: (
      await loadImageRepresentations(db, [imageRecord.shortcode])
    ).get(imageRecord.shortcode),
  };
};

/**
 * Read several images with their direct associations from one database
 * snapshot. Photo-import reconciliation calls this only after locking the
 * corresponding rows, so it cannot observe an in-flight commit halfway
 * through its pending-to-uploaded transition.
 */
export const getImagesByShortcodes = async (
  db: Database,
  shortcodes: readonly string[],
): Promise<ImageWithEntity[]> => {
  if (shortcodes.length === 0) return [];
  const records = await getDb(db).query.image.findMany({
    where: and(
      inArray(image.shortcode, [...new Set(shortcodes)]),
      notDeleted(image),
    ),
    with: imageEntityRelations,
  });
  const representations = await loadImageRepresentations(
    db,
    records.map((row) => row.shortcode),
  );
  return records.map((row) => ({
    ...imageWithRelationsToAPI(row),
    representations: representations.get(row.shortcode),
  }));
};

/**
 * Rename an image. `filename` is the only safely user-editable column — `key`/
 * `url`/`size`/`contentType`/`status` are all derived from the upload itself,
 * so this is intentionally the entire update surface (see `imageUpdateInput`).
 * Re-reads via {@link getImageById} so the output matches `getByID`'s shape
 * (including the resolved entity association) rather than a bare row.
 */
export const updateImage = async (
  db: Database,
  imageId: string,
  data: ImageUpdateInput,
): Promise<ImageWithEntity> => {
  await updateAndReturn(
    db,
    image,
    { filename: data.filename, useOriginal: data.useOriginal },
    and(eq(image.id, imageId), notDeleted(image)),
  );
  return getImageById(db, imageId);
};

/**
 * Flip a PENDING image row to UPLOADED once the browser's presigned PUT to R2
 * succeeds. Without this, a standalone `/images` upload (no owning entity to
 * call `associatePendingImages`) stays PENDING forever — rendering "Upload
 * pending…" indefinitely and then getting deleted, R2 object included, by
 * {@link findCullablePendingImages} (PENDING + no association is exactly its
 * selection).
 *
 * Predicated on `status = "PENDING"` (not just `id`) so the transition is
 * forward-only and safe: it can never resurrect a FAILED row back to
 * UPLOADED, and a duplicate call on a row that already flipped throws rather
 * than silently re-writing state that something else may have changed since.
 */
export const markImageUploaded = async (
  db: Database,
  imageId: string,
): Promise<ImageWithEntity> => {
  await updateAndReturn(
    db,
    image,
    { status: "UPLOADED" },
    and(eq(image.id, imageId), eq(image.status, "PENDING"), notDeleted(image)),
  );
  return getImageById(db, imageId);
};

export const getImageByKey = async (
  db: Database,
  key: string,
): Promise<{
  id: string;
  shortcode: string;
  url: string;
  key: string;
} | null> => {
  const imageRecord = await getDb(db).query.image.findFirst({
    where: eq(image.key, key),
    columns: {
      id: true,
      // Selected because callers report the PUBLIC id back to a client.
      shortcode: true,
      key: true,
    },
  });

  return imageRecord
    ? { ...imageRecord, url: getR2PublicUrl(imageRecord.key) }
    : null;
};

/**
 * Unassociated PENDING image rows older than the threshold — the abandoned
 * uploads the cull deletes. Shared by {@link cullPendingImages} and
 * {@link countCullablePendingImages} so the Maintenance card's "N affected"
 * figure can't drift from what the button actually removes.
 */
export const countCullablePendingImages = async (
  db: Database,
  olderThanHours: number,
): Promise<number> => {
  const cutoffDate = new Date();
  cutoffDate.setHours(cutoffDate.getHours() - olderThanHours);
  const [row] = await getDb(db)
    .select({ count: sql<number>`count(*)::int` })
    .from(image)
    .where(cullablePendingImageWhere(db, cutoffDate));
  return row?.count ?? 0;
};

export const cullPendingImages = async (
  db: Database,
  olderThanHours: number,
) => {
  // Claim and delete in one transaction. Commit holds the same image-row locks
  // while it creates associations and performs its final activation, so
  // SKIP LOCKED makes this culler leave in-flight imports untouched instead of
  // deleting rows selected by a stale pre-lock snapshot.
  const result = await withTransaction(db, async (tx) => {
    const cutoffDate = new Date();
    cutoffDate.setHours(cutoffDate.getHours() - olderThanHours);
    const pendingImages = await tx
      .select({ id: image.id })
      .from(image)
      .where(cullablePendingImageWhere(db, cutoffDate))
      .for("update", { skipLocked: true });

    if (pendingImages.length === 0) {
      return {
        count: 0,
        deletedIds: [],
        deletedKeys: [],
        affectedOwnerSearchRefs: [],
      };
    }

    const imageIds = pendingImages.map((img) => img.id);
    const deleted = await deleteImagesTx(tx, imageIds);

    return {
      count: deleted.deletedIds.length,
      deletedIds: deleted.deletedIds,
      deletedKeys: deleted.deletedKeys,
      affectedOwnerSearchRefs: deleted.affectedOwnerSearchRefs,
    };
  });
  await refreshCapturedImageSearchOwnerRefs(
    db,
    result.affectedOwnerSearchRefs,
    "image.cull",
  );
  return {
    count: result.count,
    deletedIds: result.deletedIds,
    deletedKeys: result.deletedKeys,
  };
};

/**
 * How to clear each of `image`'s incoming edges (`INCOMING_EDGES.image`)
 * before the hard delete below. `Record` over that literal-union key type
 * requires every declared edge to have an entry, so a new edge on `image` is a
 * compile error here until it's dispositioned — the guard that would have
 * caught `PurchaseImage` shipping with no disposition in the first place.
 *
 * - `hard-delete` (`deleteRow`) — a join table: delete the association row,
 *   detaching the image from whatever product/location/recipe/project/purchase
 *   owned it.
 * - `detach` (`clearFk`) — a direct FK column (`Cookbook.coverImageId` today):
 *   null it so the parent row survives, just without a cover.
 */
export const IMAGE_HARD_DELETE = {
  "ImportRunTarget.imageId": {
    code: "deleteRow",
    effect: "hard-delete",
    description:
      "A photo-inventory worklist row cannot outlive its image: the three-way target check forbids clearing the link.",
  },
  "ImageProcessingJob.imageId": {
    code: "deleteRow",
    effect: "hard-delete",
    description:
      "The original image's durable processing attempts are removed before the original row.",
  },
  "ImageDerivative.imageId": {
    code: "deleteRow",
    effect: "hard-delete",
    description:
      "Non-gallery derivative records are removed with their original image.",
  },
  "ImageDescriptionCorrection.imageId": {
    code: "deleteRow",
    effect: "hard-delete",
    description:
      "A confirmed description cannot outlive the image it describes.",
  },
  "ImportPreparedOrder.primaryDocumentImageId": {
    code: "clearFk",
    effect: "detach",
    description:
      "Prepared import evidence remains while its deleted primary document link is cleared.",
  },
  "ImportPreparedOrder.screenshotImageId": {
    code: "clearFk",
    effect: "detach",
    description:
      "Prepared import evidence remains while its deleted screenshot link is cleared.",
  },
  "ImportHunt.receiptImageId": {
    code: "clearFk",
    effect: "detach",
    description:
      "The receipt hunt remains while its optional submitted image is cleared.",
  },
  "OrderMailAttachment.imageId": {
    code: "clearFk",
    effect: "detach",
    description:
      "The normalized mail attachment remains while its optional stored image is cleared.",
  },
  "Cookbook.coverImageId": {
    code: "clearFk",
    effect: "detach",
    description:
      "A cookbook's cover image is cleared, not cascaded — the cookbook survives without a cover.",
  },
  "Vendor.logoImageId": {
    code: "clearFk",
    effect: "detach",
    description:
      "A vendor logo is cleared when its Image is removed; the vendor keeps its monogram fallback.",
  },
  "ProductImage.imageId": {
    code: "deleteRow",
    effect: "hard-delete",
    description:
      "The product's image association is removed along with the image.",
  },
  "LocationImage.imageId": {
    code: "deleteRow",
    effect: "hard-delete",
    description:
      "The location's image association is removed along with the image.",
  },
  "RecipeImage.imageId": {
    code: "deleteRow",
    effect: "hard-delete",
    description:
      "The recipe's image association is removed along with the image.",
  },
  "ProjectImage.imageId": {
    code: "deleteRow",
    effect: "hard-delete",
    description:
      "The project's image association is removed along with the image.",
  },
  "PurchaseImage.imageId": {
    code: "deleteRow",
    effect: "hard-delete",
    description:
      "The purchase's image association is removed along with the image.",
  },
  "GardenEntryImage.imageId": {
    code: "deleteRow",
    effect: "hard-delete",
    description:
      "The garden entry's image association is removed with the image.",
  },
  "MealImage.imageId": {
    code: "deleteRow",
    effect: "hard-delete",
    description:
      "The meal's image association is removed along with the image.",
  },
  "TaskImage.imageId": {
    code: "deleteRow",
    effect: "hard-delete",
    description:
      "The task's image association is removed along with the image.",
  },
} satisfies IncomingEdgePolicy<"image", OperationDisposition>;

type ImageEdgeOperation = {
  clear: (tx: DrizzleTransaction, imageIds: string[]) => Promise<void>;
  findReferenced: (
    dbc: DrizzleClient | DrizzleTransaction,
    imageIds?: string[],
  ) => Promise<string[]>;
  joinColumn?: PgColumn;
  /** Processing metadata must cascade on delete but is never user ownership. */
  countsAsOwnership?: boolean;
};

const parseImageIds = (imageIds: readonly string[]): ImageId[] =>
  imageIds.map((imageId) => parseEntityId("image", imageId));

const IMAGE_EDGE_OPERATIONS = {
  "ImportRunTarget.imageId": {
    countsAsOwnership: false,
    clear: async (tx: DrizzleTransaction, imageIds: string[]) => {
      await tx
        .delete(importRunTarget)
        .where(inArray(importRunTarget.imageId, parseImageIds(imageIds)));
    },
    findReferenced: async (
      dbc: DrizzleClient | DrizzleTransaction,
      imageIds?: string[],
    ) => {
      const rows = await dbc
        .select({ imageId: importRunTarget.imageId })
        .from(importRunTarget)
        .where(
          and(
            isNotNull(importRunTarget.imageId),
            imageIds
              ? inArray(importRunTarget.imageId, parseImageIds(imageIds))
              : undefined,
          ),
        );
      return rows.flatMap(({ imageId }) => (imageId ? [imageId] : []));
    },
    joinColumn: undefined,
  },
  // Job rows refer to derivatives as well as originals, so they must go first.
  "ImageProcessingJob.imageId": {
    countsAsOwnership: false,
    clear: async (tx: DrizzleTransaction, imageIds: string[]) => {
      await tx
        .delete(imageProcessingJob)
        .where(inArray(imageProcessingJob.imageId, parseImageIds(imageIds)));
    },
    findReferenced: async (
      dbc: DrizzleClient | DrizzleTransaction,
      imageIds?: string[],
    ) => {
      const rows = await dbc
        .select({ imageId: imageProcessingJob.imageId })
        .from(imageProcessingJob)
        .where(
          imageIds
            ? inArray(imageProcessingJob.imageId, parseImageIds(imageIds))
            : undefined,
        );
      return rows.map(({ imageId }) => imageId);
    },
    joinColumn: undefined,
  },
  "ImageDerivative.imageId": {
    countsAsOwnership: false,
    clear: async (tx: DrizzleTransaction, imageIds: string[]) => {
      await tx
        .delete(imageDerivative)
        .where(inArray(imageDerivative.imageId, parseImageIds(imageIds)));
    },
    findReferenced: async (
      dbc: DrizzleClient | DrizzleTransaction,
      imageIds?: string[],
    ) => {
      const rows = await dbc
        .select({ imageId: imageDerivative.imageId })
        .from(imageDerivative)
        .where(
          imageIds
            ? inArray(imageDerivative.imageId, parseImageIds(imageIds))
            : undefined,
        );
      return rows.map(({ imageId }) => imageId);
    },
    joinColumn: undefined,
  },
  "ImageDescriptionCorrection.imageId": {
    countsAsOwnership: false,
    clear: async (tx: DrizzleTransaction, imageIds: string[]) => {
      await tx
        .delete(imageDescriptionCorrection)
        .where(
          inArray(imageDescriptionCorrection.imageId, parseImageIds(imageIds)),
        );
    },
    findReferenced: async (
      dbc: DrizzleClient | DrizzleTransaction,
      imageIds?: string[],
    ) => {
      const rows = await dbc
        .select({ imageId: imageDescriptionCorrection.imageId })
        .from(imageDescriptionCorrection)
        .where(
          imageIds
            ? inArray(
                imageDescriptionCorrection.imageId,
                parseImageIds(imageIds),
              )
            : undefined,
        );
      return rows.map(({ imageId }) => imageId);
    },
    joinColumn: undefined,
  },
  "ImportPreparedOrder.primaryDocumentImageId": {
    clear: async (tx, imageIds) => {
      await tx
        .update(importPreparedOrder)
        .set({ primaryDocumentImageId: null })
        .where(inArray(importPreparedOrder.primaryDocumentImageId, imageIds));
    },
    findReferenced: async (dbc, imageIds) => {
      const rows = await dbc
        .select({ imageId: importPreparedOrder.primaryDocumentImageId })
        .from(importPreparedOrder)
        .where(
          and(
            isNotNull(importPreparedOrder.primaryDocumentImageId),
            imageIds
              ? inArray(importPreparedOrder.primaryDocumentImageId, imageIds)
              : undefined,
          ),
        );
      return rows.flatMap(({ imageId }) => (imageId ? [imageId] : []));
    },
    joinColumn: undefined,
  },
  "ImportPreparedOrder.screenshotImageId": {
    clear: async (tx, imageIds) => {
      await tx
        .update(importPreparedOrder)
        .set({ screenshotImageId: null })
        .where(inArray(importPreparedOrder.screenshotImageId, imageIds));
    },
    findReferenced: async (dbc, imageIds) => {
      const rows = await dbc
        .select({ imageId: importPreparedOrder.screenshotImageId })
        .from(importPreparedOrder)
        .where(
          and(
            isNotNull(importPreparedOrder.screenshotImageId),
            imageIds
              ? inArray(importPreparedOrder.screenshotImageId, imageIds)
              : undefined,
          ),
        );
      return rows.flatMap(({ imageId }) => (imageId ? [imageId] : []));
    },
    joinColumn: undefined,
  },
  "ImportHunt.receiptImageId": {
    clear: async (tx, imageIds) => {
      await tx
        .update(importHunt)
        .set({ receiptImageId: null })
        .where(inArray(importHunt.receiptImageId, imageIds));
    },
    findReferenced: async (dbc, imageIds) => {
      const rows = await dbc
        .select({ imageId: importHunt.receiptImageId })
        .from(importHunt)
        .where(
          and(
            isNotNull(importHunt.receiptImageId),
            imageIds ? inArray(importHunt.receiptImageId, imageIds) : undefined,
          ),
        );
      return rows.flatMap(({ imageId }) => (imageId ? [imageId] : []));
    },
    joinColumn: undefined,
  },
  "OrderMailAttachment.imageId": {
    clear: async (tx, imageIds) => {
      await tx
        .update(orderMailAttachment)
        .set({ imageId: null })
        .where(inArray(orderMailAttachment.imageId, imageIds));
    },
    findReferenced: async (dbc, imageIds) => {
      const rows = await dbc
        .select({ imageId: orderMailAttachment.imageId })
        .from(orderMailAttachment)
        .where(
          and(
            isNotNull(orderMailAttachment.imageId),
            imageIds
              ? inArray(orderMailAttachment.imageId, imageIds)
              : undefined,
          ),
        );
      return rows.flatMap(({ imageId }) => (imageId ? [imageId] : []));
    },
    joinColumn: undefined,
  },
  "Cookbook.coverImageId": {
    clear: async (tx, imageIds) => {
      await tx
        .update(cookbook)
        .set({ coverImageId: null })
        .where(inArray(cookbook.coverImageId, imageIds));
    },
    findReferenced: async (dbc, imageIds) => {
      const rows = await dbc
        .select({ imageId: cookbook.coverImageId })
        .from(cookbook)
        .where(
          and(
            isNotNull(cookbook.coverImageId),
            imageIds ? inArray(cookbook.coverImageId, imageIds) : undefined,
          ),
        );
      return rows.flatMap(({ imageId }) => (imageId ? [imageId] : []));
    },
    joinColumn: undefined,
  },
  "Vendor.logoImageId": {
    clear: async (tx, imageIds) => {
      await tx
        .update(vendor)
        .set({ logoImageId: null })
        .where(inArray(vendor.logoImageId, imageIds));
    },
    findReferenced: async (dbc, imageIds) => {
      const rows = await dbc
        .select({ imageId: vendor.logoImageId })
        .from(vendor)
        .where(
          and(
            isNotNull(vendor.logoImageId),
            imageIds ? inArray(vendor.logoImageId, imageIds) : undefined,
          ),
        );
      return rows.flatMap(({ imageId }) => (imageId ? [imageId] : []));
    },
    joinColumn: undefined,
  },
  "ProductImage.imageId": {
    clear: async (tx, imageIds) => {
      await tx
        .delete(productImage)
        .where(inArray(productImage.imageId, imageIds));
    },
    findReferenced: async (dbc, imageIds) => {
      const rows = await dbc
        .select({ imageId: productImage.imageId })
        .from(productImage)
        .where(
          and(
            isNotNull(productImage.imageId),
            imageIds ? inArray(productImage.imageId, imageIds) : undefined,
            notDeleted(productImage),
          ),
        );
      return rows.map(({ imageId }) => imageId);
    },
    joinColumn: productImage.imageId,
  },
  "LocationImage.imageId": {
    clear: async (tx, imageIds) => {
      await tx
        .delete(locationImage)
        .where(inArray(locationImage.imageId, imageIds));
    },
    findReferenced: async (dbc, imageIds) => {
      const rows = await dbc
        .select({ imageId: locationImage.imageId })
        .from(locationImage)
        .where(
          and(
            isNotNull(locationImage.imageId),
            imageIds ? inArray(locationImage.imageId, imageIds) : undefined,
            notDeleted(locationImage),
          ),
        );
      return rows.map(({ imageId }) => imageId);
    },
    joinColumn: locationImage.imageId,
  },
  "RecipeImage.imageId": {
    clear: async (tx, imageIds) => {
      await tx
        .delete(recipeImage)
        .where(inArray(recipeImage.imageId, imageIds));
    },
    findReferenced: async (dbc, imageIds) => {
      const rows = await dbc
        .select({ imageId: recipeImage.imageId })
        .from(recipeImage)
        .where(
          and(
            isNotNull(recipeImage.imageId),
            imageIds ? inArray(recipeImage.imageId, imageIds) : undefined,
            notDeleted(recipeImage),
          ),
        );
      return rows.map(({ imageId }) => imageId);
    },
    joinColumn: recipeImage.imageId,
  },
  "ProjectImage.imageId": {
    clear: async (tx, imageIds) => {
      await tx
        .delete(projectImage)
        .where(inArray(projectImage.imageId, imageIds));
    },
    findReferenced: async (dbc, imageIds) => {
      const rows = await dbc
        .select({ imageId: projectImage.imageId })
        .from(projectImage)
        .where(
          and(
            isNotNull(projectImage.imageId),
            imageIds ? inArray(projectImage.imageId, imageIds) : undefined,
            notDeleted(projectImage),
          ),
        );
      return rows.map(({ imageId }) => imageId);
    },
    joinColumn: projectImage.imageId,
  },
  "PurchaseImage.imageId": {
    clear: async (tx, imageIds) => {
      await tx
        .delete(purchaseImage)
        .where(inArray(purchaseImage.imageId, imageIds));
    },
    findReferenced: async (dbc, imageIds) => {
      const rows = await dbc
        .select({ imageId: purchaseImage.imageId })
        .from(purchaseImage)
        .where(
          and(
            isNotNull(purchaseImage.imageId),
            imageIds ? inArray(purchaseImage.imageId, imageIds) : undefined,
            notDeleted(purchaseImage),
          ),
        );
      return rows.map(({ imageId }) => imageId);
    },
    joinColumn: purchaseImage.imageId,
  },
  "GardenEntryImage.imageId": {
    clear: async (tx, imageIds) => {
      await tx
        .delete(gardenEntryImage)
        .where(inArray(gardenEntryImage.imageId, imageIds));
    },
    findReferenced: async (dbc, imageIds) => {
      const rows = await dbc
        .select({ imageId: gardenEntryImage.imageId })
        .from(gardenEntryImage)
        .where(
          and(
            isNotNull(gardenEntryImage.imageId),
            imageIds ? inArray(gardenEntryImage.imageId, imageIds) : undefined,
            notDeleted(gardenEntryImage),
          ),
        );
      return rows.map(({ imageId }) => imageId);
    },
    joinColumn: gardenEntryImage.imageId,
  },
  "MealImage.imageId": {
    clear: async (tx, imageIds) => {
      await tx.delete(mealImage).where(inArray(mealImage.imageId, imageIds));
    },
    findReferenced: async (dbc, imageIds) => {
      const rows = await dbc
        .select({ imageId: mealImage.imageId })
        .from(mealImage)
        .where(
          and(
            isNotNull(mealImage.imageId),
            imageIds ? inArray(mealImage.imageId, imageIds) : undefined,
            notDeleted(mealImage),
          ),
        );
      return rows.map(({ imageId }) => imageId);
    },
    joinColumn: mealImage.imageId,
  },
  "TaskImage.imageId": {
    clear: async (tx, imageIds) => {
      await tx.delete(taskImage).where(inArray(taskImage.imageId, imageIds));
    },
    findReferenced: async (dbc, imageIds) => {
      const rows = await dbc
        .select({ imageId: taskImage.imageId })
        .from(taskImage)
        .where(
          and(
            isNotNull(taskImage.imageId),
            imageIds ? inArray(taskImage.imageId, imageIds) : undefined,
            notDeleted(taskImage),
          ),
        );
      return rows.map(({ imageId }) => imageId);
    },
    joinColumn: taskImage.imageId,
  },
} satisfies Record<IncomingEdgeKey<"image">, ImageEdgeOperation>;
const imageEdgeOperations: ImageEdgeOperation[] = Object.values(
  IMAGE_EDGE_OPERATIONS,
);

/**
 * Resolve `imageIds` down to the subset that actually exists — bogus or
 * already-gone ids are silently skipped rather than causing a partial
 * cascade. Used by {@link deleteImages}, which also needs the keys for the R2
 * cleanup.
 */
const fetchExistingImages = async (
  tx: DrizzleTransaction,
  imageIds: string[],
): Promise<Array<{ id: ImageId; shortcode: string; key: string }>> => {
  const rows = await tx
    .select({ id: image.id, shortcode: image.shortcode, key: image.key })
    .from(image)
    .where(inArray(image.id, imageIds))
    // Lock the original before reading derivative keys or clearing edges. A
    // worker claim/adoption takes the same image lock, so it cannot rotate a
    // key between our collection and hard delete.
    .orderBy(asc(image.id))
    .for("update");
  return rows.map((row) => ({
    ...row,
    id: parseEntityId("image", row.id),
  }));
};

type DeletedImages = {
  deletedIds: ImageId[];
  deletedShortcodes: ImageShortcode[];
  deletedKeys: string[];
};

type DeletedImagesTx = DeletedImages & {
  affectedOwnerSearchRefs: SearchableEntityRef[];
};

/**
 * Hard-delete image rows and return their R2 keys so the caller can drop the
 * objects too.
 *
 * `Image` DOES carry a `deletedAt` (see `softDeletedAt()` in schema.ts, and the
 * partial unique index on `key` that keys off it) — it's simply never set,
 * because images are the one gallery entity deleted for real rather than
 * tombstoned. An image with no owning entity has no use once removed, and
 * restore was never implemented for any entity, so "delete" here means the row
 * is gone — matching how the pending cull already works. Reads still go through
 * `notDeleted(image)` so the column stays honest if that ever changes.
 * Every incoming edge is cleared first, per {@link IMAGE_HARD_DELETE}'s
 * disposition — they FK the image, so this also detaches it from whatever
 * entity owned it. Missing ids are skipped; the returned keys are only those
 * actually removed.
 */
export const deleteImages = async (
  db: Database,
  imageIds: ImageId[],
): Promise<DeletedImages> => {
  if (imageIds.length === 0)
    return { deletedIds: [], deletedShortcodes: [], deletedKeys: [] };
  const { affectedOwnerSearchRefs, ...deleted } = await withTransaction(
    db,
    (tx) => deleteImagesTx(tx, imageIds),
  );
  await refreshCapturedImageSearchOwnerRefs(
    db,
    affectedOwnerSearchRefs,
    "image.delete",
  );
  return deleted;
};

/**
 * The cascade + hard delete itself, on a caller-owned transaction. Extracted so
 * {@link detachImagesFromEntity} can run it inside the very transaction that
 * removed the join rows — splitting the two across transactions would leave
 * exactly the window this whole mechanism exists to close.
 *
 * Private on purpose: `deleteImages` keeps the public "I own a boundary"
 * promise (and its `db.transaction` span) that `withTransactionOn` would blur.
 */
const deleteImagesTx = async (
  tx: DrizzleTransaction,
  imageIds: string[],
): Promise<DeletedImagesTx> => {
  if (imageIds.length === 0)
    return {
      deletedIds: [],
      deletedShortcodes: [],
      deletedKeys: [],
      affectedOwnerSearchRefs: [],
    };

  const rows = await fetchExistingImages(tx, imageIds);
  if (rows.length === 0)
    return {
      deletedIds: [],
      deletedShortcodes: [],
      deletedKeys: [],
      affectedOwnerSearchRefs: [],
    };

  const ids = rows.map((row) => row.id);
  const affectedOwnerSearchRefs: SearchableEntityRef[] = [];
  for (const id of ids) {
    const refs = await findDirectImageSearchOwnerRefs(tx, id);
    affectedOwnerSearchRefs.push(
      ...refs.filter((ref) => ref.entityType !== "image"),
    );
  }
  const derivatives = await tx
    .select({ id: imageDerivative.id, key: imageDerivative.key })
    .from(imageDerivative)
    .where(inArray(imageDerivative.imageId, ids))
    .orderBy(asc(imageDerivative.id))
    .for("update");
  if (derivatives.length > 0) {
    await tx
      .insert(imageProcessingOrphan)
      .values(
        derivatives.map((derivative) => ({
          key: derivative.key,
          reason: "original_image_deleted",
        })),
      )
      .onConflictDoNothing();
  }
  const inputs = await tx
    .select({ key: imageProcessingAttempt.inputKey })
    .from(imageProcessingAttempt)
    .innerJoin(
      imageProcessingJob,
      eq(imageProcessingJob.id, imageProcessingAttempt.jobId),
    )
    .where(inArray(imageProcessingJob.imageId, ids));
  const inputKeys = inputs.flatMap((input) => (input.key ? [input.key] : []));
  if (inputKeys.length)
    await tx
      .insert(imageProcessingOrphan)
      .values(
        inputKeys.map((key) => ({ key, reason: "original_image_deleted" })),
      )
      .onConflictDoNothing();
  const affectedPurchases = await tx
    .selectDistinct({ purchaseId: purchaseImage.purchaseId })
    .from(purchaseImage)
    .where(and(inArray(purchaseImage.imageId, ids), notDeleted(purchaseImage)));

  for (const operation of imageEdgeOperations) {
    await operation.clear(tx, ids);
  }

  await softDeleteEntitySearchArtifactsTx(tx, "image", ids);
  await tx.delete(image).where(inArray(image.id, ids));

  await touchDataQualityTargets(tx, {
    purchaseIds: affectedPurchases.map((row) => row.purchaseId),
  });

  return {
    deletedIds: ids,
    deletedShortcodes: rows.map((row) =>
      parseShortcodeFor("image", row.shortcode),
    ),
    deletedKeys: [
      ...rows.map((row) => row.key),
      ...derivatives.map((row) => row.key),
    ],
    affectedOwnerSearchRefs,
  };
};

/** Referenced-image detection shares the image edge registry so delete and detach cannot drift. */
const findReferencedImageIds = async (
  dbc: DrizzleClient | DrizzleTransaction,
  imageIds?: string[],
): Promise<Set<string>> => {
  const referenced = new Set<string>();
  // Sequential, not Promise.all: a pg transaction is a single connection, and
  // this runs inside the caller's.
  for (const operation of imageEdgeOperations) {
    if (operation.countsAsOwnership === false) continue;
    for (const imageId of await operation.findReferenced(dbc, imageIds)) {
      referenced.add(imageId);
    }
  }
  return referenced;
};

/** Detach joins and reap newly unreferenced uploaded images transactionally; drop R2 keys only after commit. */
export const detachImagesFromEntity = async (
  tx: DrizzleTransaction,
  entity: AttachableImageRef,
  imageIds: ImageId[],
): Promise<{ deletedIds: string[]; deletedKeys: string[] }> => {
  if (imageIds.length === 0) return { deletedIds: [], deletedKeys: [] };

  await match(entity)
    .with({ entity: "product" }, ({ id }) =>
      tx
        .update(productImage)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(productImage.productId, id),
            inArray(productImage.imageId, imageIds),
            notDeleted(productImage),
          ),
        ),
    )
    .with({ entity: "recipe" }, ({ id }) =>
      tx
        .delete(recipeImage)
        .where(
          and(
            eq(recipeImage.recipeId, id),
            inArray(recipeImage.imageId, imageIds),
          ),
        ),
    )
    .with({ entity: "location" }, ({ id }) =>
      tx
        .delete(locationImage)
        .where(
          and(
            eq(locationImage.locationId, id),
            inArray(locationImage.imageId, imageIds),
          ),
        ),
    )
    .with({ entity: "project" }, ({ id }) =>
      tx
        .delete(projectImage)
        .where(
          and(
            eq(projectImage.projectId, id),
            inArray(projectImage.imageId, imageIds),
          ),
        ),
    )
    .with({ entity: "purchase" }, ({ id }) =>
      tx
        .delete(purchaseImage)
        .where(
          and(
            eq(purchaseImage.purchaseId, id),
            inArray(purchaseImage.imageId, imageIds),
          ),
        ),
    )
    .with({ entity: "gardenEntry" }, ({ id }) =>
      tx
        .delete(gardenEntryImage)
        .where(
          and(
            eq(gardenEntryImage.gardenEntryId, id),
            inArray(gardenEntryImage.imageId, imageIds),
          ),
        ),
    )
    .with({ entity: "meal" }, ({ id }) =>
      tx
        .delete(mealImage)
        .where(
          and(eq(mealImage.mealId, id), inArray(mealImage.imageId, imageIds)),
        ),
    )
    .with({ entity: "task" }, ({ id }) =>
      tx
        .delete(taskImage)
        .where(
          and(eq(taskImage.taskId, id), inArray(taskImage.imageId, imageIds)),
        ),
    )
    .exhaustive();

  return await reapUnreferencedImages(tx, imageIds);
};

/**
 * Of these images, delete the ones nothing points at any more — the shared tail
 * of every removal that drops an association.
 *
 * Call it AFTER the associations are gone (a still-live join row is still a
 * reference), on the same transaction, and drop the returned R2 keys only once
 * that transaction commits. Idempotent and safe on ids that are still
 * referenced: those are simply filtered out.
 *
 * Exported so `removeEntity`'s child cascade can share the reference rules
 * rather than restate them — {@link findReferencedImageIds} is the one place
 * "referenced" is defined, and a second definition is exactly how the detach and
 * delete paths drifted apart in the first place.
 */
export const reapUnreferencedImages = async (
  tx: DrizzleTransaction,
  imageIds: string[],
): Promise<DeletedImagesTx> => {
  if (imageIds.length === 0)
    return {
      deletedIds: [],
      deletedShortcodes: [],
      deletedKeys: [],
      affectedOwnerSearchRefs: [],
    };
  const referenced = await findReferencedImageIds(tx, imageIds);
  return await deleteImagesTx(
    tx,
    imageIds.filter((id) => !referenced.has(id)),
  );
};

/**
 * The `imageId` column, if this table is one of `image`'s join tables — i.e. an
 * edge {@link IMAGE_HARD_DELETE} disposes of by deleting the row rather than
 * nulling an FK. Read from `INCOMING_EDGES.image` rather than a hand-kept list,
 * so a new gallery entity is picked up here the moment it is declared there.
 *
 * Lets a caller that only knows it is cascading onto some table (`removeEntity`)
 * discover that the rows it is about to remove are image attachments, and read
 * the ids before they stop being findable.
 */
export const imageJoinColumnFor = (table: PgTable): PgColumn | undefined => {
  for (const operation of imageEdgeOperations) {
    if (operation.joinColumn?.table === table) return operation.joinColumn;
  }
  return undefined;
};

/**
 * Associate an image with a product.
 *
 * @param db Database client
 * @param productId Product ID to associate the image with
 * @param imageIds Public `IMG-` shortcodes to associate — what
 *   `importImageFromUrl` (image-storage.service.ts) hands back, e.g. from
 *   `importImageFromUPC`. Resolved to uuids here since `associatePendingImages`
 *   writes straight into `ProductImage.imageId`, an unbranded uuid FK.
 */
export const associateImagesWithProduct = async (
  db: Database,
  productId: ProductId,
  imageIds: string[],
): Promise<void> => {
  const resolvedImageIds = await resolveAllPresent(db, "image", imageIds);
  await associatePendingImages(
    getDb(db),
    imageJoinBindings.product,
    productId,
    resolvedImageIds,
  );
};

/**
 * Associate an image with a recipe. The recipe counterpart of
 * {@link associateImagesWithProduct} (server-side scrape import — see
 * `importRecipeImageFromUrl`). `imageIds` are public `IMG-` shortcodes,
 * resolved the same way.
 */
export const associateImagesWithRecipe = async (
  db: Database,
  recipeId: RecipeId,
  imageIds: string[],
): Promise<void> => {
  const resolvedImageIds = await resolveAllPresent(db, "image", imageIds);
  await associatePendingImages(
    getDb(db),
    imageJoinBindings.recipe,
    recipeId,
    resolvedImageIds,
  );
};

/**
 * Does this recipe already have a (non-deleted) image attached? Guards the
 * server-side import from re-fetching a hero photo into R2 on every re-import
 * (`Image` has no source-URL column to dedupe on).
 */
export const recipeHasImages = async (
  db: Database,
  recipeId: RecipeId,
): Promise<boolean> => {
  const rows = await getDb(db)
    .select({ id: recipeImage.id })
    .from(recipeImage)
    .innerJoin(
      image,
      and(
        eq(image.id, recipeImage.imageId),
        notDeleted(image),
        displayableImageWhere,
      ),
    )
    .where(and(eq(recipeImage.recipeId, recipeId), notDeleted(recipeImage)))
    .limit(1);
  return rows.length > 0;
};

/**
 * Assert an attach target exists (and isn't soft-deleted) before we upload +
 * associate, so a bad id fails cleanly instead of surfacing as a raw FK
 * violation after the object is already in R2.
 */
export const assertAttachableEntityExists = async (
  db: Database,
  entity: AttachableImageRef,
): Promise<void> => {
  // Count inside each arm so the table is a concrete type — a union of the four
  // (branded-id) tables collapses Drizzle's query inference to `never`.
  const count = await match(entity)
    .with({ entity: "product" }, ({ id }) =>
      countWhere(db, product, and(eq(product.id, id), notDeleted(product))),
    )
    .with({ entity: "recipe" }, ({ id }) =>
      countWhere(db, recipe, and(eq(recipe.id, id), notDeleted(recipe))),
    )
    .with({ entity: "location" }, ({ id }) =>
      countWhere(db, location, and(eq(location.id, id), notDeleted(location))),
    )
    .with({ entity: "project" }, ({ id }) =>
      countWhere(db, project, and(eq(project.id, id), notDeleted(project))),
    )
    .with({ entity: "purchase" }, ({ id }) =>
      countWhere(db, purchase, and(eq(purchase.id, id), notDeleted(purchase))),
    )
    .with({ entity: "gardenEntry" }, ({ id }) =>
      countWhere(
        db,
        gardenEntry,
        and(eq(gardenEntry.id, id), notDeleted(gardenEntry)),
      ),
    )
    .with({ entity: "meal" }, ({ id }) =>
      countWhere(db, meal, and(eq(meal.id, id), notDeleted(meal))),
    )
    .with({ entity: "task" }, ({ id }) =>
      countWhere(db, task, and(eq(task.id, id), notDeleted(task))),
    )
    .exhaustive();
  if (count === 0) {
    throw createAppError(
      "IMAGE_ATTACH_FAILED",
      `${entity.entity} ${entity.id} not found`,
    );
  }
};

const hasLiveAttachment = async (
  dbc: DrizzleClient | DrizzleTransaction,
  entity: AttachableImageRef,
  imageId: string,
): Promise<boolean> => {
  const rows = await match(entity)
    .with({ entity: "product" }, ({ id }) =>
      dbc
        .select({ id: productImage.id })
        .from(productImage)
        .where(
          and(
            eq(productImage.productId, id),
            eq(productImage.imageId, imageId),
            notDeleted(productImage),
          ),
        )
        .limit(1),
    )
    .with({ entity: "recipe" }, ({ id }) =>
      dbc
        .select({ id: recipeImage.id })
        .from(recipeImage)
        .where(
          and(
            eq(recipeImage.recipeId, id),
            eq(recipeImage.imageId, imageId),
            notDeleted(recipeImage),
          ),
        )
        .limit(1),
    )
    .with({ entity: "location" }, ({ id }) =>
      dbc
        .select({ id: locationImage.id })
        .from(locationImage)
        .where(
          and(
            eq(locationImage.locationId, id),
            eq(locationImage.imageId, imageId),
            notDeleted(locationImage),
          ),
        )
        .limit(1),
    )
    .with({ entity: "project" }, ({ id }) =>
      dbc
        .select({ id: projectImage.id })
        .from(projectImage)
        .where(
          and(
            eq(projectImage.projectId, id),
            eq(projectImage.imageId, imageId),
            notDeleted(projectImage),
          ),
        )
        .limit(1),
    )
    .with({ entity: "purchase" }, ({ id }) =>
      dbc
        .select({ id: purchaseImage.id })
        .from(purchaseImage)
        .where(
          and(
            eq(purchaseImage.purchaseId, id),
            eq(purchaseImage.imageId, imageId),
            notDeleted(purchaseImage),
          ),
        )
        .limit(1),
    )
    .with({ entity: "gardenEntry" }, ({ id }) =>
      dbc
        .select({ id: gardenEntryImage.id })
        .from(gardenEntryImage)
        .where(
          and(
            eq(gardenEntryImage.gardenEntryId, id),
            eq(gardenEntryImage.imageId, imageId),
            notDeleted(gardenEntryImage),
          ),
        )
        .limit(1),
    )
    .with({ entity: "meal" }, ({ id }) =>
      dbc
        .select({ id: mealImage.id })
        .from(mealImage)
        .where(
          and(
            eq(mealImage.mealId, id),
            eq(mealImage.imageId, imageId),
            notDeleted(mealImage),
          ),
        )
        .limit(1),
    )
    .with({ entity: "task" }, ({ id }) =>
      dbc
        .select({ id: taskImage.id })
        .from(taskImage)
        .where(
          and(
            eq(taskImage.taskId, id),
            eq(taskImage.imageId, imageId),
            notDeleted(taskImage),
          ),
        )
        .limit(1),
    )
    .exhaustive();
  return rows.length > 0;
};

/**
 * Locate a previous MCP attachment retry without treating arbitrary Image rows
 * as idempotency winners.
 *
 * `targetType`/`targetId` are PROVENANCE, not a reference — detaching the image
 * leaves them intact, and so does an entity delete (which soft-deletes the join
 * row) and the `Cookbook.coverImageId` set-null path. Matching on them alone
 * made a retry of a detached file report success: no upload, no join row,
 * `imageCount` unchanged, and a response indistinguishable from a real attach.
 * So the keyed lookup only names a candidate; the attachment still has to exist.
 *
 * Defense in depth now that {@link detachImagesFromEntity} deletes the row it
 * detaches, and still load-bearing for the paths that leave a
 * targeted-but-unattached image behind.
 */
export const findAttachmentByIdempotencyKey = async (
  db: Database | DrizzleTransaction,
  entity: AttachableImageRef,
  idempotencyKey: string,
): Promise<typeof image.$inferSelect | null> => {
  const dbc = "query" in db ? db : getDb(db);
  const candidate = await dbc.query.image.findFirst({
    where: and(
      eq(image.targetType, entity.entity),
      eq(image.targetId, entity.id),
      eq(image.idempotencyKey, idempotencyKey),
      notDeleted(image),
    ),
  });
  if (!candidate) return null;
  return (await hasLiveAttachment(dbc, entity, candidate.id))
    ? candidate
    : null;
};

export const getImagesAttachedToEntity = async (
  db: Database,
  entity: AttachableImageRef,
): Promise<Array<typeof image.$inferSelect>> => {
  const dbc = getDb(db);
  return await match(entity)
    .with({ entity: "product" }, ({ id }) =>
      dbc
        .select({ image })
        .from(productImage)
        .innerJoin(image, eq(productImage.imageId, image.id))
        .where(
          and(
            eq(productImage.productId, id),
            notDeleted(productImage),
            notDeleted(image),
          ),
        )
        .then((rows) => rows.map((row) => row.image)),
    )
    .with({ entity: "recipe" }, ({ id }) =>
      dbc
        .select({ image })
        .from(recipeImage)
        .innerJoin(image, eq(recipeImage.imageId, image.id))
        .where(
          and(
            eq(recipeImage.recipeId, id),
            notDeleted(recipeImage),
            notDeleted(image),
          ),
        )
        .then((rows) => rows.map((row) => row.image)),
    )
    .with({ entity: "location" }, ({ id }) =>
      dbc
        .select({ image })
        .from(locationImage)
        .innerJoin(image, eq(locationImage.imageId, image.id))
        .where(
          and(
            eq(locationImage.locationId, id),
            notDeleted(locationImage),
            notDeleted(image),
          ),
        )
        .then((rows) => rows.map((row) => row.image)),
    )
    .with({ entity: "project" }, ({ id }) =>
      dbc
        .select({ image })
        .from(projectImage)
        .innerJoin(image, eq(projectImage.imageId, image.id))
        .where(
          and(
            eq(projectImage.projectId, id),
            notDeleted(projectImage),
            notDeleted(image),
          ),
        )
        .then((rows) => rows.map((row) => row.image)),
    )
    .with({ entity: "purchase" }, ({ id }) =>
      dbc
        .select({ image })
        .from(purchaseImage)
        .innerJoin(image, eq(purchaseImage.imageId, image.id))
        .where(
          and(
            eq(purchaseImage.purchaseId, id),
            notDeleted(purchaseImage),
            notDeleted(image),
          ),
        )
        .then((rows) => rows.map((row) => row.image)),
    )
    .with({ entity: "gardenEntry" }, ({ id }) =>
      dbc
        .select({ image })
        .from(gardenEntryImage)
        .innerJoin(image, eq(gardenEntryImage.imageId, image.id))
        .where(
          and(
            eq(gardenEntryImage.gardenEntryId, id),
            notDeleted(gardenEntryImage),
            notDeleted(image),
          ),
        )
        .then((rows) => rows.map((row) => row.image)),
    )
    .with({ entity: "meal" }, ({ id }) =>
      dbc
        .select({ image })
        .from(mealImage)
        .innerJoin(image, eq(mealImage.imageId, image.id))
        .where(
          and(
            eq(mealImage.mealId, id),
            notDeleted(mealImage),
            notDeleted(image),
          ),
        )
        .then((rows) => rows.map((row) => row.image)),
    )
    .with({ entity: "task" }, ({ id }) =>
      dbc
        .select({ image })
        .from(taskImage)
        .innerJoin(image, eq(taskImage.imageId, image.id))
        .where(
          and(
            eq(taskImage.taskId, id),
            notDeleted(taskImage),
            notDeleted(image),
          ),
        )
        .then((rows) => rows.map((row) => row.image)),
    )
    .exhaustive();
};

export const updateImageIntegrity = async (
  db: Database,
  imageId: string,
  values: Pick<
    typeof image.$inferInsert,
    | "width"
    | "height"
    | "detectedContentType"
    | "sha256"
    | "renderStatus"
    | "storageStatus"
    | "verifiedAt"
  >,
): Promise<void> => {
  await getDb(db)
    .update(image)
    .set(values)
    .where(and(eq(image.id, imageId), notDeleted(image)));
};

export const selectImagesMissingDimensions = async (
  db: Database,
  limit: number,
) =>
  getDb(db)
    .select({
      id: image.id,
      key: image.key,
      contentType: image.contentType,
      size: image.size,
      width: image.width,
      height: image.height,
      detectedContentType: image.detectedContentType,
      sha256: image.sha256,
    })
    .from(image)
    .where(
      and(
        eq(image.status, "UPLOADED"),
        notDeleted(image),
        displayableImageWhere,
        or(isNull(image.width), isNull(image.height)),
      ),
    )
    .orderBy(asc(image.createdAt), asc(image.id))
    .limit(limit);

export const countImagesMissingDimensions = async (
  db: Database,
): Promise<number> => {
  const [row] = await getDb(db)
    .select({ count: count() })
    .from(image)
    .where(
      and(
        eq(image.status, "UPLOADED"),
        notDeleted(image),
        displayableImageWhere,
        or(isNull(image.width), isNull(image.height)),
      ),
    );
  return row?.count ?? 0;
};

const lockAttachableEntity = async (
  tx: DrizzleTransaction,
  entity: AttachableImageRef,
): Promise<void> => {
  const rows = await match(entity)
    .with({ entity: "product" }, ({ id }) =>
      tx
        .select({ id: product.id })
        .from(product)
        .where(and(eq(product.id, id), notDeleted(product)))
        .for("update"),
    )
    .with({ entity: "recipe" }, ({ id }) =>
      tx
        .select({ id: recipe.id })
        .from(recipe)
        .where(and(eq(recipe.id, id), notDeleted(recipe)))
        .for("update"),
    )
    .with({ entity: "location" }, ({ id }) =>
      tx
        .select({ id: location.id })
        .from(location)
        .where(and(eq(location.id, id), notDeleted(location)))
        .for("update"),
    )
    .with({ entity: "project" }, ({ id }) =>
      tx
        .select({ id: project.id })
        .from(project)
        .where(and(eq(project.id, id), notDeleted(project)))
        .for("update"),
    )
    .with({ entity: "purchase" }, ({ id }) =>
      tx
        .select({ id: purchase.id })
        .from(purchase)
        .where(and(eq(purchase.id, id), notDeleted(purchase)))
        .for("update"),
    )
    .with({ entity: "gardenEntry" }, ({ id }) =>
      tx
        .select({ id: gardenEntry.id })
        .from(gardenEntry)
        .where(and(eq(gardenEntry.id, id), notDeleted(gardenEntry)))
        .for("update"),
    )
    .with({ entity: "meal" }, ({ id }) =>
      tx
        .select({ id: meal.id })
        .from(meal)
        .where(and(eq(meal.id, id), notDeleted(meal)))
        .for("update"),
    )
    .with({ entity: "task" }, ({ id }) =>
      tx
        .select({ id: task.id })
        .from(task)
        .where(and(eq(task.id, id), notDeleted(task)))
        .for("update"),
    )
    .exhaustive();
  if (rows.length === 0) {
    throw createAppError(
      "IMAGE_ATTACH_FAILED",
      `${entity.entity} ${entity.id} not found`,
    );
  }
};

const touchAttachableEntity = async (
  tx: DrizzleTransaction,
  entity: AttachableImageRef,
  updatedAt: Date,
): Promise<void> => {
  await match(entity)
    .with({ entity: "product" }, ({ id }) =>
      tx.update(product).set({ updatedAt }).where(eq(product.id, id)),
    )
    .with({ entity: "recipe" }, ({ id }) =>
      tx.update(recipe).set({ updatedAt }).where(eq(recipe.id, id)),
    )
    .with({ entity: "location" }, ({ id }) =>
      tx.update(location).set({ updatedAt }).where(eq(location.id, id)),
    )
    .with({ entity: "project" }, ({ id }) =>
      tx.update(project).set({ updatedAt }).where(eq(project.id, id)),
    )
    .with({ entity: "purchase" }, ({ id }) =>
      tx.update(purchase).set({ updatedAt }).where(eq(purchase.id, id)),
    )
    .with({ entity: "gardenEntry" }, ({ id }) =>
      tx.update(gardenEntry).set({ updatedAt }).where(eq(gardenEntry.id, id)),
    )
    .with({ entity: "meal" }, ({ id }) =>
      tx.update(meal).set({ updatedAt }).where(eq(meal.id, id)),
    )
    .with({ entity: "task" }, ({ id }) =>
      tx.update(task).set({ updatedAt }).where(eq(task.id, id)),
    )
    .exhaustive();
};

const countAttachmentPreconditionImages = async (
  tx: DrizzleTransaction,
  entity: AttachableImageRef,
): Promise<number> => {
  const whereImage = and(notDeleted(image), displayableImageWhere);
  const totals = await match(entity)
    .with({ entity: "product" }, ({ id }) =>
      tx
        .select({ total: count() })
        .from(productImage)
        .innerJoin(image, eq(productImage.imageId, image.id))
        .where(
          and(
            eq(productImage.productId, id),
            notDeleted(productImage),
            notDeleted(image),
          ),
        ),
    )
    .with({ entity: "recipe" }, ({ id }) =>
      tx
        .select({ total: count() })
        .from(recipeImage)
        .innerJoin(image, eq(recipeImage.imageId, image.id))
        .where(
          and(
            eq(recipeImage.recipeId, id),
            notDeleted(recipeImage),
            whereImage,
          ),
        ),
    )
    .with({ entity: "location" }, ({ id }) =>
      tx
        .select({ total: count() })
        .from(locationImage)
        .innerJoin(image, eq(locationImage.imageId, image.id))
        .where(
          and(
            eq(locationImage.locationId, id),
            notDeleted(locationImage),
            whereImage,
          ),
        ),
    )
    .with({ entity: "project" }, ({ id }) =>
      tx
        .select({ total: count() })
        .from(projectImage)
        .innerJoin(image, eq(projectImage.imageId, image.id))
        .where(
          and(
            eq(projectImage.projectId, id),
            notDeleted(projectImage),
            whereImage,
          ),
        ),
    )
    .with({ entity: "purchase" }, ({ id }) =>
      tx
        .select({ total: count() })
        .from(purchaseImage)
        .innerJoin(image, eq(purchaseImage.imageId, image.id))
        .where(
          and(
            eq(purchaseImage.purchaseId, id),
            notDeleted(purchaseImage),
            whereImage,
          ),
        ),
    )
    .with({ entity: "gardenEntry" }, ({ id }) =>
      tx
        .select({ total: count() })
        .from(gardenEntryImage)
        .innerJoin(image, eq(gardenEntryImage.imageId, image.id))
        .where(
          and(
            eq(gardenEntryImage.gardenEntryId, id),
            notDeleted(gardenEntryImage),
            whereImage,
          ),
        ),
    )
    .with({ entity: "meal" }, ({ id }) =>
      tx
        .select({ total: count() })
        .from(mealImage)
        .innerJoin(image, eq(mealImage.imageId, image.id))
        .where(
          and(eq(mealImage.mealId, id), notDeleted(mealImage), whereImage),
        ),
    )
    .with({ entity: "task" }, ({ id }) =>
      tx
        .select({ total: count() })
        .from(taskImage)
        .innerJoin(image, eq(taskImage.imageId, image.id))
        .where(
          and(eq(taskImage.taskId, id), notDeleted(taskImage), whereImage),
        ),
    )
    .exhaustive();
  return Number(totals[0]?.total ?? 0);
};

/**
 * Attach an already-UPLOADED image to one of the gallery entities by
 * dispatching to its join table. Mirrors {@link associateImagesWithProduct} for
 * the others; `.exhaustive()` forces this to grow if `attachableImageEntity`
 * does. Takes a client-or-tx so it can run inside the insert transaction (see
 * {@link createAndAssociateUploadedImage}).
 */
const associateImageWithEntity = async (
  dbc: DrizzleClient | DrizzleTransaction,
  entity: AttachableImageRef,
  imageId: ImageId,
  documentKind?: PurchaseDocumentKind,
  purpose?: ProductImagePurpose,
): Promise<void> => {
  await match(entity)
    .with({ entity: "product" }, async ({ id }) => {
      const sortOrder = await nextImageSortOrder(
        dbc,
        imageJoinBindings.product,
        id,
      );
      await dbc.insert(productImage).values({
        productId: id,
        imageId,
        sortOrder,
        purpose: purpose ?? null,
      });
    })
    .with({ entity: "recipe" }, ({ id }) =>
      associatePendingImages(dbc, imageJoinBindings.recipe, id, [imageId]),
    )
    .with({ entity: "location" }, ({ id }) =>
      associatePendingImages(dbc, imageJoinBindings.location, id, [imageId]),
    )
    .with({ entity: "project" }, ({ id }) =>
      associatePendingImages(dbc, imageJoinBindings.project, id, [imageId]),
    )
    .with({ entity: "purchase" }, async ({ id }) => {
      const sortOrder = await nextImageSortOrder(
        dbc,
        imageJoinBindings.purchase,
        id,
      );
      await dbc.insert(purchaseImage).values({
        purchaseId: id,
        imageId,
        sortOrder,
        documentKind: documentKind ?? "other",
      });
      await dbc
        .update(purchase)
        .set({ updatedAt: new Date() })
        .where(and(eq(purchase.id, id), notDeleted(purchase)));
    })
    .with({ entity: "gardenEntry" }, ({ id }) =>
      associatePendingImages(dbc, imageJoinBindings.gardenEntry, id, [imageId]),
    )
    .with({ entity: "meal" }, ({ id }) =>
      associatePendingImages(dbc, imageJoinBindings.meal, id, [imageId]),
    )
    .with({ entity: "task" }, ({ id }) =>
      associatePendingImages(dbc, imageJoinBindings.task, id, [imageId]),
    )
    .exhaustive();
};

/**
 * Insert an UPLOADED image row and associate it with its target entity in a
 * single transaction, so a failure in either step rolls back the DB write. The
 * caller owns removing the R2 object on failure (see attachFileToEntity) — a
 * stranded UPLOADED row would otherwise never be reaped (cull only touches
 * PENDING rows).
 */
export const createAndAssociateUploadedImage = async (
  db: Database,
  params: {
    key: string;
    filename: string;
    contentType: string;
    size: number;
    width?: number | null;
    height?: number | null;
    detectedContentType?: string | null;
    sha256?: string | null;
    renderStatus?: "unverified" | "verified" | "failed" | null;
    storageStatus?:
      | "unverified"
      | "available"
      | "missing"
      | "metadata_mismatch"
      | null;
    verifiedAt?: Date | null;
    targetType?: string | null;
    targetId?: string | null;
    idempotencyKey?: string | null;
    source?: "own" | "catalog" | "unknown";
    sourcePageUrl?: string | null;
    sourceAssetUrl?: string | null;
    sourceName?: string | null;
  },
  entity: AttachableImageRef,
  documentKind?: PurchaseDocumentKind,
): Promise<typeof image.$inferSelect> => {
  return (await createOrReuseAttachedImage(db, params, entity, documentKind))
    .row;
};

/**
 * Transactional half of MCP attachment. The target row lock makes the gallery
 * count precondition meaningful, while the partial unique index elects one
 * winner if two requests with the same idempotency key race after uploading.
 */
export const createOrReuseAttachedImage = async (
  db: Database,
  params: Parameters<typeof createUploadedImageRecord>[1] & {
    expectedImageCount?: number;
    pendingImageId?: ImageId;
    purpose?: ProductImagePurpose;
  },
  entity: AttachableImageRef,
  documentKind?: PurchaseDocumentKind,
): Promise<{ row: typeof image.$inferSelect; reused: boolean }> =>
  await withTransaction(db, async (tx) => {
    await lockAttachableEntity(tx, entity);
    if (params.idempotencyKey) {
      const winner = await findAttachmentByIdempotencyKey(
        tx,
        entity,
        params.idempotencyKey,
      );
      if (winner) return { row: winner, reused: true };
    }
    if (params.expectedImageCount !== undefined) {
      const actual = await countAttachmentPreconditionImages(tx, entity);
      if (actual !== params.expectedImageCount) {
        throw createAppError(
          "IMAGE_PRECONDITION_FAILED",
          `Expected ${params.expectedImageCount} attached images, found ${actual}`,
        );
      }
    }

    const {
      expectedImageCount: _expectedImageCount,
      pendingImageId,
      purpose,
      ...record
    } = params;
    if (pendingImageId) {
      const promoted = await updateAndReturn(
        tx,
        image,
        {
          ...record,
          status: "UPLOADED",
          targetType: entity.entity,
          targetId: entity.id,
        },
        and(
          eq(image.id, pendingImageId),
          eq(image.status, "PENDING"),
          notDeleted(image),
        ),
      );
      await associateImageWithEntity(
        tx,
        entity,
        parseEntityId("image", promoted.id),
        documentKind,
        purpose,
      );
      return { row: promoted, reused: false };
    }

    // Minted inline rather than via `insertWithShortcode`: this insert needs
    // `onConflictDoNothing` on the idempotency key, and the helper's own
    // collision retry would fight that. A code burned by a no-op conflict is
    // fine — shortcodes are never reused, so an unused one is simply retired.
    const shortcode = await generateUniqueShortcode(tx, "image");
    const [inserted] = await tx
      .insert(image)
      .values({
        ...record,
        shortcode,
        status: "UPLOADED",
        targetType: entity.entity,
        targetId: entity.id,
      })
      .onConflictDoNothing({
        target: [image.targetType, image.targetId, image.idempotencyKey],
        where: sql`${image.idempotencyKey} IS NOT NULL AND ${image.deletedAt} IS NULL`,
      })
      .returning();
    if (!inserted) {
      // Only possible for an idempotency race; the target lock serializes the
      // normal expected-count path. Re-read so the loser can return the winner.
      if (params.idempotencyKey) {
        const winner = await findAttachmentByIdempotencyKey(
          tx,
          entity,
          params.idempotencyKey,
        );
        if (winner) return { row: winner, reused: true };
        // Conflicted with a row the liveness check then rejected: the partial
        // unique index spans unattached rows, so a stale one still owns this
        // key. Both `detachImagesFromEntity` and `removeEntity` reap an
        // unreferenced image transactionally, so a row here means some
        // removal path left one behind.
        throw createAppError(
          "IMAGE_ATTACH_FAILED",
          `A detached file still holds idempotencyKey "${params.idempotencyKey}" for this ${entity.entity}. ` +
            "Retry with a different key.",
        );
      }
      throw new Error("Image attachment insert unexpectedly returned no row");
    }
    await associateImageWithEntity(
      tx,
      entity,
      parseEntityId("image", inserted.id),
      documentKind,
      purpose,
    );
    return { row: inserted, reused: false };
  });

export const getImagesByProjectIds = async (
  db: Database,
  projectIds: ProjectId[],
): Promise<
  Record<string, Array<{ id: ImageShortcode; url: string; filename: string }>>
> => {
  if (projectIds.length === 0) return {};

  const rows = await getDb(db)
    .select({
      projectId: projectImage.projectId,
      shortcode: image.shortcode,
      key: image.key,
      filename: image.filename,
    })
    .from(projectImage)
    .innerJoin(image, eq(projectImage.imageId, image.id))
    .where(
      and(
        inArray(projectImage.projectId, projectIds),
        notDeleted(projectImage),
        notDeleted(image),
        displayableImageWhere,
      ),
    )
    .orderBy(asc(projectImage.sortOrder), asc(projectImage.createdAt));

  const result: Record<
    string,
    Array<{ id: ImageShortcode; url: string; filename: string }>
  > = {};
  for (const row of rows) {
    const list = result[row.projectId] ?? [];
    list.push({
      id: parseShortcodeFor("image", row.shortcode),
      url: getR2PublicUrl(row.key),
      filename: row.filename,
    });
    result[row.projectId] = list;
  }
  return result;
};
