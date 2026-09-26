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
import type { ActorContext } from "@cubby/schemas/context";
import {
  parseShortcodeFor,
  type ImageId,
  type ImageShortcode,
  type ImportRunId,
  type LedgerPartyId,
  type LocationId,
  type ProductCategoryId,
  type ProductId,
} from "@cubby/schemas/identifiers";
import {
  imageId,
  importRunId,
  importRunShortcode,
} from "@cubby/schemas/identifiers";
import { inventoryOwnershipMode } from "@cubby/schemas/inventory-ownership";
import {
  commitPhotoGroupProduct,
  photoGroupProposalList,
  proposePhotoGroupsInput,
  type CommitPhotoGroupInput,
  type PhotoGroupApprovalResult,
  type PhotoGroupProposal,
  type PhotoGroupProposalGroup,
  type PhotoGroupProposalList,
  type PhotoGroupProposalProductSummary,
  type PhotoRunImage,
  type ProposePhotoGroupsOutput,
} from "@cubby/schemas/photo-import-run";
import {
  importRunPurpose,
  importRunStatus,
  importRunTargetState,
} from "@cubby/schemas/purchase-import";
import { getErrorMessage } from "@cubby/shared";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import {
  aiAnalysis,
  image,
  imageProcessingJob,
  imageProcessingAttempt,
  importRun,
  importRunTarget,
  ledgerParty,
  location,
  photoGroupProposal,
  product,
  productCategory,
} from "~/server/db/schema";
import { assertImportRunCapability } from "~/server/purchase-import/capabilities";
import {
  getDb,
  notDeleted,
  withTransactionDatabase,
} from "~/server/repo/database-helpers";
import { loadImageAnalysisSummaries } from "~/server/repo/image-analysis-summary";
import { loadImageRepresentations } from "~/server/repo/image-processing";
import { currentMemberLedgerParty } from "~/server/repo/member-login";
import { getProductCoverImageUrlsByProductIds } from "~/server/repo/product/crud";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";

import { commitPhotoGroup } from "./writer";

/** Matches the native uploader's per-run ceiling. */
const RUN_IMAGE_LIMIT = 1_000;
const DISCARD_REASON = "Discarded in review";

type ProposalRow = typeof photoGroupProposal.$inferSelect;
type RunImage = { imageId: ImageId; shortcode: string; state: string };

const storedCreate = commitPhotoGroupProduct.options[1].shape.create;
const storedInventory = z.object({
  ownershipMode: inventoryOwnershipMode.optional(),
  quantity: z.number().int().positive(),
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
      id: importRun.id,
      shortcode: importRun.shortcode,
      purpose: importRun.purpose,
      status: importRun.status,
    })
    .from(importRun)
    .where(eq(importRun.shortcode, importRunShortcode.parse(runShortcode)))
    .limit(1);
  if (!row) throw new PhotoRunNotFoundError(runShortcode);
  assertImportRunCapability(
    importRunPurpose.parse(row.purpose),
    "photo_commit",
  );
  return {
    id: importRunId.parse(row.id),
    shortcode: importRunShortcode.parse(row.shortcode),
    status: importRunStatus.parse(row.status),
  };
}
type LoadedRun = Awaited<ReturnType<typeof loadRun>>;

async function loadRunImages(db: Database, runId: ImportRunId) {
  const rows = await getDb(db)
    .select({
      imageId: image.id,
      shortcode: image.shortcode,
      state: importRunTarget.state,
    })
    .from(importRunTarget)
    .innerJoin(image, eq(image.id, importRunTarget.imageId))
    .where(eq(importRunTarget.runId, runId))
    .orderBy(importRunTarget.position)
    .limit(RUN_IMAGE_LIMIT);
  const ordered: RunImage[] = rows.map((row) => ({
    ...row,
    imageId: imageId.parse(row.imageId),
  }));
  const byCode = new Map(ordered.map((entry) => [entry.shortcode, entry]));
  const byId = new Map(ordered.map((entry) => [entry.imageId, entry]));
  return { byCode, byId, ordered };
}

const loadProposalRows = (db: Database, runId: ImportRunId) =>
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
 * hard-deletes its `ImportRunTarget` but not the id stored in this row's
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
): Promise<(PhotoGroupProposalProductSummary & { uuid: ProductId })[]> {
  const ids = where.ids ?? [];
  const codes = where.shortcodes ?? [];
  if (!ids.length && !codes.length) return [];
  const rows = await getDb(db)
    .select({
      id: product.id,
      shortcode: product.shortcode,
      name: product.name,
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
    create: (row: ProposalRow) => ({
      ...storedCreate.parse(row.productCreate),
      categoryId: row.productCreateCategoryId
        ? (categoryById.get(row.productCreateCategoryId) ?? null)
        : null,
    }),
    ownerPartyId: (row: ProposalRow) =>
      row.inventoryOwnerPartyId
        ? ownerById.get(row.inventoryOwnerPartyId)
        : undefined,
  };
}

async function toViews(
  db: Database,
  rows: ProposalRow[],
  imagesById: Map<ImageId, RunImage>,
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
  const [chosen, conflicts, locations, linked] = await Promise.all([
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
  ]);
  const summaryById = new Map(chosen.map((entry) => [entry.uuid, entry]));
  const summaryByCode = new Map(conflicts.map((entry) => [entry.id, entry]));
  const locationById = new Map(locations.map((entry) => [entry.id, entry]));
  const strip = (
    entry: (typeof chosen)[number] | undefined,
  ): PhotoGroupProposalProductSummary | null =>
    entry ? { id: entry.id, name: entry.name, coverUrl: entry.coverUrl } : null;
  return rows.map((row) => {
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
      inventory: inventory
        ? {
            locationId: place
              ? parseShortcodeFor("location", place.shortcode)
              : null,
            locationName: place?.name ?? null,
            ownershipMode: inventory.ownershipMode,
            ownerPartyId: linked.ownerPartyId(row),
            quantity: inventory.quantity,
          }
        : null,
      evidence: row.evidence,
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
): Promise<PhotoGroupProposalList> {
  const [images, rows] = await Promise.all([
    loadRunImages(db, run.id),
    loadProposalRows(db, run.id),
  ]);
  const assigned = new Set(
    rows
      .filter((row) => row.state === "proposed")
      .flatMap((row) => [...row.images, ...row.skip].map((e) => e.imageId)),
  );
  return photoGroupProposalList.parse({
    runId: run.shortcode,
    runStatus: run.status,
    proposals: await toViews(db, rows, images.byId),
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

type ResolvedGroup = {
  group: PhotoGroupProposalGroup;
  images: { imageId: ImageId; purpose: "item" | "label" }[];
  skip: { imageId: ImageId; reason: string }[];
  productId: ProductId | null;
  locationId: LocationId | null;
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
  const categoryId =
    group.product.kind === "create" && group.product.create.categoryId
      ? await resolveOrThrow(
          db,
          "productCategory",
          group.product.create.categoryId,
        )
      : null;
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
  runId: ImportRunId,
  entry: ResolvedGroup,
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
        ? { ...group.product.create, categoryId: undefined }
        : null,
    productCreateCategoryId: entry.categoryId,
    inventoryLocationId: entry.locationId,
    inventory: group.inventory
      ? {
          quantity: group.inventory.quantity,
          ownershipMode: group.inventory.ownershipMode,
        }
      : null,
    inventoryOwnerPartyId: entry.ownerPartyId,
    evidence: group.evidence ?? null,
    conflictProductIds: null,
    lastError: null,
    updatedAt: new Date(),
  };
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
): Promise<ProposePhotoGroupsOutput> {
  const input = proposePhotoGroupsInput.parse(rawInput);
  const run = await loadRun(db, input.runId);
  // Dropping a proposed group commits nothing, so a reviewer can tidy a run
  // after it stops; a run stopped for human review can still refine proposals.
  if (
    run.status !== "running" &&
    run.status !== "needs_review" &&
    input.groups.length > 0
  ) {
    throw new Error(
      `Photo-inventory run ${run.shortcode} is not open for review (status: ${run.status})`,
    );
  }
  const frozenGroupKeys = await withTransactionDatabase(db, async (txDb) => {
    await getDb(txDb)
      .select({ id: importRun.id })
      .from(importRun)
      .where(eq(importRun.id, run.id))
      .for("update");
    const [runImages, existing] = await Promise.all([
      loadRunImages(txDb, run.id),
      loadProposalRows(txDb, run.id),
    ]);
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
    for (const key of input.removeGroupKeys ?? []) {
      const row = existingByKey.get(key);
      if (!row) throw new Error(`Group ${key} does not exist in this run`);
      if (row.state !== "proposed")
        throw new Error(`Group ${key} is ${row.state} and cannot be removed`);
    }

    const resolved: ResolvedGroup[] = [];
    for (const group of writable) {
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
    for (const entry of resolved) await upsertProposal(txDb, run.id, entry);
    return frozen;
  });
  return { ...(await buildList(db, run)), frozenGroupKeys };
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
  const inventory = group.inventory?.locationId
    ? {
        locationId: group.inventory.locationId,
        ownershipMode: group.inventory.ownershipMode,
        ownerPartyId: group.inventory.ownerPartyId,
        quantity: group.inventory.quantity,
      }
    : undefined;
  return proposePhotoGroups(db, {
    runId: input.runId,
    groups: [
      {
        groupKey: group.groupKey,
        images: group.images,
        skip: group.skip,
        product: { kind: "existing", existingId: input.productId },
        inventory,
        evidence: group.evidence,
      },
    ],
  });
}

/** Keep the reviewed photo grouping intact while correcting a new Product's identity. */
export async function updatePhotoGroupProductDraft(
  db: Database,
  input: {
    runId: string;
    groupKey: string;
    name: string;
    categoryId?: string | null;
    manufacturer?: string | null;
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
      }
    : undefined;
  return proposePhotoGroups(db, {
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
            manufacturer: input.manufacturer ?? undefined,
            model: input.model ?? undefined,
            notes: input.notes ?? undefined,
          },
        },
        inventory,
        evidence: group.evidence,
      },
    ],
  });
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
    inventoryLocationId: row.inventoryLocationId,
    inventory: row.inventory,
    inventoryOwnerPartyId: row.inventoryOwnerPartyId,
    evidence: row.evidence,
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
    if (roster.images.length) {
      const descriptionJobs = await getDb(db)
        .select({
          imageId: imageProcessingJob.imageId,
          state: imageProcessingJob.state,
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
            eq(imageProcessingJob.sourceContentHash, image.sha256),
          ),
        )
        .orderBy(desc(imageProcessingJob.processorRevision));
      const latestByImage = new Map<ImageId, string>();
      for (const job of descriptionJobs) {
        const id = imageId.parse(job.imageId);
        if (!latestByImage.has(id)) latestByImage.set(id, job.state);
      }
      const unfinished = roster.images.filter((entry) => {
        const state = latestByImage.get(entry.imageId);
        return state && state !== "ready" && state !== "skipped";
      });
      if (unfinished.length)
        throw new Error(
          `AI description is still processing or needs retry for ${unfinished.length} photo${unfinished.length === 1 ? "" : "s"}`,
        );
    }
    const input = await commitInputFor(db, run, row, roster);
    const result = await commitPhotoGroup(db, input, actor);
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
    const committedProductId = result.productId
      ? await resolveOrThrow(db, "product", result.productId)
      : row.productId;
    await persistSettled(db, run, row, roster, "committed", committedProductId);
    return { groupKey: row.groupKey, outcome: result.outcome };
  } catch (error) {
    // A frozen row never takes an error: a concurrent approval may have
    // committed it while this attempt failed.
    await getDb(db)
      .update(photoGroupProposal)
      .set({
        lastError: getErrorMessage(error).slice(0, 2_000),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(photoGroupProposal.id, row.id),
          eq(photoGroupProposal.state, "proposed"),
        ),
      );
    return {
      groupKey: row.groupKey,
      outcome: "failed",
      error: getErrorMessage(error),
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
  input: { runId: string; groupKeys?: string[] | undefined },
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
  const run = await loadRun(db, runShortcode);
  const rows = await getDb(db)
    .select({
      imageId: image.id,
      shortcode: image.shortcode,
      sha256: image.sha256,
      position: importRunTarget.position,
      state: importRunTarget.state,
    })
    .from(importRunTarget)
    .innerJoin(image, eq(image.id, importRunTarget.imageId))
    .where(eq(importRunTarget.runId, run.id))
    .orderBy(importRunTarget.position, image.shortcode)
    .limit(RUN_IMAGE_LIMIT);
  if (!rows.length) return [];
  const shortcodes = rows.map((row) => row.shortcode);
  const [representations, summaries, jobs, localAnalyses] = await Promise.all([
    loadImageRepresentations(db, shortcodes),
    loadImageAnalysisSummaries(db, shortcodes),
    getDb(db)
      .select({
        id: imageProcessingJob.id,
        imageId: imageProcessingJob.imageId,
        kind: imageProcessingJob.kind,
        state: imageProcessingJob.state,
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
          eq(aiAnalysis.entityType, "image"),
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
    .filter((job) => job.kind === "describe_image")
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
  // Newest processor revision first: the first current-source job per
  // (image, kind) is the one that decides what the reviewer sees.
  const jobByKey = new Map<string, (typeof jobs)[number]>();
  for (const job of jobs) {
    if (job.sourceContentHash !== hashById.get(job.imageId)) continue;
    const key = `${job.imageId}:${job.kind}`;
    if (!jobByKey.has(key)) jobByKey.set(key, job);
  }
  return rows.flatMap((row) => {
    const rendition = representations.get(row.shortcode);
    if (!rendition) return [];
    const summary = summaries.get(row.shortcode);
    const cutout = jobByKey.get(`${row.imageId}:subject_lift`);
    const describe = jobByKey.get(`${row.imageId}:describe_image`);
    return {
      id: parseShortcodeFor("image", row.shortcode),
      position: row.position,
      targetState: importRunTargetState.parse(row.state),
      originalUrl: rendition.original,
      cutoutUrl: rendition.transparent,
      cutout: cutout?.state ?? null,
      describe: describe?.state ?? null,
      ...descriptionJobTiming(describe, descriptionAttempts),
      localAnalysisReady: locallyAnalyzed.has(row.imageId),
      cutoutReason:
        cutout && (cutout.state === "skipped" || cutout.state === "failed")
          ? cutout.lastError
          : null,
      describeReason: describe?.state === "failed" ? describe.lastError : null,
      description: summary?.description ?? null,
      recognizedText: summary?.recognizedText ?? null,
    };
  });
}
