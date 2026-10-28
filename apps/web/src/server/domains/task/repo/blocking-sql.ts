/**
 * Shared recursive membership for task reads that need to distinguish work
 * that is ready from work blocked manually, by another task, or by a project
 * dependency on any live ancestor. Keep this as one SQL source: summary and
 * Today must agree with `listActionableTasks` about what is blocked.
 */
import { sql } from "drizzle-orm";

import { notDeleted } from "~/server/db/helpers/predicates";

export const openTaskBlockingCtes = sql`
  WITH RECURSIVE project_ancestors AS (
    SELECT p."id" AS "projectId", p."id" AS "ancestorId", 0 AS depth
    FROM "Project" p
    WHERE ${notDeleted("p")}
    UNION ALL
    SELECT pa."projectId", parent."id", pa.depth + 1
    FROM project_ancestors pa
    JOIN "Project" current ON current."id" = pa."ancestorId"
    JOIN "Project" parent
      ON parent."id" = current."parentProjectId"
     AND ${notDeleted("parent")}
    WHERE pa.depth < 100
  ), blocked_tasks AS (
    SELECT t."id"
    FROM "Task" t
    WHERE ${notDeleted("t")} AND t."status" = 'blocked'
    UNION
    SELECT td."fromEntityId"
    FROM "EntityLink" td
    JOIN "Task" blocker
      ON td."kind" = 'taskDependency' AND ${notDeleted("td")}
     AND blocker."id" = td."toEntityId"
     AND ${notDeleted("blocker")}
     AND blocker."status" <> 'done'
    UNION
    SELECT t."id"
    FROM "Task" t
    JOIN project_ancestors pa ON pa."projectId" = t."projectId"
    JOIN "Project" owner
      ON owner."id" = pa."ancestorId"
     AND ${notDeleted("owner")}
     AND owner."status" <> 'done'
    JOIN "EntityLink" pd
      ON pd."fromEntityId" = owner."id"
     AND pd."kind" = 'projectDependency' AND ${notDeleted("pd")}
    JOIN "Project" blocker
      ON blocker."id" = pd."toEntityId"
     AND ${notDeleted("blocker")}
     AND blocker."status" <> 'done'
    WHERE ${notDeleted("t")}
  )
`;
