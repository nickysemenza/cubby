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
  startDate: string | null;
  endDate: string | null;
  icon: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Rollup returned for a project with no purchases/tasks yet. */
export const EMPTY_PROJECT_ROLLUP: ProjectRollup = {
  spent: 0,
  purchaseCount: 0,
  taskCount: 0,
  doneTaskCount: 0,
};

export const dbProjectToAPI = (
  row: ProjectRow,
  rollup: ProjectRollup,
  blockedByIds: ProjectId[],
  blockingIds: ProjectId[],
): ProjectOut => ({
  id: row.id,
  name: row.name,
  status: row.status,
  kind: row.kind,
  locations: row.locations,
  costEstimate: row.costEstimate,
  startDate: row.startDate,
  endDate: row.endDate,
  icon: row.icon,
  notes: row.notes,
  blockedByIds,
  blockingIds,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  rollup,
});
