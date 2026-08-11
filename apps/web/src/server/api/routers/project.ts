/**
 * Project Router — household project tracker (migrated from Notion).
 *
 * Standard CRUD over the `project` entity, a second list read for the WBS
 * renderer (`tree` — same filters as `list`, paginated by root of the filtered
 * forest; see repo/project/tree.ts), plus two dashboard reads:
 * `dashboardSummary` (the bounded Overview read — summary counts, active
 * project list w/ rollups, task-status breakdown, upcoming tasks, Needs
 * Attention, filter options) and `portfolioAnalytics` (on-demand chart
 * aggregates for the Charts/Analytics tab). Both replace the old fetch-all
 * `project.dashboard` (every project/task/expense in one round trip,
 * reduced client-side) — see repo/project/dashboard-summary.ts /
 * repo/project/portfolio-analytics.ts. Rollups/aggregates are SQL computed in
 * the repo — never client-side.
 */

import type {
  ProductShortcode,
  ProjectShortcode,
} from "@cubby/schemas/identifiers";
import { projectShortcode } from "@cubby/schemas/identifiers";
import {
  createProjectFromTasksInput,
  createProjectFromTasksOut,
  projectCreateInput,
  projectDashboardFiltersSchema,
  projectDashboardSummaryOut,
  projectFiltersSchema,
  projectOptionsOut,
  projectOut,
  projectPortfolioAnalyticsOut,
  projectResourceMutationInput,
  projectResourceMutationOut,
  projectResourceProjectInput,
  projectResourcesOut,
  projectSortableFields,
  projectToolMatrixInput,
  projectToolMatrixOut,
  projectToolSuggestionsOut,
  projectToolUsageSetInput,
  projectToolUsageSetOut,
  projectUpdateData,
  repointProjectUsesInput,
  repointProjectUsesOut,
} from "@cubby/schemas/project";
import { z } from "zod";
import { createAppError } from "~/server/errors/app-error";
import {
  attachProjectResources,
  createProject,
  deleteProjects,
  detachProjectResources,
  getProjectByID,
  getProjectByShortcode,
  listProjectResources,
  projectDashboardSummary,
  projectList,
  projectNameOptions,
  projectPortfolioAnalytics,
  projectToolMatrix,
  projectTreePage,
  repointProjectUses,
  setProjectToolUsage,
  suggestProjectTools,
  updateProject,
} from "~/server/repo/project";
import { createProjectFromTasks } from "~/server/repo/project/create-from-tasks";
import {
  resolveAllOrThrow,
  resolveOrThrow,
} from "~/server/repo/shortcode-resolver";
import { deleteStoredObjects } from "~/server/services/image-storage.service";
import { runMutationSideEffectsForEntities } from "~/server/services/mutation-side-effects";
import {
  createEntityListProcedure,
  createSearchableEntityCrudProcedures,
} from "../crud-factory";
import { createTRPCRouter, protectedProcedure, strictOutput } from "../trpc";

const {
  getByID,
  getByShortcode,
  list,
  create,
  update,
  delete: deleteItem,
} = createSearchableEntityCrudProcedures({
  schemas: {
    createInput: projectCreateInput,
    updateInput: projectUpdateData,
    output: projectOut,
    filters: projectFiltersSchema,
    sort: { sortableFields: projectSortableFields, defaultSort: "createdAt" },
    idSchema: projectShortcode,
  },
  repository: {
    getByID: async (services, shortcode: ProjectShortcode) => {
      const id = await resolveOrThrow(services.db, "project", shortcode);
      return getProjectByID(services.db, id);
    },
    getByShortcode: (services, shortcode) =>
      getProjectByShortcode(services.db, shortcode),
    list: async (services, filters, sort, pagination) =>
      projectList(services.db, filters, sort, pagination),
    create: async (services, data) =>
      createProject(services.db, data, services.actorContext),
    update: async (services, shortcode: ProjectShortcode, data) =>
      updateProject(services.db, shortcode, data, services.actorContext),
    delete: async (services, ids: ProjectShortcode[]) => {
      const { detachedImageKeys } = await deleteProjects(
        services.db,
        ids,
        services.actorContext,
      );
      // After the commit, never inside it: an R2 delete has no rollback.
      await deleteStoredObjects(detachedImageKeys);
      return undefined;
    },
  },
  entityName: "project",
});

/**
 * `/projects?view=data&rows=tree`'s WBS page — same input and `{meta, items}`
 * output as `list` (so the list hook can swap one for the other), but the page
 * it returns is N roots of the filtered forest plus their matching descendants,
 * and `meta.totalCount` counts those roots. See repo/project/tree.ts for why
 * the page is chosen on this side of the wire.
 */
const { list: tree } = createEntityListProcedure({
  schemas: {
    output: projectOut,
    filters: projectFiltersSchema,
    sort: { sortableFields: projectSortableFields, defaultSort: "createdAt" },
  },
  repository: {
    list: (services, filters, sorts, pagination) =>
      projectTreePage(services.db, filters, sorts, pagination),
  },
  entityName: "project",
});

/** `/projects?view=overview`'s bounded summary read — see repo/project/dashboard-summary.ts. */
const dashboardSummary = protectedProcedure
  .input(projectDashboardFiltersSchema)
  .output(strictOutput(projectDashboardSummaryOut))
  .query(({ ctx, input }) => projectDashboardSummary(ctx.db, input));

/** `/projects?view=analytics`'s on-demand chart aggregates — see repo/project/portfolio-analytics.ts. */
const portfolioAnalytics = protectedProcedure
  .input(projectDashboardFiltersSchema)
  .output(strictOutput(projectPortfolioAnalyticsOut))
  .query(({ ctx, input }) => projectPortfolioAnalytics(ctx.db, input));

/**
 * Lightweight `{id, name, icon}` options for pickers/filter selects (see
 * `useProjectOptions`) — a single indexed query, no rollups/dependency joins.
 * Replaces paging through the full `list` at pageSize 500 just for names.
 */
const options = protectedProcedure
  .output(strictOutput(z.array(projectOptionsOut)))
  .query(({ ctx }) => projectNameOptions(ctx.db));

/**
 * Inbox → project promotion: create a project and move the given tasks onto
 * it in one transaction (repo/project/create-from-tasks.ts). One wave-wide
 * side-effect dispatch covers the created project plus every moved task,
 * mirroring `task.bulkMove`'s shape.
 */
const createFromTasks = protectedProcedure
  .input(createProjectFromTasksInput)
  .output(strictOutput(createProjectFromTasksOut))
  .mutation(async ({ ctx, input }) => {
    const { output, projectEntityId, taskEntityIds } =
      await createProjectFromTasks(ctx.db, input, ctx.actorContext);
    // Fire-and-forget wave-wide dispatch (embedding refresh) — the output
    // schema (createProjectFromTasksOut) has no sideEffects slot to report it
    // through, unlike the task-bulk mutations' *ListAndSideEffectsOut shape.
    // Uses the INTERNAL uuids (not `output`'s public shortcodes) since that's
    // what the embedding pipeline keys on.
    await runMutationSideEffectsForEntities(ctx.db, [
      {
        action: "created" as const,
        entity: { entityType: "project" as const, entityId: projectEntityId },
        source: "project.createFromTasks",
      },
      ...taskEntityIds.map((entityId) => ({
        action: "updated" as const,
        entity: { entityType: "task" as const, entityId },
        source: "project.createFromTasks",
      })),
    ]);
    return output;
  });

async function resolveProjectResourceIds(
  db: Parameters<typeof resolveOrThrow>[0],
  input: { projectId: ProjectShortcode; productIds?: ProductShortcode[] },
) {
  const projectId = await resolveOrThrow(db, "project", input.projectId);
  if (!input.productIds) {
    return { projectId, productIds: [] };
  }
  const productIds = await resolveAllOrThrow(db, "product", input.productIds);
  return { projectId, productIds };
}

const resources = protectedProcedure
  .input(projectResourceProjectInput)
  .output(strictOutput(projectResourcesOut))
  .query(async ({ ctx, input }) => {
    const ids = await resolveProjectResourceIds(ctx.db, input);
    return listProjectResources(ctx.db, ids.projectId);
  });

const toolSuggestions = protectedProcedure
  .input(projectResourceProjectInput)
  .output(strictOutput(projectToolSuggestionsOut))
  .query(async ({ ctx, input }) => {
    const ids = await resolveProjectResourceIds(ctx.db, input);
    return suggestProjectTools(ctx.db, ids.projectId);
  });

const attachResources = protectedProcedure
  .input(projectResourceMutationInput)
  .output(strictOutput(projectResourceMutationOut))
  .mutation(async ({ ctx, input }) => {
    const ids = await resolveProjectResourceIds(ctx.db, input);
    return attachProjectResources(
      ctx.db,
      ids.projectId,
      ids.productIds,
      ctx.actorContext,
    );
  });

const detachResources = protectedProcedure
  .input(projectResourceMutationInput)
  .output(strictOutput(projectResourceMutationOut))
  .mutation(async ({ ctx, input }) => {
    const ids = await resolveProjectResourceIds(ctx.db, input);
    return detachProjectResources(
      ctx.db,
      ids.projectId,
      ids.productIds,
      ctx.actorContext,
    );
  });

const repointUses = protectedProcedure
  .input(repointProjectUsesInput)
  .output(strictOutput(repointProjectUsesOut))
  .mutation(async ({ ctx, input }) => {
    const [fromProductId, toProductId] = await Promise.all([
      resolveOrThrow(ctx.db, "product", input.fromProductId),
      resolveOrThrow(ctx.db, "product", input.toProductId),
    ]);
    const projectIds = input.projectIds
      ? await resolveAllOrThrow(ctx.db, "project", input.projectIds)
      : undefined;
    return repointProjectUses(
      ctx.db,
      { fromProductId, toProductId, projectIds },
      ctx.actorContext,
    );
  });

/**
 * The whole `/projects/tools` grid in one read — columns, rows, and the
 * non-empty cells. Filters are plain values, so there is nothing to resolve.
 */
const toolMatrix = protectedProcedure
  .input(projectToolMatrixInput)
  .output(strictOutput(projectToolMatrixOut))
  .query(({ ctx, input }) => projectToolMatrix(ctx.db, input));

/**
 * One checkbox. Declarative and idempotent — see `projectToolUsageSetInput`
 * for why this exists alongside `attachResources`/`detachResources`.
 */
const setToolUsage = protectedProcedure
  .input(projectToolUsageSetInput)
  .output(strictOutput(projectToolUsageSetOut))
  .mutation(async ({ ctx, input }) => {
    const ids = await resolveProjectResourceIds(ctx.db, {
      projectId: input.projectId,
      productIds: [input.productId],
    });
    const productId = ids.productIds[0];
    if (!productId) {
      throw createAppError(
        "PRODUCT_NOT_FOUND",
        `Product ${input.productId} not found`,
      );
    }
    const { changed } = await setProjectToolUsage(
      ctx.db,
      ids.projectId,
      productId,
      input.used,
      ctx.actorContext,
    );
    return {
      projectId: input.projectId,
      productId: input.productId,
      used: input.used,
      changed,
    };
  });

export const projectRouter = createTRPCRouter({
  getByID,
  getByShortcode,
  list,
  tree,
  create,
  update,
  delete: deleteItem,
  dashboardSummary,
  portfolioAnalytics,
  options,
  createFromTasks,
  resources,
  toolSuggestions,
  toolMatrix,
  attachResources,
  detachResources,
  repointUses,
  setToolUsage,
});
