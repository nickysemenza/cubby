import { defineRepository } from "~/server/entity-kernel/repo/repository";
import { bindShortcodeResolver } from "~/server/generic/shortcode/repo/shortcode-resolver";

import {
  deleteImages,
  IMAGE_HARD_DELETE,
  imageScaffold,
  updateImage,
} from "./image";

const imageShortcodes = bindShortcodeResolver("image");

/** Images are created by the upload workflow, never as a row CRUD action. */
export const imageRepository = defineRepository("image", {
  lifecycle: { delete: IMAGE_HARD_DELETE },
  scaffold: imageScaffold,
  update: async (ctx, shortcode, data) => {
    const entityId = await imageShortcodes.one(ctx.db, shortcode);
    return { output: await updateImage(ctx.db, entityId, data), entityId };
  },
  updateRead: async (ctx, shortcode, data, fields) =>
    updateImage.read(
      fields,
      ctx.db,
      await imageShortcodes.one(ctx.db, shortcode),
      data,
    ),
  delete: async (ctx, shortcodes) => {
    const { deletedShortcodes, deletedKeys } = await deleteImages(
      ctx.db,
      await imageShortcodes.all(ctx.db, shortcodes),
    );
    return { removed: deletedShortcodes, detachedImageKeys: deletedKeys };
  },
});
