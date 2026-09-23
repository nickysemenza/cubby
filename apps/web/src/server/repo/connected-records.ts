import {
  connectedPathNodeSchema,
  connectedRecordsOutputSchema,
  type ConnectedRecordsInput,
  type ConnectedRecordsOutput,
} from "@cubby/schemas/connected-records";
import {
  connectedPathVariants,
  connectedViews,
} from "@cubby/schemas/connected-views";
import type { Entity } from "@cubby/schemas/entity";
import { allEntities, entityManifest } from "@cubby/schemas/entity-manifest";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { unwrapDb } from "~/server/repo/database-helpers";

import { labelSql } from "./entity-graph";
import { compileTraversal } from "./relatedness/traversal";

type PathNode = z.infer<typeof connectedPathNodeSchema>;

const entityByTable = new Map<string, Entity>(
  allEntities.flatMap((entity) => {
    const table = entityManifest[entity].dbTable;
    return table === null ? [] : [[table, entity] as const];
  }),
);

function resolveConnectedView(source: Entity, viewKey: string) {
  if (viewKey.startsWith("relation:")) {
    const key = viewKey.slice("relation:".length);
    const relation = entityManifest[source].relationships.find(
      (candidate) => candidate.key === key && candidate.cardinality === "many",
    );
    if (!relation) throw new Error(`Unknown relation view ${source}.${key}`);
    return {
      target: relation.target,
      routes: [[key]],
    };
  }
  const view = connectedViews[source].find(
    (candidate) => candidate.key === viewKey,
  );
  if (!view) throw new Error(`Unknown connected view ${source}.${viewKey}`);
  return view;
}

const nodeExpression = (entity: Entity, alias: string): SQL =>
  sql`jsonb_build_object(
    'entityType', ${entity}::text,
    'entityId', ${sql.raw(`${alias}."shortcode"`)},
    'label', ${labelSql(entity, alias)}
  )`;

export function compiledConnectedRoutes(source: Entity, viewKey: string) {
  const view = resolveConnectedView(source, viewKey);
  const variants = view.routes.flatMap((route) =>
    connectedPathVariants(source, route),
  );
  const distinct = new Map<string, (typeof variants)[number]>();
  for (const variant of variants) {
    if (variant.target !== view.target) {
      throw new Error(
        `Connected view ${source}.${viewKey} reaches ${variant.target}`,
      );
    }
    distinct.set(
      variant.steps.map((step) => `${step.direction}:${step.edge}`).join("|"),
      variant,
    );
  }
  return [...distinct.values()].map((variant, index) => {
    const traversal = compileTraversal(source, variant.steps, `c${index}_`, {
      root: "s",
      leaf: "t",
      to: view.target,
    });
    const nodes: { entity: Entity; alias: string }[] = [
      { entity: source, alias: "s" },
      ...traversal.hops.flatMap((hop) => {
        const entity = entityByTable.get(hop.table);
        return entity === undefined ? [] : [{ entity, alias: hop.alias }];
      }),
    ];
    if (nodes.at(-1)?.entity !== view.target) {
      throw new Error(`Connected view ${source}.${viewKey} has no target node`);
    }
    return {
      traversal,
      hops: nodes.length - 1,
      path: sql`jsonb_build_array(${sql.join(
        nodes.map((node) => nodeExpression(node.entity, node.alias)),
        sql`, `,
      )})`,
    };
  });
}

const pageRowSchema = z.object({
  totalCount: z.coerce.number().int().nonnegative(),
  items: z.array(
    z.object({
      targetId: z.string(),
      targetLabel: z.string(),
      shortestHops: z.number().int().positive(),
      paths: z.array(z.array(connectedPathNodeSchema).min(2)).min(1),
    }),
  ),
});

/** Complete, paged records and every witnessed provenance route. */
export async function getConnectedRecords(
  db: Database,
  input: ConnectedRecordsInput,
): Promise<ConnectedRecordsOutput> {
  const { source, viewKey } = input;
  const view = resolveConnectedView(source.entityType, viewKey);
  const routes = compiledConnectedRoutes(source.entityType, viewKey);
  if (routes.length === 0)
    throw new Error(`No routes for ${source.entityType}.${viewKey}`);
  const hopCounts = routes.map((route) => route.hops);
  const routeHopRange = {
    min: Math.min(...hopCounts),
    max: Math.max(...hopCounts),
  };
  if (input.targetIds?.length === 0) {
    return {
      targetEntity: view.target,
      totalCount: 0,
      items: [],
      routeHopRange,
    };
  }
  const rootTable = entityManifest[source.entityType].dbTable;
  if (!rootTable) throw new Error(`No local table for ${source.entityType}`);
  const rootLiveness = entityManifest[source.entityType].softDelete
    ? sql`AND s."deletedAt" IS NULL`
    : sql``;
  const targetFilter = input.targetIds
    ? sql`AND t."shortcode" IN (${sql.join(
        input.targetIds.map((id) => sql`${id}`),
        sql`, `,
      )})`
    : sql``;
  const routeQueries = routes.map(
    (route) => sql`
      SELECT t."shortcode" AS "targetId",
        ${labelSql(view.target, "t")} AS "targetLabel",
        ${route.hops}::int AS "hops",
        ${route.path} AS "path"
      FROM ${sql.raw(`"${rootTable}"`)} s
      ${route.traversal.joins}
      WHERE s."shortcode" = ${source.entityId}
        ${rootLiveness}
        ${targetFilter}
    `,
  );
  const result = await unwrapDb(db).execute(sql`
    WITH paths AS (${sql.join(routeQueries, sql` UNION ALL `)}),
      unique_paths AS (
        SELECT DISTINCT "targetId", "targetLabel", "hops", "path" FROM paths
      ),
      targets AS (
        SELECT "targetId", max("targetLabel") AS "targetLabel"
        FROM unique_paths GROUP BY "targetId"
      ),
      page AS (
        SELECT * FROM targets
        ORDER BY "targetLabel", "targetId"
        LIMIT ${input.limit ?? 20} OFFSET ${input.offset ?? 0}
      ),
      page_items AS (
        SELECT page."targetId", page."targetLabel",
          min(evidence."hops")::int AS "shortestHops",
          jsonb_agg(evidence."path" ORDER BY evidence."hops", evidence."path"::text) AS "paths"
        FROM page JOIN unique_paths evidence ON evidence."targetId" = page."targetId"
        GROUP BY page."targetId", page."targetLabel"
      )
    SELECT (SELECT count(*)::int FROM targets) AS "totalCount",
      COALESCE((SELECT jsonb_agg(to_jsonb(page_items) ORDER BY "targetLabel", "targetId") FROM page_items), '[]'::jsonb) AS "items"
  `);
  const row = pageRowSchema.parse(result.rows[0]);
  const items = row.items.map((item) => ({
    target: {
      entityType: view.target,
      entityId: item.targetId,
      label: item.targetLabel,
    } satisfies PathNode,
    paths: item.paths,
    shortestHops: item.shortestHops,
  }));
  return connectedRecordsOutputSchema.parse({
    targetEntity: view.target,
    totalCount: row.totalCount,
    items,
    routeHopRange,
  });
}
