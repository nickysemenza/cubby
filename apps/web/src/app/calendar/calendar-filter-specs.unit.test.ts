import { calendarFilterFields } from "@cubby/schemas/calendar";
import { describe, expect, it } from "vitest";

import {
  buildFiltersFromManifest,
  filterGetterFromSearch,
} from "~/entities/filters";

import {
  calendarFilterSpecs,
  calendarScheduleFilterSpecs,
} from "./calendar-filter-specs";
import { buildCalendarFilters } from "./calendar-filters";
import { calendarSearchSchema } from "./calendar-search";

/**
 * The calendar's specs sit OUTSIDE `entityFilters`, so the registry's two drift
 * guards can't see them. These are the hand-written equivalents — without them
 * a new spec could name a URL key the route strips, or a wire field the input
 * schema rejects, and nothing would fail.
 */
describe("calendarFilterSpecs drift guards", () => {
  it("declares exactly the URL keys the route's search schema accepts", () => {
    const routeKeys = Object.keys(calendarSearchSchema.shape)
      .filter((key) => key !== "date" && key !== "day" && key !== "period")
      .sort();
    const specKeys = calendarFilterSpecs
      .map((spec) => spec.urlKey ?? spec.columnId)
      .sort();
    expect(specKeys).toEqual(routeKeys);
  });

  it("emits only fields the calendar range input declares", () => {
    const allowed = new Set(Object.keys(calendarFilterFields));
    for (const spec of calendarFilterSpecs) {
      expect(allowed).toContain(spec.field ?? spec.columnId);
      // oxlint-disable-next-line vitest/no-conditional-expect -- The data-dependent branch determines whether this optional case is applicable.
      if (spec.nullable) expect(allowed).toContain(spec.nullable.field);
    }
  });
});

describe("calendarScheduleFilterSpecs", () => {
  it("offers only the two Schedule kinds and filters that constrain them", () => {
    expect(calendarScheduleFilterSpecs.map((spec) => spec.columnId)).toEqual([
      "kinds",
      "project",
      "taskStatus",
      "taskTrade",
    ]);
    expect(
      calendarScheduleFilterSpecs[0]?.options?.map((item) => item.value),
    ).toEqual(["task", "planting"]);
  });
});

describe("buildCalendarFilters", () => {
  it("partitions sentinels, coerces the boolean, and keeps sets as arrays", () => {
    expect(
      buildFiltersFromManifest(
        calendarFilterSpecs,
        filterGetterFromSearch(calendarFilterSpecs, {
          kinds: "task,expense",
          project: "PRJ-4K7M,__none__",
          future: "true",
          taskStatus: "blocked",
        }),
      ),
    ).toEqual({
      kinds: ["task", "expense"],
      projectId: ["PRJ-4K7M"],
      projectPresenceFilter: "none",
      expenseFuture: true,
      taskStatus: ["blocked"],
    });
  });

  it("expands a project selection to its subtree, unprompted", () => {
    expect(buildCalendarFilters({ project: "PRJ-4K7M" })).toMatchObject({
      projectId: ["PRJ-4K7M"],
      includeSubProjects: true,
    });
  });

  it("leaves includeSubProjects off when no project is selected", () => {
    expect(buildCalendarFilters({ taskStatus: "blocked" })).not.toHaveProperty(
      "includeSubProjects",
    );
  });

  it("accepts the planting item kind alongside the others", () => {
    expect(buildCalendarFilters({ kinds: "planting,task" })).toEqual({
      kinds: ["planting", "task"],
    });
  });

  it("reads an old bookmark's kinds and projectKinds unchanged", () => {
    expect(
      buildCalendarFilters({ kinds: "meal,task", projectKinds: "renovation" }),
    ).toEqual({
      kinds: ["meal", "task"],
      projectKind: ["renovation"],
    });
  });
});
