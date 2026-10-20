import { assessmentFamily } from "@cubby/schemas/assessment";
import {
  DERIVED_REFRESH_PAGE,
  DERIVED_REFRESH_ROOT_PAGE,
  DERIVED_REFRESH_RECONCILE_INTERVAL_MS,
  derivedRefreshReconcileCursor,
  derivedRefreshOwners,
} from "@cubby/schemas/derived-refresh";
import { entitySchema } from "@cubby/schemas/entity";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { searchableEntitySchema } from "@cubby/schemas/search";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, asc, eq, gt, inArray, lt, sql, type SQL } from "drizzle-orm";
import { getTableName, getTableColumns } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import {
  derivedRefreshCursor,
  derivedRefreshObservedInput,
  derivedRefreshSnapshot,
  entityIdentity,
  recipe,
  assessmentState,
} from "~/server/db/schema";
import { SHORTCODE_TABLE } from "~/server/generated/shortcode-tables.gen";
import {
  advanceInputRevisions,
  readInputRevisions,
} from "~/server/generic/derived-refresh/repo/revisions";
import type { SemanticEmbeddingConfig } from "~/server/generic/embedding/service/semantic/config";
import { selectUnembeddedSearchDocumentRefs } from "~/server/generic/search/repo/search-document";

import { captureDerivedRefresh } from "./capture";

const KEY = "derived-refresh";
const ignored = [
  "createdAt",
  "updatedAt",
  "verifiedAt",
  "lastVerifiedAt",
  "lastSeenAt",
  "totals",
  "totalsComputedAt",
];
const ignoredSql = sql`ARRAY[${sql.join(
  ignored.map((key) => sql`${key}`),
  sql`, `,
)}]::text[]`;
type InputTable = { name: string; scope: string; query: SQL };
/** Direct identity keys plus declared child owners; old refs survive in observations. */
const observedOwners = (row: SQL, name: string) => sql`coalesce((
  SELECT jsonb_agg(jsonb_build_object('entityKind', e.kind, 'entityId', e.id::text) ORDER BY e.kind,e.id)
  FROM "Entity" e WHERE e.id IN (
    SELECT CASE WHEN (kv.key='id' OR right(kv.key,2)='Id')
      AND kv.value #>> '{}' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      THEN (kv.value #>> '{}')::uuid END FROM jsonb_each(${row}) kv
    UNION SELECT s."recipeId" FROM "RecipeSection" s WHERE s.id=(${row}->>'recipeSectionId')::uuid
    UNION SELECT m.id FROM "Email" m WHERE m."orderMailId"=CASE
      WHEN ${name === "OrderMail"} THEN (${row}->>'id')::uuid
      WHEN ${name === "OrderMailEvent"} THEN (${row}->>'orderMailId')::uuid END
  )
), '[]'::jsonb)`;
const ownTables = Object.entries(SHORTCODE_TABLE).flatMap(
  ([kind, table]): InputTable[] =>
    kind === "run"
      ? []
      : [
          {
            name: getTableName(table),
            scope: `kind:${kind}`,
            query: sql`SELECT ${table.id} AS id,
              md5((to_jsonb(${table})-${ignoredSql})::text) || ':' ||
              md5(jsonb_build_array(${sql.join(
                Object.entries(getTableColumns(table))
                  .filter(([key]) => key.endsWith("Id"))
                  .map(([, column]) => sql`${column}`),
                sql`, `,
              )})::text) AS fingerprint,
              ${observedOwners(sql`to_jsonb(${table})`, getTableName(table))} AS owners FROM ${table}`,
          },
        ],
);
const entityByTable = new Map<string, string>(
  Object.entries(SHORTCODE_TABLE).map(([kind, table]) => [
    getTableName(table),
    kind,
  ]),
);
const contextTables = [
  "EntityLink",
  "EntityAttachment",
  "EntityExternalId",
  "EntitySource",
  "AiAnalysis",
  "FinancialTransactionAllocation",
  "ExpenseAttribution",
  "ProductUnitMapping",
  "RecipeSection",
  "RecipeSectionIngredient",
  "MealRecipe",
  "MealFoodEntry",
  "ImportSourceProduct",
  "ImportSourceOrder",
  "OrderMail",
  "OrderMailEvent",
  "StatementRow",
].map((name): InputTable => ({
  name,
  scope: `context:${name}`,
  query: sql`SELECT r.id, md5((to_jsonb(r)-${ignoredSql})::text) AS fingerprint,
    ${observedOwners(sql`to_jsonb(r)`, name)} AS owners FROM ${sql.identifier(name)} r`,
}));
const tables: readonly InputTable[] = [
  ...ownTables,
  ...contextTables,
  {
    name: "AssessmentState",
    scope: "context:AssessmentState",
    query: sql`SELECT r.id, md5(jsonb_build_object('family',family,'recordId',"recordId",'data',data,${assessmentState.active.name}::text,active,'confirmedValue',"confirmedValue")::text) AS fingerprint,
    ${observedOwners(sql`to_jsonb(r)`, "AssessmentState")} AS owners
    FROM "AssessmentState" r WHERE (family=${assessmentFamily.enum.image_description} AND "confirmedValue" IS NOT NULL) OR (family=${assessmentFamily.enum.email_link} AND active)`,
  },
];
const fingerprintRow = z.object({ id: z.uuid(), fingerprint: z.string() });
const observedRow = fingerprintRow.extend({ owners: derivedRefreshOwners });
const storedObservedRow = observedRow
  .omit({ id: true })
  .extend({ key: z.string(), scope: z.string() });

// Only truly ownerless input changes need the conservative corpus backstop.
const projectionInputs = contextTables
  .map((table) => `repair:${table.scope}`)
  .concat("repair:context:AssessmentState");

export async function reconcileAvailability(db: Database) {
  const [row] = await getDb(db)
    .select()
    .from(derivedRefreshCursor)
    .where(eq(derivedRefreshCursor.key, KEY))
    .limit(1);
  return {
    due: !row || row.availableAt <= new Date(),
    key: row?.availableAt.toISOString() ?? "initial",
    active: row?.cursor != null,
  };
}

/** Genuine full reconciliation: observes rows and removals without trusting hooks or updatedAt. */
export async function reconcileDerivedRefreshPage(
  db: Database,
  options: { embeddingConfig?: SemanticEmbeddingConfig } = {},
): Promise<{ done: boolean; processed: number }> {
  return withTransactionDatabase(db, async (tx) => {
    await getDb(tx)
      .insert(derivedRefreshCursor)
      .values({ key: KEY })
      .onConflictDoNothing();
    const [stored] = await getDb(tx)
      .select()
      .from(derivedRefreshCursor)
      .where(eq(derivedRefreshCursor.key, KEY))
      .limit(1)
      .for("update");
    if (stored && stored.availableAt > new Date())
      return { done: true, processed: 0 };
    const cursor = derivedRefreshReconcileCursor.parse(
      stored?.cursor ?? {
        phase: "inputs",
        table: 0,
        after: null,
        startedAt: new Date().toISOString(),
      },
    );
    let next = cursor;
    const startedAt = new Date(cursor.startedAt);
    let processed = 0;
    let finished = false;
    if (cursor.phase === "inputs") {
      const table = tables[cursor.table];
      if (!table) next = { ...cursor, phase: "orphans", after: null };
      else {
        const result = await getDb(tx)
          .execute(sql`SELECT r.id::text AS id, r.fingerprint, r.owners FROM (${table.query}) r
          ${cursor.after ? sql`WHERE r.id>${cursor.after}::uuid` : sql``}
          ORDER BY r.id LIMIT ${DERIVED_REFRESH_PAGE}`);
        const rows = z.array(observedRow).parse(result.rows);
        const keyed = rows.map((row) => ({
          ...row,
          key: `${table.name}:${row.id}`,
        }));
        const previous = storedObservedRow.array().parse(
          keyed.length
            ? await getDb(tx)
                .select()
                .from(derivedRefreshObservedInput)
                .where(
                  inArray(
                    derivedRefreshObservedInput.key,
                    keyed.map((row) => row.key),
                  ),
                )
            : [],
        );
        const hashes = new Map(
          previous.map((row) => [row.key, row.fingerprint]),
        );
        const changed = keyed.filter(
          (row) => hashes.get(row.key) !== row.fingerprint,
        );
        if (changed.length) {
          const entity = entityByTable.get(table.name);
          const prior = new Map(previous.map((row) => [row.key, row]));
          const refs = changed.flatMap((row) => {
            const old = prior.get(row.key);
            const endpointsChanged =
              old !== undefined &&
              old.fingerprint.split(":")[1] !== row.fingerprint.split(":")[1];
            return entity && !endpointsChanged
              ? [{ entityKind: entitySchema.parse(entity), entityId: row.id }]
              : [...(old?.owners ?? []), ...row.owners];
          });
          await advanceInputRevisions(tx, [
            "all",
            table.scope,
            ...(!entity &&
            changed.some(
              (row) =>
                row.owners.length === 0 &&
                (prior.get(row.key)?.owners.length ?? 0) === 0,
            )
              ? [`repair:${table.scope}`]
              : []),
            ...(entity
              ? changed.map((row) => `entity:${entity}:${row.id}`)
              : []),
          ]);
          await captureDerivedRefresh(tx, refs, { invalidate: false });
        }
        if (keyed.length)
          await getDb(tx)
            .insert(derivedRefreshObservedInput)
            .values(
              keyed.map((row) => ({
                key: row.key,
                fingerprint: row.fingerprint,
                owners: row.owners,
                scope: table.scope,
                seenAt: startedAt,
              })),
            )
            .onConflictDoUpdate({
              target: derivedRefreshObservedInput.key,
              set: {
                fingerprint: sql`excluded.fingerprint`,
                owners: sql`excluded.owners`,
                seenAt: startedAt,
              },
            });
        next =
          rows.length < DERIVED_REFRESH_PAGE
            ? { ...cursor, table: cursor.table + 1, after: null }
            : { ...cursor, after: rows.at(-1)?.id ?? null };
        processed = rows.length;
      }
    } else if (cursor.phase === "orphans") {
      const removed = storedObservedRow
        .array()
        .parse(
          await getDb(tx)
            .select()
            .from(derivedRefreshObservedInput)
            .where(lt(derivedRefreshObservedInput.seenAt, startedAt))
            .orderBy(asc(derivedRefreshObservedInput.key))
            .limit(DERIVED_REFRESH_PAGE),
        );
      if (removed.length) {
        await advanceInputRevisions(tx, [
          "all",
          ...removed.flatMap((row) => {
            const [table, id] = row.key.split(":");
            const entity = table ? entityByTable.get(table) : undefined;
            return [
              row.scope,
              ...(!entity && row.owners.length === 0
                ? [`repair:${row.scope}`]
                : []),
              ...(entity && id ? [`entity:${entity}:${id}`] : []),
            ];
          }),
        ]);
        await captureDerivedRefresh(
          tx,
          removed.flatMap((row) => row.owners),
          { invalidate: false },
        );
        await getDb(tx)
          .delete(derivedRefreshObservedInput)
          .where(
            inArray(
              derivedRefreshObservedInput.key,
              removed.map((row) => row.key),
            ),
          );
      } else next = { ...cursor, phase: "roots", after: null };
      processed = removed.length;
    } else if (cursor.phase === "roots") {
      const roots = await getDb(tx)
        .select({
          entityKind: entityIdentity.kind,
          entityId: entityIdentity.id,
        })
        .from(entityIdentity)
        .where(
          and(
            sql`${entityIdentity.kind}<>${entitySchema.enum.run}`,
            cursor.after ? gt(entityIdentity.id, cursor.after) : undefined,
          ),
        )
        .orderBy(asc(entityIdentity.id))
        .limit(DERIVED_REFRESH_ROOT_PAGE);
      const revisions = new Map(await readInputRevisions(tx, projectionInputs));
      const declared = roots.flatMap((root) => {
        const kind = entitySchema.parse(root.entityKind);
        const table = Object.entries(SHORTCODE_TABLE).find(
          ([key]) => key === kind,
        )?.[1];
        return table
          ? [
              {
                ...root,
                entityKind: kind,
                key: `${getTableName(table)}:${root.entityId}`,
              },
            ]
          : [];
      });
      const observed = declared.length
        ? await getDb(tx)
            .select()
            .from(derivedRefreshObservedInput)
            .where(
              inArray(
                derivedRefreshObservedInput.key,
                declared.map((root) => root.key),
              ),
            )
        : [];
      const snapshots = declared.length
        ? await getDb(tx)
            .select()
            .from(derivedRefreshSnapshot)
            .where(
              inArray(
                derivedRefreshSnapshot.entityId,
                declared.map((root) => root.entityId),
              ),
            )
        : [];
      const documentRows = declared.length
        ? await getDb(tx).execute(sql`
        WITH refs(kind,id) AS (VALUES ${sql.join(
          declared.map(
            (root) => sql`(${root.entityKind}::text, ${root.entityId}::uuid)`,
          ),
          sql`, `,
        )})
        SELECT d."entityId"::text AS id, md5((to_jsonb(d)-ARRAY['id','createdAt','updatedAt']::text[])::text) AS fingerprint
        FROM refs JOIN "SearchDocument" d ON d."entityKind"=refs.kind AND d."entityId"=refs.id AND d."deletedAt" IS NULL
      `)
        : null;
      const documents = new Map(
        z
          .array(fingerprintRow)
          .parse(documentRows?.rows ?? [])
          .map((row) => [row.id, row.fingerprint]),
      );
      const own = new Map(observed.map((row) => [row.key, row.fingerprint]));
      const stored = new Map(
        snapshots.map((row) => [row.entityId, row.fingerprint]),
      );
      const changed = [];
      for (const root of declared) {
        const fingerprint = await sha256Hex(
          JSON.stringify([
            "derived-refresh-v2",
            own.get(root.key) ?? "missing",
            documents.get(root.entityId) ?? null,
            projectionInputs.map((key) => [key, revisions.get(key) ?? 0]),
          ]),
        );
        if (stored.get(root.entityId) !== fingerprint)
          changed.push({
            entityKind: root.entityKind,
            entityId: root.entityId,
            fingerprint,
          });
      }
      if (changed.length) {
        await captureDerivedRefresh(tx, changed, { invalidate: false });
        await getDb(tx)
          .insert(derivedRefreshSnapshot)
          .values(changed)
          .onConflictDoUpdate({
            target: [
              derivedRefreshSnapshot.entityKind,
              derivedRefreshSnapshot.entityId,
            ],
            set: {
              fingerprint: sql`excluded.fingerprint`,
              updatedAt: sql`now()`,
            },
          });
      }
      processed = roots.length;
      if (roots.length < DERIVED_REFRESH_ROOT_PAGE) {
        next = { ...cursor, phase: "recipes", after: null };
      } else next = { ...cursor, after: roots.at(-1)?.entityId ?? null };
    } else if (cursor.phase === "recipes") {
      // Cache damage and a lost wake-up must be repaired even when the owning
      // input snapshot is unchanged. Active/exhausted work remains coalesced.
      const missing = await getDb(tx)
        .select({ id: recipe.id })
        .from(recipe)
        .where(
          and(
            sql`${recipe.deletedAt} IS NULL`,
            sql`(${recipe.totals} IS NULL OR ${recipe.totalsComputedAt} IS NULL)`,
            cursor.after
              ? gt(recipe.id, parseEntityId("recipe", cursor.after))
              : undefined,
          ),
        )
        .orderBy(asc(recipe.id))
        .limit(DERIVED_REFRESH_ROOT_PAGE);
      await captureDerivedRefresh(
        tx,
        missing.map(({ id }) => ({ entityKind: "recipe", entityId: id })),
        { invalidate: false },
      );
      processed = missing.length;
      if (missing.length < DERIVED_REFRESH_ROOT_PAGE) {
        next = { ...cursor, phase: "embeddings", after: null };
      } else next = { ...cursor, after: missing.at(-1)?.id ?? null };
    } else {
      const position = cursor.after
        ? z
            .object({ entityKind: searchableEntitySchema, entityId: z.uuid() })
            .parse(JSON.parse(cursor.after))
        : undefined;
      const page = options.embeddingConfig
        ? await selectUnembeddedSearchDocumentRefs(
            tx,
            options.embeddingConfig,
            { cursor: position, pageSize: DERIVED_REFRESH_ROOT_PAGE },
          )
        : { refs: [], nextCursor: null };
      await captureDerivedRefresh(tx, page.refs, { invalidate: false });
      processed = page.refs.length;
      finished = page.nextCursor === null;
      next = {
        ...cursor,
        after: page.nextCursor ? JSON.stringify(page.nextCursor) : null,
      };
    }
    if (finished) {
      const availableAt = new Date(
        Date.now() + DERIVED_REFRESH_RECONCILE_INTERVAL_MS,
      );
      await getDb(tx)
        .insert(derivedRefreshCursor)
        .values({ key: KEY, cursor: null, availableAt })
        .onConflictDoUpdate({
          target: derivedRefreshCursor.key,
          set: { cursor: null, availableAt },
        });
      return { done: true, processed };
    }
    await getDb(tx)
      .insert(derivedRefreshCursor)
      .values({ key: KEY, cursor: next })
      .onConflictDoUpdate({
        target: derivedRefreshCursor.key,
        set: { cursor: next },
      });
    return { done: false, processed };
  });
}
