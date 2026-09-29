import type { ActorContext } from "@cubby/schemas/context";
import {
  buildPaginatedResponse,
  normalizeSorts,
} from "@cubby/schemas/pagination";
import type {
  createProjectFromTasksInput,
  projectToolUsageSetInput,
  repointProjectUsesInput,
} from "@cubby/schemas/project";
import type { z } from "zod";

import { projectContract } from "~/contracts/project.contract";
import type { Database } from "~/server/db";
import { createAppError } from "~/server/errors/app-error";
import { implementOperationDomain } from "~/server/operation-domain.server";
import {
  getProjectDependencyGraph,
  projectDashboardSummary,
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
import { bindWorkflow, workflow } from "~/server/workflow-runtime";

type MutationContext = { db: Database; actor: ActorContext };
type CreateFromTasksInput = z.output<typeof createProjectFromTasksInput>;
type RepointInput = z.output<typeof repointProjectUsesInput>;
type ToolUsageInput = z.output<typeof projectToolUsageSetInput>;

const createFromTasksWorkflow = bindWorkflow(
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
);

export const projectCreateFromTasksWorkflow = (
  db: Database,
  input: CreateFromTasksInput,
  actor: ActorContext,
) => createFromTasksWorkflow({ db, actor }, input);

export async function projectRepointUsesWorkflow(
  db: Database,
  input: RepointInput,
  actor: ActorContext,
) {
  const [fromProductId, toProductId] = await Promise.all([
    resolveOrThrow(db, "product", input.fromProductId),
    resolveOrThrow(db, "product", input.toProductId),
  ]);
  const projectIds = input.projectIds
    ? await resolveAllOrThrow(db, "project", input.projectIds)
    : undefined;
  return repointProjectUses(
    db,
    { fromProductId, toProductId, projectIds },
    actor,
  );
}

export async function projectSetToolUsageWorkflow(
  db: Database,
  input: ToolUsageInput,
  actor: ActorContext,
) {
  const projectId = await resolveOrThrow(db, "project", input.projectId);
  const [productId] = await resolveAllOrThrow(db, "product", [input.productId]);
  if (!productId)
    throw createAppError(
      "PRODUCT_NOT_FOUND",
      `Product ${input.productId} not found`,
    );
  const usage = await setProjectToolUsage(
    db,
    projectId,
    productId,
    input.used,
    actor,
  );
  return {
    projectId: input.projectId,
    productId: input.productId,
    used: input.used,
    changed: usage.changed,
  };
}

export const projectHandlers = implementOperationDomain(projectContract, {
  getDependencyGraph: async (context, input) =>
    getProjectDependencyGraph(
      context.db,
      input?.projectId
        ? await resolveOrThrow(context.db, "project", input.projectId)
        : undefined,
    ),
  tree: async (context, input) => {
    const page = await projectTreePage(
      context.db,
      input.filters,
      normalizeSorts(input.sort),
      input.pagination,
    );
    return buildPaginatedResponse(
      input.pagination,
      page.data,
      page.count,
      page.sums,
    );
  },
  dashboardSummary: (context, input) =>
    projectDashboardSummary(context.db, input),
  portfolioAnalytics: (context, input) =>
    projectPortfolioAnalytics(context.db, input),
  createFromTasks: (context, input) =>
    projectCreateFromTasksWorkflow(context.db, input, context.actorContext),
  toolSuggestions: async (context, input) =>
    suggestProjectTools(
      context.db,
      await resolveOrThrow(context.db, "project", input.projectId),
    ),
  toolMatrix: (context, input) => projectToolMatrix(context.db, input),
  toolGallery: (context, input) => projectToolGallery(context.db, input),
  setToolUsage: (context, input) =>
    projectSetToolUsageWorkflow(context.db, input, context.actorContext),
});
