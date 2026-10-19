import { withTransactionDatabase } from "~/server/db/helpers";
import {
  mutationEvents,
  runMutationSideEffects,
  runMutationSideEffectsForEntities,
} from "~/server/entity-kernel/repo/mutation-side-effects";
import { defineRepository, onDb } from "~/server/entity-kernel/repo/repository";
import { bindShortcodeResolver } from "~/server/generic/shortcode/repo/shortcode-resolver";

import {
  createLocationRecord,
  deleteLocations,
  getLocationById,
  LOCATION_DELETE_EDGE_POLICY,
  locationList,
  locationListRead,
  updateLocation,
  updateLocationAiDescription,
} from "./crud";
import { getLocationByShortcode } from "./lookup";

const locationShortcodes = bindShortcodeResolver("location");

/**
 * `sideEffects: false`: a location write dispatches its own events, which
 * carry whether its images changed (the vision description depends on it).
 */
export const locationRepository = defineRepository("location", {
  sideEffects: false,
  lifecycle: { delete: LOCATION_DELETE_EDGE_POLICY },
  get: onDb(getLocationByShortcode),
  list: (ctx, filters, sorts, pagination) =>
    locationList(ctx.db, filters, sorts, pagination),
  listRead: (ctx, filters, sorts, pagination, projection) =>
    locationListRead(ctx.db, filters, sorts, pagination, projection),
  create: async (ctx, data) => {
    const { output, entityId } = await createLocationRecord(
      ctx.db,
      data,
      ctx.actorContext,
    );
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
});
