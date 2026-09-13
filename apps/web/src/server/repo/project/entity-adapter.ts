import {
  defineEntityAdapter,
  deletedWithImages,
} from "~/server/entity-kernel/adapter";

import {
  createProject,
  deleteProjects,
  getProjectByShortcode,
  PROJECT_DELETE_EDGE_POLICY,
  updateProject,
} from "./crud";
import { projectList } from "./lookup";

export const projectEntityAdapter = defineEntityAdapter({
  entity: "project",
  lifecycle: { delete: PROJECT_DELETE_EDGE_POLICY },
  repository: {
    get: (ctx, id) => getProjectByShortcode(ctx.db, id),
    list: (ctx, filters, sorts, pagination) =>
      projectList(ctx.db, filters, sorts, pagination),
    create: (ctx, data) => createProject(ctx.db, data, ctx.actorContext),
    update: (ctx, id, data) =>
      updateProject(ctx.db, id, data, ctx.actorContext),
    delete: async (ctx, ids) => {
      const { detachedImageKeys, deletedImageShortcodes } =
        await deleteProjects(ctx.db, ids, ctx.actorContext);
      return {
        deletedReferences: deletedWithImages(
          "project",
          ids,
          deletedImageShortcodes,
        ),
        detachedImageKeys,
      };
    },
  },
});
