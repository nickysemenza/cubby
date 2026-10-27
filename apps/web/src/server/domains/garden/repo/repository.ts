import type { ActorContext } from "@cubby/schemas/context";
import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
import { parseShortcodeFor, type PlantingId } from "@cubby/schemas/identifiers";
import { and, asc, eq, inArray } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import { notDeleted, unwrapDb } from "~/server/db/helpers";
import { entityLink, planting } from "~/server/db/schema";
import {
  asActor,
  defineRepository,
} from "~/server/entity-kernel/repo/repository";
import {
  diffUnorderedIdSet,
  logAuditEntries,
} from "~/server/generic/audit-log/repo/audit-log";
import { recordChange } from "~/server/generic/changes/repo/change";
import { liveLinks } from "~/server/generic/entity-links/repo/entity-links";
import { deleteByPolicy } from "~/server/generic/removal/repo/dispositions";
import { bindShortcodeResolver } from "~/server/generic/shortcode/repo/shortcode-resolver";

import {
  createGardenEntry,
  createPlanting,
  gardenEntryScaffold,
  plantingScaffold,
  updateGardenEntry,
  updatePlanting,
} from "./garden";

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
  scaffold: plantingScaffold,
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
  updateRead: async (ctx, shortcode, data, fields) =>
    updatePlanting.read(
      fields,
      ctx.db,
      await plantings.one(ctx.db, shortcode),
      data,
      ctx.actorContext,
    ),
  delete: async (ctx, shortcodes) => {
    const ids = await plantings.all(ctx.db, shortcodes);
    const result = await deleteByPolicy(ctx.db, {
      entity: "planting",
      policy: PLANTING_DELETE_EDGE_POLICY,
      ids,
      actor: ctx.actorContext,
      beforeDelete: (tx, removed) =>
        auditEntryPlantingSets(tx, removed, ctx.actorContext),
    });
    await recordChange(ctx.db, { kind: "source", categories: ["gardenEntry"] });
    return result;
  },
});

export const gardenEntryRepository = defineRepository("gardenEntry", {
  lifecycle: { delete: GARDEN_ENTRY_DELETE_EDGE_POLICY },
  scaffold: gardenEntryScaffold,
  create: asActor(createGardenEntry),
  update: async (ctx, shortcode, data) => {
    const id = await entries.one(ctx.db, shortcode);
    return {
      output: await updateGardenEntry(ctx.db, id, data, ctx.actorContext),
      entityId: id,
    };
  },
  updateRead: async (ctx, shortcode, data, fields) =>
    updateGardenEntry.read(
      fields,
      ctx.db,
      await entries.one(ctx.db, shortcode),
      data,
      ctx.actorContext,
    ),
});
