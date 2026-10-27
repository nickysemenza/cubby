import { fieldProvenance } from "@cubby/schemas/field-envelope";
/**
 * Project's stored folded dates (ADR 0021): the effective start (the list's
 * recursive SQL, evaluated for changed projects only) and the completion year
 * (the whole-tree TS fold, read once per batch).
 */
import type { ProjectId } from "@cubby/schemas/identifiers";
import { sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { isTransaction } from "~/server/db/helpers";
import { project } from "~/server/db/schema";
import type {
  DerivedCompute,
  DerivedComputed,
} from "~/server/generic/derived/repo/compute";
import { sqlColumnCompute } from "~/server/generic/derived/repo/sql-compute";

import { projectStartDateSql } from "./lookup";
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
  "project.startDate": sqlColumnCompute(
    { table: project, id: project.id, deletedAt: project.deletedAt },
    sql`(${projectStartDateSql})::text`,
    {
      provenance: sql`CASE WHEN ${project.startDate} IS NOT NULL
        THEN ${JSON.stringify(fieldProvenance.parse({ kind: "own", ownership: { kind: "record" } }))}::jsonb
        ELSE ${JSON.stringify(fieldProvenance.parse({ kind: "computed" }))}::jsonb END`,
    },
  ),
  "project.completionYear": completionYearCompute,
};
