import type { Entity } from "@cubby/schemas/entity";
import type { FieldExplanationOutput } from "@cubby/schemas/field-explanation";
import {
  fieldResolutionSchema,
  type FieldResolution,
} from "@cubby/schemas/field-resolution";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";

import { unwrapDb } from "./database-helpers";
import { expenseSpendingCategoryResolutionSql } from "./expense-category-resolution";
import { effectiveExpenseProjectSql } from "./expense-inheritance";
import {
  effectiveTaskProjectSql,
  eligibleParentTaskTradeSql,
} from "./task-project-inheritance";

type Evidence = NonNullable<FieldExplanationOutput["resolutionEvidence"]>;
const nodeSchema = z.object({
  shortcode: z.string(),
  name: z.string(),
  depth: z.number(),
  value: z.json(),
  assigned: z.boolean(),
});
type Node = z.infer<typeof nodeSchema>;
const source = (
  entityKind: "project" | "task" | "productCategory",
  node: Node | undefined,
) => (node ? { entityKind, entityId: node.shortcode, name: node.name } : null);

/** Match canonical inheritance's bounded traversal; expose only public identities. */
async function ancestors(
  db: Database,
  kind: "project" | "task" | "productCategory",
  start: SQL,
  field: string,
): Promise<Node[]> {
  const config =
    kind === "project"
      ? { table: "Project", parent: "parentProjectId" }
      : kind === "task"
        ? { table: "Task", parent: "parentTaskId" }
        : { table: "ProductCategory", parent: "parentId" };
  const table = sql.identifier(config.table);
  const parent = sql.identifier(config.parent);
  let value: SQL;
  let assigned: SQL;
  if (kind === "productCategory" && field === "feature") {
    value = sql`to_jsonb(p.feature)`;
    assigned = sql`p.feature IS NOT NULL`;
  } else if (kind === "productCategory") {
    value = sql`jsonb_build_object('mode',p."spendingCategoryMode",'category',(SELECT c.shortcode FROM "SpendingCategory" c WHERE c.id=p."spendingCategoryId" AND c."deletedAt" IS NULL))`;
    assigned = sql`p."spendingCategoryMode" <> 'inherit'`;
  } else if (kind === "project" && field === "locations") {
    value = sql`to_jsonb(p.locations)`;
    assigned = sql`p."locationsMode" = 'explicit'`;
  } else if (
    kind === "task" &&
    (field === "projectId" || field === "subjectProductId")
  ) {
    const target = field === "projectId" ? sql`"Project"` : sql`"Product"`;
    const column = sql.identifier(field);
    const mode = sql.identifier(
      field === "projectId" ? "projectMode" : "subjectProductMode",
    );
    value = sql`to_jsonb((SELECT c.shortcode FROM ${target} c WHERE c.id=p.${column} AND c."deletedAt" IS NULL))`;
    assigned = sql`p.${mode} = 'explicit' OR p.${column} IS NOT NULL`;
  } else {
    const trade = sql.identifier(kind === "project" ? "defaultTrade" : "trade");
    value = sql`to_jsonb(p.${trade})`;
    assigned = sql`p.${trade} IS NOT NULL`;
  }
  const maxDepth = kind === "productCategory" ? 3 : 100;
  const rows = await unwrapDb(db).execute(sql`
    WITH RECURSIVE ancestry AS (
      SELECT p.id,p.${parent} AS parent,p.shortcode,p.name,${value} AS value,${assigned} AS assigned,0 AS depth,ARRAY[p.id] AS visited
      FROM ${table} p WHERE p.id=${start} AND p."deletedAt" IS NULL
      UNION ALL
      SELECT p.id,p.${parent},p.shortcode,p.name,${value},${assigned},a.depth+1,a.visited||p.id
      FROM ancestry a JOIN ${table} p ON p.id=a.parent
      WHERE p."deletedAt" IS NULL AND a.depth<${maxDepth} AND NOT p.id=ANY(a.visited)
    ) SELECT shortcode,name,value,assigned,depth FROM ancestry ORDER BY depth`);
  return z.array(nodeSchema).parse(rows.rows);
}

async function eligibleTaskTradeSource(
  db: Database,
  shortcode: string,
  nodes: Node[],
) {
  const eligible = await unwrapDb(db).execute(sql`
    SELECT ${eligibleParentTaskTradeSql("t")} AS trade
    FROM "Task" t WHERE t.shortcode=${shortcode} AND t."deletedAt" IS NULL`);
  const parentEligible = z
    .array(z.object({ trade: z.string().nullable() }))
    .parse(eligible.rows)[0]?.trade;
  return parentEligible
    ? source(
        "task",
        nodes.find((node) => node.depth === 1),
      )
    : null;
}

/** Lazy evidence is loaded on the same snapshot as the authoritative resolution. */
export async function loadFieldResolutionEvidence(
  db: Database,
  entity: Entity,
  shortcode: string,
  field: string,
  resolution: FieldResolution | null,
): Promise<{ evidence: Evidence | null; truncated: boolean }> {
  if (!resolution) return { evidence: null, truncated: false };
  let nodes: Node[] = [];
  let kind: "project" | "task" | "productCategory" = "project";
  let fallbackSource: Evidence["fallbackSource"] = null;
  const extra: Evidence["hierarchy"] = [];
  if (entity === "expense" && field === "spendingCategoryId") {
    kind = "productCategory";
    nodes = await ancestors(
      db,
      kind,
      sql`(SELECT g."categoryId" FROM "Expense" e JOIN "Product" g ON g.id=e."productId" AND g."deletedAt" IS NULL WHERE e.shortcode=${shortcode} AND e."deletedAt" IS NULL)`,
      field,
    );
    const fallback = await unwrapDb(db).execute(
      sql`SELECT ${expenseSpendingCategoryResolutionSql("e", undefined, true)} AS resolution FROM "Expense" e WHERE e.shortcode=${shortcode} AND e."deletedAt" IS NULL`,
    );
    if (fallback.rows[0])
      fallbackSource = fieldResolutionSchema.parse(
        fallback.rows[0].resolution,
      ).sourceEntity;
  } else if (entity === "expense" && field === "trade") {
    nodes = await ancestors(
      db,
      kind,
      sql`(SELECT ${effectiveExpenseProjectSql("e")} FROM "Expense" e WHERE e.shortcode=${shortcode} AND e."deletedAt" IS NULL)`,
      field,
    );
    const row = (
      await unwrapDb(db).execute(
        sql`SELECT p.shortcode,p."defaultTrade" AS trade FROM "Expense" e JOIN "Purchase" p ON p.id=e."purchaseId" AND p."deletedAt" IS NULL WHERE e.shortcode=${shortcode} AND e."deletedAt" IS NULL AND e."lineKind"='principal'`,
      )
    ).rows[0];
    const purchase = z
      .object({ shortcode: z.string(), trade: z.string().nullable() })
      .safeParse(row);
    if (purchase.success && purchase.data.trade !== null) {
      fallbackSource = {
        entityKind: "purchase",
        entityId: purchase.data.shortcode,
        name: null,
      };
      extra.push({
        label: "Purchase default",
        entity: { entityKind: "purchase", entityId: purchase.data.shortcode },
        value: purchase.data.trade,
      });
    } else
      fallbackSource = source(
        kind,
        nodes.find((node) => node.assigned),
      );
  } else if (
    entity === "project" &&
    (field === "defaultTrade" || field === "locations")
  ) {
    nodes = await ancestors(
      db,
      kind,
      sql`(SELECT id FROM "Project" WHERE shortcode=${shortcode} AND "deletedAt" IS NULL)`,
      field,
    );
    fallbackSource = source(
      kind,
      nodes.find((node) => node.depth > 0 && node.assigned),
    );
  } else if (
    entity === "task" &&
    ["trade", "projectId", "subjectProductId"].includes(field)
  ) {
    kind = "task";
    nodes = await ancestors(
      db,
      kind,
      sql`(SELECT id FROM "Task" WHERE shortcode=${shortcode} AND "deletedAt" IS NULL)`,
      field,
    );
    fallbackSource = source(
      kind,
      nodes.find((node) => node.depth === 1 && node.assigned),
    );
    if (field === "trade") {
      fallbackSource = await eligibleTaskTradeSource(db, shortcode, nodes);
    }
    if (field === "trade" && !fallbackSource) {
      const projects = await ancestors(
        db,
        "project",
        sql`(SELECT ${effectiveTaskProjectSql("t")} FROM "Task" t WHERE t.shortcode=${shortcode} AND t."deletedAt" IS NULL)`,
        "defaultTrade",
      );
      fallbackSource = source(
        "project",
        projects.find((node) => node.assigned),
      );
      extra.push(
        ...projects.map((node) => ({
          label: "Project trade ancestry",
          entity: { entityKind: "project" as const, entityId: node.shortcode },
          value: {
            name: node.name,
            value: node.value,
            assigned: node.assigned,
          },
        })),
      );
    }
  } else if (
    entity === "productCategory" &&
    ["spendingCategoryId", "spendingCategoryMode", "feature"].includes(field)
  ) {
    kind = "productCategory";
    nodes = await ancestors(
      db,
      kind,
      sql`(SELECT id FROM "ProductCategory" WHERE shortcode=${shortcode} AND "deletedAt" IS NULL)`,
      field,
    );
    fallbackSource = source(
      kind,
      nodes.find((node) => node.depth > 0 && node.assigned),
    );
  }
  const hierarchy = [
    ...extra,
    ...nodes.map((node) => ({
      label:
        kind === "productCategory"
          ? "Product category ancestry"
          : kind === "task"
            ? "Task ancestry"
            : "Project ancestry",
      entity: { entityKind: kind, entityId: node.shortcode },
      value: { name: node.name, value: node.value, assigned: node.assigned },
    })),
  ];
  return {
    evidence: { hierarchy: hierarchy.slice(0, 50), fallbackSource },
    truncated: hierarchy.length > 50,
  };
}
