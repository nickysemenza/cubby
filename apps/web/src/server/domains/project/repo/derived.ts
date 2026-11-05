/**
 * Project snapshot folds: completion year and subtree rollups. Effective
 * start reads the declared SQL view.
 */
import type { ProjectId } from "@cubby/schemas/identifiers";

import type { Database, DrizzleTransaction } from "~/server/db";
import { isTransaction } from "~/server/db/helpers";
import type {
  DerivedCompute,
  DerivedComputed,
} from "~/server/generic/derived/repo/compute";

import {
  loadProjectDateWindows,
  loadProjectSubtreeRollups,
  loadProjectTree,
  projectCompletionYear,
} from "./subtree";

// The drain computes outside its publication transaction (ADR 0021).
const readDatabase = (db: Database | DrizzleTransaction): Database => {
  if (isTransaction(db))
    throw new Error("Project dates compute outside a transaction");
  return db;
};

const completionYearCompute: DerivedCompute = async (db, ids) => {
  const tree = await loadProjectTree(readDatabase(db));
  const { dateWindows } = await loadProjectDateWindows(readDatabase(db), tree);
  const out = new Map<string, DerivedComputed>();
  for (const id of ids) {
    // SAFETY: the drain passes ids of `project.completionYear` marks only.
    const projectId = id as ProjectId;
    const row = tree.rowsById.get(projectId);
    const window = dateWindows.get(projectId);
    if (!row || !window) continue;
    const year = projectCompletionYear(row, window);
    out.set(id, { value: year, sort: year });
  }
  return out;
};

const rollupsCompute: DerivedCompute = async (db, ids) => {
  const loaded = await loadProjectSubtreeRollups(readDatabase(db));
  const out = new Map<string, DerivedComputed>();
  for (const row of loaded.allRows) {
    if (!ids.includes(row.id)) continue;
    const own = loaded.ownRollups.get(row.id);
    const subtree = loaded.subtreeRollups.get(row.id);
    const dateWindow = loaded.dateWindows.get(row.id);
    if (!own || !subtree || !dateWindow) continue;
    const value = {
      rollup: { ...own, subtree },
      dateWindow,
      taskProgress: `${own.doneTaskCount}/${own.taskCount}`,
      ownContentDates: loaded.ownContentDates.get(row.id) ?? {
        contentStart: null,
        contentEnd: null,
      },
    };
    out.set(row.id, { value, sort: null });
  }
  return out;
};

export const projectDerivedComputes = {
  "project.rollups": rollupsCompute,
  "project.completionYear": completionYearCompute,
};
