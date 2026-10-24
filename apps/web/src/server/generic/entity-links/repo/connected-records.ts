import {
  connectedPathNodeSchema,
  connectedRecordsOutputSchema,
  type ConnectedRecordsInput,
  type ConnectedRecordsOutput,
  type ConnectedRecordsPreviewInput,
  type ConnectedRecordsPreviewOutput,
} from "@cubby/schemas/connected-records";
import type { DerivedConnectedRelationship } from "@cubby/schemas/connected-views";
import {
  connectedPathVariants,
  connectionCatalog,
} from "@cubby/schemas/connected-views";
import type { Entity } from "@cubby/schemas/entity";
import type { RelationshipWitness } from "@cubby/schemas/entity-integrity";
import { allEntities, entityManifest } from "@cubby/schemas/entity-manifest";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { unwrapDb } from "~/server/db/helpers";
import { purchaseAssociatedEmailsSql } from "~/server/domains/email/repo/email-sql";
import { labelSql } from "~/server/generic/entity-graph/repo/entity-graph";
import { compileTraversal } from "~/server/generic/relatedness/repo/traversal";

type PathNode = z.infer<typeof connectedPathNodeSchema>;

const entityByTable = new Map<string, Entity>(
  allEntities.flatMap((entity) => {
    const table = entityManifest[entity].dbTable;
    return table === null ? [] : [[table, entity] as const];
  }),
);

function resolveConnectedView(source: Entity, viewKey: string) {
  const view = connectionCatalog.resolve(source, viewKey);
  if (!view) throw new Error(`Unknown connected view ${source}.${viewKey}`);
  return view;
}

const nodeExpression = (
  entity: Entity,
  alias: string,
  via?: RelationshipWitness,
): SQL =>
  sql`jsonb_build_object(
    'entityKind', ${entity}::text,
    'entityId', ${sql.raw(`${alias}."shortcode"`)},
    'label', ${labelSql(entity, alias)}
    ${via ? sql`, 'via', ${JSON.stringify(via)}::jsonb` : sql``}
  )`;

export function compiledConnectedRoutes(source: Entity, viewKey: string) {
  const view = resolveConnectedView(source, viewKey);
  if (view.kind === "derived") return [];
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
      JSON.stringify(variant.witnesses) +
        variant.steps
          .map((step) => `${step.direction}:${step.edge}`)
          .join("|") +
        (variant.derived
          ? `|${variant.derived.source}.${variant.derived.key}`
          : ""),
      variant,
    );
  }
  return [...distinct.values()].map((variant, index) => {
    const traversal = compileTraversal(source, variant.steps, `c${index}_`, {
      root: "s",
      leaf: variant.derived ? "derived_source" : "t",
      to: variant.derived?.source ?? view.target,
    });
    const nodes: {
      entity: Entity;
      alias: string;
      via?: RelationshipWitness;
    }[] = [
      { entity: source, alias: "s" },
      ...traversal.hops.flatMap((hop, index) => {
        const entity = entityByTable.get(hop.table);
        return entity === undefined
          ? []
          : [
              {
                entity,
                alias: hop.alias,
                via: variant.witnesses.find(
                  (item) => item.stepCount === index + 1,
                )?.witness,
              },
            ];
      }),
    ];
    const derivedJoin = variant.derived
      ? derivedConnectionJoin(variant.derived, traversal.leafAlias, "t")
      : sql``;
    if (variant.derived)
      nodes.push({
        entity: view.target,
        alias: "t",
        via: variant.witnesses.at(-1)?.witness,
      });
    if (nodes.at(-1)?.entity !== view.target) {
      throw new Error(`Connected view ${source}.${viewKey} has no target node`);
    }
    return {
      traversal: {
        ...traversal,
        joins: sql`${traversal.joins} ${derivedJoin}`,
      },
      hops: nodes.length - 1,
      path: sql`jsonb_build_array(${sql.join(
        nodes.map((node) => nodeExpression(node.entity, node.alias, node.via)),
        sql`, `,
      )})`,
    };
  });
}

/** Each derived terminal reuses its owning policy rather than guessing physical links. */
const derivedJoinBuilders = {
  purchaseEmails: (sourceAlias: string, targetAlias: string) =>
    sql`JOIN LATERAL (${purchaseAssociatedEmailsSql(sql.raw(`${sourceAlias}."id"`))}) ${sql.raw(targetAlias)} ON true`,
} satisfies Record<
  DerivedConnectedRelationship["resolver"],
  (sourceAlias: string, targetAlias: string) => SQL
>;

function derivedConnectionJoin(
  derived: DerivedConnectedRelationship,
  sourceAlias: string,
  targetAlias: string,
): SQL {
  return derivedJoinBuilders[derived.resolver](sourceAlias, targetAlias);
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

/** Shared page query for individual tables and the batched detail preview. */
function prepareConnectedPage(input: ConnectedRecordsInput) {
  const { source, viewKey } = input;
  const view = resolveConnectedView(source.entityKind, viewKey);
  // A derived relation has no edge path to witness; its list filter is the
  // whole answer, so there is no per-record route evidence to return.
  if (view.kind === "derived" || input.targetIds?.length === 0)
    return { target: view.target, query: null };
  const routes = compiledConnectedRoutes(source.entityKind, viewKey);
  if (routes.length === 0)
    throw new Error(`No routes for ${source.entityKind}.${viewKey}`);
  const rootTable = entityManifest[source.entityKind].dbTable;
  if (!rootTable) throw new Error(`No local table for ${source.entityKind}`);
  const rootLiveness = entityManifest[source.entityKind].softDelete
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
  const query = sql`
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
  `;
  return { target: view.target, query };
}

function connectedPage(target: Entity, value: unknown): ConnectedRecordsOutput {
  const row = pageRowSchema.parse(value);
  const items = row.items.map((item) => ({
    target: {
      entityKind: target,
      entityId: item.targetId,
      label: item.targetLabel,
    } satisfies PathNode,
    paths: item.paths,
    shortestHops: item.shortestHops,
  }));
  return connectedRecordsOutputSchema.parse({
    targetEntity: target,
    totalCount: row.totalCount,
    items,
  });
}

const emptyPage = { totalCount: 0, items: [] };
const emptyPageQuery = sql`SELECT 0::int AS "totalCount", '[]'::jsonb AS "items"`;

/** Complete, paged records and every witnessed provenance route. */
export async function getConnectedRecords(
  db: Database,
  input: ConnectedRecordsInput,
): Promise<ConnectedRecordsOutput> {
  const plan = prepareConnectedPage(input);
  if (!plan.query) return connectedPage(plan.target, emptyPage);
  const result = await unwrapDb(db).execute(plan.query);
  return connectedPage(plan.target, result.rows[0]);
}

/** Every requested group shares one statement while retaining its own complete count and page. */
export async function getConnectedRecordsPreview(
  db: Database,
  input: ConnectedRecordsPreviewInput,
): Promise<ConnectedRecordsPreviewOutput> {
  const views = connectionCatalog.views(input.source.entityKind, input.scope);
  if (views.length === 0) return { views: [] };
  const queries = views.map((view, index) => {
    const { query } = prepareConnectedPage({
      source: input.source,
      viewKey: view.key,
      limit: input.limit ?? 3,
    });
    return sql`SELECT ${index}::int AS "viewIndex", page."totalCount", page."items" FROM (${query ?? emptyPageQuery}) page`;
  });
  const result = await unwrapDb(db).execute(
    sql`${sql.join(queries, sql` UNION ALL `)} ORDER BY "viewIndex"`,
  );
  const rows = z
    .array(pageRowSchema.extend({ viewIndex: z.number().int().nonnegative() }))
    .parse(result.rows);
  if (rows.length !== views.length)
    throw new Error("Incomplete connected-record preview");
  return {
    views: rows.map((row) => {
      const view = views[row.viewIndex];
      if (!view)
        throw new Error(
          `Unknown connected-record preview index ${row.viewIndex}`,
        );
      return {
        ...connectedPage(view.target, row),
        viewKey: view.key,
        title: view.title,
        evidence: view.evidence ?? false,
      };
    }),
  };
}
