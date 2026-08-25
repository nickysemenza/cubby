import {
  infLocation,
  locationFiltersSchema,
  locationListItemOut,
  locationSortableFields,
} from "@cubby/schemas/location";
import { defineEntityAdapter } from "~/server/entity-kernel/adapter";
import { bindShortcodeResolver } from "~/server/repo/shortcode-resolver";
import {
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

const locationShortcodes = bindShortcodeResolver("location");

export const locationEntityAdapter = defineEntityAdapter({
  entity: "location",
  sideEffects: false,
  filters: locationFiltersSchema,
  detailOutput: infLocation,
  listOutput: locationListItemOut,
  sort: {
    fields: locationSortableFields,
    default: "createdAt",
    groupable: ["type"],
  },
  lifecycle: { delete: LOCATION_DELETE_EDGE_POLICY },
  repository: {
    get: (ctx, id) => getLocationByShortcode(ctx.db, id),
    list: (ctx, filters, sorts, pagination, groupBy) =>
      locationList(ctx.db, filters, sorts, pagination, groupBy),
    create: async (ctx, data) => {
      const output = await createLocation(ctx.db, data, ctx.actorContext);
      const entityId = await locationShortcodes.one(ctx.db, output.id);
      const backgroundBatches = await runMutationSideEffects(ctx.db, {
        action: "created",
        entity: { entityType: "location", entityId },
        source: "location.create",
        locationImagesChanged: (data.pendingImageIds?.length ?? 0) > 0,
      });
      return { output, entityId, backgroundBatches };
    },
    update: async (ctx, shortcode, data) => {
      const entityId = await locationShortcodes.one(ctx.db, shortcode);
      const imagesChanged =
        (data.pendingImageIds?.length ?? 0) > 0 ||
        (data.removeImageIds?.length ?? 0) > 0;
      const { location: updated, detachedImageKeys } = await updateLocation(
        ctx.db,
        entityId,
        data,
        ctx.actorContext,
      );
      const backgroundBatches = await runMutationSideEffects(ctx.db, {
        action: "updated",
        entity: { entityType: "location", entityId },
        source: "location.update",
        locationImagesChanged: imagesChanged,
      });
      if (!imagesChanged)
        return {
          output: updated,
          entityId,
          detachedImageKeys,
          backgroundBatches,
        };
      if (updated.images.length === 0)
        await updateLocationAiDescription(ctx.db, entityId, null);
      return {
        output: await getLocationById(ctx.db, entityId),
        entityId,
        detachedImageKeys,
        backgroundBatches,
      };
    },
    delete: async (ctx, shortcodes) => {
      const ids = await locationShortcodes.all(ctx.db, shortcodes);
      const { deleted, detachedImageKeys } = await deleteLocations(
        ctx.db,
        ids,
        ctx.actorContext,
      );
      const backgroundBatches = await runMutationSideEffectsForEntities(
        ctx.db,
        ids.map((entityId) => ({
          action: "deleted" as const,
          entity: { entityType: "location" as const, entityId },
          source: "location.delete",
        })),
      );
      return { deleted, detachedImageKeys, backgroundBatches };
    },
  },
});
