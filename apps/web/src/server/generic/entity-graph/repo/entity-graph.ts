import {
  connectionCatalog,
  relationshipSources as localSources,
} from "@cubby/schemas/connected-views";
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
import { allEntities, entityManifest } from "@cubby/schemas/entity-manifest";
import { sql } from "drizzle-orm";
import { groupBy } from "es-toolkit";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import { unwrapDb } from "~/server/db/helpers";
import { notDeleted } from "~/server/db/helpers/predicates";
import { resolveEntityDisplayImages } from "~/server/entity-kernel/repo/entity-display-image";
import { labelSql } from "~/server/generic/entity-graph/repo/record-label";
import { compileTraversal } from "~/server/generic/relatedness/repo/traversal";

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

const pathDescription = (provenance: RelationshipProvenance): string[] =>
  provenance.kind === "query"
    ? [`query:${provenance.query}`]
    : provenance.kind === "local-path"
      ? provenance.steps.map((step) => `${step.direction}:${step.edge}`)
      : provenance.kind === "unconstrained"
        ? [`unconstrained:${provenance.edge}`]
        : provenance.kind === "derived"
          ? [`derived:${provenance.filter}`]
          : provenance.sourceColumns.map((column) => `external:${column}`);

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
    id: `${entityRefKey(source.entityKind, source.entityId)}|${entityRefKey(destination.entityKind, destination.entityId)}|${pathKey(descriptor.path)}`,
    source,
    target: destination,
    relationshipKey: descriptor.relationshipKey,
    label: descriptor.label,
    sourceKey: descriptor.sourceKey,
    provenance: pathDescription(descriptor.path),
  };
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
      return sql`jsonb_strip_nulls(jsonb_build_object('quantity', ${column("amountValue")}::text, 'unit', ${column("amountUnit")}, 'placement', ${column("placement")}::text))`;
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
  const rootsByEntity = groupBy(input.roots, (root) => root.entityKind);
  for (const rootEntity of allEntities) {
    const requestedRoots = rootsByEntity[rootEntity];
    if (!requestedRoots) continue;
    const rootTable = entityManifest[rootEntity].dbTable;
    if (!rootTable) continue;
    await options.beforeQuery?.();
    // Append-only roots have no deletedAt column; liveness belongs to the manifest.
    const rootRows = await unwrapDb(db).execute(sql`
      SELECT "id" AS "dbId", "shortcode" AS "id", ${labelSql(rootEntity, "")} AS "label",
        ${metadataFor(rootEntity, "")} AS "metadata"
      FROM ${sql.raw(`"${rootTable}"`)}
      WHERE "shortcode" IN (${sql.join(
        requestedRoots.map((root) => sql`${root.entityId}`),
        sql`, `,
      )})
        ${entityManifest[rootEntity].softDelete ? sql`AND ${notDeleted(rootTable)}` : sql``}
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
        ref: { entityKind: rootEntity, entityId: row.id },
        dbId: row.dbId,
        label: row.label,
        metadata: row.metadata,
      }));
    for (const root of liveRoots) {
      imageRefs.set(entityRefKey(rootEntity, root.ref.entityId), {
        entityKind: rootEntity,
        entityId: root.dbId,
      });
      nodes.set(entityRefKey(rootEntity, root.ref.entityId), {
        ...root.ref,
        label: root.label,
        metadata: root.metadata,
      });
    }
    if (liveRoots.length === 0) continue;

    const relationships = connectionCatalog
      .relationships(rootEntity)
      .filter(
        (relationship) =>
          (!input.relationshipKeys ||
            input.relationshipKeys.includes(relationship.key)) &&
          (!input.entityKinds ||
            input.entityKinds.includes(relationship.target)),
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
        { root: "s", leaf: "t", to: relationship.target },
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
              ${entityManifest[rootEntity].softDelete ? sql`AND ${notDeleted("s")}` : sql``}
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
            entityKind: relationship.target,
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
                        entityKind: relationship.target,
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
            entityKind: relationship.target,
            entityId: row.targetShortcode,
          };
          nodes.set(entityRefKey(target.entityKind, target.entityId), {
            ...target,
            label: row.label,
            metadata: row.metadata,
          });
          imageRefs.set(entityRefKey(target.entityKind, target.entityId), {
            entityKind: target.entityKind,
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
    input.roots.map((root) => entityRefKey(root.entityKind, root.entityId)),
  );
  const outputNodes = [...nodes.values()]
    .sort(
      (left, right) =>
        Number(
          requestedKeys.has(entityRefKey(right.entityKind, right.entityId)),
        ) -
        Number(requestedKeys.has(entityRefKey(left.entityKind, left.entityId))),
    )
    .slice(0, MAX_GRAPH_NODES);
  const nodeKeys = new Set(
    outputNodes.map((node) => entityRefKey(node.entityKind, node.entityId)),
  );
  const outputEdges = [...edges.values()]
    .filter(
      (edge) =>
        nodeKeys.has(
          entityRefKey(edge.source.entityKind, edge.source.entityId),
        ) &&
        nodeKeys.has(
          entityRefKey(edge.target.entityKind, edge.target.entityId),
        ),
    )
    .slice(0, MAX_GRAPH_EDGES);
  const retainedEdges = new Set(outputEdges.map((edge) => edge.id));
  const outputBranches = branches.map((branch) => {
    const firstOmitted = branch.items.findIndex(
      (item) =>
        !nodeKeys.has(entityRefKey(item.entityKind, item.entityId)) ||
        branch.edgeIds.some((id) => {
          const edge = edges.get(id);
          return (
            edge &&
            !retainedEdges.has(id) &&
            [edge.source, edge.target].some(
              (ref) =>
                ref.entityKind === item.entityKind &&
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
                ref.entityKind === item.entityKind &&
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
            entityRefKey(node.entityKind, node.entityId),
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
      const ref = imageRefs.get(entityRefKey(node.entityKind, node.entityId));
      const image =
        ref && images.get(entityRefKey(ref.entityKind, ref.entityId));
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
