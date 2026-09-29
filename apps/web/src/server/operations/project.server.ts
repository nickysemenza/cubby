import type { ActorContext } from "@cubby/schemas/context";
import {
  buildPaginatedResponse,
  normalizeSorts,
} from "@cubby/schemas/pagination";
import {
  type createProjectFromTasksInput,
  LIVE_PROJECT_STATUSES,
  type projectToolUsageSetInput,
  type repointProjectUsesInput,
} from "@cubby/schemas/project";
import { sumBy } from "es-toolkit";
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
  // Mirrors the UI's Overview default (live statuses) rather than the filter
  // schema's "no status condition", so an unscoped call doesn't balloon with
  // completed-project history.
  houseStatus: (context, input) =>
    projectDashboardSummary(context.db, {
      statusScope: [...LIVE_PROJECT_STATUSES],
      ...input,
    }),
  budget: async (context, input) =>
    projectBudget(await projectPortfolioAnalytics(context.db, input)),
  repointUses: (context, input) =>
    projectRepointUsesWorkflow(context.db, input, context.actorContext),
});

/**
 * Budget rows sorted worst overrun first; unbudgeted rows sink to the bottom
 * ordered by projected spend (they're the missing-budget attention items).
 */
function projectBudget(
  analytics: Awaited<ReturnType<typeof projectPortfolioAnalytics>>,
) {
  const projects = analytics.costVsEstimate
    .map((row) => {
      const projected = row.actual + row.committed;
      const estimate = row.estimate;
      return {
        ...row,
        projected,
        remaining: estimate === null ? null : estimate - projected,
        percentUsed:
          estimate === null || estimate <= 0
            ? null
            : Math.round((projected / estimate) * 100),
        overBudget: estimate !== null && projected > estimate,
      };
    })
    .sort((a, b) => {
      if (a.remaining === null || b.remaining === null) {
        if (a.remaining === b.remaining) return b.projected - a.projected;
        return a.remaining === null ? 1 : -1;
      }
      return a.remaining - b.remaining || b.projected - a.projected;
    });

  // Totals sum SCOPE ROOTS only. Every row is a subtree rollup, so totalling
  // all of them counts an in-scope child twice — once in its own row and once
  // inside its parent's. The rows stay complete; only totals are deduplicated.
  const scopeRoots = projects.filter((p) => p.isScopeRoot);
  return {
    projects,
    totals: {
      estimate: sumBy(scopeRoots, (p) => p.estimate ?? 0),
      actual: sumBy(scopeRoots, (p) => p.actual),
      committed: sumBy(scopeRoots, (p) => p.committed),
      projected: sumBy(scopeRoots, (p) => p.projected),
      overBudgetCount: projects.filter((p) => p.overBudget).length,
      missingEstimateCount: projects.filter((p) => p.estimate === null).length,
    },
    plannedVsActualByMonth: analytics.plannedVsActual,
  };
}
