import { cookbookSchemaBindings } from "~/entity/generated/entity-schema-bindings.cookbook.gen";
import { DECLARED_EDGE_DELETE_POLICIES } from "~/server/db/generated/declared-edges.gen";
import { defineRepository } from "~/server/entity-kernel/repo/repository";

import { cookbookScaffold, updateCookbook } from "./cookbook";

/**
 * A cookbook is born from an EPUB import and deleted with its recipes by that
 * workflow (`deleteCookbook`, under the policy declared here); the kernel
 * serves reads and title/author/subject edits.
 */
export const cookbookRepository = defineRepository("cookbook", {
  schemas: cookbookSchemaBindings,
  lifecycle: { delete: DECLARED_EDGE_DELETE_POLICIES.cookbook },
  scaffold: cookbookScaffold,
  update: (ctx, shortcode, data) =>
    updateCookbook(ctx.db, shortcode, data, ctx.actorContext),
  updateRead: (ctx, shortcode, data, fields) =>
    updateCookbook.read(fields, ctx.db, shortcode, data, ctx.actorContext),
});
