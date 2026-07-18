/**
 * Project Router — household project tracker (migrated from Notion).
 *
 * Standard CRUD over the `project` entity plus `dashboard`, the one-shot query
 * behind /projects: every project (with cost/progress rollups + dependency
 * ids) and the full task/purchase history the charts aggregate over. Rollups
 * are SQL aggregates computed in the repo — never client-side.
 */

import { type ProjectId, projectId } from "@cubby/schemas/identifiers";
import {
  projectCreateInput,
  projectDashboardOut,
  projectFiltersSchema,
  projectOptionsOut,
  projectOut,
  projectSortableFields,
  projectUpdateData,
} from "@cubby/schemas/project";
import { z } from "zod";
import {
  createProject,
  deleteProjects,
  getProjectByID,
  projectList,
  projectNameOptions,
  updateProject,
} from "~/server/repo/project";
import { purchaseList } from "~/server/repo/purchase";
import { taskList } from "~/server/repo/task";
import { runMutationSideEffects } from "~/server/services/mutation-side-effects";
import {
  createDeleteProcedure,
  createEntityCrudProcedures,
} from "../crud-factory";
import { createTRPCRouter, protectedProcedure } from "../trpc";

const { getByID, list, create, update } = createEntityCrudProcedures({
  schemas: {
    createInput: projectCreateInput,
    updateInput: projectUpdateData,
    output: projectOut,
    filters: projectFiltersSchema,
    sort: { sortableFields: projectSortableFields, defaultSort: "createdAt" },
    idSchema: projectId,
  },
  repository: {
    getByID: async (services, id: ProjectId) => getProjectByID(services.db, id),
    list: async (services, filters, sort, pagination) =>
      projectList(services.db, filters, sort, pagination),
    create: async (services, data) => {
      const created = await createProject(
        services.db,
        data,
        services.actorContext,
      );
      await runMutationSideEffects(services.db, {
        action: "created",
        entity: { entityType: "project", entityId: created.id },
        source: "project.create",
      });
      return created;
    },
    update: async (services, id: ProjectId, data) => {
      const updated = await updateProject(
        services.db,
        id,
        data,
        services.actorContext,
      );
      await runMutationSideEffects(services.db, {
        action: "updated",
        entity: { entityType: "project", entityId: id },
        source: "project.update",
      });
      return updated;
    },
  },
  entityName: "project",
});

const deleteItem = createDeleteProcedure<ProjectId>(async (services, ids) => {
  await deleteProjects(services.db, ids, services.actorContext);
  return undefined;
}, projectId);

/** Everything the projects dashboard renders, in one round trip. */
const FETCH_ALL = { pageIndex: 0, pageSize: 100_000 };
const dashboard = protectedProcedure
  .output(projectDashboardOut)
  .query(async ({ ctx }) => {
    const [projects, tasks, purchases] = await Promise.all([
      projectList(
        ctx.db,
        {},
        [{ orderBy: "startDate", direction: "desc" }],
        FETCH_ALL,
      ),
      taskList(
        ctx.db,
        {},
        [{ orderBy: "createdAt", direction: "desc" }],
        FETCH_ALL,
      ),
      purchaseList(
        ctx.db,
        {},
        [{ orderBy: "date", direction: "desc" }],
        FETCH_ALL,
      ),
    ]);
    return {
      projects: projects.data,
      tasks: tasks.data,
      purchases: purchases.data,
    };
  });

/**
 * Lightweight `{id, name}` options for pickers/filter selects (see
 * `useProjectOptions`) — a single indexed query, no rollups/dependency joins.
 * Replaces paging through the full `list` at pageSize 500 just for names.
 */
const options = protectedProcedure
  .output(z.array(projectOptionsOut))
  .query(({ ctx }) => projectNameOptions(ctx.db));

export const projectRouter = createTRPCRouter({
  getByID,
  list,
  create,
  update,
  delete: deleteItem,
  dashboard,
  options,
});
