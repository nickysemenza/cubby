import { defineRepository } from "~/server/entity-kernel/repo/repository";

import {
  COOKBOOK_DELETE_EDGE_POLICY,
  cookbookScaffold,
  updateCookbook,
} from "./cookbook";

/**
 * A cookbook is born from an EPUB import and deleted with its recipes by that
 * workflow (`deleteCookbook`, under the policy declared here); the kernel
 * serves reads and title/author/subject edits.
 */
export const cookbookRepository = defineRepository("cookbook", {
  lifecycle: { delete: COOKBOOK_DELETE_EDGE_POLICY },
  scaffold: cookbookScaffold,
  update: (ctx, shortcode, data) =>
    updateCookbook(ctx.db, shortcode, data, ctx.actorContext),
  updateRead: (ctx, shortcode, data, fields) =>
    updateCookbook.read(fields, ctx.db, shortcode, data, ctx.actorContext),
});
