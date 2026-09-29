import { entityMutationReferences } from "~/server/entity-kernel/adapter";
import { createAppError } from "~/server/errors/app-error";
import { withTransactionDatabase } from "~/server/repo/database-helpers";
import { defineRepository, onDb } from "~/server/repo/repository";
import { bindShortcodeResolver } from "~/server/repo/shortcode-resolver";
import {
  mutationEvents,
  runMutationSideEffects,
  runMutationSideEffectsForEntities,
} from "~/server/services/mutation-side-effects";

import {
  createLocation,
  deleteLocations,
  getLocationById,
  LOCATION_DELETE_EDGE_POLICY,
  locationList,
  updateLocation,
  updateLocationAiDescription,
} from "./crud";
import { getLocationByShortcode } from "./lookup";
import { reparentLocationsInBulk } from "./reparent";

const locationShortcodes = bindShortcodeResolver("location");

/**
 * `sideEffects: false`: a location write dispatches its own events, which
 * carry whether its images changed (the vision description depends on it).
 */
export const locationRepository = defineRepository("location", {
  sideEffects: false,
  lifecycle: { delete: LOCATION_DELETE_EDGE_POLICY },
  get: onDb(getLocationByShortcode),
  list: (ctx, filters, sorts, pagination, groupBy) =>
    locationList(ctx.db, filters, sorts, pagination, groupBy),
  create: async (ctx, data) => {
    const output = await createLocation(ctx.db, data, ctx.actorContext);
    const entityId = await locationShortcodes.one(ctx.db, output.id);
    await runMutationSideEffects(ctx.db, {
      action: "created",
      entity: { entity: "location", id: entityId },
      source: "location.create",
      locationImagesChanged: (data.pendingImageIds?.length ?? 0) > 0,
    });
    return { output, entityId };
  },
  update: async (ctx, shortcode, data) => {
    const entityId = await locationShortcodes.one(ctx.db, shortcode);
    const imagesChanged =
      (data.pendingImageIds?.length ?? 0) > 0 ||
      (data.removeImageIds?.length ?? 0) > 0;
    // The description a removed last image leaves behind is cleared in the
    // update's transaction; the vision refresh and embedding tasks publish
    // only after its commit, so none of them reads the pre-update row.
    return withTransactionDatabase(ctx.db, async (transactionDb) => {
      const { location: updated, detachedImageKeys } = await updateLocation(
        transactionDb,
        entityId,
        data,
        ctx.actorContext,
      );
      if (imagesChanged && updated.images.length === 0)
        await updateLocationAiDescription(transactionDb, entityId, null);
      await runMutationSideEffects(transactionDb, {
        action: "updated",
        entity: { entity: "location", id: entityId },
        source: "location.update",
        locationImagesChanged: imagesChanged,
      });
      return {
        output: imagesChanged
          ? await getLocationById(transactionDb, entityId)
          : updated,
        entityId,
        detachedImageKeys,
      };
    });
  },
  delete: async (ctx, shortcodes) => {
    const ids = await locationShortcodes.all(ctx.db, shortcodes);
    const result = await deleteLocations(ctx.db, ids, ctx.actorContext);
    await runMutationSideEffectsForEntities(
      ctx.db,
      mutationEvents("location", "deleted", ids, "location.delete"),
    );
    return result;
  },
  /**
   * The field mask says `parentId`; the semantics stay in
   * {@link reparentLocationsInBulk} (Home mapping, cycle check, race guard).
   * An ABSENT `parentId` is refused rather than defaulted: an explicit `null`
   * moves to Home, so reading `undefined` as `null` would move a selection
   * to Home on an empty patch.
   */
  bulkUpdate: async (ctx, shortcodes, data) => {
    if (data.parentId === undefined)
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "A bulk location patch must supply parentId (null moves to Home).",
      );
    await reparentLocationsInBulk(
      ctx.db,
      ctx.actorContext,
      shortcodes,
      data.parentId,
    );
    return {
      updatedReferences: entityMutationReferences("location", shortcodes),
    };
  },
});
