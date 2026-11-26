import {
  connectedPathNodeSchema,
  connectedRecordsOutputSchema,
  type ConnectedRecordsInput,
  type ConnectedRecordsOutput,
  type ConnectedRecordsPreviewInput,
  type ConnectedRecordsPreviewOutput,
} from "@cubby/schemas/connected-records";
import {
  connectedPathVariants,
  connectionCatalog,
} from "@cubby/schemas/connected-views";
import { entityRefKey, type Entity } from "@cubby/schemas/entity";
import type { RelationshipWitness } from "@cubby/schemas/entity-integrity";
import { allEntities, entityManifest } from "@cubby/schemas/entity-manifest";
import type { ImageUrlSummary } from "@cubby/schemas/image-summary";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import {
  boundTransaction,
  unwrapDb,
  withTransactionDatabase,
} from "~/server/db/helpers";
import { notDeleted } from "~/server/db/helpers/predicates";
import { textArrayParam } from "~/server/db/helpers/query";
import { resolvePublicEntityDisplayImages } from "~/server/entity-kernel/repo/entity-display-image";
import { isStatementTimeout } from "~/server/errors/db-errors";
import { labelSql } from "~/server/generic/entity-graph/repo/record-label";
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

const nodeExpression = async (
  entity: Entity,
  alias: string,
  via?: RelationshipWitness,
): Promise<SQL> =>
  sql`jsonb_build_object(
    'entityKind', ${entity}::text,
    'entityId', ${sql.raw(`${alias}."shortcode"`)},
    'label', ${await labelSql(entity, alias)}
    ${via ? sql`, 'via', ${JSON.stringify(via)}::jsonb` : sql``}
  )`;

export async function compiledConnectedRoutes(source: Entity, viewKey: string) {
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
        variant.steps.map((step) => `${step.direction}:${step.edge}`).join("|"),
      variant,
    );
  }
  return Promise.all(
    [...distinct.values()].map(async (variant, index) => {
      const traversal = compileTraversal(source, variant.steps, `c${index}_`, {
        root: "s",
        leaf: "t",
        to: view.target,
        singleRoot: true,
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
      if (nodes.at(-1)?.entity !== view.target) {
        throw new Error(
          `Connected view ${source}.${viewKey} has no target node`,
        );
      }
      return {
        traversal,
        nodes,
        hops: nodes.length - 1,
        path: sql`jsonb_build_array(${sql.join(
          await Promise.all(
            nodes.map((node) =>
              nodeExpression(node.entity, node.alias, node.via),
            ),
          ),
          sql`, `,
        )})`,
      };
    }),
  );
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

const connectedSource = (source: ConnectedRecordsInput["source"]): SQL => {
  const definition = entityManifest[source.entityKind];
  if (!definition.dbTable)
    throw new Error(`No local table for ${source.entityKind}`);
  return sql`WITH connected_source AS MATERIALIZED (
    SELECT * FROM ${sql.identifier(definition.dbTable)} s
    WHERE s."shortcode" = ${source.entityId}
      ${definition.softDelete ? sql`AND ${notDeleted("s")}` : sql``}
  )`;
};

/** Shared page query for individual tables and the batched detail preview. */
async function prepareConnectedPage(input: ConnectedRecordsInput) {
  const { source, viewKey } = input;
  const view = resolveConnectedView(source.entityKind, viewKey);
  // A derived relation has no edge path to witness; its list filter is the
  // whole answer, so there is no per-record route evidence to return.
  if (view.kind === "derived" || input.targetIds?.length === 0)
    return { target: view.target, query: null };
  const routes = await compiledConnectedRoutes(source.entityKind, viewKey);
  if (routes.length === 0)
    throw new Error(`No routes for ${source.entityKind}.${viewKey}`);
  const targetFilter = input.targetIds
    ? sql`AND t."shortcode" = ANY(${textArrayParam(input.targetIds)})`
    : sql``;
  const fromRoute = (route: (typeof routes)[number]) => sql`
    FROM connected_source s
    ${route.traversal.joins}
    WHERE true ${targetFilter}`;
  // Expensive relationship queries produce witnesses once. The IDs feed exact
  // membership, and only witnesses on the requested page are labeled.
  const witnessedRoutes: SQL[] = [];
  const targetIds: SQL[] = [];
  const evidence: SQL[] = [];
  for (const [index, route] of routes.entries()) {
    const path = sql`${route.hops}::int AS hops, ${route.path} AS path`;
    if (!route.traversal.hops.some((hop) => hop.candidateRows)) {
      targetIds.push(sql`SELECT t.id ${fromRoute(route)}`);
      evidence.push(sql`SELECT t.shortcode AS "targetId", ${path}
        ${fromRoute(route)} AND t.id IN (SELECT id FROM page)`);
      continue;
    }
    const witnesses = sql.identifier(`route_${index}`);
    const nodeIds = route.nodes.map((node) => sql.identifier(node.alias));
    witnessedRoutes.push(sql`${witnesses} AS MATERIALIZED (
      SELECT DISTINCT ${sql.join(
        nodeIds.map((node) => sql`${node}.id AS ${node}`),
        sql`, `,
      )}
      ${fromRoute(route)}
    ),`);
    targetIds.push(sql`SELECT t AS id FROM ${witnesses}`);
    evidence.push(sql`SELECT page."targetId", ${path}
      FROM page JOIN ${witnesses} witness ON witness.t = page.id
      ${sql.join(
        route.nodes.map((node, nodeIndex) => {
          const alias = nodeIds[nodeIndex];
          const table = entityManifest[node.entity].dbTable;
          if (!alias || !table)
            throw new Error(`Missing connected node ${node.entity}`);
          return sql`JOIN ${sql.identifier(table)} ${alias} ON ${alias}.id = witness.${alias}`;
        }),
        sql` `,
      )}`);
  }
  const targetTable = entityManifest[view.target].dbTable;
  if (!targetTable) throw new Error(`No local table for ${view.target}`);
  const query = sql`
    WITH ${sql.join(witnessedRoutes, sql` `)}
      target_ids AS MATERIALIZED (SELECT DISTINCT id FROM (${sql.join(targetIds, sql` UNION ALL `)}) reached),
      page AS MATERIALIZED (
        SELECT t.id, t.shortcode AS "targetId", ${await labelSql(view.target, "t")} AS "targetLabel"
        FROM target_ids JOIN ${sql.identifier(targetTable)} t USING (id)
        ORDER BY "targetLabel", "targetId"
        LIMIT ${input.limit ?? 20} OFFSET ${input.offset ?? 0}
      ),
      unique_paths AS (SELECT DISTINCT "targetId", hops, path
        FROM (${sql.join(evidence, sql` UNION ALL `)}) witnessed_paths),
      page_items AS (
        SELECT page."targetId", page."targetLabel",
          min(evidence.hops)::int AS "shortestHops",
          jsonb_agg(evidence.path ORDER BY evidence.hops, evidence.path::text) AS "paths"
        FROM page JOIN unique_paths evidence USING ("targetId")
        GROUP BY page."targetId", page."targetLabel"
      )
    SELECT (SELECT count(*)::int FROM target_ids) AS "totalCount",
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

function withCover(
  node: PathNode,
  covers: ReadonlyMap<string, ImageUrlSummary>,
) {
  const image = covers.get(entityRefKey(node.entityKind, node.entityId));
  return image ? { ...node, image } : node;
}

/**
 * One display-image read for every record a page names: the target and each
 * path node. A preview stamps every view together so a detail screen does
 * not repeat that read once per slot.
 */
async function withCanonicalCovers<T extends ConnectedRecordsOutput>(
  db: Database,
  pages: readonly T[],
): Promise<T[]> {
  const refs = pages.flatMap((page) =>
    page.items.flatMap((item) => [item.target, ...item.paths.flat()]),
  );
  if (refs.length === 0) return [...pages];
  const covers = await resolvePublicEntityDisplayImages(db, refs);
  if (covers.size === 0) return [...pages];
  return pages.map((page) => ({
    ...page,
    items: page.items.map((item) => ({
      ...item,
      target: withCover(item.target, covers),
      paths: item.paths.map((path) =>
        path.map((node) => withCover(node, covers)),
      ),
    })),
  }));
}

const emptyPage = { totalCount: 0, items: [] };
const emptyPageQuery = sql`SELECT 0::int AS "totalCount", '[]'::jsonb AS "items"`;
const STATEMENT_BUDGET_MS = 5_000;

async function executeConnectedRead(db: Database, query: SQL) {
  const nested = boundTransaction(db) !== undefined;
  try {
    return await withTransactionDatabase(
      db,
      async (tx) => {
        const client = unwrapDb(tx);
        const [timeout] = await client.execute(
          sql`WITH previous AS MATERIALIZED (
            SELECT setting::int AS ms FROM pg_settings WHERE name = 'statement_timeout'
          ) SELECT ms, set_config(
            'statement_timeout', least(nullif(ms, 0), ${STATEMENT_BUDGET_MS})::text, true
          ) FROM previous`,
          "objects",
        );
        const result = await client.execute(query, "objects");
        // Releasing a savepoint keeps SET LOCAL changes in the outer transaction.
        if (nested) {
          const { ms } = z.object({ ms: z.number() }).parse(timeout);
          await client.execute(
            sql`SELECT set_config('statement_timeout', ${String(ms)}, true)`,
          );
        }
        return result;
      },
      { accessMode: "read only" },
    );
  } catch (error) {
    if (!isStatementTimeout(error)) throw error;
    throw new Error(
      "Loading connected records exceeded the database statement timeout (SQLSTATE 57014).",
      { cause: error },
    );
  }
}

/** Complete, paged records and every witnessed provenance route. */
export async function getConnectedRecords(
  db: Database,
  input: ConnectedRecordsInput,
): Promise<ConnectedRecordsOutput> {
  const plan = await prepareConnectedPage(input);
  const page = plan.query
    ? connectedPage(
        plan.target,
        (
          await executeConnectedRead(
            db,
            sql`${connectedSource(input.source)} SELECT * FROM (${plan.query}) page`,
          )
        )[0],
      )
    : connectedPage(plan.target, emptyPage);
  return (await withCanonicalCovers(db, [page]))[0] ?? page;
}

/** Every requested group shares one statement while retaining its own complete count and page. */
export async function getConnectedRecordsPreview(
  db: Database,
  input: ConnectedRecordsPreviewInput,
): Promise<ConnectedRecordsPreviewOutput> {
  const views = connectionCatalog.views(input.source.entityKind, input.scope);
  if (views.length === 0) return { views: [] };
  const queries = await Promise.all(
    views.map(async (view, index) => {
      const { query } = await prepareConnectedPage({
        source: input.source,
        viewKey: view.key,
        limit: input.limit ?? 3,
      });
      return sql`SELECT ${index}::int AS "viewIndex", page."totalCount", page."items" FROM (${query ?? emptyPageQuery}) page`;
    }),
  );
  const result = await executeConnectedRead(
    db,
    sql`${connectedSource(input.source)}
      ${sql.join(queries, sql` UNION ALL `)} ORDER BY "viewIndex"`,
  );
  const rows = z
    .array(pageRowSchema.extend({ viewIndex: z.number().int().nonnegative() }))
    .parse(result);
  if (rows.length !== views.length)
    throw new Error("Incomplete connected-record preview");
  return {
    views: await withCanonicalCovers(
      db,
      rows.map((row) => {
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
    ),
  };
}
