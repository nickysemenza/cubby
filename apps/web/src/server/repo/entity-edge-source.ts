/**
 * The physical entity graph as one read-only edge source (ADR 0006):
 * `(edgeKey, sourceKind, sourceId, targetKind, targetId)` for every declared
 * `ENTITY_EDGES` column whose two ends are both entities.
 *
 * Composed at runtime from the edge registry rather than stored as a view, so
 * it can never drift from the registry and needs no migration. Writes stay on
 * the typed tables; nothing here is mutable. Edge columns on join or child
 * rows name their source through `ENTITY_EDGE_OWNERS`.
 */

import { entityRefKey } from "@cubby/schemas/entity";
import type {
  EntityConnectionGroup,
  EntityConnectionItem,
  EntityConnectionsInput,
  EntityConnectionsOut,
  OrphanEntitiesOut,
} from "@cubby/schemas/entity-connections";
import { entityConnectionsInput } from "@cubby/schemas/entity-connections";
import type { EdgeRole } from "@cubby/schemas/entity-integrity";
import {
  allEntities,
  entityManifest,
  shortcodeEntities,
  type ShortcodeEntity,
} from "@cubby/schemas/entity-manifest";
import {
  ENTITY_LABEL,
  ENTITY_NOT_FOUND_REASON,
  parseEntityRef,
} from "@cubby/schemas/identifiers";
import { is, type SQL, sql } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  ENTITY_EDGE_OWNERS,
  type EntityEdgeOwner,
} from "~/server/db/entity-edge-owners";
import { ENTITY_EDGE_SEMANTICS } from "~/server/db/entity-edge-semantics";
import { INCOMING_EDGES } from "~/server/db/entity-incoming-edges";
import { createAppError } from "~/server/errors/app-error";
import { unwrapDb } from "~/server/repo/database-helpers";
import {
  describeUnresolvableCode,
  isShortcodeEntity,
  resolveEntityIdentity,
} from "~/server/repo/entity-identity";
import { ENTITY_LIFECYCLE_REGISTRY } from "~/server/repo/entity-lifecycle-registry";
import { lookupEntityLabels } from "~/server/repo/shortcode-resolver";

type EdgeSource =
  /** The column sits on an entity table: that row is the source. */
  | { kind: "self"; sourceKind: ShortcodeEntity }
  /** The owning entity is named by another column on the same row. */
  | { kind: "owner"; column: string; sourceKind: ShortcodeEntity }
  /** The owner's kind varies per row and is read from `Entity`. */
  | { kind: "identity"; column: string }
  /** The owner is one join away. */
  | {
      kind: "via";
      column: string;
      viaTable: string;
      viaOwner: string;
      viaSoftDeletable: boolean;
      sourceKind: ShortcodeEntity;
    };

export interface EntityEdgeSpec {
  edgeKey: string;
  targetKind: ShortcodeEntity;
  table: string;
  column: string;
  softDeletable: boolean;
  source: EdgeSource;
  label: string;
  role: EdgeRole;
}

const entityByTable = new Map<string, ShortcodeEntity>(
  shortcodeEntities.flatMap((entity) => {
    const table = entityManifest[entity].dbTable;
    return table ? [[table, entity] as const] : [];
  }),
);

/** The entity a registered edge column points at, found by its key. */
const targetOfEdgeKey = (edgeKey: string): ShortcodeEntity => {
  const target = allEntities.find(
    (entity) => edgeKey in INCOMING_EDGES[entity],
  );
  if (!target || !isShortcodeEntity(target))
    throw new Error(`EntityEdge: no entity declares the edge ${edgeKey}.`);
  return target;
};

const tableInfo = (table: PgTable) => {
  const config = getTableConfig(table);
  return {
    name: config.name,
    softDeletable: config.columns.some((column) => column.name === "deletedAt"),
  };
};

const ownerOf = (table: string): EntityEdgeOwner | undefined =>
  Object.entries(ENTITY_EDGE_OWNERS).find(([name]) => name === table)?.[1];

const sourceFor = (table: string, column: string): EdgeSource | null => {
  const self = entityByTable.get(table);
  if (self) return { kind: "self", sourceKind: self };
  const owner = ownerOf(table);
  if (!owner)
    throw new Error(
      `EntityEdge: ${table} carries an ENTITY_EDGES column but has no ENTITY_EDGE_OWNERS entry.`,
    );
  if ("excluded" in owner) return null;
  if ("ownerIdentity" in owner) {
    return owner.ownerIdentity.name === column
      ? null
      : { kind: "identity", column: owner.ownerIdentity.name };
  }
  if ("owner" in owner) {
    // The owner column links the row to its own owner; it is not an edge.
    if (owner.owner.name === column) return null;
    return {
      kind: "owner",
      column: owner.owner.name,
      sourceKind: targetOfEdgeKey(`${table}.${owner.owner.name}`),
    };
  }
  const { via } = owner;
  if (!is(via.owner.table, PgTable))
    throw new Error(`EntityEdge: ${table}'s owner join is not a table.`);
  const viaInfo = tableInfo(via.owner.table);
  return {
    kind: "via",
    column: via.column.name,
    viaTable: viaInfo.name,
    viaOwner: via.owner.name,
    viaSoftDeletable: viaInfo.softDeletable,
    sourceKind: targetOfEdgeKey(`${viaInfo.name}.${via.owner.name}`),
  };
};

/** Every graph-visible edge, derived once from the registries. */
export const ENTITY_EDGE_SPECS: readonly EntityEdgeSpec[] = allEntities.flatMap(
  (target) => {
    if (!isShortcodeEntity(target)) return [];
    const semantics = ENTITY_EDGE_SEMANTICS[target];
    return Object.entries(INCOMING_EDGES[target]).flatMap(([edgeKey, edge]) => {
      const column = edge.column;
      if (!is(column.table, PgTable))
        throw new Error(`EntityEdge: ${edgeKey} is not on a table.`);
      const info = tableInfo(column.table);
      const source = sourceFor(info.name, column.name);
      if (source === null) return [];
      const meaning = Object.entries(semantics).find(
        ([key]) => key === edgeKey,
      )?.[1];
      if (!meaning)
        throw new Error(`EntityEdge: ${edgeKey} has no edge semantics.`);
      return [
        {
          edgeKey,
          targetKind: target,
          table: info.name,
          column: column.name,
          softDeletable: info.softDeletable,
          source,
          label: meaning.label,
          role: meaning.role,
        },
      ];
    });
  },
);

const ident = (name: string) => sql.identifier(name);

const sourceIdSql = (spec: EntityEdgeSpec): SQL =>
  spec.source.kind === "self"
    ? sql`s."id"`
    : spec.source.kind === "via"
      ? sql`v.${ident(spec.source.viaOwner)}`
      : sql`s.${ident(spec.source.column)}`;

const sourceKindSql = (spec: EntityEdgeSpec): SQL =>
  spec.source.kind === "identity"
    ? sql`owner_identity."kind"`
    : sql`${spec.source.sourceKind}::text`;

type EdgeFilter =
  | { side: "target"; id: string }
  | { side: "source"; id: string }
  | null;

/** One `UNION ALL` arm; a filter is pushed into the arm so indexes apply. */
const branchSql = (spec: EntityEdgeSpec, filter: EdgeFilter): SQL => {
  const sourceId = sourceIdSql(spec);
  const conditions: SQL[] = [
    sql`s.${ident(spec.column)} IS NOT NULL`,
    sql`${sourceId} IS NOT NULL`,
  ];
  if (spec.softDeletable) conditions.push(sql`s."deletedAt" IS NULL`);
  if (filter?.side === "target")
    conditions.push(sql`s.${ident(spec.column)} = ${filter.id}::uuid`);
  if (filter?.side === "source")
    conditions.push(sql`${sourceId} = ${filter.id}::uuid`);
  const joins: SQL[] = [];
  if (spec.source.kind === "via") {
    joins.push(
      sql`JOIN ${ident(spec.source.viaTable)} v ON v."id" = s.${ident(spec.source.column)}${
        spec.source.viaSoftDeletable ? sql` AND v."deletedAt" IS NULL` : sql``
      }`,
    );
  }
  if (spec.source.kind === "identity") {
    joins.push(
      sql`JOIN "Entity" owner_identity ON owner_identity."id" = s.${ident(spec.source.column)}`,
    );
  }
  return sql`SELECT ${spec.edgeKey}::text AS "edgeKey",
    ${sourceKindSql(spec)} AS "sourceKind", ${sourceId} AS "sourceId",
    ${spec.targetKind}::text AS "targetKind", s.${ident(spec.column)} AS "targetId"
  FROM ${ident(spec.table)} s ${sql.join(joins, sql` `)}
  WHERE ${sql.join(conditions, sql` AND `)}`;
};

/**
 * The live edge source: both endpoints must be live identities. `specs` and
 * `filter` narrow the arms; with neither, this is the whole graph.
 */
const entityEdgeSourceSql = (
  specs: readonly EntityEdgeSpec[] = ENTITY_EDGE_SPECS,
  filter: EdgeFilter = null,
): SQL => sql`SELECT edge.*, source_entity."shortcode" AS "sourceCode",
    target_entity."shortcode" AS "targetCode"
  FROM (${sql.join(
    specs.map((spec) => branchSql(spec, filter)),
    sql` UNION ALL `,
  )}) edge
  JOIN "Entity" source_entity ON source_entity."id" = edge."sourceId"
    AND source_entity."deletedAt" IS NULL
  JOIN "Entity" target_entity ON target_entity."id" = edge."targetId"
    AND target_entity."deletedAt" IS NULL`;

const edgeRow = z.object({
  edgeKey: z.string(),
  sourceKind: z.string(),
  sourceId: z.string(),
  targetKind: z.string(),
  targetId: z.string(),
  sourceCode: z.string().nullable(),
  targetCode: z.string().nullable(),
});
type EdgeRow = z.infer<typeof edgeRow>;

const edgeKindSchema = z.enum(shortcodeEntities);

const readEdges = async (
  db: Database | DrizzleTransaction,
  specs: readonly EntityEdgeSpec[],
  filter: EdgeFilter,
): Promise<EdgeRow[]> => {
  if (specs.length === 0) return [];
  const result = await unwrapDb(db).execute(entityEdgeSourceSql(specs, filter));
  return z.array(edgeRow).parse(result.rows);
};

// One column (`EntityAttachment.imageId` aside) can target several kinds, so
// a spec is named by its target kind and edge key together.
const SPECS_BY_TARGET_AND_KEY = new Map(
  ENTITY_EDGE_SPECS.map((spec) => [`${spec.targetKind}:${spec.edgeKey}`, spec]),
);
const specFor = (targetKind: string, edgeKey: string) =>
  SPECS_BY_TARGET_AND_KEY.get(`${targetKind}:${edgeKey}`);

/** Resolve a read code (following a merge redirect) to a live identity. */
const liveSubject = async (
  db: Database | DrizzleTransaction,
  code: string,
): Promise<{
  id: string;
  kind: ShortcodeEntity;
  shortcode: string;
  redirectedFrom: string | null;
}> => {
  const identity = await resolveEntityIdentity(db, code);
  if (identity.state === "live") return { ...identity, redirectedFrom: null };
  if (identity.state === "redirected" && identity.canonicalDeletedAt === null)
    return {
      id: identity.canonicalId,
      kind: identity.kind,
      shortcode: identity.canonicalShortcode,
      redirectedFrom: identity.requested,
    };
  const kind = identity.state === "missing" ? null : identity.kind;
  throw createAppError(
    kind ? ENTITY_NOT_FOUND_REASON[kind] : "CONSTRAINT_VIOLATION",
    (kind && (await describeUnresolvableCode(db, kind, code))) ??
      `No entity has the code ${code}`,
  );
};

/** One-hop physical connections of an entity, grouped by edge. */
export async function getEntityConnections(
  db: Database | DrizzleTransaction,
  rawInput: EntityConnectionsInput,
): Promise<EntityConnectionsOut> {
  const input = entityConnectionsInput.parse(rawInput);
  const subject = await liveSubject(db, input.id);
  const incomingSpecs = ENTITY_EDGE_SPECS.filter(
    (spec) => spec.targetKind === subject.kind,
  );
  const outgoingSpecs = ENTITY_EDGE_SPECS.filter(
    (spec) =>
      spec.source.kind === "identity" ||
      spec.source.sourceKind === subject.kind,
  );
  const [incoming, outgoing] = await Promise.all([
    readEdges(db, incomingSpecs, { side: "target", id: subject.id }),
    readEdges(db, outgoingSpecs, { side: "source", id: subject.id }),
  ]);
  const policy =
    input.operation === undefined
      ? undefined
      : ENTITY_LIFECYCLE_REGISTRY.find(
          (entry) =>
            entry.entity === subject.kind &&
            entry.operation === input.operation,
        )?.policy;

  type Draft = Omit<EntityConnectionGroup, "items"> & {
    others: { id: string; kind: ShortcodeEntity; code: string }[];
  };
  const groups = new Map<string, Draft>();
  const add = (
    direction: "incoming" | "outgoing",
    row: EdgeRow,
    spec: EntityEdgeSpec,
  ) => {
    const otherKind = edgeKindSchema.parse(
      direction === "incoming" ? row.sourceKind : row.targetKind,
    );
    const otherId = direction === "incoming" ? row.sourceId : row.targetId;
    const otherCode =
      direction === "incoming" ? row.sourceCode : row.targetCode;
    const key = `${direction}:${row.edgeKey}:${otherKind}`;
    const group = groups.get(key) ?? {
      direction,
      edgeKey: row.edgeKey,
      label:
        direction === "incoming"
          ? spec.label
          : ENTITY_LABEL[otherKind].toLowerCase(),
      role: spec.role,
      otherKind,
      count: 0,
      disposition:
        direction === "incoming" && policy
          ? (Object.entries(policy).find(
              ([edge]) => edge === row.edgeKey,
            )?.[1] ?? null)
          : null,
      others: [],
    };
    group.count += 1;
    if (otherCode && group.others.length < input.limitPerGroup) {
      group.others.push({ id: otherId, kind: otherKind, code: otherCode });
    }
    groups.set(key, group);
  };
  for (const row of incoming) {
    const spec = specFor(row.targetKind, row.edgeKey);
    if (spec) add("incoming", row, spec);
  }
  for (const row of outgoing) {
    const spec = specFor(row.targetKind, row.edgeKey);
    if (spec) add("outgoing", row, spec);
  }

  const drafts = [...groups.values()];
  const labels = await lookupEntityLabels(
    db,
    drafts.flatMap((group) =>
      group.others.map((other) => parseEntityRef(other.kind, other.id)),
    ),
  );
  const toItem = (other: Draft["others"][number]): EntityConnectionItem => ({
    id: other.code,
    kind: other.kind,
    name: labels.get(entityRefKey(other.kind, other.id)) ?? null,
  });
  return {
    id: subject.shortcode,
    kind: subject.kind,
    redirectedFrom: subject.redirectedFrom,
    groups: drafts
      .map(({ others, ...group }) => ({ ...group, items: others.map(toItem) }))
      .sort(
        (a, b) =>
          a.direction.localeCompare(b.direction) ||
          a.label.localeCompare(b.label),
      ),
  };
}

/**
 * Kinds whose live rows are expected to connect to something. Standalone
 * kinds (a Task, a Wish, a Project, a note-like Garden entry) stay out: an
 * unconnected one is normal, not a cleanup candidate.
 */
// Products are excluded: `orphanedProducts` already reports them with a
// one-click delete.
const ORPHAN_CHECK_KINDS = [
  "location",
  "vendor",
  "ingredient",
  "cookbook",
  "plant",
  "image",
] as const satisfies readonly ShortcodeEntity[];

/** Live entities of the checked kinds with no live physical connection. */
export async function findOrphanEntities(
  db: Database | DrizzleTransaction,
  options: { limit: number },
): Promise<OrphanEntitiesOut> {
  const kinds = sql.join(
    ORPHAN_CHECK_KINDS.map((kind) => sql`${kind}`),
    sql`, `,
  );
  const result = await unwrapDb(db).execute(sql`
    WITH edge AS (${entityEdgeSourceSql()}),
    connected AS (
      -- A same-kind edge (a location's parent) counts only for its target: a
      -- location that merely sits in the tree is still empty.
      SELECT "sourceId" AS id FROM edge WHERE "sourceKind" <> "targetKind"
      UNION SELECT "targetId" FROM edge
    ),
    orphan AS (
      SELECT e."id", e."kind", e."shortcode", e."createdAt"
      FROM "Entity" e
      WHERE e."kind" IN (${kinds}) AND e."deletedAt" IS NULL
        AND e."shortcode" IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM connected c WHERE c.id = e."id")
    )
    SELECT o.*, count(*) OVER ()::int AS "total"
    FROM orphan o
    ORDER BY o."createdAt" DESC, o."id"
    LIMIT ${options.limit}`);
  const rows = z
    .array(
      z.object({
        id: z.string(),
        kind: edgeKindSchema,
        shortcode: z.string(),
        total: z.number(),
      }),
    )
    .parse(result.rows);
  const labels = await lookupEntityLabels(
    db,
    rows.map((row) => parseEntityRef(row.kind, row.id)),
  );
  return {
    count: rows[0]?.total ?? 0,
    items: rows.map((row) => ({
      id: row.shortcode,
      kind: row.kind,
      name: labels.get(entityRefKey(row.kind, row.id)) ?? null,
    })),
  };
}
