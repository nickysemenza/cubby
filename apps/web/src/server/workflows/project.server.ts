import type { ActorContext } from "@cubby/schemas/context";
import {
  buildPaginatedResponse,
  normalizeSorts,
} from "@cubby/schemas/pagination";
import {
  createProjectFromTasksInput,
  projectDependencyGraphInput,
  projectResourceMutationInput,
  projectResourceProjectInput,
  projectToolUsageSetInput,
  projectTreeInput,
  repointProjectUsesInput,
} from "@cubby/schemas/project";
import type { z } from "zod";

import type { Database } from "~/server/db";
import { createAppError } from "~/server/errors/app-error";
import {
  attachProjectResources,
  detachProjectResources,
  listProjectResources,
  getProjectDependencyGraph,
  projectDashboardSummary,
  projectNameOptions,
  projectPortfolioAnalytics,
  projectToolMatrix,
  projectToolGallery,
  projectTreePage,
  repointProjectUses,
  setProjectToolUsage,
  suggestProjectTools,
} from "~/server/repo/project";
import { createProjectFromTasks } from "~/server/repo/project/create-from-tasks";
import {
  resolveAllOrThrow,
  resolveOrThrow,
} from "~/server/repo/shortcode-resolver";
import {
  mutationEvents,
  runMutationSideEffectsForEntities,
} from "~/server/services/mutation-side-effects";
import { markProblemCountsDirtyBestEffort } from "~/server/services/problem-counts-cache";
import {
  bindWorkflow,
  defineWorkflowOperation,
  workflow,
} from "~/server/workflow-runtime";

type GraphInput = z.output<typeof projectDependencyGraphInput>;
type TreeInput = z.output<typeof projectTreeInput>;
type MutationContext = { db: Database; actor: ActorContext };
type CreateFromTasksInput = z.output<typeof createProjectFromTasksInput>;
type ResourceInput = z.output<typeof projectResourceProjectInput>;
type ResourceMutationInput = z.output<typeof projectResourceMutationInput>;
type RepointInput = z.output<typeof repointProjectUsesInput>;
type ToolUsageInput = z.output<typeof projectToolUsageSetInput>;

export const projectDependencyGraphWorkflow = bindWorkflow(
  workflow<Database, GraphInput>("project.getDependencyGraph")
    .call("projectId", async ({ context }, { input }) =>
      input?.projectId
        ? resolveOrThrow(context, "project", input.projectId)
        : undefined,
    )
    .call("graph", async ({ context }, { projectId }) =>
      getProjectDependencyGraph(context, projectId),
    )
    .output(({ graph }) => graph),
  (db: Database, input: GraphInput) => ({ context: db, input }),
);

export const projectTreeWorkflow = bindWorkflow(
  workflow<Database, TreeInput>("project.tree")
    .call("page", async ({ context }, { input }) =>
      projectTreePage(
        context,
        input.filters,
        normalizeSorts(input.sort),
        input.pagination,
      ),
    )
    .output(({ input, page }) =>
      buildPaginatedResponse(
        input.pagination,
        page.data,
        page.count,
        page.sums,
      ),
    ),
  (db: Database, input: TreeInput) => ({ context: db, input }),
);

export const projectDashboardSummaryWorkflow = defineWorkflowOperation(
  "project.dashboardSummary",
  projectDashboardSummary,
);
export const projectPortfolioAnalyticsWorkflow = defineWorkflowOperation(
  "project.portfolioAnalytics",
  projectPortfolioAnalytics,
);
export const projectOptionsWorkflow = defineWorkflowOperation(
  "project.options",
  (db: Database) => projectNameOptions(db),
);

export const projectCreateFromTasksWorkflow = bindWorkflow(
  workflow<MutationContext, CreateFromTasksInput>("project.createFromTasks")
    .commit("created", async ({ context }, { input }) =>
      createProjectFromTasks(context.db, input, context.actor),
    )
    .effect("effects", async ({ context }, { created }) =>
      runMutationSideEffectsForEntities(context.db, [
        ...mutationEvents(
          "project",
          "created",
          [created.projectEntityId],
          "project.createFromTasks",
        ),
        ...mutationEvents(
          "task",
          "updated",
          created.taskEntityIds,
          "project.createFromTasks",
        ),
      ]),
    )
    .output(({ created }) => created.output),
  (db: Database, input: CreateFromTasksInput, actor: ActorContext) => ({
    context: { db, actor },
    input,
  }),
);

const resolveProjectResourceIds = async (
  db: Database,
  input: { projectId: string; productIds?: string[] },
) => ({
  projectId: await resolveOrThrow(db, "project", input.projectId),
  productIds: input.productIds
    ? await resolveAllOrThrow(db, "product", input.productIds)
    : [],
});

export const projectResourcesWorkflow = bindWorkflow(
  workflow<Database, ResourceInput>("project.resources")
    .call("projectId", async ({ context }, { input }) =>
      resolveOrThrow(context, "project", input.projectId),
    )
    .call("resources", async ({ context }, { projectId }) =>
      listProjectResources(context, projectId),
    )
    .output(({ resources }) => resources),
  (db: Database, input: ResourceInput) => ({ context: db, input }),
);

export const projectToolSuggestionsWorkflow = bindWorkflow(
  workflow<Database, ResourceInput>("project.toolSuggestions")
    .call("projectId", async ({ context }, { input }) =>
      resolveOrThrow(context, "project", input.projectId),
    )
    .call("suggestions", async ({ context }, { projectId }) =>
      suggestProjectTools(context, projectId),
    )
    .output(({ suggestions }) => suggestions),
  (db: Database, input: ResourceInput) => ({ context: db, input }),
);

export const projectAttachResourcesWorkflow = bindWorkflow(
  workflow<MutationContext, ResourceMutationInput>("project.attachResources")
    .call("ids", async ({ context }, { input }) =>
      resolveProjectResourceIds(context.db, input),
    )
    .commit("attached", async ({ context }, { ids }) =>
      attachProjectResources(
        context.db,
        ids.projectId,
        ids.productIds,
        context.actor,
      ),
    )
    .effect("badge", async () => {
      await markProblemCountsDirtyBestEffort("project.attachResources");
    })
    .output(({ attached }) => attached),
  (db: Database, input: ResourceMutationInput, actor: ActorContext) => ({
    context: { db, actor },
    input,
  }),
);

export const projectDetachResourcesWorkflow = bindWorkflow(
  workflow<MutationContext, ResourceMutationInput>("project.detachResources")
    .call("ids", async ({ context }, { input }) =>
      resolveProjectResourceIds(context.db, input),
    )
    .commit("detached", async ({ context }, { ids }) =>
      detachProjectResources(
        context.db,
        ids.projectId,
        ids.productIds,
        context.actor,
      ),
    )
    .effect("badge", async () => {
      await markProblemCountsDirtyBestEffort("project.detachResources");
    })
    .output(({ detached }) => detached),
  (db: Database, input: ResourceMutationInput, actor: ActorContext) => ({
    context: { db, actor },
    input,
  }),
);

export const projectRepointUsesWorkflow = bindWorkflow(
  workflow<MutationContext, RepointInput>("project.repointUses")
    .parallel("products", 2, {
      fromProductId: async ({ context }, { input }) =>
        resolveOrThrow(context.db, "product", input.fromProductId),
      toProductId: async ({ context }, { input }) =>
        resolveOrThrow(context.db, "product", input.toProductId),
    })
    .call("projectIds", async ({ context }, { input }) =>
      input.projectIds
        ? resolveAllOrThrow(context.db, "project", input.projectIds)
        : undefined,
    )
    .commit("repointed", async ({ context }, { products, projectIds }) =>
      repointProjectUses(
        context.db,
        { ...products, projectIds },
        context.actor,
      ),
    )
    .effect("badge", async () => {
      await markProblemCountsDirtyBestEffort("project.repointUses");
    })
    .output(({ repointed }) => repointed),
  (db: Database, input: RepointInput, actor: ActorContext) => ({
    context: { db, actor },
    input,
  }),
);

export const projectToolMatrixWorkflow = defineWorkflowOperation(
  "project.toolMatrix",
  projectToolMatrix,
);
export const projectToolGalleryWorkflow = defineWorkflowOperation(
  "project.toolGallery",
  projectToolGallery,
);

export const projectSetToolUsageWorkflow = bindWorkflow(
  workflow<MutationContext, ToolUsageInput>("project.setToolUsage")
    .call("ids", async ({ context }, { input }) =>
      resolveProjectResourceIds(context.db, {
        projectId: input.projectId,
        productIds: [input.productId],
      }),
    )
    .call("productId", async (_, { input, ids }) => {
      const productId = ids.productIds[0];
      if (!productId)
        throw createAppError(
          "PRODUCT_NOT_FOUND",
          `Product ${input.productId} not found`,
        );
      return productId;
    })
    .commit("usage", async ({ context }, { input, ids, productId }) =>
      setProjectToolUsage(
        context.db,
        ids.projectId,
        productId,
        input.used,
        context.actor,
      ),
    )
    .effect("badge", async () => {
      await markProblemCountsDirtyBestEffort("project.setToolUsage");
    })
    .output(({ input, usage }) => ({
      projectId: input.projectId,
      productId: input.productId,
      used: input.used,
      changed: usage.changed,
    })),
  (db: Database, input: ToolUsageInput, actor: ActorContext) => ({
    context: { db, actor },
    input,
  }),
);
