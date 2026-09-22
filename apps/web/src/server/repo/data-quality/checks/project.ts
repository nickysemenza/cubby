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
      // A project still in `planning` has no committed start; every other
      // status expects one.
      expected: (t: Project) => sql`${t.status} <> 'planning'`,
      missing: (t: Project) => sql`${t.startDate} IS NULL`,
    },
  },
});
