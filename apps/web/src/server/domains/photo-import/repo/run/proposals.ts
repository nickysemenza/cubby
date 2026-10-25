import type { ActorContext } from "@cubby/schemas/context";
import {
  parseShortcodeFor,
  type ImageId,
  type ImageShortcode,
  type RunId,
  type LedgerPartyId,
  type LocationId,
  type ProductCategoryId,
  type ProductId,
} from "@cubby/schemas/identifiers";
import {
  imageId,
  runEntityId,
  runShortcode as runShortcodeSchema,
  inventoryShortcode,
} from "@cubby/schemas/identifiers";
import { selectImageDescriptionEvidence } from "@cubby/schemas/image-processing";
import { inventoryOwnershipMode } from "@cubby/schemas/inventory-ownership";
import {
  storedPhotoRunInput,
  type PhotoRunDefaults,
  photoRunImageState,
  photoGroupReview,
  photoRunImageCommitReceipt,
  commitPhotoGroupProduct,
  photoGroupProposalList,
  proposePhotoGroupsInput,
  type CommitPhotoGroupInput,
  type PhotoGroupApprovalResult,
  type PhotoGroupReview,
  type PhotoGroupProposal,
  type PhotoGroupProposalGroup,
  type PhotoGroupProposalList,
  type PhotoGroupProposalProductSummary,
  type PhotoRunImage,
  type PhotoGroupProposalOrigin,
  type ProposePhotoGroupsOutput,
} from "@cubby/schemas/photo-import-run";
import { runPurpose, runStatus } from "@cubby/schemas/purchase-import";
import { getErrorMessage } from "@cubby/shared";
import { PHOTO_RUN_IMAGE_LIMIT } from "@cubby/shared/client-constants";
/**
 * Review queue in front of the photo-inventory writer: an agent proposes item
 * groups for a run, a household member edits and approves them on the run
 * page, and approval commits each group through `commitPhotoGroup` with the
 * stored payload. See `packages/schemas/src/photo-import-run.ts` for the wire
 * contract.
 *
 * Invariants:
 *  - every image a `proposed` row mentions is a reviewable target of its run
 *    when saved (`pending`, or `unresolved` after a stopped photo run), and
 *    appears in exactly one `proposed` row (attached or
 *    skipped); deleting an image later hard-deletes its target but leaves its
 *    id in the row's JSON, so every reader drops ids with no run target
 *    (`liveRoster`) instead of failing;
 *  - `committed` and `discarded` rows are frozen: a save naming their
 *    groupKey leaves them untouched and reports it as frozen;
 *  - a discard commits the group's images as `skip` so the run can complete.
 */
import { countLabel } from "@cubby/shared/pluralize";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import {
  productBrandNameSql,
  productBrandCodeSql,
} from "~/server/db/computed/product-brand-sql";
import {
  getDb,
  notDeleted,
  withTransactionDatabase,
} from "~/server/db/helpers";
import {
  vendor,
  aiAnalysis,
  image,
  imageProcessingJob,
  imageProcessingAttempt,
  run as runTable,
  photoRunImage,
  ledgerParty,
  location,
  photoGroupProposal,
  photoGroupSourceEvidence,
  product,
  productCategory,
  entityExternalId,
} from "~/server/db/schema";
import { imageJobDisplayStateSql } from "~/server/domains/image-processing/repo/image-job-state";
import {
  IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION,
  IMAGE_DESCRIPTION_PROCESSOR_REVISION,
  loadImageRepresentations,
} from "~/server/domains/image-processing/repo/image-processing";
import { loadImageAnalysisEvidence } from "~/server/domains/image/repo/image-analysis-summary";
import { loadLocationAncestors } from "~/server/domains/location/repo/tree";
import { photoFieldCrossCheck } from "~/server/domains/photo-import/repo/photo-correctness";
import { photoRunImageOrder } from "~/server/domains/photo-import/repo/photo-import";
import {
  effectivePhotoGroupConcern,
  photoGroupSteps,
} from "~/server/domains/photo-import/repo/run/photo-group-steps";
import { getProductCoverImageUrlsByProductIds } from "~/server/domains/product/repo/crud";
import { assertRunCapability } from "~/server/domains/purchase-import/repo/capabilities";
import { recordChange } from "~/server/generic/changes/repo/change";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { currentMemberLedgerParty } from "~/server/http/member-login";

import { assertPhotoGroupReviewIntent, commitPhotoGroup } from "./writer";

function normalizeReview(review: PhotoGroupReview | null | undefined) {
  if (!review) return undefined;
  return {
    ...review,
    unresolvedReason: effectivePhotoGroupConcern(review.unresolvedReason),
    productChanges:
      review.productChanges && Object.keys(review.productChanges).length
        ? review.productChanges
        : undefined,
  };
}

const DISCARD_REASON = "Discarded in review";

type ProposalRow = typeof photoGroupProposal.$inferSelect;
type RunImage = {
  imageId: ImageId;
  shortcode: string;
  state: string;
  diff: typeof photoRunImage.$inferSelect.commitReceipt;
};

const storedCreate = commitPhotoGroupProduct.options[1].shape.create;
const storedInventory = z.object({
  ownershipMode: inventoryOwnershipMode.optional(),
  quantity: z.number().int().positive(),
  mode: z.enum(["create", "add"]).optional(),
  existingEntryId: inventoryShortcode.optional(),
  /** An explicit `ownerPartyId: null`: household stock, not a missing owner. */
  household: z.literal(true).optional(),
});

/** A run that does not exist, or that this actor may not review; routes map it to 404. */
class PhotoRunNotFoundError extends Error {
  constructor(runShortcode: string) {
    super(`Import run ${runShortcode} was not found`);
    this.name = "PhotoRunNotFoundError";
  }
}

/**
 * The browser surface's household-member gate, matching
 * the run operations: the actor must have a live `member` LedgerParty.
 */
export async function assertPhotoRunReviewer(
  db: Database,
  actor: ActorContext,
  runShortcode: string,
): Promise<void> {
  const member = await currentMemberLedgerParty(db, actor);
  if (!member) throw new PhotoRunNotFoundError(runShortcode);
  await loadRun(db, runShortcode);
}

async function loadRun(db: Database, runShortcode: string) {
  const [row] = await getDb(db)
    .select({
      id: runTable.id,
      shortcode: runTable.shortcode,
      purpose: runTable.purpose,
      status: runTable.status,
      input: runTable.input,
    })
    .from(runTable)
    .where(eq(runTable.shortcode, runShortcodeSchema.parse(runShortcode)))
    .limit(1);
  if (!row) throw new PhotoRunNotFoundError(runShortcode);
  assertRunCapability(runPurpose.parse(row.purpose), "photo_commit");
  return {
    id: runEntityId.parse(row.id),
    shortcode: runShortcodeSchema.parse(row.shortcode),
    status: runStatus.parse(row.status),
    input: storedPhotoRunInput.parse(row.input ?? null),
  };
}
type LoadedRun = Awaited<ReturnType<typeof loadRun>>;

async function loadRunImages(db: Database, runId: RunId) {
  const rows = await getDb(db)
    .select({
      imageId: image.id,
      shortcode: image.shortcode,
      state: photoRunImage.state,
      diff: photoRunImage.commitReceipt,
    })
    .from(photoRunImage)
    .innerJoin(image, eq(image.id, photoRunImage.imageId))
    .where(eq(photoRunImage.runId, runId))
    .orderBy(...photoRunImageOrder())
    .limit(PHOTO_RUN_IMAGE_LIMIT);
  const ordered: RunImage[] = rows.map((row) => ({
    ...row,
    imageId: imageId.parse(row.imageId),
  }));
  const byCode = new Map(ordered.map((entry) => [entry.shortcode, entry]));
  const byId = new Map(ordered.map((entry) => [entry.imageId, entry]));
  return { byCode, byId, ordered };
}

const loadProposalRows = (db: Database, runId: RunId) =>
  getDb(db)
    .select()
    .from(photoGroupProposal)
    .where(eq(photoGroupProposal.runId, runId))
    .orderBy(photoGroupProposal.createdAt, photoGroupProposal.groupKey);

type LiveRoster = {
  /** Stored entries whose image is still a target of the run. */
  images: ProposalRow["images"];
  skip: ProposalRow["skip"];
  /** Shortcodes, parallel to `images` / `skip`. */
  imageCodes: ImageShortcode[];
  skipCodes: ImageShortcode[];
  missing: number;
};

/**
 * A row's roster minus images that left the run: deleting an image
 * hard-deletes its `PhotoRunImage` but not the id stored in this row's
 * JSON, and a missing id must not break listing, approval, or discard.
 */
function liveRoster(
  row: ProposalRow,
  imagesById: Map<ImageId, RunImage>,
): LiveRoster {
  const live = <T extends { imageId: ImageId }>(entries: T[]) =>
    entries.flatMap((entry) => {
      const image = imagesById.get(entry.imageId);
      return image
        ? [{ entry, code: parseShortcodeFor("image", image.shortcode) }]
        : [];
    });
  const images = live(row.images);
  const skip = live(row.skip);
  return {
    images: images.map((item) => item.entry),
    skip: skip.map((item) => item.entry),
    imageCodes: images.map((item) => item.code),
    skipCodes: skip.map((item) => item.code),
    missing: row.images.length + row.skip.length - images.length - skip.length,
  };
}

async function productSummaries(
  db: Database,
  where: { ids?: ProductId[]; shortcodes?: string[] },
): Promise<
  (PhotoGroupProposalProductSummary & {
    uuid: ProductId;
    brandName: string | null;
    model: string | null;
  })[]
> {
  const ids = where.ids ?? [];
  const codes = where.shortcodes ?? [];
  if (!ids.length && !codes.length) return [];
  const rows = await getDb(db)
    .select({
      id: product.id,
      shortcode: product.shortcode,
      name: product.name,
      brandCode: productBrandCodeSql(product.brandId),
      brandName: productBrandNameSql(product.brandId),
      model: product.model,
    })
    .from(product)
    .where(
      and(
        notDeleted(product),
        ids.length
          ? inArray(product.id, ids)
          : inArray(product.shortcode, codes),
      ),
    );
  const covers = await getProductCoverImageUrlsByProductIds(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => ({
    id: parseShortcodeFor("product", row.shortcode),
    name: row.name,
    coverUrl: covers.get(row.id) ?? null,
    uuid: row.id,
    brandId: row.brandCode,
    brandName: row.brandName,
    model: row.model,
  }));
}

/** Live codes for the category and owner FK columns of these rows. */
async function linkedCodes(db: Database, rows: readonly ProposalRow[]) {
  const categoryIds = [
    ...new Set(rows.flatMap((row) => row.productCreateCategoryId ?? [])),
  ];
  const ownerIds = [
    ...new Set(rows.flatMap((row) => row.inventoryOwnerPartyId ?? [])),
  ];
  const brandIds = [
    ...new Set(rows.flatMap((row) => row.productCreateBrandId ?? [])),
  ];
  const brands = brandIds.length
    ? await getDb(db)
        .select({ id: vendor.id, shortcode: vendor.shortcode })
        .from(vendor)
        .where(and(inArray(vendor.id, brandIds), notDeleted(vendor)))
    : [];
  const brandById = new Map(
    brands.map((row) => [row.id, parseShortcodeFor("vendor", row.shortcode)]),
  );
  const brandCodeOf = (row: ProposalRow) => {
    if (!row.productCreateBrandId) return null;
    const code = brandById.get(row.productCreateBrandId);
    if (!code)
      throw new Error(
        `Photo proposal ${row.groupKey} refers to a Brand that is no longer available.`,
      );
    return code;
  };
  const [categories, owners] = await Promise.all([
    categoryIds.length
      ? getDb(db)
          .select({
            id: productCategory.id,
            shortcode: productCategory.shortcode,
          })
          .from(productCategory)
          .where(
            and(
              inArray(productCategory.id, categoryIds),
              notDeleted(productCategory),
            ),
          )
      : Promise.resolve([]),
    ownerIds.length
      ? getDb(db)
          .select({ id: ledgerParty.id, shortcode: ledgerParty.shortcode })
          .from(ledgerParty)
          .where(
            and(inArray(ledgerParty.id, ownerIds), notDeleted(ledgerParty)),
          )
      : Promise.resolve([]),
  ]);
  const categoryById = new Map(
    categories.map((row) => [
      row.id,
      parseShortcodeFor("productCategory", row.shortcode),
    ]),
  );
  const ownerById = new Map(
    owners.map((row) => [
      row.id,
      parseShortcodeFor("ledgerParty", row.shortcode),
    ]),
  );
  return {
    createBrandId: brandCodeOf,
    create: (row: ProposalRow) => ({
      brandId: brandCodeOf(row),
      ...storedCreate.omit({ brandId: true }).parse(row.productCreate),
      categoryId: row.productCreateCategoryId
        ? (categoryById.get(row.productCreateCategoryId) ?? null)
        : null,
    }),
    createCategoryId: (row: ProposalRow) =>
      row.productCreateCategoryId
        ? (categoryById.get(row.productCreateCategoryId) ?? null)
        : null,
    ownerPartyId: (row: ProposalRow) =>
      row.inventoryOwnerPartyId
        ? ownerById.get(row.inventoryOwnerPartyId)
        : storedInventory.safeParse(row.inventory).data?.household
          ? null
          : undefined,
  };
}

function comparisonIdentityFields(
  row: ProposalRow,
  selected:
    | Pick<
        Awaited<ReturnType<typeof productSummaries>>[number],
        "name" | "brandName" | "model"
      >
    | undefined,
  identifiers: string[],
) {
  const draft = row.productKind === "create" ? row.productCreate : null;
  return {
    name: draft?.name ?? selected?.name ?? "",
    brandName: draft ? null : selected?.brandName,
    model: draft ? draft.model : selected?.model,
    identifiers,
  };
}

async function toViews(
  db: Database,
  rows: ProposalRow[],
  imagesById: Map<ImageId, RunImage>,
  runStatus: string,
  processing: readonly PhotoRunImage[],
): Promise<PhotoGroupProposal[]> {
  const productIds = [
    ...new Set(rows.flatMap((row) => (row.productId ? [row.productId] : []))),
  ];
  const conflictCodes = [
    ...new Set(rows.flatMap((row) => row.conflictProductIds ?? [])),
  ];
  const locationIds = [
    ...new Set(
      rows.flatMap((row) =>
        row.inventoryLocationId ? [row.inventoryLocationId] : [],
      ),
    ),
  ];
  const [chosen, conflicts, locations, linked, identifiers] = await Promise.all(
    [
      productSummaries(db, { ids: productIds }),
      productSummaries(db, { shortcodes: conflictCodes }),
      locationIds.length
        ? getDb(db)
            .select({
              id: location.id,
              shortcode: location.shortcode,
              name: location.name,
            })
            .from(location)
            .where(and(inArray(location.id, locationIds), notDeleted(location)))
        : Promise.resolve([]),
      linkedCodes(db, rows),
      productIds.length
        ? getDb(db)
            .select({
              id: entityExternalId.entityId,
              value: entityExternalId.externalId,
            })
            .from(entityExternalId)
            .where(
              and(
                eq(entityExternalId.entityKind, "product"),
                inArray(entityExternalId.entityId, productIds),
                notDeleted(entityExternalId),
              ),
            )
        : Promise.resolve([]),
    ],
  );
  const summaryById = new Map(chosen.map((entry) => [entry.uuid, entry]));
  const summaryByCode = new Map(conflicts.map((entry) => [entry.id, entry]));
  const ancestorsById = await loadLocationAncestors(
    db,
    locations.map((entry) => entry.id),
  );
  // A leaf name alone ("Closet") is ambiguous between rooms; the reviewer
  // sees the same breadcrumb the Location picker lists.
  const locationById = new Map(
    locations.map((entry) => [
      entry.id,
      {
        ...entry,
        name: [
          ...(ancestorsById.get(entry.id) ?? []).map((rung) => rung.name),
          entry.name,
        ].join(" › "),
      },
    ]),
  );
  const strip = (
    entry: (typeof chosen)[number] | undefined,
  ): PhotoGroupProposalProductSummary | null =>
    entry ? { id: entry.id, name: entry.name, coverUrl: entry.coverUrl } : null;
  return rows.map((storedRow) => {
    const row = {
      ...storedRow,
      review:
        normalizeReview(
          storedRow.review ? photoGroupReview.parse(storedRow.review) : null,
        ) ?? null,
    };
    const roster = liveRoster(row, imagesById);
    const productSummary = row.productId
      ? strip(summaryById.get(row.productId))
      : null;
    const inventory = row.inventory
      ? storedInventory.parse(row.inventory)
      : null;
    const place = row.inventoryLocationId
      ? locationById.get(row.inventoryLocationId)
      : undefined;
    return {
      groupKey: row.groupKey,
      crossCheck: photoFieldCrossCheck(
        comparisonIdentityFields(
          row,
          row.productId ? summaryById.get(row.productId) : undefined,
          identifiers
            .filter((entry) => entry.id === row.productId)
            .map((entry) => entry.value),
        ),
        processing
          .filter((photo) => roster.imageCodes.includes(photo.id))
          .flatMap((photo) =>
            photo.recognizedText ? [photo.recognizedText] : [],
          ),
      ),
      ...photoGroupSteps({
        state: row.state,
        runStatus,
        kind: row.productKind,
        productName:
          row.productKind === "create"
            ? (row.productCreate?.name ?? null)
            : (productSummary?.name ?? null),
        productMissing: row.productKind === "existing" && !productSummary,
        imageCount: roster.images.length,
        skipCount: roster.skip.length,
        concern: row.review?.unresolvedReason ?? null,
        stockIntent:
          row.review?.stockIntent ?? (inventory ? "receive" : "evidence"),
        inventoryMissing: !inventory || !place,
        destination:
          inventory && place
            ? { locationName: place.name, quantity: inventory.quantity }
            : null,
        descriptionBlocked: processing.some(
          (photo) =>
            roster.imageCodes.includes(photo.id) &&
            photo.describe !== null &&
            !["ready", "skipped"].includes(photo.describe),
        ),
      }),
      review: row.review
        ? {
            ...row.review,
            productChanges:
              row.review.productChanges &&
              "categoryId" in row.review.productChanges
                ? {
                    ...row.review.productChanges,
                    ...("brandId" in row.review.productChanges
                      ? { brandId: linked.createBrandId(row) }
                      : {}),
                    categoryId: linked.createCategoryId(row),
                  }
                : row.review.productChanges &&
                    "brandId" in row.review.productChanges
                  ? {
                      ...row.review.productChanges,
                      brandId: linked.createBrandId(row),
                    }
                  : row.review.productChanges,
          }
        : undefined,
      state: row.state,
      images: roster.images.map((entry, index) => ({
        id: roster.imageCodes[index]!,
        purpose: entry.purpose,
      })),
      skip: roster.skip.map((entry, index) => ({
        id: roster.skipCodes[index]!,
        reason: entry.reason,
      })),
      product:
        row.productKind === "existing"
          ? {
              kind: "existing" as const,
              existing: productSummary,
            }
          : {
              kind: "create" as const,
              create: linked.create(row),
            },
      committedProduct: row.state === "committed" ? productSummary : null,
      committedInventoryId:
        row.state === "committed"
          ? (() => {
              const stored = row.images.flatMap((entry) => {
                const parsed = z
                  .object({ groupKey: z.string(), inventoryId: z.string() })
                  .safeParse(imagesById.get(entry.imageId)?.diff);
                if (!parsed.success || parsed.data.groupKey !== row.groupKey)
                  return [];
                return [
                  parseShortcodeFor("inventory", parsed.data.inventoryId),
                ];
              });
              return stored[0] ?? null;
            })()
          : null,
      inventory: inventory
        ? {
            locationId: place
              ? parseShortcodeFor("location", place.shortcode)
              : null,
            locationName: place?.name ?? null,
            ownershipMode: inventory.ownershipMode,
            ownerPartyId: linked.ownerPartyId(row),
            quantity: inventory.quantity,
            mode: inventory.mode,
            existingEntryId: inventory.existingEntryId,
          }
        : null,
      evidence: row.evidence,
      origin: row.origin ?? null,
      conflict: row.conflictProductIds?.length
        ? row.conflictProductIds.flatMap((conflictCode) => {
            const entry = summaryByCode.get(
              parseShortcodeFor("product", conflictCode),
            );
            return entry ? [strip(entry)!] : [];
          })
        : null,
      lastError: row.lastError,
      missingImageCount: roster.missing,
      committedAt: row.committedAt?.toISOString() ?? null,
      updatedAt: row.updatedAt.toISOString(),
    };
  });
}

async function buildList(
  db: Database,
  run: LoadedRun,
  processingRead = loadPhotoRunImages(db, run),
): Promise<PhotoGroupProposalList> {
  const [images, rows, processing] = await Promise.all([
    loadRunImages(db, run.id),
    loadProposalRows(db, run.id),
    processingRead,
  ]);
  const assigned = new Set(
    rows
      .filter((row) => row.state === "proposed")
      .flatMap((row) => [...row.images, ...row.skip].map((e) => e.imageId)),
  );
  return photoGroupProposalList.parse({
    runId: run.shortcode,
    runStatus: run.status,
    proposals: await toViews(db, rows, images.byId, run.status, processing),
    unassignedImageIds: images.ordered
      .filter(
        (entry) =>
          (entry.state === "pending" ||
            (run.status === "needs_review" && entry.state === "unresolved")) &&
          !assigned.has(entry.imageId),
      )
      .map((entry) => entry.shortcode),
  });
}

export async function listPhotoGroupProposals(
  db: Database,
  runShortcode: string,
): Promise<PhotoGroupProposalList> {
  return buildList(db, await loadRun(db, runShortcode));
}

export async function readPhotoRunDefaults(db: Database, publicId: string) {
  return (await loadRun(db, publicId)).input?.defaults ?? null;
}

/** A batch destination fills missing receive decisions; member exceptions stay intact. */
export async function setPhotoRunDefaults(
  db: Database,
  publicId: string,
  defaults: PhotoRunDefaults,
) {
  return withTransactionDatabase(db, async (txDb) => {
    const run = await loadRun(txDb, publicId);
    const [locked] = await getDb(txDb)
      .select({ input: runTable.input, status: runTable.status })
      .from(runTable)
      .where(eq(runTable.id, run.id))
      .for("update");
    if (!locked || !["running", "needs_review"].includes(locked.status))
      throw new Error("This photo run is no longer open for review");
    const locationId = defaults.locationId
      ? await resolveOrThrow(txDb, "location", defaults.locationId)
      : null;
    const input = storedPhotoRunInput.parse(locked?.input ?? null) ?? {
      kind: "photo_inventory" as const,
      processor: null,
      batches: [],
    };
    await getDb(txDb)
      .update(runTable)
      .set({ input: { ...input, defaults }, updatedAt: new Date() })
      .where(eq(runTable.id, run.id));
    if (locationId) {
      const rows = await loadProposalRows(txDb, run.id);
      for (const row of rows) {
        // An explicit reference/count/historical choice or destination is never overwritten.
        if (
          row.state !== "proposed" ||
          row.images.length === 0 ||
          row.inventory ||
          row.review?.stockIntent !== "receive"
        )
          continue;
        await getDb(txDb)
          .update(photoGroupProposal)
          .set({
            inventoryLocationId: locationId,
            inventory: { quantity: 1, mode: "create" },
            origin: "member",
            updatedAt: new Date(),
          })
          .where(eq(photoGroupProposal.id, row.id));
      }
    }
    await recordChange(txDb, { kind: "source", categories: ["run"] });
  });
}

/** Review and lifecycle use the same current image evidence within one read. */
export async function readPhotoRunReview(db: Database, runShortcode: string) {
  const run = await loadRun(db, runShortcode);
  const processing = loadPhotoRunImages(db, run);
  const [images, review] = await Promise.all([
    processing,
    buildList(db, run, processing),
  ]);
  return { images, review, defaults: run.input?.defaults ?? null };
}

type ResolvedGroup = {
  group: PhotoGroupProposalGroup;
  images: { imageId: ImageId; purpose: "item" | "label" }[];
  skip: { imageId: ImageId; reason: string }[];
  productId: ProductId | null;
  locationId: LocationId | null;
  brandId: import("@cubby/schemas/identifiers").VendorId | null;
  categoryId: ProductCategoryId | null;
  ownerPartyId: LedgerPartyId | null;
};

/** Resolve one group's codes against targets still available for human review. */
async function resolveGroup(
  db: Database,
  run: LoadedRun,
  group: PhotoGroupProposalGroup,
  runImages: Map<string, RunImage>,
): Promise<ResolvedGroup> {
  const pendingImage = (code: string) => {
    const entry = runImages.get(code);
    if (!entry)
      throw new Error(
        `Image ${code} is not part of photo-inventory run ${run.shortcode}`,
      );
    if (
      entry.state !== "pending" &&
      !(run.status === "needs_review" && entry.state === "unresolved")
    )
      throw new Error(
        `Image ${code} is already ${entry.state} in run ${run.shortcode}; only reviewable images can be proposed`,
      );
    return entry.imageId;
  };
  const images = group.images.map((entry) => ({
    imageId: pendingImage(entry.id),
    purpose: entry.purpose,
  }));
  const skip = (group.skip ?? []).map((entry) => ({
    imageId: pendingImage(entry.id),
    reason: entry.reason,
  }));
  // Resolve every other code now so a bad reference fails the proposal, not
  // the approval a reviewer clicks later.
  const productId =
    group.product.kind === "existing"
      ? await resolveOrThrow(db, "product", group.product.existingId)
      : null;
  const brandCode =
    group.product.kind === "create"
      ? group.product.create.brandId
      : group.review?.productChanges?.brandId;
  const brandId = brandCode
    ? await resolveOrThrow(db, "vendor", brandCode)
    : null;
  const categoryCode =
    group.product.kind === "create"
      ? group.product.create.categoryId
      : group.review?.productChanges?.categoryId;
  const categoryId = categoryCode
    ? await resolveOrThrow(db, "productCategory", categoryCode)
    : null;
  assertPhotoGroupReviewIntent(group, "draft");
  const locationId = group.inventory
    ? await resolveOrThrow(db, "location", group.inventory.locationId)
    : null;
  const ownerPartyId = group.inventory?.ownerPartyId
    ? await resolveOrThrow(db, "ledgerParty", group.inventory.ownerPartyId)
    : null;
  return {
    group,
    images,
    skip,
    productId,
    locationId,
    categoryId,
    brandId,
    ownerPartyId,
  };
}

/** Exclusivity is checked against the post-write set of proposed rows. */
function assertOneGroupPerImage(
  existing: readonly ProposalRow[],
  resolved: readonly ResolvedGroup[],
  replacedKeys: ReadonlySet<string>,
  imagesById: Map<ImageId, RunImage>,
) {
  const owner = new Map<ImageId, string>();
  const claim = (imageId: ImageId, groupKey: string) => {
    const previous = owner.get(imageId);
    if (previous !== undefined) {
      const code = imagesById.get(imageId)?.shortcode ?? imageId;
      throw new Error(
        `Image ${code} appears in both group ${previous} and group ${groupKey}; each image belongs to exactly one group`,
      );
    }
    owner.set(imageId, groupKey);
  };
  for (const row of existing) {
    if (row.state !== "proposed" || replacedKeys.has(row.groupKey)) continue;
    for (const entry of [...row.images, ...row.skip])
      claim(entry.imageId, row.groupKey);
  }
  for (const entry of resolved) {
    for (const item of [...entry.images, ...entry.skip])
      claim(item.imageId, entry.group.groupKey);
  }
}

async function upsertProposal(
  txDb: Database,
  runId: RunId,
  entry: ResolvedGroup,
  origin: PhotoGroupProposalOrigin | null,
) {
  const { group } = entry;
  const values = {
    images: entry.images,
    skip: entry.skip,
    productKind: group.product.kind,
    productId: entry.productId,
    // Category and owner are FK columns, not codes in the JSON, so a merge
    // or delete before approval is followed rather than breaking it.
    productCreate:
      group.product.kind === "create"
        ? { ...group.product.create, categoryId: undefined, brandId: undefined }
        : null,
    productCreateCategoryId: entry.categoryId,
    productCreateBrandId: entry.brandId,
    inventoryLocationId: entry.locationId,
    inventory: group.inventory
      ? {
          quantity: group.inventory.quantity,
          ownershipMode: group.inventory.ownershipMode,
          mode: group.inventory.mode,
          existingEntryId: group.inventory.existingEntryId,
          household:
            group.inventory.ownerPartyId === null ? (true as const) : undefined,
        }
      : null,
    inventoryOwnerPartyId: entry.ownerPartyId,
    review: group.review
      ? {
          ...group.review,
          confirmation: null,
          productChanges:
            group.review.productChanges &&
            "categoryId" in group.review.productChanges
              ? { ...group.review.productChanges, categoryId: null }
              : normalizeReview(group.review)?.productChanges,
        }
      : null,
    evidence: group.evidence ?? null,
    origin,
    conflictProductIds: null,
    lastError: null,
    updatedAt: new Date(),
  };
  if (
    values.review?.productChanges &&
    "brandId" in values.review.productChanges
  )
    values.review.productChanges.brandId = null;
  await getDb(txDb)
    .insert(photoGroupProposal)
    .values({ runId, groupKey: group.groupKey, ...values })
    .onConflictDoUpdate({
      target: [photoGroupProposal.runId, photoGroupProposal.groupKey],
      set: values,
      // Belt and braces for the frozen filter: never rewrite history.
      setWhere: eq(photoGroupProposal.state, "proposed"),
    });
}

/**
 * Create or replace `proposed` groups by groupKey and drop `removeGroupKeys`,
 * atomically, then re-check that every image sits in at most one live
 * proposed group. Serialized per run by locking the run row.
 */
export async function proposePhotoGroups(
  db: Database,
  rawInput: z.input<typeof proposePhotoGroupsInput>,
  /** Recorded as each written row's last writer; null = not known. */
  origin: PhotoGroupProposalOrigin | null = null,
  /** A coordinator's signed dispatch generation (`_runExecution.generation`). */
  coordinatorGeneration?: string,
): Promise<ProposePhotoGroupsOutput> {
  const input = proposePhotoGroupsInput.parse(rawInput);
  const run = await loadRun(db, input.runId);
  const frozenGroupKeys = await withTransactionDatabase(db, async (txDb) => {
    // Vendor merge/delete locks the same rows exclusively. Take shared locks
    // in its canonical order before touching proposal rows, through persistence.
    const brandCodes = [
      ...new Set(
        input.groups.flatMap((group) => {
          const code =
            group.product.kind === "create"
              ? group.product.create.brandId
              : group.review?.productChanges?.brandId;
          return code ? [code] : [];
        }),
      ),
    ];
    if (brandCodes.length) {
      const brands = await getDb(txDb)
        .select({ id: vendor.id })
        .from(vendor)
        .where(and(inArray(vendor.shortcode, brandCodes), notDeleted(vendor)))
        .orderBy(vendor.id)
        .for("share");
      if (brands.length !== brandCodes.length)
        throw new Error(
          "A selected photo Brand is no longer available. Reload the proposal before saving.",
        );
    }
    const [locked] = await getDb(txDb)
      .select({
        dispatchEventId: runTable.dispatchEventId,
        input: runTable.input,
      })
      .from(runTable)
      .where(eq(runTable.id, run.id))
      .for("update");
    run.input = storedPhotoRunInput.parse(locked?.input ?? null);
    // Generation fence: a coordinator writes only for the dispatch generation
    // its delegation was signed with. Admitting a new upload batch replaces
    // that generation, so a superseded coordinator — even one still running
    // after the new generation started — cannot overwrite the regrouped Run.
    if (
      origin === "coordinator" &&
      (!coordinatorGeneration ||
        locked?.dispatchEventId !== coordinatorGeneration)
    )
      throw new Error(
        `Photo run ${run.shortcode} was regrouped after new photos arrived; this coordinator generation is no longer active`,
      );
    const [runImages, existing] = await Promise.all([
      loadRunImages(txDb, run.id),
      loadProposalRows(txDb, run.id),
    ]);
    for (const row of existing) {
      if (row.state !== "proposed") continue;
      const receipt = await reconcileCommittedProposal(
        txDb,
        run,
        row,
        runImages.byId,
      );
      if (receipt) {
        row.state = "committed";
        row.productId = receipt.productId;
      }
    }
    const existingByKey = new Map(existing.map((row) => [row.groupKey, row]));
    const frozen = input.groups
      .map((group) => group.groupKey)
      .filter((key) => {
        const row = existingByKey.get(key);
        return row !== undefined && row.state !== "proposed";
      });
    const writable = input.groups.filter(
      (group) => !frozen.includes(group.groupKey),
    );
    if (
      run.status !== "running" &&
      run.status !== "needs_review" &&
      writable.length
    )
      throw new Error(
        `Photo-inventory run ${run.shortcode} is not open for review (status: ${run.status})`,
      );
    for (const key of input.removeGroupKeys ?? []) {
      const row = existingByKey.get(key);
      if (!row) throw new Error(`Group ${key} does not exist in this run`);
      if (row.state !== "proposed")
        throw new Error(`Group ${key} is ${row.state} and cannot be removed`);
    }

    const resolved: ResolvedGroup[] = [];
    for (const group of writable) {
      const rosterCodes = new Set(
        [...group.images, ...(group.skip ?? [])].map((entry) => entry.id),
      );
      const predecessors = existing.filter(
        (row) =>
          row.groupKey === group.groupKey ||
          [...row.images, ...row.skip].some(
            (entry) =>
              runImages.byId.has(entry.imageId) &&
              rosterCodes.has(
                parseShortcodeFor(
                  "image",
                  runImages.byId.get(entry.imageId)!.shortcode,
                ),
              ),
          ),
      );
      const lineage = new Set([
        ...rosterCodes,
        ...predecessors.flatMap((row) => [
          ...(row.review?.candidateScopeImageIds ?? []),
          ...liveRoster(row, runImages.byId).imageCodes,
          ...liveRoster(row, runImages.byId).skipCodes,
        ]),
      ]);
      // Concerns and their history follow photos just like rejection scope.
      // Only resolvePhotoGroupConcern may clear a predecessor's concern.
      const concerns = [
        ...new Set([
          ...predecessors.flatMap(
            (row) =>
              normalizeReview(row.review)?.unresolvedReason?.split("\n") ?? [],
          ),
          ...(normalizeReview(group.review)?.unresolvedReason?.split("\n") ??
            []),
        ]),
      ];
      const resolvedConcerns = [
        ...new Map(
          predecessors
            .flatMap((row) => row.review?.resolvedConcerns ?? [])
            .map((concern) => [JSON.stringify(concern), concern]),
        ).values(),
      ];
      group.review = {
        ...(group.review ?? {
          observedName:
            group.product.kind === "create"
              ? group.product.create.name
              : group.groupKey,
          stockIntent: group.inventory
            ? "receive"
            : (run.input?.defaults?.stockIntent ?? "evidence"),
        }),
        unresolvedReason: concerns.join("\n") || null,
        candidateScopeImageIds: [...lineage],
        resolvedConcerns,
        confirmation: null,
      };
      if (
        group.review.stockIntent === "receive" &&
        group.images.length > 0 &&
        !group.inventory &&
        run.input?.defaults?.locationId
      )
        group.inventory = {
          locationId: run.input.defaults.locationId,
          quantity: 1,
          mode: "create",
        };
      resolved.push(await resolveGroup(txDb, run, group, runImages.byCode));
    }

    assertOneGroupPerImage(
      existing,
      resolved,
      new Set([
        ...writable.map((group) => group.groupKey),
        ...(input.removeGroupKeys ?? []),
      ]),
      runImages.byId,
    );

    if (input.removeGroupKeys?.length) {
      const removedKeys = new Set(input.removeGroupKeys);
      const sourceEvidence = existing.flatMap((row) =>
        row.state === "proposed" &&
        removedKeys.has(row.groupKey) &&
        row.sourceManufacturer !== null
          ? [
              {
                groupKey: row.groupKey,
                sourceManufacturer: row.sourceManufacturer,
              },
            ]
          : [],
      );
      // Regrouping replaces child rows. Archive each original in the owning
      // Run's durable evidence before deletion, atomically with its replacement.
      if (sourceEvidence.length)
        await getDb(txDb)
          .insert(photoGroupSourceEvidence)
          .values(sourceEvidence.map((entry) => ({ runId: run.id, ...entry })));
      await getDb(txDb)
        .delete(photoGroupProposal)
        .where(
          and(
            eq(photoGroupProposal.runId, run.id),
            inArray(photoGroupProposal.groupKey, input.removeGroupKeys),
            eq(photoGroupProposal.state, "proposed"),
          ),
        );
    }
    for (const entry of resolved)
      await upsertProposal(txDb, run.id, entry, origin);
    return frozen;
  });
  return { ...(await buildList(db, run)), frozenGroupKeys };
}

/** Resolution is explicit; ordinary edits preserve the original concern. */
export async function resolvePhotoGroupConcern(
  db: Database,
  input: {
    runId: string;
    groupKey: string;
    reply?: string;
    expectedRevision?: string;
  },
  actor: ActorContext,
): Promise<PhotoGroupProposalList> {
  const run = await loadRun(db, input.runId);
  await withTransactionDatabase(db, async (txDb) => {
    await getDb(txDb)
      .select({ id: runTable.id })
      .from(runTable)
      .where(eq(runTable.id, run.id))
      .for("update");
    const row = (await loadProposalRows(txDb, run.id)).find(
      (entry) => entry.groupKey === input.groupKey,
    );
    if (!row || row.state !== "proposed")
      throw new Error("Proposed photo group was not found");
    if (
      input.expectedRevision &&
      row.updatedAt.toISOString() !== input.expectedRevision
    )
      throw new Error(
        "Photo group review changed; reload before resolving its concern",
      );
    const review = normalizeReview(row.review);
    if (!review?.unresolvedReason) return;
    await getDb(txDb)
      .update(photoGroupProposal)
      .set({
        review: {
          ...review,
          unresolvedReason: null,
          confirmation: null,
          resolvedConcerns: [
            ...(review.resolvedConcerns ?? []),
            {
              reason: review.unresolvedReason,
              reply: input.reply?.trim() || null,
              by: actor.userId,
              at: new Date().toISOString(),
            },
          ],
        },
        origin: "member",
        updatedAt: new Date(),
      })
      .where(eq(photoGroupProposal.id, row.id));
  });
  return buildList(db, run);
}

/** A reviewer changes only the destination Product; the photo roster and other evidence stay put. */
export async function chooseExistingProductForPhotoGroup(
  db: Database,
  input: { runId: string; groupKey: string; productId: string },
) {
  const review = await listPhotoGroupProposals(db, input.runId);
  const group = review.proposals.find(
    (item) => item.groupKey === input.groupKey,
  );
  if (!group || group.state !== "proposed")
    throw new Error("Proposed photo group was not found");
  if (
    !group.review &&
    group.product.kind === "existing" &&
    !group.product.existing
  )
    throw new Error(
      "Confirm the missing observed identity on web before choosing a Product",
    );
  const sameProduct =
    group.product.kind === "existing" &&
    group.product.existing?.id === input.productId;
  const inventory = group.inventory?.locationId
    ? {
        locationId: group.inventory.locationId,
        ownershipMode: group.inventory.ownershipMode,
        ownerPartyId: group.inventory.ownerPartyId,
        quantity: group.inventory.quantity,
        mode: sameProduct ? group.inventory.mode : ("create" as const),
        existingEntryId: sameProduct
          ? group.inventory.existingEntryId
          : undefined,
      }
    : undefined;
  return proposePhotoGroups(
    db,
    {
      runId: input.runId,
      groups: [
        {
          groupKey: group.groupKey,
          images: group.images,
          skip: group.skip,
          product: { kind: "existing", existingId: input.productId },
          review: {
            ...(group.review ?? {
              observedName:
                group.product.kind === "create"
                  ? group.product.create.name
                  : (group.product.existing?.name ?? group.groupKey),
              stockIntent: inventory ? "receive" : "evidence",
            }),
            unresolvedReason: group.review?.unresolvedReason ?? null,
            productChanges: sameProduct
              ? group.review?.productChanges
              : undefined,
          },
          inventory,
          evidence: group.evidence,
        },
      ],
    },
    "member",
  );
}

/** Keep the reviewed photo grouping intact while correcting a new Product's identity. */
export async function updatePhotoGroupProductDraft(
  db: Database,
  input: {
    runId: string;
    groupKey: string;
    name: string;
    categoryId?: string | null;
    brandId?: import("@cubby/schemas/identifiers").VendorShortcode | null;
    model?: string | null;
    notes?: string | null;
  },
) {
  const review = await listPhotoGroupProposals(db, input.runId);
  const group = review.proposals.find(
    (item) => item.groupKey === input.groupKey,
  );
  if (!group || group.state !== "proposed" || group.product.kind !== "create")
    throw new Error("Proposed new-product group was not found");
  const inventory = group.inventory?.locationId
    ? {
        locationId: group.inventory.locationId,
        ownershipMode: group.inventory.ownershipMode,
        ownerPartyId: group.inventory.ownerPartyId,
        quantity: group.inventory.quantity,
        mode: group.inventory.mode,
        existingEntryId: group.inventory.existingEntryId,
      }
    : undefined;
  return proposePhotoGroups(
    db,
    {
      runId: input.runId,
      groups: [
        {
          groupKey: group.groupKey,
          images: group.images,
          skip: group.skip,
          product: {
            kind: "create",
            create: {
              ...group.product.create,
              name: input.name,
              categoryId: input.categoryId ?? undefined,
              brandId:
                input.brandId === undefined
                  ? group.product.create.brandId
                  : input.brandId,
              model: input.model ?? undefined,
              notes: input.notes ?? undefined,
            },
          },
          review: {
            ...(group.review ?? {
              observedName: group.product.create.name,
              stockIntent: inventory ? "receive" : "evidence",
            }),
            unresolvedReason: group.review?.unresolvedReason ?? null,
          },
          inventory,
          evidence: group.evidence,
        },
      ],
    },
    "member",
  );
}

/** Rebuild the writer's input from a stored row, refusing a row whose chosen Product or Location was deleted. */
async function commitInputFor(
  db: Database,
  run: LoadedRun,
  row: ProposalRow,
  roster: LiveRoster,
): Promise<CommitPhotoGroupInput> {
  if (!roster.images.length && !roster.skip.length)
    throw new Error(
      `Every photo in group ${row.groupKey} was deleted; remove the group instead of approving it`,
    );
  let productChoice: CommitPhotoGroupInput["product"];
  if (row.productKind === "existing") {
    if (!row.productId)
      throw new Error(
        `Group ${row.groupKey}'s chosen Product was deleted; pick another Product before approving`,
      );
    const [chosen] = await getDb(db)
      .select({ shortcode: product.shortcode })
      .from(product)
      .where(and(eq(product.id, row.productId), notDeleted(product)));
    if (!chosen)
      throw new Error(`Group ${row.groupKey}'s chosen Product was deleted`);
    productChoice = {
      kind: "existing",
      existingId: parseShortcodeFor("product", chosen.shortcode),
    };
  } else {
    productChoice = {
      kind: "create",
      create: (await linkedCodes(db, [row])).create(row),
    };
  }
  let inventory: CommitPhotoGroupInput["inventory"];
  if (row.inventory) {
    if (!row.inventoryLocationId)
      throw new Error(
        `Group ${row.groupKey}'s inventory Location was deleted; pick another Location before approving`,
      );
    const [place] = await getDb(db)
      .select({ shortcode: location.shortcode })
      .from(location)
      .where(
        and(eq(location.id, row.inventoryLocationId), notDeleted(location)),
      );
    if (!place)
      throw new Error(`Group ${row.groupKey}'s inventory Location was deleted`);
    const stored = storedInventory.parse(row.inventory);
    inventory = {
      locationId: parseShortcodeFor("location", place.shortcode),
      quantity: stored.quantity,
      ownershipMode: stored.ownershipMode,
      mode: stored.mode,
      existingEntryId: stored.existingEntryId,
      ownerPartyId: (await linkedCodes(db, [row])).ownerPartyId(row),
    };
  }
  return {
    runId: run.shortcode,
    groupKey: row.groupKey,
    images: roster.images.map((entry, index) => ({
      id: roster.imageCodes[index]!,
      purpose: entry.purpose,
    })),
    product: productChoice,
    review: row.review
      ? {
          ...row.review,
          productChanges:
            row.review.productChanges &&
            "categoryId" in row.review.productChanges
              ? {
                  ...row.review.productChanges,
                  ...("brandId" in row.review.productChanges
                    ? {
                        brandId: (await linkedCodes(db, [row])).createBrandId(
                          row,
                        ),
                      }
                    : {}),
                  categoryId: (await linkedCodes(db, [row])).createCategoryId(
                    row,
                  ),
                }
              : row.review.productChanges &&
                  "brandId" in row.review.productChanges
                ? {
                    ...row.review.productChanges,
                    brandId: (await linkedCodes(db, [row])).createBrandId(row),
                  }
                : row.review.productChanges,
        }
      : undefined,
    inventory,
    skip: roster.skip.map((entry, index) => ({
      id: roster.skipCodes[index]!,
      reason: entry.reason,
    })),
  };
}

/**
 * Freeze a group as committed or discarded with the roster and choices the
 * writer actually committed — `row` as read before the commit, not whatever a
 * concurrent save wrote since. Upserting also restores a row a concurrent
 * save removed, so a committed group is never left without its record.
 */
async function persistSettled(
  db: Database,
  run: LoadedRun,
  row: ProposalRow,
  roster: LiveRoster,
  state: "committed" | "discarded",
  productId: ProductId | null,
) {
  const now = new Date();
  const values = {
    state,
    images: roster.images,
    skip: roster.skip,
    productKind: row.productKind,
    productId,
    productCreate: row.productCreate,
    productCreateCategoryId: row.productCreateCategoryId,
    productCreateBrandId: row.productCreateBrandId,
    inventoryLocationId: row.inventoryLocationId,
    inventory: row.inventory,
    inventoryOwnerPartyId: row.inventoryOwnerPartyId,
    evidence: row.evidence,
    review: row.review,
    conflictProductIds: null,
    lastError: null,
    committedAt: now,
    updatedAt: now,
  };
  await getDb(db)
    .insert(photoGroupProposal)
    .values({ runId: run.id, groupKey: row.groupKey, ...values })
    .onConflictDoUpdate({
      target: [photoGroupProposal.runId, photoGroupProposal.groupKey],
      set: values,
      setWhere: eq(photoGroupProposal.state, "proposed"),
    });
}

/** Target receipts survive a failure after the domain transaction committed. */
async function reconcileCommittedProposal(
  db: Database,
  run: LoadedRun,
  row: ProposalRow,
  imagesById: Map<ImageId, RunImage>,
): Promise<{ productId: ProductId | null } | null> {
  const roster = liveRoster(row, imagesById);
  if (!roster.images.length && !roster.skip.length) return null;
  const attached = roster.images.map((entry) => {
    const target = imagesById.get(entry.imageId);
    const receipt = photoRunImageCommitReceipt.safeParse(target?.diff);
    return target?.state === "completed" &&
      receipt.success &&
      receipt.data.groupKey === row.groupKey &&
      receipt.data.purpose === entry.purpose &&
      receipt.data.productId
      ? receipt.data
      : null;
  });
  if (attached.some((receipt) => !receipt)) return null;
  if (
    roster.skip.some((entry) => {
      const target = imagesById.get(entry.imageId);
      const receipt = photoRunImageCommitReceipt.safeParse(target?.diff);
      return (
        target?.state !== "skipped" ||
        !receipt.success ||
        receipt.data.groupKey !== row.groupKey
      );
    })
  )
    return null;
  const productCodes = new Set(
    attached.flatMap((receipt) => receipt?.productId ?? []),
  );
  if (productCodes.size > 1)
    throw new Error(
      `Group ${row.groupKey} has inconsistent committed Product receipts`,
    );
  const productCode = attached[0]?.productId;
  const productId = productCode
    ? await resolveOrThrow(db, "product", productCode)
    : row.productId;
  await persistSettled(db, run, row, roster, "committed", productId);
  return { productId };
}

async function approveRow(
  db: Database,
  run: LoadedRun,
  row: ProposalRow,
  imagesById: Map<ImageId, RunImage>,
  actor: ActorContext,
): Promise<PhotoGroupApprovalResult> {
  if (row.state === "committed")
    return { groupKey: row.groupKey, outcome: "replayed" };
  if (row.state === "discarded")
    return {
      groupKey: row.groupKey,
      outcome: "failed",
      error: `Group ${row.groupKey} was discarded`,
    };
  const roster = liveRoster(row, imagesById);
  try {
    if (await reconcileCommittedProposal(db, run, row, imagesById))
      return { groupKey: row.groupKey, outcome: "replayed" };
    row.review = normalizeReview(row.review) ?? {
      observedName: row.productCreate?.name ?? row.groupKey,
      unresolvedReason: null,
      stockIntent: row.inventory ? "receive" : "evidence",
    };
    if (roster.images.length && row.review.unresolvedReason)
      throw new Error(row.review.unresolvedReason);
    if (roster.images.length) {
      const descriptionJobs = await getDb(db)
        .select({
          imageId: imageProcessingJob.imageId,
          state: imageProcessingJob.state,
          processorRevision: imageProcessingJob.processorRevision,
        })
        .from(imageProcessingJob)
        .innerJoin(image, eq(image.id, imageProcessingJob.imageId))
        .where(
          and(
            inArray(
              imageProcessingJob.imageId,
              roster.images.map((entry) => entry.imageId),
            ),
            eq(imageProcessingJob.kind, "describe_image"),
            inArray(imageProcessingJob.processorRevision, [
              IMAGE_DESCRIPTION_PROCESSOR_REVISION,
              IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION,
            ]),
            eq(imageProcessingJob.sourceContentHash, image.sha256),
          ),
        );
      // Either description settles a photo: running out of AI money never
      // blocks one an Apple device already described.
      const settled = new Set<ImageId>();
      const requested = new Set<ImageId>();
      for (const job of descriptionJobs) {
        const id = imageId.parse(job.imageId);
        if (job.processorRevision === IMAGE_DESCRIPTION_PROCESSOR_REVISION)
          requested.add(id);
        if (
          job.state === "ready" ||
          (job.state === "skipped" &&
            job.processorRevision === IMAGE_DESCRIPTION_PROCESSOR_REVISION)
        )
          settled.add(id);
      }
      const unfinished = roster.images.filter(
        (entry) => requested.has(entry.imageId) && !settled.has(entry.imageId),
      );
      if (unfinished.length)
        throw new Error(
          `AI description is still processing or needs retry for ${countLabel(unfinished.length, "photo")}`,
        );
    }
    const input = await commitInputFor(db, run, row, roster);
    const result = await commitPhotoGroup(
      db,
      input,
      actor,
      {
        id: row.id,
        updatedAt: row.updatedAt,
      },
      async (txDb, committed) => {
        const committedProductId = committed.productId
          ? await resolveOrThrow(txDb, "product", committed.productId)
          : row.productId;
        await persistSettled(
          txDb,
          run,
          {
            ...row,
            review: {
              ...row.review!,
              confirmation: { by: actor.userId, at: new Date().toISOString() },
            },
          },
          roster,
          "committed",
          committedProductId,
        );
      },
    );
    if (result.outcome === "conflict") {
      // Only onto the row as read: a newer save already cleared the conflict
      // for a payload this attempt never saw.
      await getDb(db)
        .update(photoGroupProposal)
        .set({
          conflictProductIds: result.conflict?.existingProductIds ?? [],
          lastError: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(photoGroupProposal.id, row.id),
            eq(photoGroupProposal.state, "proposed"),
            eq(photoGroupProposal.updatedAt, row.updatedAt),
          ),
        );
      return { groupKey: row.groupKey, outcome: "conflict" };
    }

    return { groupKey: row.groupKey, outcome: result.outcome };
  } catch (error) {
    const message = getErrorMessage(error);
    // A frozen row never takes an error: a concurrent approval may have
    // committed it while this attempt failed.
    await getDb(db)
      .update(photoGroupProposal)
      .set({
        lastError: message.slice(0, 2_000),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(photoGroupProposal.id, row.id),
          eq(photoGroupProposal.state, "proposed"),
          eq(photoGroupProposal.updatedAt, row.updatedAt),
        ),
      );
    return {
      groupKey: row.groupKey,
      outcome: "failed",
      error: message,
    };
  }
}

/**
 * Commit the named proposed groups (every proposed group when `groupKeys` is
 * omitted) through the writer, one at a time. A name/alias `conflict` keeps
 * the group proposed with the colliding Products recorded; any other failure
 * keeps it proposed with `lastError`. Never throws for a per-group failure.
 */
export async function approvePhotoGroupProposals(
  db: Database,
  input: {
    runId: string;
    groupKeys?: string[] | undefined;
    expectedRevisions?: { groupKey: string; updatedAt: string }[] | undefined;
  },
  actor: ActorContext,
): Promise<PhotoGroupProposalList & { results: PhotoGroupApprovalResult[] }> {
  const run = await loadRun(db, input.runId);
  const [images, rows] = await Promise.all([
    loadRunImages(db, run.id),
    loadProposalRows(db, run.id),
  ]);
  const byKey = new Map(rows.map((row) => [row.groupKey, row]));
  const keys =
    input.groupKeys ??
    rows.filter((row) => row.state === "proposed").map((row) => row.groupKey);
  if (input.expectedRevisions) {
    const expected = new Map(
      input.expectedRevisions.map((revision) => [
        revision.groupKey,
        revision.updatedAt,
      ]),
    );
    if (
      expected.size !== keys.length ||
      keys.some((key) => {
        const row = byKey.get(key);
        return (
          !row ||
          !expected.has(key) ||
          (row.state !== "committed" &&
            row.updatedAt.toISOString() !== expected.get(key))
        );
      })
    )
      throw new Error(
        "Photo group review changed; reload before approving this batch",
      );
  }
  const results: PhotoGroupApprovalResult[] = [];
  for (const key of keys) {
    const row = byKey.get(key);
    results.push(
      row
        ? await approveRow(db, run, row, images.byId, actor)
        : {
            groupKey: key,
            outcome: "failed",
            error: `Group ${key} does not exist in this run`,
          },
    );
  }
  return { ...(await buildList(db, await loadRun(db, input.runId))), results };
}

/**
 * Reject a proposed group: every image it mentions is committed as `skip`
 * through the writer (so the run can still complete), and the row freezes as
 * `discarded`.
 */
export async function discardPhotoGroupProposal(
  db: Database,
  input: { runId: string; groupKey: string },
  actor: ActorContext,
): Promise<PhotoGroupProposalList> {
  const run = await loadRun(db, input.runId);
  const [images, rows] = await Promise.all([
    loadRunImages(db, run.id),
    loadProposalRows(db, run.id),
  ]);
  const row = rows.find((entry) => entry.groupKey === input.groupKey);
  if (!row) throw new Error(`Group ${input.groupKey} does not exist`);
  if (row.state !== "proposed")
    throw new Error(`Group ${input.groupKey} is already ${row.state}`);
  const roster = liveRoster(row, images.byId);
  // A group whose photos were all deleted has nothing left to skip.
  if (roster.images.length || roster.skip.length) {
    await commitPhotoGroup(
      db,
      {
        runId: run.shortcode,
        groupKey: row.groupKey,
        images: [],
        skip: [
          ...roster.imageCodes.map((id) => ({ id, reason: DISCARD_REASON })),
          ...roster.skip.map((entry, index) => ({
            id: roster.skipCodes[index]!,
            reason: entry.reason,
          })),
        ],
        // A skip-only group never touches its product (see the writer), but
        // the contract still requires one; the group name is a placeholder.
        product: { kind: "create", create: { name: row.groupKey } },
      },
      actor,
    );
  }
  await persistSettled(db, run, row, roster, "discarded", row.productId);
  return buildList(db, await loadRun(db, input.runId));
}

function descriptionJobTiming(
  job:
    | { id: string; dispatchedAt: Date | null; completedAt: Date | null }
    | undefined,
  attempts: readonly {
    jobId: string;
    startedAt: Date;
    completedAt: Date | null;
  }[],
) {
  const completedAttempts = attempts.filter(
    (attempt) => attempt.jobId === job?.id && attempt.completedAt,
  );
  const attemptMs = completedAttempts.reduce(
    (total, attempt) =>
      total +
      Math.max(0, attempt.completedAt!.getTime() - attempt.startedAt.getTime()),
    0,
  );
  const elapsedMs =
    job?.dispatchedAt && job.completedAt
      ? Math.max(0, job.completedAt.getTime() - job.dispatchedAt.getTime())
      : null;
  return {
    describeStartedAt: job?.dispatchedAt?.toISOString() ?? null,
    describeCompletedAt: job?.completedAt?.toISOString() ?? null,
    describeAttemptMs: completedAttempts.length ? attemptMs : null,
    describeWaitingMs:
      elapsedMs !== null && completedAttempts.length
        ? Math.max(0, elapsedMs - attemptMs)
        : null,
  };
}

/** Every run photo with both renditions, processing state and analysis snippets, for the review table. */
export async function listPhotoRunImages(
  db: Database,
  runShortcode: string,
): Promise<PhotoRunImage[]> {
  return loadPhotoRunImages(db, await loadRun(db, runShortcode));
}

async function loadPhotoRunImages(
  db: Database,
  run: LoadedRun,
): Promise<PhotoRunImage[]> {
  const rows = await getDb(db)
    .select({
      imageId: image.id,
      shortcode: image.shortcode,
      sha256: image.sha256,
      position: photoRunImage.position,
      capturedAt: image.capturedAt,
      capturedAtOffsetMinutes: image.capturedAtOffsetMinutes,
      state: photoRunImage.state,
      skipReason: photoRunImage.skipReason,
      deviceWorkState: photoRunImage.deviceWorkState,
      deviceWorkError: photoRunImage.deviceWorkError,
      deviceWorkAttempts: photoRunImage.deviceWorkAttempts,
    })
    .from(photoRunImage)
    .innerJoin(image, eq(image.id, photoRunImage.imageId))
    .where(eq(photoRunImage.runId, run.id))
    .orderBy(...photoRunImageOrder())
    .limit(PHOTO_RUN_IMAGE_LIMIT);
  if (!rows.length) return [];
  const shortcodes = rows.map((row) => row.shortcode);
  const [
    representations,
    { summaries, descriptionEvidence },
    jobs,
    localAnalyses,
  ] = await Promise.all([
    loadImageRepresentations(db, shortcodes),
    loadImageAnalysisEvidence(db, shortcodes),
    getDb(db)
      .select({
        id: imageProcessingJob.id,
        imageId: imageProcessingJob.imageId,
        kind: imageProcessingJob.kind,
        processorRevision: imageProcessingJob.processorRevision,
        state: imageJobDisplayStateSql(),
        lastError: imageProcessingJob.lastError,
        dispatchedAt: imageProcessingJob.dispatchedAt,
        completedAt: imageProcessingJob.completedAt,
        sourceContentHash: imageProcessingJob.sourceContentHash,
      })
      .from(imageProcessingJob)
      .where(
        inArray(
          imageProcessingJob.imageId,
          rows.map((row) => imageId.parse(row.imageId)),
        ),
      )
      .orderBy(desc(imageProcessingJob.processorRevision)),
    getDb(db)
      .select({ imageId: aiAnalysis.entityId })
      .from(aiAnalysis)
      .where(
        and(
          eq(aiAnalysis.entityKind, "image"),
          eq(aiAnalysis.feature, "photo-local-analysis"),
          inArray(
            aiAnalysis.entityId,
            rows.map((row) => imageId.parse(row.imageId)),
          ),
          notDeleted(aiAnalysis),
        ),
      ),
  ]);
  const descriptionJobIds = jobs
    .filter(
      (job) =>
        job.kind === "describe_image" &&
        job.processorRevision === IMAGE_DESCRIPTION_PROCESSOR_REVISION,
    )
    .map((job) => job.id);
  const descriptionAttempts = descriptionJobIds.length
    ? await getDb(db)
        .select({
          jobId: imageProcessingAttempt.jobId,
          startedAt: imageProcessingAttempt.startedAt,
          completedAt: imageProcessingAttempt.completedAt,
        })
        .from(imageProcessingAttempt)
        .where(inArray(imageProcessingAttempt.jobId, descriptionJobIds))
    : [];
  const locallyAnalyzed = new Set(localAnalyses.map((entry) => entry.imageId));
  const hashById = new Map(rows.map((row) => [row.imageId, row.sha256]));
  // Cloud descriptions own the timing; either description settles the
  // review gate, so an Apple description stands in while cloud work waits
  // (for AI funding, say) and the photo notes the missing cloud description.
  const jobByKey = new Map<string, (typeof jobs)[number]>();
  const appleDescribed = new Set<string>();
  for (const job of jobs) {
    if (job.sourceContentHash !== hashById.get(job.imageId)) continue;
    if (
      job.kind === "describe_image" &&
      job.processorRevision !== IMAGE_DESCRIPTION_PROCESSOR_REVISION
    ) {
      if (
        job.processorRevision === IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION &&
        job.state === "ready"
      )
        appleDescribed.add(job.imageId);
      continue;
    }
    const key = `${job.imageId}:${job.kind}`;
    if (!jobByKey.has(key)) jobByKey.set(key, job);
  }
  return rows.flatMap((row) => {
    const rendition = representations.get(row.shortcode);
    if (!rendition) return [];
    const summary = summaries.get(row.shortcode);
    const selectedDescription =
      descriptionEvidence.get(row.shortcode) ??
      selectImageDescriptionEvidence([], null, null);
    const cutout = jobByKey.get(`${row.imageId}:subject_lift`);
    const describe = jobByKey.get(`${row.imageId}:describe_image`);
    const cloudDescriptionMissing =
      appleDescribed.has(row.imageId) && describe?.state !== "ready";
    return {
      id: parseShortcodeFor("image", row.shortcode),
      position: row.position,
      capturedAt: row.capturedAt?.toISOString() ?? null,
      capturedAtOffsetMinutes: row.capturedAtOffsetMinutes,
      targetState: photoRunImageState.parse(row.state),
      skipReason: row.skipReason,
      originalUrl: rendition.original,
      cutoutUrl: rendition.transparent,
      cutout: cutout?.state ?? null,
      describe: cloudDescriptionMissing ? "ready" : (describe?.state ?? null),
      cloudDescriptionMissing,
      ...descriptionJobTiming(describe, descriptionAttempts),
      // Device-reported completion is the source of truth going forward;
      // an AiAnalysis row from before this column existed still counts, so
      // an in-flight run's older photos do not regress to "not ready".
      localAnalysisReady:
        row.deviceWorkState === "completed" || locallyAnalyzed.has(row.imageId),
      deviceWorkState: row.deviceWorkState,
      deviceWorkError: row.deviceWorkError,
      deviceWorkAttempts: row.deviceWorkAttempts,
      cutoutReason:
        cutout && (cutout.state === "skipped" || cutout.state === "failed")
          ? cutout.lastError
          : null,
      describeReason:
        describe?.state === "failed" ||
        describe?.state === "skipped" ||
        cloudDescriptionMissing
          ? (describe?.lastError ?? null)
          : null,
      description: selectedDescription.description,
      descriptionEvidence: selectedDescription,
      recognizedText: summary?.recognizedText ?? null,
    };
  });
}
