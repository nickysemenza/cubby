import {
  defineEntityAdapter,
  entityMutationReferences,
} from "~/server/entity-kernel/adapter";
import { createAppError } from "~/server/errors/app-error";
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
import { reparentLocationsInBulk } from "./reparent";

const locationShortcodes = bindShortcodeResolver("location");

export const locationEntityAdapter = defineEntityAdapter({
  entity: "location",
  sideEffects: false,
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
        entity: { entity: "location", id: entityId },
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
        entity: { entity: "location", id: entityId },
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
      const { detachedImageKeys, deletedImageShortcodes } =
        await deleteLocations(ctx.db, ids, ctx.actorContext);
      const backgroundBatches = await runMutationSideEffectsForEntities(
        ctx.db,
        ids.map((entityId) => ({
          action: "deleted" as const,
          entity: { entity: "location" as const, id: entityId },
          source: "location.delete",
        })),
      );
      return {
        deletedReferences: [
          ...entityMutationReferences("location", shortcodes),
          ...entityMutationReferences("image", deletedImageShortcodes),
        ],
        detachedImageKeys,
        backgroundBatches,
      };
    },
    /**
     * The field mask says `parentId`; the semantics behind it stay
     * hand-written. See {@link reparentLocationsInBulk} — a declarative column
     * patch would drop the Home mapping, the cycle check and the race guard.
     *
     * An ABSENT `parentId` is refused rather than defaulted: an explicit
     * `null` means "move to Home", so silently reading `undefined` as `null`
     * would move a selection to Home on an empty patch.
     */
    bulkUpdate: async (ctx, shortcodes, data) => {
      if (data.parentId === undefined) {
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          "A bulk location patch must supply parentId (null moves to Home).",
        );
      }
      const { backgroundBatches } = await reparentLocationsInBulk(
        ctx.db,
        ctx.actorContext,
        shortcodes,
        data.parentId,
      );
      return {
        updatedReferences: entityMutationReferences("location", shortcodes),
        backgroundBatches,
      };
    },
  },
});
