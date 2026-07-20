import type { ProjectId } from "@cubby/schemas/identifiers";
import type { ProjectOut, ProjectRollup } from "@cubby/schemas/project";

/** Shape of a `project` row as returned by a plain (no relations) select. */
type ProjectRow = {
  id: ProjectOut["id"];
  name: string;
  status: ProjectOut["status"];
  kind: ProjectOut["kind"];
  locations: string[];
  costEstimate: number | null;
  parentProjectId: ProjectId | null;
  startDate: string | null;
  endDate: string | null;
  icon: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** This project's own (non-recursive) rollup — see `ProjectRollup`'s doc comment. */
export type ProjectOwnRollup = Omit<ProjectRollup, "subtree">;
export type ProjectSubtreeRollup = ProjectRollup["subtree"];

/** Own-rollup zeros — the per-project aggregate for a project with no purchases/tasks yet. */
export const EMPTY_PROJECT_OWN_ROLLUP: ProjectOwnRollup = {
  spent: 0,
  purchaseCount: 0,
  taskCount: 0,
  doneTaskCount: 0,
};

/** Subtree-rollup zeros — a project with no live descendants. */
export const EMPTY_PROJECT_SUBTREE_ROLLUP: ProjectSubtreeRollup = {
  spent: 0,
  purchaseCount: 0,
  taskCount: 0,
  doneTaskCount: 0,
  projectCount: 0,
  costEstimate: null,
};

export const dbProjectToAPI = (
  row: ProjectRow,
  ownRollup: ProjectOwnRollup,
  subtreeRollup: ProjectSubtreeRollup,
  blockedByIds: ProjectId[],
  blockingIds: ProjectId[],
  parentProjectName: string | null,
  childProjectIds: ProjectId[],
): ProjectOut => ({
  id: row.id,
  name: row.name,
  status: row.status,
  kind: row.kind,
  locations: row.locations,
  costEstimate: row.costEstimate,
  parentProjectId: row.parentProjectId,
  parentProjectName,
  childProjectIds,
  startDate: row.startDate,
  endDate: row.endDate,
  icon: row.icon,
  notes: row.notes,
  blockedByIds,
  blockingIds,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  rollup: { ...ownRollup, subtree: subtreeRollup },
});
