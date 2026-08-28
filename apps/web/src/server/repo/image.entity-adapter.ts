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
      const { deletedShortcodes, deletedKeys } = await deleteImages(
        ctx.db,
        ids,
      );
      return {
        deletedReferences: deletedShortcodes.map((id) => ({
          entity: "image",
          id,
        })),
        detachedImageKeys: deletedKeys,
      };
    },
  },
});
