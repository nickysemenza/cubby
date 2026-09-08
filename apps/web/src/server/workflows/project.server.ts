import type { ActorContext } from "@cubby/schemas/context";
import {
  buildPaginatedResponse,
  normalizeSorts,
} from "@cubby/schemas/pagination";
import {
  createProjectFromTasksInput,
  projectDashboardFiltersSchema,
  projectDashboardSummaryOut,
  projectOptionsOut,
  projectPortfolioAnalyticsOut,
  projectResourceMutationInput,
  projectResourceMutationOut,
  projectResourceProjectInput,
  projectResourcesOut,
  projectToolMatrixInput,
  projectToolMatrixOut,
  toolGalleryInput,
  toolGalleryOut,
  projectToolSuggestionsOut,
  projectToolUsageSetInput,
  projectToolUsageSetOut,
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
import { runMutationSideEffectsForEntities } from "~/server/services/mutation-side-effects";

export {
  createProjectFromTasksInput,
  projectDashboardFiltersSchema,
  projectResourceMutationInput,
  projectResourceProjectInput,
  projectToolMatrixInput,
  projectToolUsageSetInput,
  projectTreeInput,
  repointProjectUsesInput,
};

export const projectTreeWorkflow = (
  db: Database,
  input: z.output<typeof projectTreeInput>,
) =>
  projectTreePage(
    db,
    input.filters,
    normalizeSorts(input.sort),
    input.pagination,
  ).then(({ data, count, sums }) =>
    buildPaginatedResponse(input.pagination, data, count, sums),
  );

export const projectDashboardSummaryWorkflow = (
  db: Database,
  input: z.output<typeof projectDashboardFiltersSchema>,
) => projectDashboardSummary(db, input);

export const projectPortfolioAnalyticsWorkflow = (
  db: Database,
  input: z.output<typeof projectDashboardFiltersSchema>,
) => projectPortfolioAnalytics(db, input);

export const projectOptionsWorkflow = (db: Database) => projectNameOptions(db);

export const projectCreateFromTasksWorkflow = async (
  db: Database,
  input: z.output<typeof createProjectFromTasksInput>,
  actorContext: ActorContext,
) => {
  const { output, projectEntityId, taskEntityIds } =
    await createProjectFromTasks(db, input, actorContext);
  await runMutationSideEffectsForEntities(db, [
    {
      action: "created",
      entity: { entity: "project", id: projectEntityId },
      source: "project.createFromTasks",
    },
    ...taskEntityIds.map((entityId) => ({
      action: "updated" as const,
      entity: { entity: "task" as const, id: entityId },
      source: "project.createFromTasks",
    })),
  ]);
  return output;
};

const resolveProjectResourceIds = async (
  db: Database,
  input: { projectId: string; productIds?: string[] },
) => ({
  projectId: await resolveOrThrow(db, "project", input.projectId),
  productIds: input.productIds
    ? await resolveAllOrThrow(db, "product", input.productIds)
    : [],
});

export const projectResourcesWorkflow = async (
  db: Database,
  input: z.output<typeof projectResourceProjectInput>,
) =>
  listProjectResources(
    db,
    (await resolveProjectResourceIds(db, input)).projectId,
  );

export const projectToolSuggestionsWorkflow = async (
  db: Database,
  input: z.output<typeof projectResourceProjectInput>,
) =>
  suggestProjectTools(
    db,
    (await resolveProjectResourceIds(db, input)).projectId,
  );

export const projectAttachResourcesWorkflow = async (
  db: Database,
  input: z.output<typeof projectResourceMutationInput>,
  actorContext: ActorContext,
) => {
  const ids = await resolveProjectResourceIds(db, input);
  return attachProjectResources(
    db,
    ids.projectId,
    ids.productIds,
    actorContext,
  );
};

export const projectDetachResourcesWorkflow = async (
  db: Database,
  input: z.output<typeof projectResourceMutationInput>,
  actorContext: ActorContext,
) => {
  const ids = await resolveProjectResourceIds(db, input);
  return detachProjectResources(
    db,
    ids.projectId,
    ids.productIds,
    actorContext,
  );
};

export const projectRepointUsesWorkflow = async (
  db: Database,
  input: z.output<typeof repointProjectUsesInput>,
  actorContext: ActorContext,
) => {
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
    actorContext,
  );
};

export const projectToolMatrixWorkflow = (
  db: Database,
  input: z.output<typeof projectToolMatrixInput>,
) => projectToolMatrix(db, input);

export const projectToolGalleryWorkflow = (
  db: Database,
  input: z.output<typeof toolGalleryInput>,
) => projectToolGallery(db, input);

export const projectSetToolUsageWorkflow = async (
  db: Database,
  input: z.output<typeof projectToolUsageSetInput>,
  actorContext: ActorContext,
) => {
  const ids = await resolveProjectResourceIds(db, {
    projectId: input.projectId,
    productIds: [input.productId],
  });
  const productId = ids.productIds[0];
  if (!productId)
    throw createAppError(
      "PRODUCT_NOT_FOUND",
      `Product ${input.productId} not found`,
    );
  const { changed } = await setProjectToolUsage(
    db,
    ids.projectId,
    productId,
    input.used,
    actorContext,
  );
  return {
    projectId: input.projectId,
    productId: input.productId,
    used: input.used,
    changed,
  };
};

void projectOptionsOut;
void projectDashboardSummaryOut;
void projectPortfolioAnalyticsOut;
void projectResourcesOut;
void projectToolSuggestionsOut;
void projectToolMatrixOut;
void toolGalleryOut;
void projectResourceMutationOut;
void projectToolUsageSetOut;
