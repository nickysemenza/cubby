import type { EntityReportOut } from "@cubby/schemas/entity-report";

import { reportDependency } from "~/server/generic/entity-report/repo/dependency";
import { recipeId } from "~/server/generic/entity-report/repo/record-dependencies";

/**
 * Recipe reports load the costing and availability engines; keep them off every other report's
 * closure, and off the Worker's first-request path.
 */
const recipeBuilder = (
  name: "recipeAvailabilityReport" | "recipeCostingCoverageReport",
) =>
  reportDependency(async (execution): Promise<EntityReportOut> => {
    const { id: code, services } = execution.request;
    if (!services) throw new Error("This report needs the request's services.");
    return {
      blocks: await (
        await import("~/server/domains/recipe/repo/report-recipe")
      )[name](code, await execution.read(recipeId), services),
    };
  });

export const reportBindings = {
  "recipe.availability": recipeBuilder("recipeAvailabilityReport"),
  "recipe.costing-coverage": recipeBuilder("recipeCostingCoverageReport"),
  "recipe.walkthrough": reportDependency(async (execution) => ({
    blocks: await (
      await import("~/server/domains/recipe/repo/report-recipe-walkthrough")
    ).recipeWalkthroughReport(
      execution.request.db,
      execution.request.id,
      await execution.read(recipeId),
    ),
  })),
};
