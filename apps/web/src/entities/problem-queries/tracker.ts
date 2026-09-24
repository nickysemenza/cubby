import { FILTER_NONE } from "~/entities/filters";
import { defineProblem, type ProblemQuery } from "~/entities/problem-query";

/**
 * Canonical tracker declarations. The `attention` project filter delegates
 * membership to `computeAttentionItems`, so list continuation and Problems
 * share one implementation for the three project-grain rules.
 */
export const trackerProblemQueries = [
  defineProblem({
    key: "overdueTasks",
    problemClass: "defect",
    executionLane: "tracker",
    freshness: { kind: "live" },
    continuation: { kind: "entity-list" },
    title: "Overdue tasks",
    description:
      "Open top-level tasks whose effective due date is before today.",
    emptyMessage: "No open top-level tasks are overdue.",
    source: {
      kind: "entity",
      entity: "task",
      filters: [
        { id: "dueRelative", value: "beforeToday" },
        { id: "completion", value: "open" },
        { id: "parentTaskId", value: [FILTER_NONE] },
      ],
      sort: [{ id: "dueDate", desc: false }],
      columnVisibility: { dueDate: true, status: true, project: true },
    },
  }),
  defineProblem({
    key: "stalledProjects",
    problemClass: "defect",
    executionLane: "tracker",
    freshness: { kind: "live" },
    continuation: { kind: "entity-list" },
    title: "Stalled projects",
    description:
      "In-progress projects with no project, task, or expense activity in 30 days.",
    emptyMessage: "No in-progress projects are stalled.",
    source: {
      kind: "entity",
      entity: "project",
      filters: [{ id: "attention", value: "stalled" }],
      sort: [{ id: "updatedAt", desc: false }],
      columnVisibility: { status: true, updatedAt: true },
    },
  }),
  defineProblem({
    key: "projectsMissingBudget",
    problemClass: "defect",
    executionLane: "tracker",
    freshness: { kind: "live" },
    continuation: { kind: "entity-list" },
    title: "Projects missing a budget",
    description:
      "Live projects with actual or committed subtree spend but no cost estimate.",
    emptyMessage: "Every live project with spend has a budget estimate.",
    source: {
      kind: "entity",
      entity: "project",
      filters: [{ id: "attention", value: "missing_budget" }],
      sort: [{ id: "costEstimate", desc: false }],
      columnVisibility: { costEstimate: true, status: true },
    },
  }),
  defineProblem({
    key: "blockedWorkProjects",
    problemClass: "defect",
    executionLane: "tracker",
    freshness: { kind: "live" },
    continuation: { kind: "entity-list" },
    title: "Blocked projects with no next action",
    description:
      "In-progress projects with blocked work and no unblocked next task.",
    emptyMessage: "Every in-progress project has an available next action.",
    source: {
      kind: "entity",
      entity: "project",
      filters: [{ id: "attention", value: "blocked_no_next_action" }],
      sort: [{ id: "updatedAt", desc: false }],
      columnVisibility: { status: true },
    },
  }),
  defineProblem({
    key: "projectsWithDateDrift",
    problemClass: "defect",
    executionLane: "tracker",
    freshness: { kind: "live" },
    continuation: {
      kind: "none",
      reason: "One project can emit separate start and end date violations.",
    },
    title: "Projects with date-window drift",
    description:
      "Manual date overrides that hide derived task or expense work windows.",
    emptyMessage: "No project date override hides derived work.",
    source: {
      kind: "derived",
      diagnostic: "project-date-window-drift",
      grain: "edge",
      inputs: [{ entity: "project", filters: [] }],
      operations: [
        { label: "Fold task and expense dates through live sub-projects" },
        { label: "Keep each too-narrow start or end override" },
      ],
    },
  }),
] as const satisfies readonly ProblemQuery[];
