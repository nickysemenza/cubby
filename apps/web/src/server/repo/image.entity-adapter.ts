import { imageSortableFields } from "@cubby/schemas/image";

import { defineEntityAdapter } from "~/server/entity-kernel/adapter";
import { bindShortcodeResolver } from "~/server/repo/shortcode-resolver";

import {
  deleteImages,
  getImageById,
  IMAGE_HARD_DELETE,
  imageList,
  updateImage,
} from "./image";

const imageShortcodes = bindShortcodeResolver("image");

export const imageEntityAdapter = defineEntityAdapter({
  entity: "image",
  sideEffects: false,
  sort: { fields: imageSortableFields, default: "createdAt" },
  lifecycle: { delete: IMAGE_HARD_DELETE },
  repository: {
    get: async (ctx, shortcode) =>
      getImageById(ctx.db, await imageShortcodes.one(ctx.db, shortcode)),
    list: (ctx, filters, sorts, pagination) =>
      imageList(ctx.db, filters, sorts, pagination),
    update: async (ctx, shortcode, data) => {
      const entityId = await imageShortcodes.one(ctx.db, shortcode);
      return {
        output: await updateImage(ctx.db, entityId, data),
        entityId,
      };
    },
    delete: async (ctx, shortcodes) => {
      const ids = await imageShortcodes.all(ctx.db, shortcodes);
      const { deletedIds, deletedKeys } = await deleteImages(ctx.db, ids);
      const shortcodeById = new Map<string, (typeof shortcodes)[number]>(
        ids.map((id, index) => [id, shortcodes[index]!]),
      );
      return {
        deletedReferences: deletedIds.map((id) => {
          const shortcode = shortcodeById.get(id);
          if (!shortcode) {
            throw new Error("Image delete returned an ID outside its request");
          }
          return { entity: "image", id: shortcode };
        }),
        detachedImageKeys: deletedKeys,
      };
    },
  },
});
