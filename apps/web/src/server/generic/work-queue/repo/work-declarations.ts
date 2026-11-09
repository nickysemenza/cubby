import {
  dataCheck,
  dataCheckMessage,
  dataChecksByEntity,
  type DataCheck,
} from "@cubby/schemas/data-quality";
import { entityQualityCheckState } from "@cubby/schemas/data-quality-shape";
import {
  problemActionId,
  problemActionsFor,
} from "@cubby/schemas/entity-definitions/problems/problem-actions";
import type { FilterAssembly } from "@cubby/schemas/entity-definitions/problems/problem-query";
import { problemQueryDeclarations } from "@cubby/schemas/entity-definitions/problems/problem-registry";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import { entitySummary } from "@cubby/schemas/entity-summary";
import { oneOrManyValues } from "@cubby/schemas/pagination";
import {
  workQueueGapViews,
  type WorkAction,
  type WorkSourceActionId,
} from "@cubby/schemas/work-queue";
import { workQueueGapChecks } from "@cubby/schemas/work-queue-policy";
import {
  and,
  eq,
  isNull,
  or,
  sql,
  type SQL,
  type AnyColumn,
} from "drizzle-orm";
import { alias, PgDialect, type PgTable } from "drizzle-orm/pg-core";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { qualitySnapshot } from "~/server/db/retained-tables";
import { storedEntryFor } from "~/server/generic/data-quality/repo/entry";
import { relatedGapCondition } from "~/server/generic/data-quality/repo/sql";
import type {
  ListFilterValues,
  ListPrepare,
} from "~/server/generic/list/repo/field-compiler";
import type { EntityListScaffold } from "~/server/generic/list/repo/list";
import { compileProblemFilters } from "~/server/generic/problems/repo/problem-filter-semantics";

import {
  admittedReasons,
  selectWorkCandidates,
  scopeAdmitsReasons,
  type WorkCandidateColumns,
  type WorkCandidates,
  type WorkScope,
  type WorkSource,
} from "./work-source";

type GapEntity = (typeof workQueueGapViews)[number]["entity"];
const gapView = (entity: GapEntity) => {
  const view = workQueueGapViews.find((view) => view.entity === entity);
  if (!view) throw new Error(`Work queue has no gap view for ${entity}`);
  return view;
};

/** `dynamic` sources route each row from its gaps (see `gapPublicationRead`). */
export const gapDeclaration = (
  entity: GapEntity,
  executor: "agent" | "dynamic" = "agent",
) => ({
  id: `${gapView(entity).family}:${entity}`,
  family: gapView(entity).family,
  executor,
  entity,
  link: { kind: "record" as const },
  carriesGaps: true,
  inputLabel: `${entitySummary[entity].singular} quality checks`,
  reasons: workQueueGapChecks(gapView(entity)).map((check) => ({
    key: check,
    label: dataCheckMessage[check],
    check,
  })),
});

/** Narrow admission to requested checks, while retaining every row membership
 * for overlapping negative reason filters. Record reads use fresh verdicts. */
const gapFilters = (scope: WorkScope, entity: GapEntity) => {
  const view = gapView(entity);
  const saved = entitySummary[entity].list.savedViews.find(
    (saved) => saved.id === view.view,
  );
  if (!saved)
    throw new Error(`Work queue saved view ${entity}.${view.view} is missing`);
  const filters = compileProblemFilters(entity, saved.filters);
  const checks = new Set<string>(
    admittedReasons(scope, gapDeclaration(entity).reasons).map(
      (reason) => reason.key,
    ),
  );
  if (!checks.size) return null;
  if (scope.record?.quality) {
    const quality = scope.record.quality;
    return [...quality.gaps, ...quality.relatedGaps].some((gap) =>
      checks.has(gap.check),
    )
      ? { ...filters, dataGap: undefined }
      : null;
  }
  return { ...filters, dataGap: [...checks] };
};

const gapColumns = (
  scope: WorkScope,
  entity: GapEntity,
  ownGap: (check: DataCheck) => SQL,
) => {
  const checks = workQueueGapChecks(gapView(entity));
  const own = new Set<DataCheck>(dataChecksByEntity[entity].options);
  const failed = (check: DataCheck): SQL => {
    if (scope.record?.quality)
      return sql`${[...scope.record.quality.gaps, ...scope.record.quality.relatedGaps].some((gap) => gap.check === check)}`;
    return own.has(check) ? ownGap(check) : relatedGapCondition(entity, check);
  };
  const byMessage = new Map<string, SQL[]>();
  for (const check of [
    ...checks.filter((check) => own.has(check)),
    ...checks.filter((check) => !own.has(check)),
  ])
    byMessage.set(dataCheckMessage[check], [
      ...(byMessage.get(dataCheckMessage[check]) ?? []),
      failed(check),
    ]);
  return {
    failed,
    reason: sql`concat_ws(' ', ${sql.join(
      [...byMessage].map(
        ([message, conditions]) =>
          sql`CASE WHEN ${sql.join(conditions, sql` OR `)} THEN ${message}::text END`,
      ),
      sql`, `,
    )})`,
    reasonKeys: sql`array_remove(ARRAY[${sql.join(
      checks.map(
        (check) => sql`CASE WHEN ${failed(check)} THEN ${check}::text END`,
      ),
      sql`, `,
    )}]::text[], NULL)`,
  };
};

/** One publication supplies admission and complete reason membership. */
export const gapPublicationRead = ({
  scope,
  entity,
}: {
  scope: WorkScope;
  entity: GapEntity;
}) => {
  const filters = gapFilters(scope, entity);
  if (!filters) return null;
  const { dataGap, ...otherFilters } = filters;
  const publication = alias(qualitySnapshot, `work_${entity}_quality`);
  const own = new Set<DataCheck>(dataChecksByEntity[entity].options);
  const publishedGap = (check: DataCheck) =>
    sql`coalesce(${publication.checks}->>${check} = ${entityQualityCheckState.enum.gap}, false)`;
  const admittedChecks = (oneOrManyValues(dataGap) ?? []).map((check) =>
    dataCheck.parse(check),
  );
  const { failed, ...columns } = gapColumns(scope, entity, publishedGap);
  return {
    filters: otherFilters,
    publication,
    match: eq(publication.entityId, storedEntryFor(entity).table.id),
    columns,
    /** Whether the row fails one check, for per-row executor routing. */
    failed,
    // Missing values cannot decide gap membership. Keep their routing and
    // possible reason text available for the queue's scoped completeness read.
    missingInputs: scope.record?.quality
      ? sql`false`
      : isNull(publication.checks),
    missingColumns: {
      reason: workQueueGapChecks(gapView(entity))
        .map((check) => dataCheckMessage[check])
        .join(" "),
      reasonKeys: workQueueGapChecks(gapView(entity)),
    },
    admission: admittedChecks.length
      ? or(
          ...admittedChecks.map((check) =>
            own.has(check)
              ? publishedGap(check)
              : relatedGapCondition(entity, check),
          ),
        )
      : undefined,
  };
};

export const recordScope = (
  scope: WorkScope,
  shortcode: SQL,
): SQL | undefined =>
  scope.record ? sql`${shortcode}::text = ${scope.record.id}` : undefined;

export const workProblemActions = (
  key: Parameters<typeof problemActionsFor>[0],
): WorkAction[] =>
  problemActionsFor(key).map((action) => ({
    ...action,
    id: problemActionId(key, action.id),
  }));

/** Domain readers supply their own query; declaration metadata stays shared. */
export const entityProblemSources = (
  entity: ShortcodeEntity,
  read: {
    table: PgTable & { shortcode: AnyColumn };
    columns:
      | Omit<WorkCandidateColumns, "entity" | "id" | "reason" | "reasonKeys">
      | ((source: WorkSource) => Omit<WorkCandidateColumns, "entity" | "id">);
    scaffold: Pick<EntityListScaffold, "context" | "plan" | "hasResultFilters">;
    parseFilters: (values: ListFilterValues) => object;
    prepare?: (
      db: Database,
      scope: WorkScope,
      filters: FilterAssembly,
    ) => Promise<ReadonlyArray<readonly [ListPrepare<unknown>, unknown]>>;
  },
): WorkSource[] => {
  const definitions = problemQueryDeclarations().filter(
    (definition) =>
      definition.source.kind === "entity" &&
      definition.source.entity === entity,
  );
  // The scope object belongs to one queue request. Share one preparation and
  // materialized relation across its admitted Problems, never across requests.
  const prepared = new WeakMap<WorkScope, Promise<WorkCandidates["ctes"]>>();
  // Source column (`index:key`) to its deduplicated base routing column.
  const routes = new Map<string, string>();
  const baseName = `work_problem_${entity}`;
  const base = (db: Database, scope: WorkScope) => {
    let pending = prepared.get(scope);
    if (!pending) {
      pending = (async () => {
        const columns: Record<string, SQL> = {};
        const facts: Record<string, SQL> = {};
        const expressions = new Map<string, string>();
        const dialect = new PgDialect();
        const factName = `${baseName}_facts`;
        // Bind values are part of identity: prepared contexts can differ by Problem.
        const project = (value: SQL): SQL => {
          const compiled = dialect.sqlToQuery(value);
          const key = JSON.stringify([compiled.sql, compiled.params]);
          let name = expressions.get(key);
          if (!name) {
            name = `fact_${expressions.size}`;
            expressions.set(key, name);
            facts[name] = value;
          }
          return sql`${sql.identifier(factName)}.${sql.identifier(name)}`;
        };
        for (const [index, definition] of definitions.entries()) {
          if (definition.source.kind !== "entity") continue;
          const filters = read.parseFilters(
            compileProblemFilters(entity, definition.source.filters),
          );
          const seeded =
            (await read.prepare?.(db, scope, definition.source.filters)) ?? [];
          const context = await read.scaffold.context(
            db,
            { filters, readIntent: "count" },
            seeded,
          );
          columns[`match_${index}`] =
            read.scaffold.plan(filters, {
              context,
              membership: "certain",
              project,
            }).where ?? sql`true`;
          columns[`missing_${index}`] = read.scaffold.hasResultFilters(filters)
            ? (read.scaffold.plan(filters, {
                context,
                membership: "possible",
                project,
              }).where ?? sql`true`)
            : sql`false`;
        }
        // Labels and routing (owner subqueries) are base columns, not facts:
        // the base evaluates them only for admitted candidates, while the
        // materialized facts relation covers every record.
        const routedColumns: Record<string, SQL> = {};
        const routedNames = new Map<string, string>();
        if (typeof read.columns === "function")
          for (const [index, source] of sources.entries())
            for (const [key, value] of Object.entries(read.columns(source))) {
              const expression = Array.isArray(value)
                ? sql`ARRAY[${sql.join(
                    value.map((item) => sql`${item}`),
                    sql`, `,
                  )}]::text[]`
                : sql`${value}`;
              const compiled = dialect.sqlToQuery(expression);
              const identity = JSON.stringify([compiled.sql, compiled.params]);
              let name = routedNames.get(identity);
              if (!name) {
                name = `route_${routedNames.size}`;
                routedNames.set(identity, name);
                routedColumns[name] = expression;
              }
              routes.set(`${index}:${key}`, name);
            }
        const factQuery = getDb(db)
          .select({
            code: sql`${read.table.shortcode}`.as("code"),
            ...Object.fromEntries(
              Object.entries(facts).map(([key, value]) => [key, value.as(key)]),
            ),
          })
          .from(read.table)
          .where(recordScope(scope, sql`${read.table.shortcode}`));
        const root = getDb(db)
          .select({
            code: sql`${read.table.shortcode}`.as("code"),
            ...(typeof read.columns === "function"
              ? {}
              : Object.fromEntries(
                  Object.entries(read.columns).map(([key, value]) => [
                    key,
                    sql`${value}`.as(key),
                  ]),
                )),
            ...Object.fromEntries(
              Object.entries(routedColumns).map(([key, value]) => [
                key,
                value.as(key),
              ]),
            ),
            ...Object.fromEntries(
              Object.entries(columns).map(([key, value]) => [
                key,
                sql`(${value}) IS TRUE`.as(key),
              ]),
            ),
          })
          .from(read.table)
          .innerJoin(
            sql`${sql.identifier(factName)}`,
            sql`${sql.identifier(factName)}.code = ${read.table.shortcode}`,
          )
          // Only possible candidates need labels and routing. Keep unresolved
          // matches so missing publications still contribute coverage warnings.
          .where(
            and(
              recordScope(scope, sql`${read.table.shortcode}`),
              or(...Object.values(columns)),
            ),
          );
        return [
          { name: factName, sql: sql`${factQuery}` },
          { name: baseName, sql: sql`${root}` },
        ];
      })();
      prepared.set(scope, pending);
    }
    return pending;
  };
  const sources: WorkSource[] = definitions.flatMap((definition, index) => {
    if (
      definition.source.kind !== "entity" ||
      definition.source.entity !== entity
    )
      return [];
    const source: WorkSource = {
      id: definition.key,
      family: "problem",
      executor: "human",
      entity,
      link: { kind: "record" },
      reasons: [{ key: definition.key, label: definition.title }],
      inputLabel: definition.title,
      actions: [
        ...workProblemActions(definition.key),
        // The reason group continues in the entity list with the Problem's
        // own filters; the client resolves them from the Problem key.
        ...(definition.continuation.kind === "entity-list"
          ? [
              {
                id: "open-list" satisfies WorkSourceActionId,
                label: `Open in ${entitySummary[entity].plural} list`,
                scope: "group" as const,
                target: "guided-flow" as const,
              },
            ]
          : []),
      ],
      candidates: async (db, scope) => {
        const ctes = await base(db, scope);
        if (typeof read.columns !== "function") {
          const columns = Object.fromEntries(
            Object.keys(read.columns).map((key) => [
              key,
              sql`base.${sql.identifier(key)}`,
            ]),
          );
          const admitted = definitions.flatMap((definition, index) =>
            scopeAdmitsReasons(scope, [
              { key: definition.key, label: definition.title },
            ])
              ? [
                  sql`(${definition.key}::text, ${definition.title}::text, base.${sql.identifier(`match_${index}`)}, (base.${sql.identifier(`missing_${index}`)} AND NOT base.${sql.identifier(`match_${index}`)}))`,
                ]
              : [],
          );
          const candidates = (missing: boolean) =>
            selectWorkCandidates(db, source, {
              entity,
              id: sql`base.code`,
              name: sql`base.name`,
              owners: sql`base.owners`,
              ...columns,
              source: sql`reason.source`,
              key: sql`reason.source || ':' || base.code`,
              reason: sql`reason.label`,
              reasonKeys: sql`ARRAY[reason.source]`,
            })
              .from(sql`${sql.identifier(baseName)} base`)
              .innerJoin(
                sql`LATERAL (VALUES ${sql.join(admitted, sql`, `)}) reason(source, label, matched, missing)`,
                sql`true`,
              )
              .where(missing ? sql`reason.missing` : sql`reason.matched`);
          return {
            query: candidates(false),
            missingInputs: candidates(true),
            relationKey: baseName,
            ctes,
          };
        }
        const sourceKeys = Object.keys(read.columns(source));
        const routed = (key: string) => {
          const name = routes.get(`${index}:${key}`);
          if (!name)
            throw new Error(`Unrouted ${entity} Problem column ${key}`);
          return sql`base.${sql.identifier(name)}`;
        };
        const candidates = (unresolved: boolean) =>
          selectWorkCandidates(db, source, {
            entity,
            id: sql`base.code`,
            reason: definition.title,
            reasonKeys: [definition.key],
            name: routed("name"),
            owners: routed("owners"),
            ...Object.fromEntries(sourceKeys.map((key) => [key, routed(key)])),
          })
            .from(sql`${sql.identifier(baseName)} base`)
            .where(
              unresolved
                ? sql`base.${sql.identifier(`missing_${index}`)} AND NOT base.${sql.identifier(`match_${index}`)}`
                : sql`base.${sql.identifier(`match_${index}`)}`,
            );
        return {
          query: candidates(false),
          missingInputs: candidates(true),
          ctes,
        };
      },
    };
    return [source];
  });
  return sources;
};
