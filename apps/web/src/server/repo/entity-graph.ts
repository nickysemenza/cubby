import {
  entityRefKey,
  type Entity,
  type EntityRef,
} from "@cubby/schemas/entity";
import {
  type EntityGraphEdge,
  type EntityGraphInput,
  type EntityGraphNode,
  type EntityGraphOutput,
} from "@cubby/schemas/entity-graph";
import type { RelationshipProvenance } from "@cubby/schemas/entity-integrity";
import {
  allEntities,
  entityInspectorMetadata,
  entityManifest,
} from "@cubby/schemas/entity-manifest";
import { sql } from "drizzle-orm";
import { groupBy } from "es-toolkit";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import { unwrapDb } from "~/server/repo/database-helpers";
import { resolveEntityDisplayImages } from "~/server/repo/entity-display-image";
import { compileTraversal } from "~/server/repo/relatedness/traversal";

const rowSchema = z.object({
  rootShortcode: z.string(),
  relationshipKey: z.string(),
  targetEntity: z.string().nullable(),
  targetId: z.string().nullable(),
  targetShortcode: z.string().nullable(),
  label: z.string().nullable(),
  metadata: z.record(z.string(), z.string()).nullable(),
  sourceKeys: z.array(z.string()).nullable(),
  totalCount: z.coerce.number().int().nonnegative(),
});

const MAX_GRAPH_NODES = 500;
const MAX_GRAPH_EDGES = 1_000;

const unparsedEntityGraphReadErrorSchema = z.unknown();
type EntityGraphReadError = z.input<typeof unparsedEntityGraphReadErrorSchema>;

type EntityGraphReadOptions = {
  includeImages: boolean;
  beforeQuery?: () => Promise<void>;
  /** Image hydration is optional only when the caller identifies a deadline. */
  isImageHydrationDeadline?: (error: EntityGraphReadError) => boolean;
};

type LocalSource = {
  key: string;
  label: string;
  provenance: RelationshipProvenance;
};

type GraphRelationship = {
  key: string;
  label: string;
  target: Entity;
  sources: readonly LocalSource[];
  reverseEdge?: boolean;
  canonicalRelationshipKey?: string;
  canonicalLabel?: string;
};

const pathDescription = (provenance: RelationshipProvenance): string[] =>
  provenance.kind === "local-path"
    ? provenance.steps.map((step) => `${step.direction}:${step.edge}`)
    : provenance.kind === "unconstrained"
      ? [`unconstrained:${provenance.edge}`]
      : provenance.sourceColumns.map((column) => `external:${column}`);

const localSources = (
  relationship: (typeof entityManifest)[Entity]["relationships"][number],
): readonly LocalSource[] => [
  {
    key: relationship.sourceKey ?? "direct",
    label: relationship.label,
    provenance: relationship.provenance,
  },
  ...relationship.sources.map((source) => ({
    key: source.key,
    label: source.label,
    provenance: source.provenance,
  })),
];

const samePath = (
  left: readonly { edge: string; direction: string }[],
  right: readonly { edge: string; direction: string }[],
) =>
  left.length === right.length &&
  left.every(
    (step, index) =>
      step.edge === right[index]?.edge &&
      step.direction === right[index]?.direction,
  );

type LocalPath = Extract<RelationshipProvenance, { kind: "local-path" }>;
const pathKey = (path: LocalPath) => pathDescription(path).join("|");
const reversePath = (path: LocalPath): LocalPath => ({
  kind: "local-path",
  steps: [...path.steps].reverse().map((step) => ({
    edge: step.edge,
    direction: step.direction === "incoming" ? "outgoing" : "incoming",
  })),
});

// One declared view of a physical path owns its arrow and label; reverse
// reads reuse that view, while opposite self-links retain ordered endpoints.
// The side holding the foreign key (a path that leaves along an outgoing
// edge) owns it, so declaring the reverse relation on the other entity — a
// detail page's relation section — never flips an existing arrow. Among
// equally-directed declarations the first declared wins.
const canonicalPaths = new Map<
  string,
  {
    reversed: boolean;
    path: LocalPath;
    relationshipKey: string;
    label: string;
    sourceKey: string;
  }
>();
const leavesOutgoing = (path: LocalPath) =>
  path.steps[0]?.direction === "outgoing";
for (const pass of [leavesOutgoing, () => true]) {
  for (const entity of allEntities) {
    for (const relationship of entityManifest[entity].relationships) {
      for (const source of localSources(relationship)) {
        if (source.provenance.kind !== "local-path") continue;
        if (!pass(source.provenance)) continue;
        const descriptor = {
          path: source.provenance,
          relationshipKey: relationship.key,
          label: relationship.label,
          sourceKey: source.key,
        };
        const forward = pathKey(source.provenance);
        const backward = pathKey(reversePath(source.provenance));
        if (!canonicalPaths.has(forward)) {
          canonicalPaths.set(forward, { ...descriptor, reversed: false });
          canonicalPaths.set(backward, { ...descriptor, reversed: true });
        }
      }
    }
  }
}
const canonicalEdge = (
  root: EntityRef,
  target: EntityRef,
  provenance: RelationshipProvenance,
): EntityGraphEdge => {
  const descriptor = canonicalPaths.get(pathDescription(provenance).join("|"));
  if (!descriptor) throw new Error("Graph path has no declared relationship");
  const source = descriptor.reversed ? target : root;
  const destination = descriptor.reversed ? root : target;
  return {
    id: `${entityRefKey(source.entityType, source.entityId)}|${entityRefKey(destination.entityType, destination.entityId)}|${pathKey(descriptor.path)}`,
    source,
    target: destination,
    relationshipKey: descriptor.relationshipKey,
    label: descriptor.label,
    sourceKey: descriptor.sourceKey,
    provenance: pathDescription(descriptor.path),
  };
};

/**
 * The manifest declares a reverse path where it is useful. It need not repeat
 * that path as a second relationship definition, so graph reads surface it as
 * a directional relationship of the current root (Cookbook -> Recipes is the
 * important example).
 */
const graphRelationshipsFor = (
  source: Entity,
): readonly GraphRelationship[] => [
  ...entityManifest[source].relationships.map((relationship) => ({
    key: relationship.key,
    label: relationship.label,
    target: relationship.target,
    sources: localSources(relationship),
  })),
  ...allEntities.flatMap((candidate) =>
    entityManifest[candidate].relationships.flatMap((relationship) => {
      if (relationship.target !== source) return [];
      const sources = [
        {
          key: relationship.sourceKey ?? "direct",
          label: relationship.label,
          inverse: "inverse" in relationship ? relationship.inverse : undefined,
        },
        ...relationship.sources.map((named) => ({
          key: named.key,
          label: named.label,
          inverse: named.inverse,
        })),
      ].flatMap((named) => {
        const inverse = named.inverse;
        // Check every local source of the declared relation, not just its
        // primary provenance: a two-source relation declared on both sides
        // (e.g. meal.eaters / ledgerParty.meals) only dedupes against its
        // primary path here, so the secondary (named) source's inverse would
        // otherwise leak through as a stray `inverse:*` branch.
        return inverse &&
          !entityManifest[source].relationships.some(
            (declared) =>
              declared.target === candidate &&
              localSources(declared).some(
                (local) =>
                  local.provenance.kind === "local-path" &&
                  samePath(local.provenance.steps, inverse.steps),
              ),
          )
          ? [
              {
                key: `inverse:${named.key}`,
                label: named.label,
                provenance: {
                  kind: "local-path" as const,
                  steps: inverse.steps,
                },
              },
            ]
          : [];
      });
      return sources.length === 0
        ? []
        : [
            {
              key: `inverse:${candidate}.${relationship.key}`,
              label: entityInspectorMetadata[candidate].plural ?? candidate,
              target: candidate,
              sources,
              reverseEdge: true,
              canonicalRelationshipKey: relationship.key,
              canonicalLabel: relationship.label,
            },
          ];
    }),
  ),
];

// oxlint-disable-next-line eslint/complexity -- One branch per entity whose label is not a plain name column.
const labelSql = (entity: Entity, alias: string) => {
  const prefix = alias ? `${alias}.` : "";
  const column = (name: string) => sql.raw(`${prefix}"${name}"`);
  switch (entity) {
    case "recipe":
    case "cookbook":
    case "ingredient":
    case "product":
    case "location":
    case "ledgerParty":
    case "financialAccount":
    case "project":
    case "task":
    case "vendor":
    case "wish":
    case "expense":
      return sql`COALESCE(${column("name")}::text, ${column("shortcode")})`;
    case "image":
      return sql`COALESCE(${column("filename")}::text, ${column("shortcode")})`;
    // `name || date` — mirrors `displayName` in
    // `server/repo/meal/helpers.ts` (an unnamed meal is identified by its
    // date, not by falling through to the shortcode).
    case "meal":
      return sql`COALESCE(NULLIF(TRIM(${column("name")}), ''), ${column("date")}::text, ${column("shortcode")})`;
    // `purchaseLabel(...)`'s ladder (`apps/web/src/lib/purchase-label.ts`):
    // orderId, else vendor name + date, else vendor name; a nonblank
    // `displayLabel` is appended parenthetically without replacing the
    // identity. `vendorId` has no local column to read the name from, so it's
    // a correlated subquery against `Vendor`, same technique as the
    // planting/gardenEntry cases below.
    case "purchase":
      return sql`COALESCE(
        (CASE
          WHEN NULLIF(TRIM(${column("orderId")}), '') IS NOT NULL THEN ${column("orderId")}
          WHEN ${column("date")} IS NOT NULL THEN
            COALESCE((SELECT v."name" FROM "Vendor" v WHERE v."id" = ${column("vendorId")}), 'Unknown vendor')
              || ' · ' || to_char(${column("date")}::date, 'FMMon FMDD, YYYY')
          ELSE COALESCE((SELECT v."name" FROM "Vendor" v WHERE v."id" = ${column("vendorId")}), 'Unknown vendor')
        END)
          || COALESCE(' (' || NULLIF(TRIM(${column("displayLabel")}), '') || ')', ''),
        ${column("shortcode")}
      )`;
    // `merchant || rawDescription || capitalized kind` — mirrors
    // `displayName` in `server/repo/financial-transaction.ts`.
    case "financialTransaction":
      return sql`COALESCE(${column("merchant")}::text, ${column("rawDescription")}::text, initcap(${column("kind")}::text), ${column("shortcode")})`;
    // The plant's name; its crop label lives in static data, not SQL.
    case "plant":
      return sql`COALESCE(${column("name")}, ${column("shortcode")})`;
    // The planting's plant name — a correlated subquery against `Plant`.
    case "planting":
      return sql`COALESCE(
        (SELECT p."name" FROM "Plant" p WHERE p."id" = ${column("plantId")}),
        ${column("shortcode")}
      )`;
    // `"<Note|Harvest> · <YYYY-MM-DD> · <area name>"` — mirrors `displayName`
    // in `server/repo/garden/index.ts`. `locationId` has no local name
    // column, so the location's name is a correlated subquery against
    // `Location`.
    case "gardenEntry":
      return sql`COALESCE(
        initcap(${column("kind")}::text)
          || ' · ' || to_char(${column("observedOn")}, 'YYYY-MM-DD')
          || ' · ' || (SELECT l."name" FROM "Location" l WHERE l."id" = ${column("locationId")}),
        ${column("shortcode")}
      )`;
    default:
      return column("shortcode");
  }
};

/** Small, universal display facts; relationship-specific views can enrich further. */
const metadataFor = (entity: Entity, alias = "t") => {
  const column = (name: string) =>
    sql.raw(`${alias ? `${alias}.` : ""}"${name}"`);
  switch (entity) {
    case "expense":
      return sql`jsonb_strip_nulls(jsonb_build_object('date', ${column("date")}::text, 'amount', ${column("cost")}::text))`;
    case "purchase":
      return sql`jsonb_strip_nulls(jsonb_build_object('date', ${column("date")}::text))`;
    case "inventory":
      return sql`jsonb_strip_nulls(jsonb_build_object('quantity', ${column("amount")}->>'value', 'unit', ${column("amount")}->>'unit', 'placement', ${column("placement")}::text))`;
    default:
      return sql`'{}'::jsonb`;
  }
};

/**
 * Read a bounded relationship frontier. Every SQL path is compiled from the
 * entity manifest; intermediate join rows therefore never become graph nodes.
 */
// Relationship manifests, pagination, canonical evidence, and response caps
// stay in one batched read so callers cannot assemble subtly different graphs.
// eslint-disable-next-line complexity
export async function readEntityGraph(
  db: Database | DrizzleTransaction,
  input: EntityGraphInput,
  options: EntityGraphReadOptions,
): Promise<EntityGraphOutput> {
  const offset = input.offset ?? 0;
  const limit = input.limit ?? 25;
  const nodes = new Map<string, EntityGraphNode>();
  const imageRefs = new Map<string, EntityRef>();
  const edges = new Map<string, EntityGraphEdge>();
  const branches: EntityGraphOutput["branches"] = [];
  const rootsByEntity = groupBy(input.roots, (root) => root.entityType);
  for (const rootEntity of allEntities) {
    const requestedRoots = rootsByEntity[rootEntity];
    if (!requestedRoots) continue;
    const rootTable = entityManifest[rootEntity].dbTable;
    if (!rootTable) continue;
    await options.beforeQuery?.();
    const rootRows = await unwrapDb(db).execute(sql`
      SELECT "id" AS "dbId", "shortcode" AS "id", ${labelSql(rootEntity, "")} AS "label",
        ${metadataFor(rootEntity, "")} AS "metadata"
      FROM ${sql.raw(`"${rootTable}"`)}
      WHERE "shortcode" IN (${sql.join(
        requestedRoots.map((root) => sql`${root.entityId}`),
        sql`, `,
      )})
        AND "deletedAt" IS NULL
    `);
    const liveRoots = z
      .object({
        id: z.string(),
        dbId: z.string(),
        label: z.string(),
        metadata: z.record(z.string(), z.string()),
      })
      .array()
      .parse(rootRows.rows)
      .map((row) => ({
        ref: { entityType: rootEntity, entityId: row.id },
        dbId: row.dbId,
        label: row.label,
        metadata: row.metadata,
      }));
    for (const root of liveRoots) {
      imageRefs.set(entityRefKey(rootEntity, root.ref.entityId), {
        entityType: rootEntity,
        entityId: root.dbId,
      });
      nodes.set(entityRefKey(rootEntity, root.ref.entityId), {
        ...root.ref,
        label: root.label,
        metadata: root.metadata,
      });
    }
    if (liveRoots.length === 0) continue;

    const relationships = graphRelationshipsFor(rootEntity).filter(
      (relationship) =>
        (!input.relationshipKeys ||
          input.relationshipKeys.includes(relationship.key)) &&
        (!input.entityTypes || input.entityTypes.includes(relationship.target)),
    );
    const relationSources = relationships.flatMap((relationship) =>
      relationship.sources.flatMap((source) =>
        source.provenance.kind === "local-path"
          ? [
              {
                relationship,
                source: { ...source, provenance: source.provenance },
              },
            ]
          : [],
      ),
    );
    if (relationSources.length === 0) continue;
    const sourceRows = relationSources.map(({ relationship, source }) => {
      const traversal = compileTraversal(
        rootEntity,
        source.provenance.steps,
        `graph_${source.key.replaceAll(/[^a-zA-Z0-9]/g, "_")}`,
        { root: "s", leaf: "t" },
      );
      return sql`
            SELECT s."shortcode" AS "rootShortcode", ${relationship.key}::text AS "relationshipKey", ${relationship.target}::text AS "targetEntity",
              t."id"::text AS "targetId", t."shortcode" AS "targetShortcode",
              ${labelSql(relationship.target, "t")} AS "label",
              ${metadataFor(relationship.target)} AS "metadata", ${source.key}::text AS "sourceKey"
            FROM ${sql.raw(`"${traversal.rootTable}"`)} s
            ${traversal.joins}
            WHERE s."shortcode" IN (${sql.join(
              liveRoots.map((root) => sql`${root.ref.entityId}`),
              sql`, `,
            )})
              AND s."deletedAt" IS NULL
        `;
    });
    await options.beforeQuery?.();
    const result = await unwrapDb(db).execute(sql`
          WITH raw_related AS (${sql.join(sourceRows, sql` UNION ALL `)}), related AS (
            SELECT "rootShortcode", "relationshipKey", "targetEntity", "targetId", "targetShortcode", "label", "metadata",
              array_agg(DISTINCT "sourceKey") AS "sourceKeys"
            FROM raw_related
            GROUP BY "rootShortcode", "relationshipKey", "targetEntity", "targetId", "targetShortcode", "label", "metadata"
          ), ranked AS (
            SELECT *, count(*) OVER (PARTITION BY "rootShortcode", "relationshipKey")::int AS "totalCount",
              row_number() OVER (PARTITION BY "rootShortcode", "relationshipKey" ORDER BY "label", "targetShortcode")::int AS "rowNumber"
            FROM related
          ), totals AS (
            SELECT "rootShortcode", "relationshipKey", max("totalCount")::int AS "totalCount"
            FROM ranked GROUP BY "rootShortcode", "relationshipKey"
          ), branches("rootShortcode", "relationshipKey") AS (VALUES ${sql.join(
            liveRoots.flatMap((root) =>
              relationships.map(
                (relationship) =>
                  sql`(${root.ref.entityId}, ${relationship.key})`,
              ),
            ),
            sql`, `,
          )}) SELECT branches."rootShortcode", branches."relationshipKey", ranked."targetEntity", ranked."targetId", ranked."targetShortcode", ranked."label", ranked."metadata", ranked."sourceKeys",
            COALESCE(totals."totalCount", 0)::int AS "totalCount"
          FROM branches LEFT JOIN totals USING ("rootShortcode", "relationshipKey")
          LEFT JOIN ranked ON ranked."rootShortcode" = branches."rootShortcode" AND ranked."relationshipKey" = branches."relationshipKey"
            AND ranked."rowNumber" > ${offset} AND ranked."rowNumber" <= ${offset + limit}
          ORDER BY branches."rootShortcode", branches."relationshipKey", ranked."label", ranked."targetShortcode"
      `);
    const rows = rowSchema.array().parse(result.rows);
    const rowsByBranch = groupBy(
      rows,
      (row) => `${row.rootShortcode}:${row.relationshipKey}`,
    );
    for (const relationship of relationships) {
      const localSources = relationSources
        .filter((item) => item.relationship === relationship)
        .map((item) => item.source);
      for (const root of liveRoots) {
        const allBranchRows =
          rowsByBranch[`${root.ref.entityId}:${relationship.key}`] ?? [];
        const branchRows = allBranchRows.filter(
          (
            row,
          ): row is typeof row & {
            targetId: string;
            targetShortcode: string;
            label: string;
            metadata: Record<string, string>;
            sourceKeys: string[];
          } =>
            row.targetId !== null &&
            row.targetShortcode !== null &&
            row.label !== null &&
            row.metadata !== null &&
            row.sourceKeys !== null,
        );
        const totalCount = allBranchRows[0]?.totalCount ?? 0;
        const nextOffset =
          offset + branchRows.length < totalCount
            ? offset + branchRows.length
            : null;
        branches.push({
          root: root.ref,
          relationshipKey: relationship.key,
          label: relationship.label,
          target: relationship.target,
          totalCount,
          nextOffset,
          items: branchRows.map((row) => ({
            entityType: relationship.target,
            entityId: row.targetShortcode,
          })),
          edgeIds: branchRows
            .flatMap((row) =>
              row.sourceKeys.map((sourceKey) => {
                const source = localSources.find(
                  (candidate) => candidate.key === sourceKey,
                );
                return source
                  ? canonicalEdge(
                      root.ref,
                      {
                        entityType: relationship.target,
                        entityId: row.targetShortcode,
                      },
                      source.provenance,
                    ).id
                  : null;
              }),
            )
            .filter((id): id is string => id !== null),
        });
        for (const row of branchRows) {
          const target = {
            entityType: relationship.target,
            entityId: row.targetShortcode,
          };
          nodes.set(entityRefKey(target.entityType, target.entityId), {
            ...target,
            label: row.label,
            metadata: row.metadata,
          });
          imageRefs.set(entityRefKey(target.entityType, target.entityId), {
            entityType: target.entityType,
            entityId: row.targetId,
          });
          for (const sourceKey of row.sourceKeys) {
            const source = localSources.find(
              (candidate) => candidate.key === sourceKey,
            );
            if (!source) continue;
            const edge = canonicalEdge(root.ref, target, source.provenance);
            edges.set(edge.id, edge);
          }
        }
      }
    }
  }
  const requestedKeys = new Set(
    input.roots.map((root) => entityRefKey(root.entityType, root.entityId)),
  );
  const outputNodes = [...nodes.values()]
    .sort(
      (left, right) =>
        Number(
          requestedKeys.has(entityRefKey(right.entityType, right.entityId)),
        ) -
        Number(requestedKeys.has(entityRefKey(left.entityType, left.entityId))),
    )
    .slice(0, MAX_GRAPH_NODES);
  const nodeKeys = new Set(
    outputNodes.map((node) => entityRefKey(node.entityType, node.entityId)),
  );
  const outputEdges = [...edges.values()]
    .filter(
      (edge) =>
        nodeKeys.has(
          entityRefKey(edge.source.entityType, edge.source.entityId),
        ) &&
        nodeKeys.has(
          entityRefKey(edge.target.entityType, edge.target.entityId),
        ),
    )
    .slice(0, MAX_GRAPH_EDGES);
  const retainedEdges = new Set(outputEdges.map((edge) => edge.id));
  const outputBranches = branches.map((branch) => {
    const firstOmitted = branch.items.findIndex(
      (item) =>
        !nodeKeys.has(entityRefKey(item.entityType, item.entityId)) ||
        branch.edgeIds.some((id) => {
          const edge = edges.get(id);
          return (
            edge &&
            !retainedEdges.has(id) &&
            [edge.source, edge.target].some(
              (ref) =>
                ref.entityType === item.entityType &&
                ref.entityId === item.entityId,
            )
          );
        }),
    );
    const items =
      firstOmitted < 0 ? branch.items : branch.items.slice(0, firstOmitted);
    return {
      ...branch,
      items,
      edgeIds: branch.edgeIds.filter((id) => {
        const edge = edges.get(id);
        return (
          retainedEdges.has(id) &&
          edge &&
          items.some((item) =>
            [edge.source, edge.target].some(
              (ref) =>
                ref.entityType === item.entityType &&
                ref.entityId === item.entityId,
            ),
          )
        );
      }),
      nextOffset: firstOmitted < 0 ? branch.nextOffset : offset + firstOmitted,
    };
  });
  let images: Awaited<ReturnType<typeof resolveEntityDisplayImages>> =
    new Map();
  if (options.includeImages) {
    try {
      await options.beforeQuery?.();
      images = await resolveEntityDisplayImages(
        db,
        outputNodes.flatMap((node) => {
          const ref = imageRefs.get(
            entityRefKey(node.entityType, node.entityId),
          );
          return ref ? [ref] : [];
        }),
      );
    } catch (error) {
      if (!options.isImageHydrationDeadline?.(error)) throw error;
    }
  }
  return {
    nodes: outputNodes.map((node) => {
      const ref = imageRefs.get(entityRefKey(node.entityType, node.entityId));
      const image =
        ref && images.get(entityRefKey(ref.entityType, ref.entityId));
      return image ? { ...node, image } : node;
    }),
    edges: outputEdges,
    branches: outputBranches,
    truncated:
      outputNodes.length < nodes.size || outputEdges.length < edges.size,
  };
}

export const getEntityGraph = (
  db: Database,
  input: EntityGraphInput,
): Promise<EntityGraphOutput> =>
  readEntityGraph(db, input, { includeImages: true });
