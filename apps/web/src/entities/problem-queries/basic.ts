import { PROBLEM_CLASS } from "@cubby/schemas/problems";

import { defineProblem, type ProblemQuery } from "~/entities/problem-query";

/** Exact entity-grain Problems whose membership is a small reusable assembly. */
export const basicProblemQueries = [
  defineProblem({
    key: "unclassifiedExpenses",
    problemClass: PROBLEM_CLASS.unclassifiedExpenses,
    executionLane: "tracker",
    continuation: { kind: "entity-list" },
    freshness: { kind: "live" },
    title: "Unclassified expenses",
    description:
      "Principal expense lines still using the Other trade with no cost recorded.",
    emptyMessage: "Every principal expense has a trade and cost.",
    source: {
      kind: "entity",
      entity: "expense",
      filters: [
        { id: "trade", value: ["other"] },
        { id: "lineKind", value: ["principal"] },
        // `"none"`, not `FILTER_NONE`: `cost` is a range preset whose expander
        // accepts the literal, where the sentinel is the multiselect spelling.
        { id: "cost", value: "none" },
      ],
      sort: [{ id: "date", desc: false }],
      columnVisibility: { trade: true, lineKind: true, cost: true },
    },
  }),
  defineProblem({
    key: "vendorsWithoutLogos",
    problemClass: PROBLEM_CLASS.vendorsWithoutLogos,
    executionLane: "fast",
    continuation: { kind: "entity-list" },
    freshness: { kind: "live" },
    title: "Active vendors without logos",
    description:
      "Vendors with at least one live purchase and no displayable logo image.",
    emptyMessage: "Every active vendor has a logo.",
    source: {
      kind: "entity",
      entity: "vendor",
      filters: [
        { id: "purchaseCount", value: "1" },
        { id: "logo", value: "none" },
      ],
      sort: [{ id: "purchaseCount", desc: true }],
      columnVisibility: { logo: true, purchaseCount: true },
    },
  }),
  defineProblem({
    key: "imageProcessingIssues",
    problemClass: PROBLEM_CLASS.imageProcessingIssues,
    executionLane: "fast",
    continuation: { kind: "entity-list" },
    freshness: { kind: "live" },
    title: "Image processing attention",
    description:
      "Uploaded images whose current processing failed or needs an eligibility review.",
    emptyMessage:
      "Current image processing has no failures or review findings.",
    source: {
      kind: "entity",
      entity: "image",
      filters: [{ id: "processingIssue", value: ["failed", "review_needed"] }],
      sort: [{ id: "createdAt", desc: false }],
      columnVisibility: { filename: true },
    },
  }),
] as const satisfies readonly ProblemQuery[];
