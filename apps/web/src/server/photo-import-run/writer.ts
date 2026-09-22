/**
 * Bounded, idempotent MCP writer for photo-inventory runs.
 *
 * Turns one caller-defined group of images into one Product (new or
 * existing), attaches the images with a `purpose`, optionally records one
 * inventory entry, and marks the run's `ImportRunTarget` rows. See
 * `packages/schemas/src/photo-import-run.ts` for the wire contract and
 * `.claude/skills/photo-inventory-import/SKILL.md` for the workflow this serves.
 */
import { auditEntitySchema } from "@cubby/schemas/audit";
import type { ActorContext } from "@cubby/schemas/context";
import {
  parseShortcodeFor,
  type ImageId,
  type ImageShortcode,
  type InventoryId,
  type LedgerPartyId,
  type ProductId,
} from "@cubby/schemas/identifiers";
import { productImagePurpose } from "@cubby/schemas/image";
import type { InventoryOwnershipMode } from "@cubby/schemas/inventory-ownership";
import {
  commitPhotoGroupInput,
  commitPhotoGroupOutput,
  type CommitPhotoGroupInput,
  type CommitPhotoGroupOutput,
} from "@cubby/schemas/photo-import-run";
import { productCreateInput } from "@cubby/schemas/product";
import { and, count, desc, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import {
  auditLog,
  importRun,
  importRunMutation,
  importRunTarget,
  product,
} from "~/server/db/schema";
import { assertImportRunCapability } from "~/server/purchase-import/capabilities";
import {
  loadRunScopeByShortcode,
  runImportOperation,
} from "~/server/purchase-import/run-service";
import {
  getDb,
  notDeleted,
  withTransactionDatabase,
} from "~/server/repo/database-helpers";
import { attachExistingImageToEntity } from "~/server/repo/image";
import { createInventoryEntry } from "~/server/repo/inventory/crud";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { buildCrudServices } from "~/server/request-context";
import { createProductWithSideEffects } from "~/server/services/product-orchestration.service";
import { createProductWriteActions } from "~/server/services/product.service";

const sha256 = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

/**
 * Bookkeeping recorded on `ImportRunTarget.diff` for an attached (or skipped)
 * target. `groupKey` is the replay key: a target is only a legitimate replay
 * of THIS call when its diff was written by the same group, not merely
 * "already completed" (which could be a different, unrelated commit against
 * the same run).
 */
const attachedTargetDiff = z
  .object({
    groupKey: z.string(),
    productId: z.string(),
    purpose: productImagePurpose,
    inventoryId: z.string(),
  })
  .partial();

type RunScope = Awaited<ReturnType<typeof loadRunScopeByShortcode>>;

type LockedTarget = {
  id: string;
  imageId: ImageId | null;
  state: string;
  outcome: string | null;
  diff: unknown;
};

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

/** The `diff` recorded on an attached target row — the write-side counterpart of `attachedTargetDiff`. */
type AttachedDiff = {
  groupKey: string;
  productId: string;
  purpose: "item" | "label";
  inventoryId?: string;
};

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
        .select({ targetId: importRunMutation.targetId })
        .from(importRunMutation)
        .where(
          and(
            eq(importRunMutation.runId, runId),
            eq(importRunMutation.targetType, "product"),
          ),
        )
    ).map((row) => row.targetId),
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

/** Best-effort link from an `ImportRunMutation` row to the audit trail that carries the actor. */
async function latestAuditLogId(
  db: Database,
  entityType: string,
  entityId: string,
): Promise<string | null> {
  const parsedType = auditEntitySchema.safeParse(entityType);
  if (!parsedType.success) return null;
  const [row] = await getDb(db)
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entityType, parsedType.data),
        eq(auditLog.entityId, entityId),
      ),
    )
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(1);
  return row?.id ?? null;
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
  const diff = attachedTargetDiff.safeParse(target.diff ?? {});
  if (!diff.success || diff.data.groupKey !== groupKey) return false;
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
  targetByImageId: Map<ImageId | null, LockedTarget>;
  allReplayed: boolean;
};

/**
 * Lock this group's `ImportRunTarget` rows and classify the group as either a
 * full replay of a prior commit under the same `groupKey`, or fresh work
 * (every target still `pending`). Any other mix — partial completion, or a
 * target already completed under a DIFFERENT `groupKey` — is refused: it
 * means the caller's image roster doesn't match this run's actual state.
 */
async function lockTargets(
  txDb: Database,
  scope: RunScope,
  attaches: ResolvedAttach[],
  skips: ResolvedSkip[],
  groupKey: string,
): Promise<LockedTargets> {
  const imageIds = [...attaches, ...skips].map((entry) => entry.imageId);
  const lockedTargets: LockedTarget[] = await getDb(txDb)
    .select({
      id: importRunTarget.id,
      imageId: importRunTarget.imageId,
      state: importRunTarget.state,
      outcome: importRunTarget.outcome,
      diff: importRunTarget.diff,
    })
    .from(importRunTarget)
    .where(
      and(
        eq(importRunTarget.runId, scope.public.runId),
        inArray(importRunTarget.imageId, imageIds),
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
  const allPending = [...attaches, ...skips].every(
    (entry) => targetByImageId.get(entry.imageId)?.state === "pending",
  );
  if (!allReplayed && !allPending) {
    throw new Error(
      "This group's images are in an inconsistent target state — part of the group was already completed (possibly under a different groupKey) while the rest is still pending",
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
  targetByImageId: Map<ImageId | null, LockedTarget>,
): CommitPhotoGroupOutput {
  let productShortcodeStr: string | undefined;
  let inventoryShortcodeStr: string | undefined;
  for (const entry of [...attaches, ...skips]) {
    const diff = attachedTargetDiff.safeParse(
      targetByImageId.get(entry.imageId)?.diff ?? {},
    );
    if (diff.success) {
      productShortcodeStr ??= diff.data.productId;
      inventoryShortcodeStr ??= diff.data.inventoryId;
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
  scope: RunScope,
  input: CommitPhotoGroupInput,
  actor: ActorContext,
): Promise<string> {
  if (input.product.kind === "existing") {
    await resolveOrThrow(txDb, "product", input.product.existingId);
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
  const productShortcodeStr = created.id;
  const productEntityId = await resolveOrThrow(
    txDb,
    "product",
    productShortcodeStr,
  );
  await getDb(txDb)
    .insert(importRunMutation)
    .values({
      runId: scope.public.runId,
      targetType: "product",
      targetId: productEntityId,
      mutationKind: "create",
      fields: ["name", "categoryId", "manufacturer", "model", "notes", "tags"],
      postFingerprint: await sha256(
        JSON.stringify({ groupKey: input.groupKey, product: input.product }),
      ),
      auditLogId: await latestAuditLogId(txDb, "product", productEntityId),
    });
  return productShortcodeStr;
}

/**
 * Create the group's optional shared Inventory entry. A fully omitted
 * ownership selection defaults to `person` ownership under the run's own
 * member, but an explicit `person` mode without `ownerPartyId` is refused
 * rather than silently guessing who owns it (see `commitPhotoGroupInventory`).
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
    ownershipMode = "person";
    ownerLedgerPartyId = scope.ledgerPartyId;
  } else if (requestedMode === undefined || requestedMode === "person") {
    if (!requestedOwner) {
      throw new Error(
        "Person ownership requires an explicit ownerPartyId; omit ownershipMode and ownerPartyId together to default to the run's own member",
      );
    }
    ownershipMode = "person";
    ownerLedgerPartyId = await resolveOrThrow(
      txDb,
      "ledgerParty",
      requestedOwner,
    );
  } else {
    ownershipMode = requestedMode;
    ownerLedgerPartyId = null;
  }
  const entry = await createInventoryEntry(
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
  const inventoryShortcodeStr = entry.id;
  const inventoryEntityId: InventoryId = await resolveOrThrow(
    txDb,
    "inventory",
    inventoryShortcodeStr,
  );
  await getDb(txDb)
    .insert(importRunMutation)
    .values({
      runId: scope.public.runId,
      targetType: "inventory",
      targetId: inventoryEntityId,
      mutationKind: "create",
      fields: ["amount", "ownershipMode", "ownerLedgerPartyId"],
      postFingerprint: await sha256(
        JSON.stringify({
          groupKey: input.groupKey,
          inventory: input.inventory,
        }),
      ),
      auditLogId: await latestAuditLogId(txDb, "inventory", inventoryEntityId),
    });
  return inventoryShortcodeStr;
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

/** Mark each target row completed (attach) or skipped, with a matching `ImportRunMutation` row. */
async function markTargets(
  txDb: Database,
  scope: RunScope,
  groupKey: string,
  attaches: ResolvedAttach[],
  skips: ResolvedSkip[],
  targetByImageId: Map<ImageId | null, LockedTarget>,
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
    const diff: AttachedDiff = {
      groupKey,
      productId: productShortcodeStr,
      purpose: entry.purpose,
    };
    if (inventoryShortcodeStr) {
      diff.inventoryId = inventoryShortcodeStr;
    }
    await getDb(txDb)
      .update(importRunTarget)
      .set({
        state: "completed",
        outcome: "attached",
        diff,
        warning: null,
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(importRunTarget.id, target.id));
    await getDb(txDb)
      .insert(importRunMutation)
      .values({
        runId: scope.public.runId,
        targetType: "image",
        targetId: entry.imageId,
        mutationKind: "attach",
        fields: ["purpose"],
        postFingerprint: await sha256(
          JSON.stringify({
            groupKey,
            imageId: entry.code,
            purpose: entry.purpose,
          }),
        ),
      });
    images.push({ id: entry.code, state: "completed" });
  }
  for (const entry of skips) {
    const target = targetByImageId.get(entry.imageId)!;
    await getDb(txDb)
      .update(importRunTarget)
      .set({
        state: "skipped",
        outcome: "skipped",
        warning: entry.reason,
        diff: { groupKey },
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(importRunTarget.id, target.id));
    await getDb(txDb)
      .insert(importRunMutation)
      .values({
        runId: scope.public.runId,
        targetType: "image",
        targetId: entry.imageId,
        mutationKind: "skip",
        fields: ["warning"],
        postFingerprint: await sha256(
          JSON.stringify({
            groupKey,
            imageId: entry.code,
            reason: entry.reason,
          }),
        ),
      });
    images.push({ id: entry.code, state: "skipped" });
  }
  return images;
}

/** Bump the run's counters and, once no `pending` target remains, complete the run. */
async function completeRunIfDone(
  txDb: Database,
  scope: RunScope,
  importedDelta: number,
  skippedDelta: number,
  now: Date,
): Promise<boolean> {
  const [pendingRow] = await getDb(txDb)
    .select({ pending: count() })
    .from(importRunTarget)
    .where(
      and(
        eq(importRunTarget.runId, scope.public.runId),
        eq(importRunTarget.state, "pending"),
      ),
    );
  const runCompletes = (pendingRow?.pending ?? 0) === 0;

  // Two full `.set()` calls rather than one conditionally-built object: the
  // counter bump columns need `sql` increments, whose type only unifies with
  // drizzle's `.set()` overload inline, not through a separately typed
  // intermediate record.
  if (runCompletes) {
    await getDb(txDb)
      .update(importRun)
      .set({
        imported: sql`${importRun.imported} + ${importedDelta}`,
        skipped: sql`${importRun.skipped} + ${skippedDelta}`,
        updatedAt: now,
        status: "completed",
        endedAt: now,
      })
      .where(eq(importRun.id, scope.public.runId));
  } else {
    await getDb(txDb)
      .update(importRun)
      .set({
        imported: sql`${importRun.imported} + ${importedDelta}`,
        skipped: sql`${importRun.skipped} + ${skippedDelta}`,
        updatedAt: now,
      })
      .where(eq(importRun.id, scope.public.runId));
  }

  return runCompletes;
}

async function doCommit(
  txDb: Database,
  scope: RunScope,
  input: CommitPhotoGroupInput,
  actor: ActorContext,
): Promise<CommitPhotoGroupOutput> {
  const attaches = await resolveAttaches(txDb, input.images);
  const skips = await resolveSkips(txDb, input.skip ?? []);

  // Run row first, then targets: `proposePhotoGroups` takes the same run lock
  // before it validates that proposed images are still pending, so a proposal
  // save cannot interleave with a commit. Every writer locks in this order
  // (and `completeRunIfDone` only re-touches the row already held), so no
  // run/target lock cycle exists.
  const [lockedRun] = await getDb(txDb)
    .select({ status: importRun.status })
    .from(importRun)
    .where(eq(importRun.id, scope.public.runId))
    .for("update");
  const runStatus = lockedRun?.status ?? scope.public.status;

  const { targetByImageId, allReplayed } = await lockTargets(
    txDb,
    scope,
    attaches,
    skips,
    input.groupKey,
  );
  if (allReplayed) {
    return buildReplayOutput(scope, input, attaches, skips, targetByImageId);
  }

  // Fresh work: every target is `pending`. A dead run may still legitimately
  // replay (above), but never starts new work.
  if (runStatus !== "running") {
    throw new Error(
      `Photo-inventory run ${scope.public.shortcode} is not running (status: ${runStatus})`,
    );
  }
  // A `failed` ledger row may take over with a changed payload, but "failed"
  // can also mean this transaction committed and only the ledger's completion
  // write failed. Targets carrying this groupKey prove the earlier commit
  // landed; running fresh work under the same key would duplicate it.
  const [alreadyCommitted] = await getDb(txDb)
    .select({ id: importRunTarget.id })
    .from(importRunTarget)
    .where(
      and(
        eq(importRunTarget.runId, scope.public.runId),
        sql`${importRunTarget.diff}->>'groupKey' = ${input.groupKey}`,
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
    productShortcodeStr = await resolveProduct(txDb, scope, input, actor);
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
    scope,
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
): Promise<CommitPhotoGroupOutput> {
  const input = commitPhotoGroupInput.parse(rawInput);
  const scope = await loadRunScopeByShortcode(db, input.runId);
  assertImportRunCapability(scope.public.purpose, "photo_commit");
  // NOT gated on `status === "running"` here: a crash-window retry (see
  // `runImportOperation`) can legitimately arrive after the SAME commit
  // already flipped the run to `completed`, and must still resolve as a
  // replay. `doCommit` enforces "running" only for genuinely new work.

  // Preflight BEFORE any operation row: a name/alias collision on a NEW
  // Product is reported as data, with zero writes, and never touches the
  // replay ledger — routing it through `runImportOperation` would either
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

  return runImportOperation(
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
      withTransactionDatabase(db, (transactionDb) =>
        doCommit(transactionDb, scope, input, actor),
      ),
  );
}
