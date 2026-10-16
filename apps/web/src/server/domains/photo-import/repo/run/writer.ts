/**
 * Bounded, idempotent MCP writer for photo-inventory runs.
 *
 * Turns one caller-defined group of images into one Product (new or
 * existing), attaches the images with a `purpose`, optionally records one
 * inventory entry, and marks the run's `PhotoRunImage` rows. See
 * `packages/schemas/src/photo-import-run.ts` for the wire contract and
 * `.claude/skills/photo-inventory-import/SKILL.md` for the workflow this serves.
 */
import { type ActorContext, actorInRun } from "@cubby/schemas/context";
import {
  runEntityId,
  parseShortcodeFor,
  type ImageId,
  type ImageShortcode,
  type LedgerPartyId,
  type ProductId,
} from "@cubby/schemas/identifiers";
import type { InventoryOwnershipMode } from "@cubby/schemas/inventory-ownership";
import {
  photoRunImageCommitReceipt,
  commitPhotoGroupInput,
  commitPhotoGroupOutput,
  type CommitPhotoGroupInput,
  type CommitPhotoGroupOutput,
} from "@cubby/schemas/photo-import-run";
import { productCreateInput } from "@cubby/schemas/product";
import { and, count, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import {
  getDb,
  notDeleted,
  withTransactionDatabase,
} from "~/server/db/helpers";
import {
  auditLog,
  run as runTable,
  photoRunImage,
  inventoryEntry,
  photoGroupProposal,
  product,
} from "~/server/db/schema";
import { attachExistingImageToEntity } from "~/server/domains/image/repo/image";
import {
  createInventoryEntry,
  updateInventoryEntry,
} from "~/server/domains/inventory/repo/crud";
import { inventoryAmountSql } from "~/server/domains/inventory/repo/helpers";
import { createProductWithSideEffects } from "~/server/domains/product/repo/write/product-orchestration";
import { createProductWriteActions } from "~/server/domains/product/repo/write/product-writes";
import { assertRunCapability } from "~/server/domains/purchase-import/repo/capabilities";
import { loadRunScopeByShortcode } from "~/server/domains/purchase-import/repo/run-service";
import { executeLeasedOperation } from "~/server/domains/run/repo/operation";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { buildCrudServices } from "~/server/http/request-context";

/**
 * Bookkeeping recorded on `PhotoRunImage.commitReceipt` for an attached (or skipped)
 * target. `groupKey` is the replay key: a target is only a legitimate replay
 * of THIS call when its commitReceipt was written by the same group, not merely
 * "already completed" (which could be a different, unrelated commit against
 * the same run).
 */
type RunScope = Awaited<ReturnType<typeof loadRunScopeByShortcode>>;

type LockedTarget = Pick<
  typeof photoRunImage.$inferSelect,
  "id" | "imageId" | "state" | "outcome" | "commitReceipt"
>;

import { effectivePhotoGroupConcern } from "~/server/domains/photo-import/repo/run/photo-group-steps";

type ResolvedAttach = {
  code: ImageShortcode;
  imageId: ImageId;
  purpose: "item" | "label";
};
type ResolvedSkip = {
  code: ImageShortcode;
  imageId: ImageId;
  reason: string;
};

export function assertPhotoGroupReviewIntent(
  input: Pick<CommitPhotoGroupInput, "product" | "review" | "inventory">,
  phase: "draft" | "apply" = "apply",
): void {
  if (!input.review) {
    if (phase === "apply")
      throw new Error(
        "Product writes require explicit photo group review intent",
      );
    return;
  }
  if (
    phase === "apply" &&
    input.review.stockIntent === "receive" &&
    !input.inventory
  )
    throw new Error("A receive decision requires Inventory");
  if (input.review.stockIntent !== "receive" && input.inventory)
    throw new Error("Only a receive decision can change Inventory");
  if (
    input.product.kind !== "existing" &&
    input.review.productChanges &&
    Object.keys(input.review.productChanges).length
  )
    throw new Error("Selected field changes require an existing Product");
}

/**
 * Live Products whose `name` or an `aliases[]` entry exactly (case-insensitive)
 * matches `name`, excluding Products this SAME run already created — a
 * crash-window retry of a `product.create` group must be able to re-enter
 * this preflight without being told its own earlier product collides with
 * the name it is about to reuse.
 */
async function findProductNameConflicts(
  db: Database,
  runId: string,
  name: string,
): Promise<string[]> {
  const nameKey = name.trim().toLowerCase();
  const ownProductIds = new Set(
    (
      await getDb(db)
        .select({ entityId: auditLog.entityId })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.runId, runEntityId.parse(runId)),
            eq(auditLog.entityKind, "product"),
            eq(auditLog.action, "create"),
          ),
        )
    ).map((row) => row.entityId),
  );
  const matches = await getDb(db)
    .select({ id: product.id, shortcode: product.shortcode })
    .from(product)
    .where(
      and(
        notDeleted(product),
        or(
          sql`lower(${product.name}) = ${nameKey}`,
          sql`EXISTS (SELECT 1 FROM unnest(${product.aliases}) AS alias WHERE lower(alias) = ${nameKey})`,
        ),
      ),
    );
  return matches
    .filter((row) => !ownProductIds.has(row.id))
    .map((row) => parseShortcodeFor("product", row.shortcode));
}

/**
 * A target row is a replay of THIS group when it already carries this exact
 * group's terminal state — an attach completed and attributed to this group,
 * or a skip recorded for this group. Anything else (still pending, completed
 * under a different group, or any other state) is not a replay match.
 */
function isReplayMatch(
  isSkip: boolean,
  target: LockedTarget | undefined,
  groupKey: string,
): boolean {
  if (!target) return false;
  const commitReceipt = photoRunImageCommitReceipt.safeParse(
    target.commitReceipt ?? {},
  );
  if (!commitReceipt.success || commitReceipt.data.groupKey !== groupKey)
    return false;
  return isSkip
    ? target.state === "skipped"
    : target.state === "completed" && target.outcome === "attached";
}

/** Resolve every image shortcode to its live `ImageId`, tagged with its role in this call. */
async function resolveAttaches(
  txDb: Database,
  images: CommitPhotoGroupInput["images"],
): Promise<ResolvedAttach[]> {
  return Promise.all(
    images.map(async (image) => ({
      code: image.id,
      imageId: await resolveOrThrow(txDb, "image", image.id),
      purpose: image.purpose,
    })),
  );
}

async function resolveSkips(
  txDb: Database,
  skip: NonNullable<CommitPhotoGroupInput["skip"]>,
): Promise<ResolvedSkip[]> {
  return Promise.all(
    skip.map(async (image) => ({
      code: image.id,
      imageId: await resolveOrThrow(txDb, "image", image.id),
      reason: image.reason,
    })),
  );
}

type LockedTargets = {
  targetByImageId: Map<string, LockedTarget>;
  allReplayed: boolean;
};

/**
 * Lock this group's `PhotoRunImage` rows and classify the group as either a
 * full replay of a prior commit under the same `groupKey`, or fresh review work
 * (targets `pending`, or `unresolved` on a run stopped for review). Any other
 * mix — partial completion, or a target already completed under a DIFFERENT
 * `groupKey` — is refused: it
 * means the caller's image roster doesn't match this run's actual state.
 */
async function lockTargets(
  txDb: Database,
  scope: RunScope,
  attaches: ResolvedAttach[],
  skips: ResolvedSkip[],
  groupKey: string,
  runStatus: string,
): Promise<LockedTargets> {
  const imageIds = [...attaches, ...skips].map((entry) => entry.imageId);
  const lockedTargets: LockedTarget[] = await getDb(txDb)
    .select({
      id: photoRunImage.id,
      imageId: photoRunImage.imageId,
      state: photoRunImage.state,
      outcome: photoRunImage.outcome,
      commitReceipt: photoRunImage.commitReceipt,
    })
    .from(photoRunImage)
    .where(
      and(
        eq(photoRunImage.runId, scope.public.runId),
        inArray(photoRunImage.imageId, imageIds),
      ),
    )
    .for("update");
  if (lockedTargets.length !== imageIds.length) {
    throw new Error(
      "Every image must be a live target of this photo-inventory run",
    );
  }
  const targetByImageId = new Map(
    lockedTargets.map((target) => [target.imageId, target]),
  );

  const allReplayed =
    attaches.every((entry) =>
      isReplayMatch(false, targetByImageId.get(entry.imageId), groupKey),
    ) &&
    skips.every((entry) =>
      isReplayMatch(true, targetByImageId.get(entry.imageId), groupKey),
    );
  const allReviewable = [...attaches, ...skips].every((entry) => {
    const state = targetByImageId.get(entry.imageId)?.state;
    return (
      state === "pending" ||
      (runStatus === "needs_review" && state === "unresolved")
    );
  });
  if (!allReplayed && !allReviewable) {
    throw new Error(
      "This group's images have conflicting target states; some were already settled or belong to a different group",
    );
  }
  return { targetByImageId, allReplayed };
}

/** Reconstruct a prior commit's result from the already-completed target rows — no writes. */
function buildReplayOutput(
  scope: RunScope,
  input: CommitPhotoGroupInput,
  attaches: ResolvedAttach[],
  skips: ResolvedSkip[],
  targetByImageId: Map<string, LockedTarget>,
): CommitPhotoGroupOutput {
  let productShortcodeStr: string | undefined;
  let inventoryShortcodeStr: string | undefined;
  for (const entry of [...attaches, ...skips]) {
    const commitReceipt = photoRunImageCommitReceipt.safeParse(
      targetByImageId.get(entry.imageId)?.commitReceipt ?? {},
    );
    if (commitReceipt.success) {
      productShortcodeStr ??= commitReceipt.data.productId;
      inventoryShortcodeStr ??= commitReceipt.data.inventoryId;
    }
  }
  return commitPhotoGroupOutput.parse({
    runId: scope.public.shortcode,
    groupKey: input.groupKey,
    outcome: "replayed",
    productId: productShortcodeStr,
    inventoryId: inventoryShortcodeStr,
    images: [...attaches, ...skips].map((entry) => ({
      id: entry.code,
      state: targetByImageId.get(entry.imageId)!.state,
    })),
    runStatus: scope.public.status,
  });
}

/** Resolve the group's target Product — an existing one by id, or a brand-new one. */
async function resolveProduct(
  txDb: Database,
  input: CommitPhotoGroupInput,
  actor: ActorContext,
): Promise<string> {
  if (input.product.kind === "existing") {
    const id = await resolveOrThrow(txDb, "product", input.product.existingId);
    if (
      input.review?.productChanges &&
      Object.keys(input.review.productChanges).length
    ) {
      // This bounded patch excludes image/object fields: updateProduct cannot
      // delete stored objects while this transaction remains open.
      const crud = buildCrudServices(txDb);
      await createProductWriteActions(txDb, crud.usdaClient).updateProduct(
        id,
        input.review.productChanges,
        actor,
      );
    }
    return input.product.existingId;
  }
  const crud = buildCrudServices(txDb);
  const created = await createProductWithSideEffects(
    {
      db: txDb,
      product: createProductWriteActions(txDb, crud.usdaClient),
      recipeCosting: crud.services.recipeCosting,
      upcLookupClient: crud.upcLookupClient,
    },
    productCreateInput.parse({
      name: input.product.create.name,
      categoryId: input.product.create.categoryId ?? null,
      manufacturer: input.product.create.manufacturer,
      model: input.product.create.model ?? null,
      notes: input.product.create.notes ?? null,
      tags: input.product.create.tags ?? [],
    }),
    actor,
  );
  return created.id;
}

/**
 * Create the group's optional shared Inventory entry. A fully omitted
 * ownership selection defaults to `explicit` ownership under the run's own
 * member, but `explicit` without the `ownerPartyId` key is refused rather than
 * silently guessing who owns it; a null owner is household stock (see
 * `commitPhotoGroupInventory`).
 */
async function receiveInventory(
  txDb: Database,
  scope: RunScope,
  input: CommitPhotoGroupInput,
  productId: ProductId,
  actor: ActorContext,
): Promise<string | undefined> {
  if (!input.inventory) return undefined;
  const locationId = await resolveOrThrow(
    txDb,
    "location",
    input.inventory.locationId,
  );
  const requestedMode = input.inventory.ownershipMode;
  const requestedOwner = input.inventory.ownerPartyId;
  let ownershipMode: InventoryOwnershipMode;
  let ownerLedgerPartyId: LedgerPartyId | null;
  if (requestedMode === undefined && requestedOwner === undefined) {
    ownershipMode = "explicit";
    ownerLedgerPartyId = scope.ledgerPartyId;
  } else if (requestedMode === undefined || requestedMode === "explicit") {
    if (requestedOwner === undefined) {
      throw new Error(
        "Explicit ownership requires ownerPartyId (null for household stock); omit ownershipMode and ownerPartyId together to default to the run's own member",
      );
    }
    ownershipMode = "explicit";
    ownerLedgerPartyId =
      requestedOwner === null
        ? null
        : await resolveOrThrow(txDb, "ledgerParty", requestedOwner);
  } else {
    ownershipMode = requestedMode;
    ownerLedgerPartyId = null;
  }
  const targetEntryId = input.inventory.existingEntryId;
  if (input.inventory.mode === "add" && !targetEntryId)
    throw new Error("Adding Inventory requires an explicit existing entry");
  if (input.inventory.mode !== "add" && targetEntryId)
    throw new Error("An existing Inventory entry requires add mode");
  const targetId = targetEntryId
    ? await resolveOrThrow(txDb, "inventory", targetEntryId)
    : null;
  const [before] = targetId
    ? await getDb(txDb)
        .select({
          productId: inventoryEntry.productId,
          locationId: inventoryEntry.locationId,
          placement: inventoryEntry.placement,
          ownershipMode: inventoryEntry.ownershipMode,
          ownerLedgerPartyId: inventoryEntry.ownerLedgerPartyId,
          amount: inventoryAmountSql,
        })
        .from(inventoryEntry)
        .where(and(eq(inventoryEntry.id, targetId), notDeleted(inventoryEntry)))
        .for("update")
    : [];
  if (
    targetId &&
    (!before ||
      before.productId !== productId ||
      before.locationId !== locationId ||
      before.placement !== "stock" ||
      before.ownershipMode !== ownershipMode ||
      before.ownerLedgerPartyId !== ownerLedgerPartyId)
  )
    throw new Error(
      "Existing Inventory entry no longer matches the Product, location, placement, or owner",
    );
  if (
    before &&
    (before.amount?.unit !== "each" || !Number.isFinite(before.amount.value))
  )
    throw new Error("Existing Inventory entry must have a numeric each count");
  const entry =
    targetId && before
      ? await updateInventoryEntry(
          txDb,
          targetId,
          {
            amount: {
              value: before.amount!.value + input.inventory.quantity,
              unit: "each",
            },
          },
          actor,
        )
      : await createInventoryEntry(
          txDb,
          {
            productId,
            locationId,
            amount: { value: input.inventory.quantity, unit: "each" },
            ownershipMode,
            ownerLedgerPartyId,
          },
          actor,
        );
  return entry.id;
}

/** Attach every non-skipped image to the resolved Product's gallery. */
async function attachImages(
  txDb: Database,
  attaches: ResolvedAttach[],
  productShortcodeStr: string,
  actor: ActorContext,
): Promise<void> {
  for (const entry of attaches) {
    await attachExistingImageToEntity(
      txDb,
      {
        imageId: entry.code,
        targetId: productShortcodeStr,
        purpose: entry.purpose,
      },
      actor,
    );
  }
}

/** Mark each target row completed (attach) or skipped; the PhotoRunImage row is the record. */
async function markTargets(
  txDb: Database,
  groupKey: string,
  attaches: ResolvedAttach[],
  skips: ResolvedSkip[],
  targetByImageId: Map<string, LockedTarget>,
  productShortcodeStr: string | undefined,
  inventoryShortcodeStr: string | undefined,
  now: Date,
): Promise<{ id: string; state: string }[]> {
  // Built as plain strings; `commitPhotoGroupOutput.parse` in `doCommit`
  // re-validates and brands every id on the single return path.
  const images: { id: string; state: string }[] = [];
  for (const entry of attaches) {
    const target = targetByImageId.get(entry.imageId)!;
    if (!productShortcodeStr) {
      throw new Error("An attached image needs a resolved Product");
    }
    const commitReceipt = photoRunImageCommitReceipt.parse({
      groupKey,
      productId: productShortcodeStr,
      purpose: entry.purpose,
      inventoryId: inventoryShortcodeStr,
    });
    await getDb(txDb)
      .update(photoRunImage)
      .set({
        state: "completed",
        outcome: "attached",
        commitReceipt,
        skipReason: null,
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(photoRunImage.id, target.id));
    images.push({ id: entry.code, state: "completed" });
  }
  for (const entry of skips) {
    const target = targetByImageId.get(entry.imageId)!;
    await getDb(txDb)
      .update(photoRunImage)
      .set({
        state: "skipped",
        outcome: "skipped",
        skipReason: entry.reason,
        commitReceipt: { groupKey },
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(photoRunImage.id, target.id));
    images.push({ id: entry.code, state: "skipped" });
  }
  return images;
}

/** Bump counters and complete only after every reviewable photo is settled. */
async function completeRunIfDone(
  txDb: Database,
  scope: RunScope,
  importedDelta: number,
  skippedDelta: number,
  now: Date,
): Promise<boolean> {
  const [pendingRow] = await getDb(txDb)
    .select({ pending: count() })
    .from(photoRunImage)
    .where(
      and(
        eq(photoRunImage.runId, scope.public.runId),
        inArray(photoRunImage.state, ["pending", "unresolved"]),
      ),
    );
  const runCompletes = (pendingRow?.pending ?? 0) === 0;

  // Two full `.set()` calls rather than one conditionally-built object: the
  // counter bump columns need `sql` increments, whose type only unifies with
  // drizzle's `.set()` overload inline, not through a separately typed
  // intermediate record.
  if (runCompletes) {
    await getDb(txDb)
      .update(runTable)
      .set({
        imported: sql`${runTable.imported} + ${importedDelta}`,
        skipped: sql`${runTable.skipped} + ${skippedDelta}`,
        updatedAt: now,
        status: "completed",
        endedAt: now,
      })
      .where(eq(runTable.id, scope.public.runId));
  } else {
    await getDb(txDb)
      .update(runTable)
      .set({
        imported: sql`${runTable.imported} + ${importedDelta}`,
        skipped: sql`${runTable.skipped} + ${skippedDelta}`,
        updatedAt: now,
      })
      .where(eq(runTable.id, scope.public.runId));
  }

  return runCompletes;
}

async function doCommit(
  txDb: Database,
  scope: RunScope,
  input: CommitPhotoGroupInput,
  actor: ActorContext,
  proposalRevision?: Pick<
    typeof photoGroupProposal.$inferSelect,
    "id" | "updatedAt"
  >,
): Promise<CommitPhotoGroupOutput> {
  const attaches = await resolveAttaches(txDb, input.images);
  const skips = await resolveSkips(txDb, input.skip ?? []);

  // Run row first, then targets: `proposePhotoGroups` takes the same run lock
  // before it validates that proposed images are still reviewable, so a proposal
  // save cannot interleave with a commit. Every writer locks in this order
  // (and `completeRunIfDone` only re-touches the row already held), so no
  // run/target lock cycle exists.
  const [lockedRun] = await getDb(txDb)
    .select({ status: runTable.status })
    .from(runTable)
    .where(eq(runTable.id, scope.public.runId))
    .for("update");
  const runStatus = lockedRun?.status ?? scope.public.status;

  if (proposalRevision) {
    const [current] = await getDb(txDb)
      .select({
        updatedAt: photoGroupProposal.updatedAt,
        state: photoGroupProposal.state,
      })
      .from(photoGroupProposal)
      .where(
        and(
          eq(photoGroupProposal.id, proposalRevision.id),
          eq(photoGroupProposal.runId, scope.public.runId),
          eq(photoGroupProposal.groupKey, input.groupKey),
        ),
      );
    if (
      !current ||
      current.state !== "proposed" ||
      current.updatedAt.getTime() !== proposalRevision.updatedAt.getTime()
    )
      throw new Error(
        "Photo group review changed; reload before approving this group",
      );
  }

  const { targetByImageId, allReplayed } = await lockTargets(
    txDb,
    scope,
    attaches,
    skips,
    input.groupKey,
    runStatus,
  );
  if (allReplayed) {
    return buildReplayOutput(scope, input, attaches, skips, targetByImageId);
  }

  // A photo run stopped for review can still accept the human's decision on
  // its unresolved targets. Other terminal states permit only exact replay.
  if (runStatus !== "running" && runStatus !== "needs_review") {
    throw new Error(
      `Photo-inventory run ${scope.public.shortcode} is not open for review (status: ${runStatus})`,
    );
  }
  // A `failed` ledger row may take over with a changed payload, but "failed"
  // can also mean this transaction committed and only the ledger's completion
  // write failed. Targets carrying this groupKey prove the earlier commit
  // landed; running fresh work under the same key would duplicate it.
  const [alreadyCommitted] = await getDb(txDb)
    .select({ id: photoRunImage.id })
    .from(photoRunImage)
    .where(
      and(
        eq(photoRunImage.runId, scope.public.runId),
        sql`${photoRunImage.commitReceipt}->>'groupKey' = ${input.groupKey}`,
      ),
    )
    .limit(1);
  if (alreadyCommitted) {
    throw new Error(
      `Group ${input.groupKey} was already committed to run ${scope.public.shortcode} with a different image roster; use a new groupKey`,
    );
  }

  // A skip-only group (e.g. a discarded proposal) touches no Product: it must
  // not mint a `create` Product nobody will ever see.
  let productShortcodeStr: string | undefined;
  let inventoryShortcodeStr: string | undefined;
  if (groupTouchesProduct(input)) {
    productShortcodeStr = await resolveProduct(txDb, input, actor);
    const productId = await resolveOrThrow(
      txDb,
      "product",
      productShortcodeStr,
    );
    inventoryShortcodeStr = await receiveInventory(
      txDb,
      scope,
      input,
      productId,
      actor,
    );
    await attachImages(txDb, attaches, productShortcodeStr, actor);
  }
  const now = new Date();
  const images = await markTargets(
    txDb,
    input.groupKey,
    attaches,
    skips,
    targetByImageId,
    productShortcodeStr,
    inventoryShortcodeStr,
    now,
  );
  const runCompletes = await completeRunIfDone(
    txDb,
    scope,
    attaches.length > 0 ? 1 : 0,
    skips.length,
    now,
  );

  return commitPhotoGroupOutput.parse({
    runId: scope.public.shortcode,
    groupKey: input.groupKey,
    outcome: "committed",
    productId: productShortcodeStr,
    inventoryId: inventoryShortcodeStr,
    images,
    runStatus: runCompletes ? "completed" : runStatus,
  });
}

const groupTouchesProduct = (input: CommitPhotoGroupInput): boolean =>
  input.images.length > 0 || input.inventory !== undefined;

export async function commitPhotoGroup(
  db: Database,
  rawInput: z.input<typeof commitPhotoGroupInput>,
  actor: ActorContext,
  proposalRevision?: Pick<
    typeof photoGroupProposal.$inferSelect,
    "id" | "updatedAt"
  >,
  settle?: (txDb: Database, result: CommitPhotoGroupOutput) => Promise<void>,
): Promise<CommitPhotoGroupOutput> {
  const input = commitPhotoGroupInput.parse(rawInput);
  if (groupTouchesProduct(input)) assertPhotoGroupReviewIntent(input);
  const concern = effectivePhotoGroupConcern(input.review?.unresolvedReason);
  if (groupTouchesProduct(input) && concern) throw new Error(concern);
  const scope = await loadRunScopeByShortcode(db, input.runId);
  assertRunCapability(scope.public.purpose, "photo_commit");
  // NOT gated on `status === "running"` here: a crash-window retry (see
  // `executeLeasedOperation`) can legitimately arrive after the SAME commit
  // already flipped the run to `completed`, and must still resolve as a
  // replay. `doCommit` enforces "running" only for genuinely new work.

  // Preflight BEFORE any operation row: a name/alias collision on a NEW
  // Product is reported as data, with zero writes, and never touches the
  // replay ledger — routing it through `executeLeasedOperation` would either
  // replay the conflict forever (if reported under this operation id) or
  // reject a corrected payload sent under the same groupKey.
  if (input.product.kind === "create" && groupTouchesProduct(input)) {
    const conflicts = await findProductNameConflicts(
      db,
      scope.public.runId,
      input.product.create.name,
    );
    if (conflicts.length > 0) {
      return commitPhotoGroupOutput.parse({
        runId: scope.public.shortcode,
        groupKey: input.groupKey,
        outcome: "conflict",
        images: [],
        conflict: { existingProductIds: conflicts },
        runStatus: scope.public.status,
      });
    }
  }

  return executeLeasedOperation(
    db,
    {
      runId: scope.public.runId,
      operationId: `photo-group:${input.groupKey}`,
      kind: "commit_photo_group",
      payload: input,
      // The whole commit is one transaction, so a failed attempt left no
      // partial writes: a corrected payload (e.g. an edited proposal) under
      // the same groupKey may run instead of being refused forever.
      retryFailedWithChangedInput: true,
    },
    () =>
      withTransactionDatabase(db, async (transactionDb) => {
        const result = await doCommit(
          transactionDb,
          scope,
          input,
          actorInRun(actor, runEntityId.parse(scope.public.runId)),
          proposalRevision,
        );
        await settle?.(transactionDb, result);
        return result;
      }),
  );
}
