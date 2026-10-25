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

export const projectDerivedComputes = {
  "project.startDate": sqlColumnCompute(
    { table: project, id: project.id, deletedAt: project.deletedAt },
    sql`(${projectStartDateSql})::text`,
  ),
  "project.completionYear": completionYearCompute,
};
