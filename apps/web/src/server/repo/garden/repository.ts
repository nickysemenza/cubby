import type { ActorContext } from "@cubby/schemas/context";
import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
import { parseShortcodeFor, type PlantingId } from "@cubby/schemas/identifiers";
import { and, asc, eq, inArray } from "drizzle-orm";
import { uniq } from "es-toolkit";

import type { Database, DrizzleTransaction } from "~/server/db";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import { entityLink, planting } from "~/server/db/schema";
import { bulkUpdatedWithSideEffects } from "~/server/entity-kernel/adapter";
import { createAppError } from "~/server/errors/app-error";
import { diffUnorderedIdSet, logAuditEntries } from "~/server/repo/audit-log";
import { notDeleted, unwrapDb } from "~/server/repo/database-helpers";
import { liveLinks } from "~/server/repo/entity-links";
import { bulkPatchEntities } from "~/server/repo/entity-patch";
import { deleteByPolicy } from "~/server/repo/removal/dispositions";
import { asActor, defineRepository } from "~/server/repo/repository";
import {
  bindShortcodeResolver,
  resolveLiveShortcode,
} from "~/server/repo/shortcode-resolver";
import { refreshDerivedSearchRefs } from "~/server/services/mutation-side-effects";

import {
  createGardenEntry,
  createPlanting,
  gardenEntryList,
  gardenEntryListRead,
  getGardenEntry,
  getPlanting,
  plantingList,
  plantingListRead,
  updateGardenEntry,
  updatePlanting,
} from ".";

const plantings = bindShortcodeResolver("planting");
const entries = bindShortcodeResolver("gardenEntry");

const PLANTING_DELETE_EDGE_POLICY = {
  "EntityLink[gardenEntryPlanting].to": {
    code: "soft-delete-association",
    effect: "soft-delete",
    description:
      "A garden entry outlives the planting it described; only that association is detached.",
  },
} as const satisfies IncomingEdgePolicy<"planting", OperationDisposition>;

const GARDEN_ENTRY_DELETE_EDGE_POLICY = {
  "EntityAttachment.entityId": {
    code: "soft-delete-association",
    effect: "soft-delete",
    description: "Garden entry image associations are removed with the entry.",
  },
  "EntityLink[gardenEntryPlanting].from": {
    code: "soft-delete-association",
    effect: "soft-delete",
    description:
      "Planting associations are removed with the garden entry; plantings remain.",
  },
} as const satisfies IncomingEdgePolicy<"gardenEntry", OperationDisposition>;

type PlantingBulkPatch = {
  status?: "planned" | "growing" | "finished";
  outcome?: "succeeded" | "failed" | null;
  finishedOn?: string | null;
  locationId?: string | null;
};

const raiseMissingLocation = (): never => {
  throw createAppError(
    "REFERENCED_RECORD_MISSING",
    "The selected location no longer exists.",
  );
};

const updatePlantingsInBulk = (
  db: Database,
  shortcodes: readonly string[],
  data: PlantingBulkPatch,
  actor: ActorContext,
) =>
  bulkPatchEntities(
    db,
    actor,
    {
      entity: "planting",
      table: planting,
      values: async (tx) => ({
        status: data.status,
        outcome: data.outcome,
        finishedOn: data.finishedOn,
        locationId:
          data.locationId == null
            ? data.locationId
            : ((await resolveLiveShortcode(tx, data.locationId, "location")) ??
              raiseMissingLocation()),
      }),
    },
    shortcodes,
    data,
  );

/** Live (entry, planting code) pairs of every entry naming one of `ids`. */
const entryPlantingSets = async (
  db: Database | DrizzleTransaction,
  ids: readonly PlantingId[],
) => {
  const link = entityLink;
  const touched = unwrapDb(db)
    .select({ id: link.fromEntityId })
    .from(link)
    .where(
      and(inArray(link.toEntityId, [...ids]), liveLinks("gardenEntryPlanting")),
    );
  return unwrapDb(db)
    .select({
      gardenEntryId: link.fromEntityId,
      plantingId: link.toEntityId,
      shortcode: planting.shortcode,
    })
    .from(link)
    .innerJoin(planting, eq(planting.id, link.toEntityId))
    .where(
      and(
        inArray(link.fromEntityId, touched),
        liveLinks("gardenEntryPlanting"),
        notDeleted(planting),
      ),
    )
    .orderBy(asc(link.fromEntityId), asc(planting.shortcode));
};

/** Each affected entry's `plantingIds` set loses the deleted plantings. */
const auditEntryPlantingSets = async (
  tx: DrizzleTransaction,
  ids: readonly PlantingId[],
  actor: ActorContext,
) => {
  const removed = new Set<string>(ids);
  const byEntry = new Map<string, { before: string[]; after: string[] }>();
  for (const row of await entryPlantingSets(tx, ids)) {
    const sets = byEntry.get(row.gardenEntryId) ?? { before: [], after: [] };
    const code = parseShortcodeFor("planting", row.shortcode);
    sets.before.push(code);
    if (!removed.has(row.plantingId)) sets.after.push(code);
    byEntry.set(row.gardenEntryId, sets);
  }
  await logAuditEntries(
    tx,
    actor,
    [...byEntry].flatMap(([gardenEntryId, { before, after }]) => {
      const changes = diffUnorderedIdSet(before, after);
      return changes
        ? [
            {
              entityKind: "gardenEntry" as const,
              entityId: gardenEntryId,
              action: "update" as const,
              changes: { plantingIds: changes },
            },
          ]
        : [];
    }),
  );
};

export const plantingRepository = defineRepository("planting", {
  lifecycle: { delete: PLANTING_DELETE_EDGE_POLICY },
  get: async (ctx, shortcode) =>
    getPlanting(ctx.db, await plantings.one(ctx.db, shortcode)),
  list: (ctx, filters, sorts, pagination) =>
    plantingList(ctx.db, filters, pagination, sorts),
  listRead: (ctx, filters, sorts, pagination, projection) =>
    plantingListRead(ctx.db, filters, pagination, sorts, projection),
  create: asActor(createPlanting),
  update: async (ctx, shortcode, data) => {
    const id = await plantings.one(ctx.db, shortcode);
    const { planting: output, detachedImageKeys } = await updatePlanting(
      ctx.db,
      id,
      data,
      ctx.actorContext,
    );
    return { output, entityId: id, detachedImageKeys };
  },
  // The detached entries are read before the delete removes their links.
  delete: async (ctx, shortcodes) => {
    const ids = await plantings.all(ctx.db, shortcodes);
    const affectedEntryIds = uniq(
      (await entryPlantingSets(ctx.db, ids)).map((row) => row.gardenEntryId),
    );
    const result = await deleteByPolicy(ctx.db, {
      entity: "planting",
      policy: PLANTING_DELETE_EDGE_POLICY,
      ids,
      actor: ctx.actorContext,
      beforeDelete: (tx, removed) =>
        auditEntryPlantingSets(tx, removed, ctx.actorContext),
    });
    await refreshDerivedSearchRefs(
      ctx.db,
      affectedEntryIds.map((entityId) => ({
        entityKind: "gardenEntry" as const,
        entityId,
      })),
      "planting.delete.detachGardenEntries",
    );
    return result;
  },
  bulkUpdate: async (ctx, ids, data) =>
    bulkUpdatedWithSideEffects(
      ctx,
      "planting",
      await updatePlantingsInBulk(ctx.db, ids, data, ctx.actorContext),
    ),
});

export const gardenEntryRepository = defineRepository("gardenEntry", {
  lifecycle: { delete: GARDEN_ENTRY_DELETE_EDGE_POLICY },
  get: async (ctx, shortcode) =>
    getGardenEntry(ctx.db, await entries.one(ctx.db, shortcode)),
  list: (ctx, filters, sorts, pagination) =>
    gardenEntryList(ctx.db, filters, pagination, sorts),
  listRead: (ctx, filters, sorts, pagination, projection) =>
    gardenEntryListRead(ctx.db, filters, pagination, sorts, projection),
  create: asActor(createGardenEntry),
  update: async (ctx, shortcode, data) => {
    const id = await entries.one(ctx.db, shortcode);
    return {
      output: await updateGardenEntry(ctx.db, id, data, ctx.actorContext),
      entityId: id,
    };
  },
});
