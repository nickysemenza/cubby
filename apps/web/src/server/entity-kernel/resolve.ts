/**
 * The declared `capabilities.resolve`: names → live rows, one implementation
 * for every resolvable entity. One exact pass matches every requested name
 * case-insensitively against the declared stored columns (`text-array`
 * columns by element); misses get one batched contains pass when the entity
 * declares `candidates`, and — only when the caller asks and the declaration
 * allows it — a race-safe find-or-create.
 *
 * Kept free of kernel/service imports: repositories call `resolveNames`
 * directly (inside their own transactions), and the kernel's `resolve`
 * action wraps it in the kernel-owned write transaction.
 */
import type { ActorContext } from "@cubby/schemas/context";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { isAuditableEntity } from "@cubby/schemas/entity-manifest";
import { type EntityId, parseEntityId } from "@cubby/schemas/identifiers";
import {
  and,
  getTableColumns,
  getTableName,
  type InferInsertModel,
  inArray,
  isNull,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import { generatedEntityResolveCapabilities } from "~/server/generated/entity-kernel-entities.gen";
import { logAuditEntry } from "~/server/repo/audit-log";
import { notDeleted, unwrapDb } from "~/server/repo/database-helpers";
import {
  SHORTCODE_TABLE,
  type ShortcodeTable,
  type ShortcodeTableFor,
} from "~/server/repo/shortcode-tables";
import { findOrCreateWithShortcode } from "~/server/repo/shortcode-utils";

export type ResolvableEntity = keyof typeof generatedEntityResolveCapabilities;

type Db = Database | DrizzleTransaction;

export interface ResolveRequest<E extends ResolvableEntity> {
  name: string;
  /** Extra stored-column equality a match must satisfy (a plant's crop). */
  where?: Readonly<Record<string, string>>;
  /** Insert values beyond the name, read only when this name is created. */
  values?: () => Promise<Partial<InferInsertModel<ShortcodeTableFor<E>>>>;
}

export interface ResolvedRow<E extends ResolvableEntity> {
  id: EntityId<E>;
  shortcode: string;
  name: string;
  /** The row's stored match values in declared order (its name, aliases). */
  matchValues: string[];
  created: boolean;
}

export interface ResolvedName<E extends ResolvableEntity> {
  /** The request's name, trimmed. */
  name: string;
  row: ResolvedRow<E> | null;
  /** Further exact matches (ambiguity) or, for a miss, contains-matches. */
  candidates: Array<{ id: EntityId<E>; shortcode: string; name: string }>;
}

type ResolveOptions =
  | { create: false }
  /**
   * `actor` records each created row's audit entry; the legacy ingredient
   * resolver never audited its creates and passes none.
   */
  | { create: true; actor?: ActorContext };

const matchRowSchema = z.object({
  id: z.string(),
  shortcode: z.string(),
  name: z.string(),
  values: z.array(z.string().nullable()),
  scope: z.record(z.string(), z.string().nullable()),
});
const candidateRowSchema = z.object({
  key: z.string(),
  id: z.string(),
  shortcode: z.string(),
  name: z.string(),
});
type MatchRow = z.infer<typeof matchRowSchema> & { matchValues: string[] };

/** One stored column of the entity, and whether it is a `text[]` column. */
interface StoredColumn {
  key: string;
  column: PgColumn;
  array: boolean;
}

/** The entity's resolve columns, resolved once per call. */
const resolvePlan = (entity: ResolvableEntity) => {
  const capability: {
    readonly match: readonly string[];
    readonly createMissing: boolean;
    readonly candidates?: number;
    readonly scope: readonly string[];
  } = generatedEntityResolveCapabilities[entity];
  const table: ShortcodeTable = SHORTCODE_TABLE[entity];
  const columns = getTableColumns(table);
  const column = (key: string): StoredColumn => {
    const stored = entityFieldModels[entity].storage.find(
      (entry) => entry.key === key,
    );
    const found = columns[key];
    if (!found || !stored)
      throw new Error(`${entity}.${key} is not a stored resolve column`);
    return { key, column: found, array: stored.kind === "text-array" };
  };
  const match = capability.match.map(column);
  const [name] = match;
  const createdAt = columns.createdAt;
  if (!name || !createdAt)
    throw new Error(`${entity} declares no resolvable name column`);
  return {
    entity,
    capability,
    table,
    column,
    match,
    name,
    createdAt,
    scope: [...capability.scope].map((key) => column(key).column),
  };
};
type ResolvePlan = ReturnType<typeof resolvePlan>;

/**
 * Text literals bound one parameter each: a JS array interpolated into `sql`
 * renders as a row constructor, which `IN`/`ARRAY[...]` would misread.
 */
const textList = (values: readonly string[]): SQL =>
  sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );

const keyOf = (name: string, where: Readonly<Record<string, string>> = {}) =>
  `${name.toLowerCase()}\u0000${JSON.stringify(
    Object.entries(where).sort(([a], [b]) => a.localeCompare(b)),
  )}`;

const exactPredicate = (plan: ResolvePlan, lowered: readonly string[]) =>
  or(
    ...plan.match.map(({ column, array }) =>
      array
        ? sql`EXISTS (SELECT 1 FROM unnest(${column}) AS value WHERE lower(value) IN (${textList(lowered)}))`
        : inArray(sql`lower(${column})`, [...lowered]),
    ),
  );

const liveInScope = (plan: ResolvePlan): SQL[] => [
  notDeleted(plan.table),
  ...plan.scope.map((column) => isNull(column)),
];

/** Live in-scope rows matching `where`, oldest first, with match values. */
const selectMatches = async (
  db: Db,
  plan: ResolvePlan,
  where: SQL | undefined,
  scopeKeys: readonly string[],
): Promise<MatchRow[]> => {
  const rows = await unwrapDb(db)
    .select({
      id: plan.table.id,
      shortcode: plan.table.shortcode,
      name: plan.name.column,
      values: sql`ARRAY[${sql.join(
        plan.match.map(({ column, array }) =>
          array
            ? sql`array_to_string(${column}, chr(31))`
            : sql`${column}::text`,
        ),
        sql`, `,
      )}]`,
      scope: sql`jsonb_build_object(${sql.join(
        scopeKeys.map(
          (key) => sql`${key}::text, ${plan.column(key).column}::text`,
        ),
        sql`, `,
      )})`,
    })
    .from(plan.table)
    .where(and(...liveInScope(plan), where))
    // The oldest row wins among several exact matches.
    .orderBy(plan.createdAt, plan.table.shortcode);
  return rows.map((raw) => {
    const row = matchRowSchema.parse(raw);
    return {
      ...row,
      matchValues: row.values
        .flatMap((value) => (value === null ? [] : value.split("\u001f")))
        .filter((value) => value.length > 0),
    };
  });
};

const resolvedRow = <E extends ResolvableEntity>(
  entity: E,
  row: MatchRow,
  created: boolean,
): ResolvedRow<E> => ({
  id: parseEntityId(entity, row.id),
  shortcode: row.shortcode,
  name: row.name,
  matchValues: row.matchValues,
  created,
});

/** Find-or-create one miss, race-safe on the entity's unique name index. */
const createMiss = async <E extends ResolvableEntity>(
  db: Db,
  plan: ResolvePlan & { entity: E },
  miss: ResolveRequest<E>,
  actor: ActorContext | undefined,
): Promise<ResolvedRow<E>> => {
  const where = and(
    ...liveInScope(plan),
    exactPredicate(plan, [miss.name.toLowerCase()]),
    ...Object.entries(miss.where ?? {}).map(
      ([key, value]) => sql`${plan.column(key).column} = ${value}`,
    ),
  );
  const { row, created } = await findOrCreateWithShortcode(db, plan.entity, {
    where,
    values: async () =>
      // SAFETY: the name plus empty declared `text[]` match columns are the
      // entity's required inserts beyond the minted shortcode; the compiler
      // checks the match columns are the entity's own stored text columns,
      // and `values` is typed by the same entity's insert model.
      ({
        ...Object.fromEntries(
          plan.match.map(({ key, array }) => [key, array ? [] : miss.name]),
        ),
        ...(await miss.values?.()),
      }) as never,
  });
  const id = z.object({ id: z.string() }).parse(row).id;
  if (created && actor && isAuditableEntity(plan.entity))
    await logAuditEntry(db, actor, {
      entityKind: plan.entity,
      entityId: id,
      action: "create",
    });
  const [stored] = await selectMatches(
    db,
    plan,
    sql`${plan.table.id} = ${id}`,
    [],
  );
  if (!stored) throw new Error(`${plan.entity} ${id} vanished after create`);
  return resolvedRow(plan.entity, stored, created);
};

/** One batched contains pass for every miss — not a round trip per name. */
const candidatesFor = async <E extends ResolvableEntity>(
  db: Db,
  plan: ResolvePlan & { entity: E },
  limit: number,
  lowered: readonly string[],
): Promise<Map<string, ResolvedName<E>["candidates"]>> => {
  const qualified = (column: PgColumn) =>
    sql.raw(`t.${JSON.stringify(column.name)}`);
  const contains = or(
    ...plan.match.map(({ column, array }) =>
      array
        ? sql`EXISTS (SELECT 1 FROM unnest(${qualified(column)}) AS value WHERE value ILIKE '%' || m.key || '%')`
        : sql`${qualified(column)} ILIKE '%' || m.key || '%'`,
    ),
  );
  const scoped = sql.join(
    plan.scope.map((column) => sql` AND ${qualified(column)} IS NULL`),
    sql``,
  );
  const result = await unwrapDb(db).execute(sql`
    SELECT m.key AS key, cand.id AS id, cand.shortcode AS shortcode, cand.name AS name
    FROM unnest(ARRAY[${textList(lowered)}]::text[]) AS m(key)
    CROSS JOIN LATERAL (
      SELECT t."id" AS id, t."shortcode" AS shortcode, ${qualified(plan.name.column)} AS name
      FROM ${sql.identifier(getTableName(plan.table))} t
      WHERE t."deletedAt" IS NULL${scoped} AND (${contains})
      ORDER BY ${qualified(plan.name.column)} ASC, t."shortcode" ASC, t."id" ASC
      LIMIT ${limit}
    ) cand
  `);
  const byKey = new Map<string, ResolvedName<E>["candidates"]>();
  for (const row of z.array(candidateRowSchema).parse(result.rows))
    byKey.set(row.key, [
      ...(byKey.get(row.key) ?? []),
      {
        id: parseEntityId(plan.entity, row.id),
        shortcode: row.shortcode,
        name: row.name,
      },
    ]);
  return byKey;
};

/**
 * Resolve each request to a live row, in request order, skipping blank
 * names. Requests that differ only in casing or surrounding whitespace share
 * one lookup and, when created, one row.
 */
export async function resolveNames<E extends ResolvableEntity>(
  db: Db,
  entity: E,
  requests: readonly ResolveRequest<E>[],
  options: ResolveOptions,
): Promise<ResolvedName<E>[]> {
  const plan = { ...resolvePlan(entity), entity };
  const unique = new Map<string, ResolveRequest<E>>();
  for (const request of requests) {
    const name = request.name.trim();
    const key = keyOf(name, request.where);
    if (name.length > 0 && !unique.has(key))
      unique.set(key, { ...request, name });
  }
  const pending = [...unique.values()];
  const scopeKeys = [
    ...new Set(pending.flatMap((r) => Object.keys(r.where ?? {}))),
  ];
  const rows =
    pending.length === 0
      ? []
      : await selectMatches(
          db,
          plan,
          exactPredicate(plan, [
            ...new Set(pending.map((r) => r.name.toLowerCase())),
          ]),
          scopeKeys,
        );

  const resolved = new Map<string, ResolvedName<E>>();
  const misses: ResolveRequest<E>[] = [];
  for (const [key, request] of unique) {
    const lower = request.name.toLowerCase();
    const [first, ...rest] = rows.filter(
      (row) =>
        row.matchValues.some((value) => value.toLowerCase() === lower) &&
        Object.entries(request.where ?? {}).every(
          ([column, value]) => row.scope[column] === value,
        ),
    );
    if (first)
      resolved.set(key, {
        name: request.name,
        row: resolvedRow(entity, first, false),
        candidates: rest.map((row) => resolvedRow(entity, row, false)),
      });
    else misses.push(request);
  }

  if (options.create) {
    for (const miss of misses)
      resolved.set(keyOf(miss.name, miss.where), {
        name: miss.name,
        row: await createMiss(db, plan, miss, options.actor),
        candidates: [],
      });
  } else if (misses.length > 0 && plan.capability.candidates !== undefined) {
    const byKey = await candidatesFor(db, plan, plan.capability.candidates, [
      ...new Set(misses.map((miss) => miss.name.toLowerCase())),
    ]);
    for (const miss of misses)
      resolved.set(keyOf(miss.name, miss.where), {
        name: miss.name,
        row: null,
        candidates: byKey.get(miss.name.toLowerCase()) ?? [],
      });
  }

  return requests.flatMap((request) => {
    const name = request.name.trim();
    if (name.length === 0) return [];
    return [
      resolved.get(keyOf(name, request.where)) ?? {
        name,
        row: null,
        candidates: [],
      },
    ];
  });
}
