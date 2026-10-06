import { sql } from "drizzle-orm";

import { project } from "~/server/db/schema";

import { defineEntityChecks } from "../registry";

type Project = typeof project;

export const projectChecks = defineEntityChecks({
  entity: "project",
  table: project,
  checks: {
    project_kind: {
      missing: (t: Project) => sql`${t.kind} IS NULL`,
    },
    project_start_date: {
      // `planning` and `not_started` have no actual start yet; only work
      // that has begun (or finished) expects one.
      expected: (t: Project) => sql`${t.status} IN ('in_progress', 'done')`,
      missing: (t: Project) => sql`${t.startDate} IS NULL`,
    },
    project_date_order: {
      expected: (t: Project) =>
        sql`${t.startDate} IS NOT NULL AND ${t.endDate} IS NOT NULL`,
      missing: (t: Project) => sql`${t.endDate} < ${t.startDate}`,
    },
  },
});
