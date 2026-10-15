import {
  defineRepository,
  listReadOn,
} from "~/server/entity-kernel/repo/repository";
import { bindShortcodeResolver } from "~/server/generic/shortcode/repo/shortcode-resolver";

import {
  deleteImages,
  getImageById,
  IMAGE_HARD_DELETE,
  imageListRead,
  updateImage,
} from "./image";

const imageShortcodes = bindShortcodeResolver("image");

/** Images are created by the upload workflow, never as a row CRUD action. */
export const imageRepository = defineRepository("image", {
  sideEffects: false,
  lifecycle: { delete: IMAGE_HARD_DELETE },
  get: async (ctx, shortcode) =>
    getImageById(ctx.db, await imageShortcodes.one(ctx.db, shortcode)),
  // The full list is the progressive read's complete projection, so every
  // client's row carries the same display images (an image displays itself).
  list: (ctx, filters, sorts, pagination) =>
    imageListRead(ctx.db, filters, sorts, pagination, { kind: "full" }),
  listRead: listReadOn(imageListRead),
  update: async (ctx, shortcode, data) => {
    const entityId = await imageShortcodes.one(ctx.db, shortcode);
    return { output: await updateImage(ctx.db, entityId, data), entityId };
  },
  delete: async (ctx, shortcodes) => {
    const { deletedShortcodes, deletedKeys } = await deleteImages(
      ctx.db,
      await imageShortcodes.all(ctx.db, shortcodes),
    );
    return { removed: deletedShortcodes, detachedImageKeys: deletedKeys };
  },
});
