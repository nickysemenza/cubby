/**
 * Review queue in front of the photo-inventory writer: an agent proposes item
 * groups for a run, a household member edits and approves them on the run
 * page, and approval commits each group through `commitPhotoGroup` with the
 * stored payload. See `packages/schemas/src/photo-import-run.ts` for the wire
 * contract.
 *
 * Invariants:
 *  - every image a `proposed` row mentions is a `pending` target of its run
 *    when saved, and appears in exactly one `proposed` row (attached or
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
  type LocationId,
  type ProductId,
} from "@cubby/schemas/identifiers";
import {
  imageId,
  importRunId,
  importRunShortcode,
  ledgerPartyShortcode,
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
  image,
  imageProcessingJob,
  importRun,
  importRunTarget,
  ledgerParty,
  location,
  photoGroupProposal,
  product,
} from "~/server/db/schema";
import { assertImportRunCapability } from "~/server/purchase-import/capabilities";
import {
  getDb,
  notDeleted,
  withTransactionDatabase,
} from "~/server/repo/database-helpers";
import { loadImageAnalysisSummaries } from "~/server/repo/image-analysis-summary";
import { loadImageRepresentations } from "~/server/repo/image-processing";
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
  ownerPartyId: ledgerPartyShortcode.optional(),
  quantity: z.number().int().positive(),
});

/** A run that does not exist, or that this actor may not review; routes map it to 404. */
export class PhotoRunNotFoundError extends Error {
  constructor(runShortcode: string) {
    super(`Import run ${runShortcode} was not found`);
    this.name = "PhotoRunNotFoundError";
  }
}

/**
 * The browser surface's household-member gate, matching
 * `loadImportRunByShortcode`: the actor must have a live `member` LedgerParty.
 */
export async function assertPhotoRunReviewer(
  db: Database,
  actor: ActorContext,
  runShortcode: string,
): Promise<void> {
  const [member] = await getDb(db)
    .select({ id: ledgerParty.id })
    .from(ledgerParty)
    .where(
      and(
        eq(ledgerParty.userId, actor.userId),
        eq(ledgerParty.kind, "member"),
        notDeleted(ledgerParty),
      ),
    )
    .limit(1);
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
  const [chosen, conflicts, locations] = await Promise.all([
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
              create: storedCreate.parse(row.productCreate),
            },
      committedProduct: row.state === "committed" ? productSummary : null,
      inventory: inventory
        ? {
            locationId: place
              ? parseShortcodeFor("location", place.shortcode)
              : null,
            locationName: place?.name ?? null,
            ownershipMode: inventory.ownershipMode,
            ownerPartyId: inventory.ownerPartyId,
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
        (entry) => entry.state === "pending" && !assigned.has(entry.imageId),
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
};

/** Resolve one group's codes, refusing any image that is not a still-pending target of this run. */
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
    if (entry.state !== "pending")
      throw new Error(
        `Image ${code} is already ${entry.state} in run ${run.shortcode}; only pending images can be proposed`,
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
  if (group.product.kind === "create" && group.product.create.categoryId) {
    await resolveOrThrow(
      db,
      "productCategory",
      group.product.create.categoryId,
    );
  }
  const locationId = group.inventory
    ? await resolveOrThrow(db, "location", group.inventory.locationId)
    : null;
  if (group.inventory?.ownerPartyId) {
    await resolveOrThrow(db, "ledgerParty", group.inventory.ownerPartyId);
  }
  return { group, images, skip, productId, locationId };
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
    productCreate:
      group.product.kind === "create" ? group.product.create : null,
    inventoryLocationId: entry.locationId,
    inventory: group.inventory
      ? {
          quantity: group.inventory.quantity,
          ownershipMode: group.inventory.ownershipMode,
          ownerPartyId: group.inventory.ownerPartyId,
        }
      : null,
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
  if (run.status !== "running") {
    throw new Error(
      `Photo-inventory run ${run.shortcode} is not running (status: ${run.status})`,
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
      create: storedCreate.parse(row.productCreate),
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
      ownerPartyId: stored.ownerPartyId,
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
    inventoryLocationId: row.inventoryLocationId,
    inventory: row.inventory,
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
  const [representations, summaries, jobs] = await Promise.all([
    loadImageRepresentations(db, shortcodes),
    loadImageAnalysisSummaries(db, shortcodes),
    getDb(db)
      .select({
        imageId: imageProcessingJob.imageId,
        kind: imageProcessingJob.kind,
        state: imageProcessingJob.state,
        lastError: imageProcessingJob.lastError,
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
  ]);
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
      cutoutReason:
        cutout && (cutout.state === "skipped" || cutout.state === "failed")
          ? cutout.lastError
          : null,
      description: summary?.description ?? null,
      recognizedText: summary?.recognizedText ?? null,
    };
  });
}
