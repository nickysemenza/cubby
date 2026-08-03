/**
 * Project Router — household project tracker (migrated from Notion).
 *
 * Standard CRUD over the `project` entity plus two dashboard reads:
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
import {
  projectShortcode,
  unsafeProductId,
  unsafeProjectId,
} from "@cubby/schemas/identifiers";
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
  projectToolSuggestionsOut,
  projectUpdateData,
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
  suggestProjectTools,
  updateProject,
} from "~/server/repo/project";
import { createProjectFromTasks } from "~/server/repo/project/create-from-tasks";
import {
  resolveLiveShortcode,
  resolveLiveShortcodes,
} from "~/server/repo/shortcode-resolver";
import { runMutationSideEffectsForEntities } from "~/server/services/mutation-side-effects";
import { createSearchableEntityCrudProcedures } from "../crud-factory";
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
      const id = await resolveLiveShortcode(services.db, shortcode, "project");
      if (!id) {
        throw createAppError(
          "PROJECT_NOT_FOUND",
          `Project not found: ${shortcode}`,
        );
      }
      return getProjectByID(services.db, unsafeProjectId(id));
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
      await deleteProjects(services.db, ids, services.actorContext);
      return undefined;
    },
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
 * Lightweight `{id, name}` options for pickers/filter selects (see
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
  db: Parameters<typeof resolveLiveShortcode>[0],
  input: { projectId: ProjectShortcode; productIds?: ProductShortcode[] },
) {
  const projectId = await resolveLiveShortcode(db, input.projectId, "project");
  if (!projectId) {
    throw createAppError(
      "PROJECT_NOT_FOUND",
      `Project ${input.projectId} not found`,
    );
  }
  if (!input.productIds) {
    return { projectId: unsafeProjectId(projectId), productIds: [] };
  }
  const resolved = await resolveLiveShortcodes(db, input.productIds, "product");
  const missing = input.productIds.find((code) => !resolved.has(code));
  if (missing) {
    throw createAppError("PRODUCT_NOT_FOUND", `Product ${missing} not found`);
  }
  return {
    projectId: unsafeProjectId(projectId),
    productIds: input.productIds.map((code) =>
      unsafeProductId(resolved.get(code)!),
    ),
  };
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

export const projectRouter = createTRPCRouter({
  getByID,
  getByShortcode,
  list,
  create,
  update,
  delete: deleteItem,
  dashboardSummary,
  portfolioAnalytics,
  options,
  createFromTasks,
  resources,
  toolSuggestions,
  attachResources,
  detachResources,
});
