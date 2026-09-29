/**
 * Shared recursive membership for task reads that need to distinguish work
 * that is ready from work blocked manually, by another task, or by a project
 * dependency on any live ancestor. Keep this as one SQL source: summary and
 * Today must agree with `listActionableTasks` about what is blocked.
 */
import { sql } from "drizzle-orm";

export const openTaskBlockingCtes = sql`
  WITH RECURSIVE project_ancestors AS (
    SELECT p."id" AS "projectId", p."id" AS "ancestorId", 0 AS depth
    FROM "Project" p
    WHERE p."deletedAt" IS NULL
    UNION ALL
    SELECT pa."projectId", parent."id", pa.depth + 1
    FROM project_ancestors pa
    JOIN "Project" current ON current."id" = pa."ancestorId"
    JOIN "Project" parent
      ON parent."id" = current."parentProjectId"
     AND parent."deletedAt" IS NULL
    WHERE pa.depth < 100
  ), blocked_tasks AS (
    SELECT t."id"
    FROM "Task" t
    WHERE t."deletedAt" IS NULL AND t."status" = 'blocked'
    UNION
    SELECT td."fromEntityId"
    FROM "EntityLink" td
    JOIN "Task" blocker
      ON td."kind" = 'taskDependency' AND td."deletedAt" IS NULL
     AND blocker."id" = td."toEntityId"
     AND blocker."deletedAt" IS NULL
     AND blocker."status" <> 'done'
    UNION
    SELECT t."id"
    FROM "Task" t
    JOIN project_ancestors pa ON pa."projectId" = t."projectId"
    JOIN "Project" owner
      ON owner."id" = pa."ancestorId"
     AND owner."deletedAt" IS NULL
     AND owner."status" <> 'done'
    JOIN "EntityLink" pd
      ON pd."fromEntityId" = owner."id"
     AND pd."kind" = 'projectDependency' AND pd."deletedAt" IS NULL
    JOIN "Project" blocker
      ON blocker."id" = pd."toEntityId"
     AND blocker."deletedAt" IS NULL
     AND blocker."status" <> 'done'
    WHERE t."deletedAt" IS NULL
  )
`;
