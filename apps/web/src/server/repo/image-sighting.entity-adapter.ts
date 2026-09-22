import {
  defineEntityAdapter,
  entityMutationReferences,
} from "~/server/entity-kernel/adapter";

import {
  createImageSighting,
  deleteImageSightings,
  getImageSightingByShortcode,
  IMAGE_SIGHTING_DELETE_EDGE_POLICY,
  listImageSightings,
  updateImageSighting,
} from "./image-sighting";

export const imageSightingEntityAdapter = defineEntityAdapter({
  entity: "imageSighting",
  lifecycle: { delete: IMAGE_SIGHTING_DELETE_EDGE_POLICY },
  repository: {
    get: (ctx, id) => getImageSightingByShortcode(ctx.db, id),
    list: (ctx, filters, sorts, pagination) =>
      listImageSightings(ctx.db, filters, sorts, pagination),
    create: (ctx, data) => createImageSighting(ctx.db, data, ctx.actorContext),
    update: (ctx, id, data) =>
      updateImageSighting(ctx.db, id, data, ctx.actorContext),
    delete: async (ctx, ids) => {
      await deleteImageSightings(ctx.db, ids, ctx.actorContext);
      return {
        deletedReferences: entityMutationReferences("imageSighting", ids),
      };
    },
  },
});
