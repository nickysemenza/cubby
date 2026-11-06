import { reportBuilder } from "~/server/generic/entity-report/repo/dependency";

export const reportBindings = {
  "meal.composition": reportBuilder(async (db, id) =>
    (
      await import("~/server/domains/meal/repo/report-meal")
    ).mealCompositionReport(db, id),
  ),
};
