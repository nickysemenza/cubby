/**
 * The declared `capabilities.resolve`: names → live rows, one implementation
 * for every resolvable entity. One exact pass matches every requested name
 * case-insensitively against the declared stored columns (`text-array`
 * columns by element); misses get one batched lexical pass (contains, token
 * OR, trigram) when the entity declares `candidates`, and — only when the caller asks and the declaration
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
import { searchableEntitySchema } from "@cubby/schemas/search";
import {
  and,
  getTableColumns,
  getTableName,
  inArray,
  type InferInsertModel,
  isNull,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import { ilikeContains, notDeleted, unwrapDb } from "~/server/db/helpers";
import { findPgError } from "~/server/errors/db-errors";
import { generatedEntityResolveCapabilities } from "~/server/generated/entity-kernel-entities.gen";
import {
  logAuditEntries,
  logAuditEntry,
} from "~/server/generic/audit-log/repo/audit-log";
import { buildAnyPrefixTsQuery } from "~/server/generic/search/repo/search-lexical";
import {
  SHORTCODE_TABLE,
  type ShortcodeTable,
  type ShortcodeTableFor,
} from "~/server/generic/shortcode/repo/shortcode-tables";
import {
  findOrCreateWithShortcode,
  insertManyWithShortcode,
} from "~/server/generic/shortcode/repo/shortcode-utils";
import {
  matchesNameOrAlias,
  nameMatchesAnySql,
  textArrayMatchesAnySql,
  textArraySomeSql,
} from "~/server/lib/name-alias-match";

export type ResolvableEntity = keyof typeof generatedEntityResolveCapabilities;

type Db = Database | DrizzleTransaction;

export interface ResolveRequest<E extends ResolvableEntity> {
  name: string;
  /** Extra stored-column equality a match must satisfy (a plant's crop). */
  where?: Readonly<Record<string, string>>;
  /** Insert values beyond the name, read only when this name is created. */
  values?: () => Promise<Partial<InferInsertModel<ShortcodeTableFor<E>>>>;
}

interface ResolvedRow<E extends ResolvableEntity> {
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
  /** `actor` records each created row's audit entry. */
  | { create: true; actor: ActorContext };

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
        ? textArrayMatchesAnySql(column, lowered)
        : nameMatchesAnySql(column, lowered),
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
  actor: ActorContext,
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
  if (created && isAuditableEntity(plan.entity))
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

/**
 * Create several misses with one insert, one audit insert and one read-back.
 * A miss whose name another miss's new row would store as a match value, a
 * scoped miss, or a lost name race takes the one-at-a-time find-or-create,
 * so the outcome matches creating each miss in request order.
 */
const createMisses = async <E extends ResolvableEntity>(
  db: Db,
  plan: ResolvePlan & { entity: E },
  misses: readonly ResolveRequest<E>[],
  actor: ActorContext,
): Promise<ResolvedRow<E>[]> => {
  const extras: Partial<InferInsertModel<ShortcodeTableFor<E>>>[] = [];
  for (const miss of misses) extras.push((await miss.values?.()) ?? {});
  const values = misses.map((miss, index) => ({
    ...Object.fromEntries(
      plan.match.map(({ key, array }) => [key, array ? [] : miss.name]),
    ),
    ...extras[index],
  }));
  const one = async () => {
    const rows: ResolvedRow<E>[] = [];
    for (const [index, miss] of misses.entries())
      rows.push(
        await createMiss(
          db,
          plan,
          { ...miss, values: async () => extras[index] ?? {} },
          actor,
        ),
      );
    return rows;
  };
  const keys = new Set(plan.match.map(({ key }) => key));
  const stored = values.map((row) =>
    Object.entries(row).flatMap(([key, value]) =>
      keys.has(key)
        ? [value]
            .flat()
            .flatMap((entry) =>
              typeof entry === "string" ? [entry.toLowerCase()] : [],
            )
        : [],
    ),
  );
  if (
    misses.length < 2 ||
    misses.some((miss) => Object.keys(miss.where ?? {}).length) ||
    misses.some((miss, index) =>
      stored.some(
        (matches, other) =>
          other !== index && matches.includes(miss.name.toLowerCase()),
      ),
    )
  )
    return one();
  let created;
  try {
    created = await insertManyWithShortcode(
      db,
      plan.entity,
      // SAFETY: as in `createMiss`, the name plus empty declared `text[]`
      // match columns are the entity's required inserts beyond the minted
      // shortcode, and each miss's values are typed by its insert model.
      values as never,
    );
  } catch (error) {
    if (findPgError(error)?.code !== "23505") throw error;
    return one();
  }
  const ids = created.map((row) => z.object({ id: z.string() }).parse(row).id);
  if (isAuditableEntity(plan.entity))
    await logAuditEntries(
      db,
      actor,
      ids.map((id) => ({
        entityKind: plan.entity,
        entityId: id,
        action: "create" as const,
      })),
    );
  const rows = new Map(
    (await selectMatches(db, plan, inArray(plan.table.id, ids), [])).map(
      (row) => [row.id, row],
    ),
  );
  return ids.map((id) => {
    const row = rows.get(id);
    if (!row) throw new Error(`${plan.entity} ${id} vanished after create`);
    return resolvedRow(plan.entity, row, true);
  });
};

/**
 * Mint names the caller proved absent in this transaction, in its write
 * layer: one staged row per name (match arrays empty), the create audit, and
 * resolved rows from the inserted payload. The caller rechecks the names
 * after this; a unique-name race aborts the layer. A miss stored as another
 * miss's match value must take `resolveNames` instead.
 */

/**
 * One batched candidate pass for every miss — not a round trip per name.
 * Best tier first: the stored name/aliases contain the request, the request
 * contains the stored name ("Organic Example Fruit" finds "Example Fruit"),
 * any request token prefixes the row's search vector (ranked by how many),
 * then a trigram-similar title. The search-document arms are additive: a row
 * not yet indexed still matches through the stored columns.
 */
const candidatesFor = async <E extends ResolvableEntity>(
  db: Db,
  plan: ResolvePlan & { entity: E },
  limit: number,
  lowered: readonly string[],
): Promise<Map<string, ResolvedName<E>["candidates"]>> => {
  // A resolvable entity that declares `candidates` must be indexed for search.
  const entityKind = searchableEntitySchema.parse(plan.entity);
  const column = (alias: string, column: PgColumn) =>
    sql.raw(`${alias}.${JSON.stringify(column.name)}`);
  const storedMatch = (alias: string) => {
    const name = column(alias, plan.name.column);
    return {
      name,
      contains: or(
        ...plan.match.map(({ column: match, array }) =>
          array
            ? textArraySomeSql(
                column(alias, match),
                (value) => sql`${value} ILIKE m.pattern`,
              )
            : sql`${column(alias, match)} ILIKE m.pattern`,
        ),
      ),
      contained: sql`(char_length(${name}) >= 3 AND strpos(m.key, lower(${name})) > 0)`,
      scoped: sql.join(
        plan.scope.map((scope) => sql` AND ${column(alias, scope)} IS NULL`),
        sql``,
      ),
    };
  };
  const { name, contains, contained, scoped } = storedMatch("t");
  const stored = storedMatch("c");
  const tokenQuery = sql`to_tsquery('simple', NULLIF(m.tsq, ''))`;
  const tokenMatch = sql`sd."searchVector" @@ ${tokenQuery}`;
  const table = sql.identifier(getTableName(plan.table));
  // One OR across the record and its joined search document defeats every
  // index, so each name scanned the table and computed similarity per row.
  // The page starts from candidate ids instead: each arm uses its own index
  // (search-vector GIN, trigram GiST) or scans only stored names, and the
  // outer predicate and ranking are unchanged.
  const candidateIds = sql`
          SELECT c."id" FROM ${table} c
          WHERE ${notDeleted("c")}${stored.scoped}
            AND (${stored.contains} OR ${stored.contained})
          UNION
          SELECT ts."entityId" FROM "SearchDocument" ts
          WHERE ts."entityKind" = ${entityKind} AND ${notDeleted("ts")}
            AND ts."searchVector" @@ ${tokenQuery}
          UNION
          SELECT tg."entityId" FROM "SearchDocument" tg
          WHERE tg."entityKind" = ${entityKind} AND ${notDeleted("tg")}
            AND char_length(m.key) >= 3 AND tg."normalizedText" % m.key`;
  const result = await unwrapDb(db).execute(
    sql`
    SELECT m.key AS key, cand.id AS id, cand.shortcode AS shortcode, cand.name AS name
    FROM unnest(
      ARRAY[${textList(lowered)}]::text[],
      ARRAY[${textList(lowered.map(buildAnyPrefixTsQuery))}]::text[],
      ARRAY[${textList(lowered.map(ilikeContains))}]::text[]
    ) AS m(key, tsq, pattern)
    CROSS JOIN LATERAL (
      SELECT t."id" AS id, t."shortcode" AS shortcode, ${name} AS name
      FROM (${candidateIds}) ids(id)
      JOIN ${table} t ON t."id" = ids.id
      LEFT JOIN "SearchDocument" sd
        ON sd."entityId" = t."id"
        AND sd."entityKind" = ${entityKind}
        AND ${notDeleted("sd")}
      WHERE ${notDeleted("t")}${scoped}
        AND (
          ${contains}
          OR ${contained}
          OR ${tokenMatch}
          OR (char_length(m.key) >= 3 AND sd."normalizedText" % m.key)
        )
      ORDER BY
        CASE WHEN ${contains} THEN 0 WHEN ${contained} THEN 1 WHEN ${tokenMatch} THEN 2 ELSE 3 END,
        COALESCE(ts_rank_cd(sd."searchVector", ${tokenQuery}), 0) DESC,
        COALESCE(similarity(sd."normalizedText", m.key), 0) DESC,
        ${name} ASC, t."shortcode" ASC, t."id" ASC
      LIMIT ${limit}
    ) cand
  `,
    "objects",
  );
  const byKey = new Map<string, ResolvedName<E>["candidates"]>();
  for (const row of z.array(candidateRowSchema).parse(result))
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
        matchesNameOrAlias({
          name: row.name,
          aliases: row.matchValues,
          query: lower,
        }) &&
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
    const created = await createMisses(db, plan, misses, options.actor);
    for (const [index, miss] of misses.entries())
      resolved.set(keyOf(miss.name, miss.where), {
        name: miss.name,
        row: created[index]!,
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
