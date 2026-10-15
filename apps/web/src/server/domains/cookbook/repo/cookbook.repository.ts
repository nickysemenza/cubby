import {
  defineRepository,
  listOn,
  listReadOn,
} from "~/server/entity-kernel/repo/repository";

import {
  COOKBOOK_DELETE_EDGE_POLICY,
  cookbookList,
  cookbookListRead,
  getCookbookSummary,
  updateCookbook,
} from "./cookbook";

/**
 * A cookbook is born from an EPUB import and deleted with its recipes by that
 * workflow (`deleteCookbook`, under the policy declared here); the kernel
 * serves reads and title/author/subject edits.
 */
export const cookbookRepository = defineRepository("cookbook", {
  lifecycle: { delete: COOKBOOK_DELETE_EDGE_POLICY },
  get: (ctx, shortcode) => getCookbookSummary(ctx.db, shortcode),
  list: listOn(cookbookList),
  listRead: listReadOn(cookbookListRead),
  update: (ctx, shortcode, data) =>
    updateCookbook(ctx.db, ctx.actorContext, shortcode, data),
});
