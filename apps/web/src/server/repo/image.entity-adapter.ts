import { imageShortcode } from "@cubby/schemas/identifiers";
import {
  imageListFiltersSchema,
  imageSortableFields,
  imageUpdateInput,
  imageWithEntitySchema,
} from "@cubby/schemas/image";
import type { EntityKernelBinding } from "~/server/entity-kernel/adapter";
import { bindShortcodeResolver } from "~/server/repo/shortcode-resolver";
import {
  deleteImages,
  getImageById,
  IMAGE_HARD_DELETE,
  imageList,
  updateImage,
} from "./image";

const imageShortcodes = bindShortcodeResolver("image");

export const imageEntityAdapter: EntityKernelBinding = {
  entity: "image",
  sideEffects: false,
  schemas: {
    id: imageShortcode,
    update: imageUpdateInput,
    output: imageWithEntitySchema,
    detail: imageWithEntitySchema,
    list: imageWithEntitySchema,
    filters: imageListFiltersSchema,
  },
  sort: { fields: imageSortableFields, default: "createdAt" },
  lifecycle: { delete: IMAGE_HARD_DELETE },
  repository: {
    get: async (ctx, shortcode) =>
      getImageById(
        ctx.db,
        await imageShortcodes.one(ctx.db, imageShortcode.parse(shortcode)),
      ),
    list: (ctx, filters, sorts, pagination) =>
      imageList(
        ctx.db,
        imageListFiltersSchema.parse(filters),
        sorts,
        pagination,
      ),
    update: async (ctx, shortcode, data) => {
      const entityId = await imageShortcodes.one(
        ctx.db,
        imageShortcode.parse(shortcode),
      );
      return {
        output: await updateImage(
          ctx.db,
          entityId,
          imageUpdateInput.parse(data),
        ),
        entityId,
      };
    },
    delete: async (ctx, shortcodes) => {
      const ids = await imageShortcodes.all(
        ctx.db,
        imageShortcode.array().parse(shortcodes),
      );
      const { deletedIds, deletedKeys } = await deleteImages(ctx.db, ids);
      return { deleted: deletedIds.length, detachedImageKeys: deletedKeys };
    },
  },
};
