import {
  dataCheck,
  type DataQuality,
  scoredEntities,
  type ScoredEntity,
} from "@cubby/schemas/data-quality";
import { entityRefKey } from "@cubby/schemas/entity";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import { entitySummary } from "@cubby/schemas/entity-summary";
import { FILTER_NONE } from "@cubby/schemas/filter-sentinel-fields";
import type { LedgerPartyId } from "@cubby/schemas/identifiers";
import { ledgerPartyKind } from "@cubby/schemas/ledger-party";
import { oneOrManyValues } from "@cubby/schemas/pagination";
import type { ProjectAttentionReport } from "@cubby/schemas/project";
import type { IncompleteWorkDiagnosticSource } from "@cubby/schemas/work-diagnostic-facts";
import {
  workExecutor,
  workQueueGapViews,
  workQueueInput,
  workQueueList,
  workQueueOutSchema,
  type WorkQueueGap,
  type WorkQueueInput,
  type WorkQueueRow,
} from "@cubby/schemas/work-queue";
import { workQueueGapChecks } from "@cubby/schemas/work-queue-policy";
import { parseShortcode } from "@cubby/shared";
import { and, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb, ilikeContains } from "~/server/db/helpers";
import { notDeleted } from "~/server/db/helpers/predicates";
import { textArrayParam } from "~/server/db/helpers/query";
import type { WorkPublicationMeta } from "~/server/db/work-item-schema";
import { resolvePublicEntityDisplayImageLists } from "~/server/entity-kernel/repo/entity-display-image";
import { loadDataQualities } from "~/server/generic/data-quality/repo/hydrate";
import {
  compileDeclaredFilters,
  type DeclaredFilterSet,
} from "~/server/generic/list/repo/declared-filters";
import {
  listFilterValues,
  type ListFilterValues,
} from "~/server/generic/list/repo/field-compiler";
import { resolveLiveShortcodes } from "~/server/generic/shortcode/repo/shortcode-resolver";

import {
  admittedReasons,
  emptyWorkCandidates,
  scopeAdmitsReasons,
  type WorkCte,
  type WorkScope,
  type WorkSource,
} from "./work-source";

/**
 * The composed queue: its sources, and predicates over the `work` relation
 * that defer rows before counts and paging (a planned Purchase).
 */
export interface WorkQueueComposition {
  readonly sources: readonly WorkSource[];
  readonly deferrals: readonly SQL[];
  readonly incompleteDiagnosticSources?: () => Promise<
    IncompleteWorkDiagnosticSource[]
  >;
  readonly incompleteProjectIds?: () => Promise<
    ProjectAttentionReport["incompleteProjectIds"]
  >;
}

interface WorkQueueRead {
  readonly input: WorkQueueInput;
  /** The signed-in member, for the member-only fence. */
  readonly memberPartyId: LedgerPartyId | null;
  /** Agents see shared work and work routed only to their member. */
  readonly memberOnly: boolean;
  readonly record?: WorkScope["record"];
  /** Read the household's last publication instead of evaluating sources. */
  readonly published?: PublishedWork;
}

/** A publication's rows are `WorkItem`; its coverage was captured with them. */
interface PublishedWork {
  readonly meta: WorkPublicationMeta | null;
  readonly publishedAt: Date;
  /** The latest republish's raw failure; a success clears it. */
  readonly error: string | null;
}

type RecordRead = {
  entity: ShortcodeEntity;
  id: string;
  quality?: DataQuality;
};

const column = (name: string): SQL => sql`${sql.identifier(name)}`;

/** The declared filters compiled over the routed relation's columns. */
const filterSet: DeclaredFilterSet = {
  label: "workQueue",
  descriptors: workQueueList.descriptors,
  column: (descriptor, key) => ({
    value: sql`${column(key)}`,
    kind: descriptor.stored?.array ? "text-array" : "text",
    nullable: true,
    reference: null,
  }),
};
const filterPredicate = (values: ListFilterValues): SQL | undefined =>
  and(...compileDeclaredFilters(filterSet, listFilterValues.parse(values)));

/** Prunes a source the request's filters would drop entirely. */
const admits = (
  source: WorkSource,
  input: z.output<typeof workQueueInput>,
  scope: WorkScope,
): boolean => {
  const pick = (
    include: string | string[] | undefined,
    exclude: string | string[] | undefined,
    value: string | null,
  ) => {
    if (value === null) return true;
    const included = oneOrManyValues(include);
    const excluded = oneOrManyValues(exclude);
    return (
      (!included || included.includes(value)) &&
      !(excluded ?? []).includes(value)
    );
  };
  return (
    (!scope.record ||
      !source.entity ||
      source.entity === scope.record.entity) &&
    pick(input.family, input.familyExclude, source.family) &&
    pick(
      input.executor,
      input.executorExclude,
      source.executor === "dynamic" ? null : source.executor,
    ) &&
    pick(input.entity, input.entityExclude, source.entity) &&
    scopeAdmitsReasons(scope, source.reasons)
  );
};

/** Candidate reads run four at a time; each prepares its own evidence. */
async function boundedAll<T, R>(
  items: readonly T[],
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += 4)
    results.push(
      ...(await Promise.all(items.slice(start, start + 4).map(run))),
    );
  return results;
}

const optionLabel = (
  value: SQL,
  options: readonly { value: string; label: string }[],
): SQL =>
  options.length
    ? sql`CASE ${value} ${sql.join(
        options.map(({ value: key, label }) => sql`WHEN ${key} THEN ${label}`),
        sql` `,
      )} END`
    : sql`NULL::text`;

/** Every admitted source's candidates as one `work`-shaped union, plus its CTEs. */
async function candidateUnion(
  db: Database,
  admitted: readonly WorkSource[],
  scope: WorkScope,
) {
  const prepared = (
    await boundedAll(admitted, async (source) => {
      const candidates = await source.candidates(db, scope);
      return candidates ? { ...candidates, declaration: source } : null;
    })
  ).filter((candidates) => candidates !== null);
  const ctes = new Map<string, WorkCte>();
  for (const candidates of prepared)
    for (const cte of candidates.ctes ?? []) ctes.set(cte.name, cte);
  const relations = [
    ...new Map(
      prepared.map((candidate) => [
        candidate.relationKey ?? candidate.declaration.id,
        candidate,
      ]),
    ).values(),
  ];
  const queries: SQLWrapper[] = relations.length
    ? relations.flatMap((candidates) => [
        sql`SELECT candidate.*, false AS input_incomplete FROM (${candidates.query}) candidate`,
        ...(candidates.missingInputs
          ? [
              sql`SELECT candidate.*, true AS input_incomplete FROM (${candidates.missingInputs}) candidate`,
            ]
          : []),
      ])
    : [
        sql`SELECT candidate.*, false AS input_incomplete FROM (${emptyWorkCandidates(db)}) candidate`,
      ];
  const union = sql.join(
    queries.map((query) => sql`(${query})`),
    sql` UNION ALL `,
  );
  const withCtes = sql.join(
    [...ctes.values()].map(
      (cte) => sql`${column(cte.name)} AS MATERIALIZED (${cte.sql}),`,
    ),
    sql` `,
  );
  return { prepared, withCtes, union };
}

/** Current members; routing and owner filters resolve shortcodes through it. */
const membersCte = sql`members AS (
      SELECT id, shortcode, name FROM "LedgerParty"
      WHERE kind = ${ledgerPartyKind.enum.member} AND ${notDeleted("LedgerParty")}
    )`;

/** Every owner is a current member. */
const resolvedOwners = sql`cardinality(owners) > 0 AND NOT EXISTS (
    SELECT 1 FROM unnest(owners) owner
    WHERE owner IS NULL OR NOT EXISTS (SELECT 1 FROM members member WHERE member.id = owner))`;

/** Owner codes, section key and label for each `work` row. */
const routedWork = sql`SELECT work.*, routing.owner_codes,
        CASE WHEN shared THEN 'anyone' ELSE nullif(array_to_string(routing.owner_codes, ','), '') END AS owner_key,
        CASE WHEN shared THEN 'Anyone' ELSE (
          SELECT string_agg(member.name, ', ' ORDER BY member.name, member.shortcode)
          FROM members member WHERE member.shortcode = ANY(routing.owner_codes)
        ) END AS owner_label
      FROM work CROSS JOIN LATERAL (
        SELECT CASE
          WHEN shared THEN ARRAY(SELECT shortcode FROM members ORDER BY shortcode)
          WHEN ${resolvedOwners} THEN ARRAY(SELECT member.shortcode FROM members member WHERE member.id = ANY(owners) ORDER BY member.shortcode)
          ELSE ARRAY[]::text[] END AS owner_codes
      ) routing`;

const publishedColumns = (reasonKeys: SQL) =>
  sql`source, entity, id, name, key, family, executor, reason,
      ${reasonKeys} AS reason_keys, owners, "exclusiveOwner" AS exclusive_owner,
      shared, amount, date, "inputIncomplete" AS input_incomplete,
      "ownerCodes" AS owner_codes, "ownerKey" AS owner_key, "ownerLabel" AS owner_label`;

/**
 * The admitted sources' published rows, routed when they were published. A
 * source whose rows carry only admitted reasons keeps the admitted part of
 * its stored membership, as its live candidates would.
 */
const publishedRouted = (admitted: readonly WorkSource[], scope: WorkScope) => {
  const whole = admitted.filter((source) => !source.admittedReasonsOnly);
  return sql.join(
    [
      sql`SELECT ${publishedColumns(sql`"reasonKeys"`)} FROM "WorkItem"
        WHERE source IN (${sql.join(
          [...whole.map((source) => sql`${source.id}`), sql`NULL`],
          sql`, `,
        )})`,
      ...admitted
        .filter((source) => source.admittedReasonsOnly)
        .map((source) => {
          const keys = sql.join(
            admittedReasons(scope, source.reasons).map(
              (reason) => sql`${reason.key}`,
            ),
            sql`, `,
          );
          return sql`SELECT * FROM (SELECT ${publishedColumns(
            sql`ARRAY(SELECT reason FROM unnest("reasonKeys") WITH ORDINALITY AS stored(reason, position)
              WHERE reason IN (${keys}) ORDER BY position)`,
          )} FROM "WorkItem" WHERE source = ${source.id}) pruned
            WHERE cardinality(reason_keys) > 0`;
        }),
    ].map((query) => sql`(${query})`),
    sql` UNION ALL `,
  );
};

/**
 * Reconciles the household publication with the composed sources' current
 * union, deferrals applied. Reads never wait for it; see work-publication.
 */
export async function insertWorkItems(
  db: Database,
  composition: WorkQueueComposition,
): Promise<WorkPublicationMeta> {
  const { prepared, withCtes, union } = await candidateUnion(
    db,
    composition.sources,
    {},
  );
  const deferred = and(
    ...composition.deferrals.map((deferral) => sql`NOT (${deferral})`),
  );
  await getDb(db).execute(sql`
    WITH ${withCtes}
    ${membersCte},
    work AS NOT MATERIALIZED (${union}),
    routed AS NOT MATERIALIZED (${routedWork}),
    incoming AS MATERIALIZED (
      SELECT source, entity, id, name, key, family, executor, reason,
        reason_keys, owners, exclusive_owner, shared, amount, date,
        input_incomplete, owner_codes, owner_key, owner_label
      FROM routed work ${deferred ? sql`WHERE ${deferred}` : sql``}
    ),
    removed AS (
      DELETE FROM "WorkItem" old
      WHERE NOT EXISTS (SELECT 1 FROM incoming next
        WHERE next.key=old.key AND next.input_incomplete=old."inputIncomplete")
    )
    INSERT INTO "WorkItem" (source, entity, id, name, key, family, executor,
      reason, "reasonKeys", owners, "exclusiveOwner", shared, amount, date,
      "inputIncomplete", "ownerCodes", "ownerKey", "ownerLabel")
    SELECT DISTINCT ON (key, input_incomplete)
      source, entity, id, name, key, family, executor, reason,
      reason_keys, owners, exclusive_owner, shared, amount, date,
      input_incomplete, owner_codes, owner_key, owner_label
    FROM incoming next
    WHERE NOT EXISTS (
      SELECT 1 FROM "WorkItem" stored
      WHERE stored.key=next.key AND stored."inputIncomplete"=next.input_incomplete
        AND (stored.source, stored.entity, stored.id, stored.name,
          stored.family, stored.executor, stored.reason, stored."reasonKeys",
          stored.owners, stored."exclusiveOwner", stored.shared, stored.amount,
          stored.date, stored."ownerCodes", stored."ownerKey", stored."ownerLabel")
          IS NOT DISTINCT FROM
          (next.source, next.entity, next.id, next.name,
          next.family, next.executor, next.reason, next.reason_keys,
          next.owners, next.exclusive_owner, next.shared, next.amount,
          next.date, next.owner_codes, next.owner_key, next.owner_label)
    )
    ON CONFLICT (key, "inputIncomplete") DO UPDATE SET
      source=excluded.source, entity=excluded.entity, id=excluded.id,
      name=excluded.name, family=excluded.family, executor=excluded.executor,
      reason=excluded.reason, "reasonKeys"=excluded."reasonKeys",
      owners=excluded.owners, "exclusiveOwner"=excluded."exclusiveOwner",
      shared=excluded.shared, amount=excluded.amount, date=excluded.date,
      "ownerCodes"=excluded."ownerCodes", "ownerKey"=excluded."ownerKey",
      "ownerLabel"=excluded."ownerLabel"
    WHERE ("WorkItem".source, "WorkItem".entity, "WorkItem".id,
      "WorkItem".name, "WorkItem".family, "WorkItem".executor,
      "WorkItem".reason, "WorkItem"."reasonKeys", "WorkItem".owners,
      "WorkItem"."exclusiveOwner", "WorkItem".shared, "WorkItem".amount,
      "WorkItem".date, "WorkItem"."ownerCodes", "WorkItem"."ownerKey",
      "WorkItem"."ownerLabel") IS DISTINCT FROM
      (excluded.source, excluded.entity, excluded.id,
      excluded.name, excluded.family, excluded.executor,
      excluded.reason, excluded."reasonKeys", excluded.owners,
      excluded."exclusiveOwner", excluded.shared, excluded.amount,
      excluded.date, excluded."ownerCodes", excluded."ownerKey",
      excluded."ownerLabel")`);
  const coverage = prepared.flatMap((candidate) =>
    candidate.inputCoverage
      ? [
          sql`SELECT ${candidate.declaration.id}::text AS source,
        ${candidate.declaration.family}::text AS family,
        ${candidate.declaration.executor}::text AS executor, observed.message
      FROM (${candidate.inputCoverage}) observed`,
        ]
      : [],
  );
  const coverageRows = coverage.length
    ? z
        .array(
          z.object({
            source: z.string(),
            family: z.string(),
            executor: z.string(),
            message: z.string(),
          }),
        )
        .parse(
          await getDb(db).execute(
            sql.join(coverage, sql` UNION ALL `),
            "objects",
          ),
        )
    : [];
  return {
    incompleteProjectIds: (await composition.incompleteProjectIds?.()) ?? [],
    incompleteDiagnosticSources:
      (await composition.incompleteDiagnosticSources?.()) ?? [],
    coverage: coverageRows,
  };
}

async function queryWorkQueue(
  db: Database,
  composition: WorkQueueComposition,
  read: WorkQueueRead,
) {
  const input = workQueueInput.parse(read.input);
  const scope: WorkScope = {
    record: read.record,
    reasons: oneOrManyValues(input.reason),
    reasonExclude: oneOrManyValues(input.reasonExclude),
  };
  const admitted = composition.sources.filter((source) =>
    admits(source, input, scope),
  );
  const published = read.published;
  const { prepared, withCtes, routed } = published
    ? {
        prepared: [],
        withCtes: sql``,
        routed: publishedRouted(admitted, scope),
      }
    : await candidateUnion(db, admitted, scope).then((live) => ({
        ...live,
        routed: sql`WITH work AS NOT MATERIALIZED (${live.union}) ${routedWork}`,
      }));

  const reasons = [
    ...new Map(
      composition.sources
        .flatMap((source) => source.reasons)
        .map((reason) => [reason.key, reason] as const),
    ).values(),
  ].map(({ key, label }) => ({ value: key, label }));

  const memberFence = read.memberOnly
    ? sql`(shared OR ((${resolvedOwners}) AND NOT EXISTS (
        SELECT 1 FROM unnest(owners) owner WHERE owner IS DISTINCT FROM ${read.memberPartyId}::uuid)))`
    : undefined;
  const ownerCodes = oneOrManyValues(input.owner);
  // Presence widens Owner inclusion with OR; only plain inclusion can narrow.
  const ownerAdmission = and(
    ownerCodes?.length && input.ownerPresence === undefined
      ? sql`(shared OR exclusive_owner IS NULL OR exclusive_owner = ANY(ARRAY(
          SELECT member.id FROM members member
          WHERE member.shortcode = ANY(${textArrayParam(ownerCodes)}))))`
      : undefined,
    read.memberOnly && read.memberPartyId !== null
      ? sql`(shared OR exclusive_owner IS NULL OR exclusive_owner = ${read.memberPartyId}::uuid)`
      : undefined,
  );
  const search = input.query
    ? sql`concat_ws(' ', name, reason, id) ILIKE ${ilikeContains(input.query)}`
    : undefined;
  const { view: _view, ...requested } = input;
  // A publication applied its deferrals when it was written.
  const deferrals = published ? [] : composition.deferrals;
  const population = and(
    ...deferrals.map((deferral) => sql`NOT (${deferral})`),
    ownerAdmission,
    memberFence,
    search,
    filterPredicate(requested),
  );
  // Missing inputs cannot establish positive or negative reason membership.
  // Source pruning still applies; routing, record facts and search remain fenced.
  const {
    reason: _reason,
    reasonExclude: _reasonExclude,
    ...inputFilters
  } = requested;
  const incompletePopulation = and(
    ...deferrals.map((deferral) => sql`NOT (${deferral})`),
    ownerAdmission,
    memberFence,
    search,
    filterPredicate(inputFilters),
  );
  const viewPredicates = Object.fromEntries(
    workQueueList.views.map((view) => [
      view.key,
      filterPredicate(view.filters) ?? sql`true`,
    ]),
  );
  const selectedView = input.view ? viewPredicates[input.view] : undefined;
  const admittedIds = new Set(admitted.map((source) => source.id));
  const coverage = published
    ? (published.meta?.coverage ?? [])
        .filter((observed) => admittedIds.has(observed.source))
        .map(
          (observed) => sql`
    SELECT source, NULL::int AS count, message FROM (
      SELECT ${observed.source}::text AS source, ${observed.family}::text AS family,
        ${observed.executor}::text AS executor, ${observed.message}::text AS message
    ) work ${selectedView ? sql`WHERE ${selectedView}` : sql``}`,
        )
    : prepared.flatMap((candidate) =>
        candidate.inputCoverage
          ? [
              sql`
    SELECT source, NULL::int AS count, message FROM (
      SELECT ${candidate.declaration.id}::text AS source,
        ${candidate.declaration.family}::text AS family,
        ${candidate.declaration.executor}::text AS executor, observed.message
      FROM (${candidate.inputCoverage}) observed
    ) work ${selectedView ? sql`WHERE ${selectedView}` : sql``}`,
            ]
          : [],
      );
  const coverageUnion = coverage.length
    ? sql.join(coverage, sql` UNION ALL `)
    : sql`SELECT NULL::text AS source, NULL::int AS count, NULL::text AS message WHERE false`;

  const sortExpressions = {
    executor: sql`array_position(ARRAY[${sql.join(
      workExecutor.options.map((value) => sql`${value}`),
      sql`, `,
    )}]::text[], executor)`,
    entity: sql`coalesce(${optionLabel(
      column("entity"),
      Object.entries(entitySummary).map(([value, summary]) => ({
        value,
        label: summary.singular,
      })),
    )}, 'Problem')`,
    ...Object.fromEntries(
      workQueueList.sorts.flatMap((sort) =>
        sort.key === "executor" || sort.key === "entity"
          ? []
          : [[sort.key, sql`${column(sort.column ?? sort.key)}`]],
      ),
    ),
  };
  const choice = input.group
    ? workQueueList.grouping.find((group) => group.key === input.group)
    : undefined;
  const section =
    choice?.value?.kind === "column"
      ? {
          key: sql`${column(choice.value.column)}`,
          label:
            choice.key === "reason"
              ? optionLabel(column(choice.value.column), reasons)
              : choice.key === "owner"
                ? sql`owner_label`
                : optionLabel(
                    column(choice.value.column),
                    choice.value.options ?? [],
                  ),
        }
      : undefined;
  const sectionLabel =
    section && sql`coalesce(nullif(${section.label}, ''), ${section.key})`;
  // Every sort places nulls last in both directions; name and key break ties.
  const orderBy = sql.join(
    [
      ...(section
        ? [
            sql`(${section.key}) IS NULL ASC`,
            sql`${sectionLabel} ASC`,
            sql`${section.key} ASC`,
          ]
        : []),
      ...workQueueList
        .sortsOf(input.sort, input.view)
        .map(
          (sort) =>
            sql`${Object.entries(sortExpressions).find(([key]) => key === sort.orderBy)?.[1] ?? sql`name`} ${sort.direction === "desc" ? sql`DESC` : sql`ASC`} NULLS LAST`,
        ),
      sql`name ASC`,
      sql`key ASC`,
    ],
    sql`, `,
  );

  // Inline source and routing stages so common filters can reach their inputs.
  // Counts and paging share the materialized filtered population below.
  // Under an any-of Reason filter, summarize only the selected reason keys:
  // drilling into another membership would otherwise widen that population.
  const result = await getDb(db).execute(
    // oxlint-disable-next-line cubby/no-raw-enum-literal-in-sql -- JSON property names below are the response contract, not vocabulary values.
    sql`
    WITH
    ${withCtes}
    ${membersCte},
    routed AS NOT MATERIALIZED (
      SELECT work.*, reason_keys[1] AS primary_reason FROM (${routed}) work
    ),
    filtered AS MATERIALIZED (
      SELECT * FROM routed work WHERE NOT input_incomplete
      ${population ? sql`AND (${population})` : sql``}
    ),
    incomplete AS (
      SELECT * FROM routed work WHERE input_incomplete
      ${incompletePopulation ? sql`AND (${incompletePopulation})` : sql``}
      ${selectedView ? sql`AND (${selectedView})` : sql``}
    ),
    eligible AS (
      SELECT * FROM filtered ${selectedView ? sql`WHERE ${selectedView}` : sql``}
    ),
    page AS (
      SELECT *, row_number() OVER (ORDER BY ${orderBy}) AS position
      FROM eligible ORDER BY ${orderBy}
      LIMIT ${input.pageSize} OFFSET ${input.pageIndex * input.pageSize}
    )
    SELECT
      (SELECT count(*)::int FROM eligible) AS total,
      ${
        input.pageSize === 0
          ? sql`jsonb_build_object(
        'cells', coalesce((SELECT jsonb_agg(to_jsonb(cells) ORDER BY reason, entity) FROM (
          SELECT reasons.reason, entity, count(DISTINCT key)::int AS count
          FROM eligible CROSS JOIN LATERAL unnest(reason_keys) AS reasons(reason)
          ${
            scope.reasons?.length
              ? sql`WHERE reasons.reason = ANY(${textArrayParam(scope.reasons)})`
              : sql``
          }
          GROUP BY reasons.reason, entity
        ) cells), '[]'::jsonb),
        'types', coalesce((SELECT jsonb_agg(to_jsonb(types) ORDER BY entity) FROM (
          SELECT entity, count(*)::int AS count FROM eligible GROUP BY entity
        ) types), '[]'::jsonb)
      )`
          : sql`NULL::jsonb`
      } AS summary,
      coalesce((SELECT jsonb_agg(to_jsonb(missing) ORDER BY source) FROM (
        SELECT source, count(DISTINCT key)::int AS count, NULL::text AS message FROM incomplete GROUP BY source
        UNION ALL ${coverageUnion}
      ) missing), '[]'::jsonb) AS "incompleteSources",
      (SELECT jsonb_build_object('all', count(*)::int, ${sql.join(
        Object.entries(viewPredicates).flatMap(([view, predicate]) => [
          sql`${view}::text`,
          sql`count(*) FILTER (WHERE ${predicate})::int`,
        ]),
        sql`, `,
      )}) FROM filtered) AS "viewCounts",
      ${
        section
          ? sql`(SELECT coalesce(jsonb_agg(to_jsonb(sections) ORDER BY sections.key = ${FILTER_NONE}, sections.label, sections.key), '[]'::jsonb) FROM (
              SELECT coalesce(section, ${FILTER_NONE}::text) AS key,
                coalesce(label, ${choice?.noValueLabel ?? "None"}::text) AS label, count(*)::int AS count
              FROM (SELECT ${section.key} AS section, ${sectionLabel} AS label FROM eligible) sectioned
              GROUP BY section, label
            ) sections)`
          : sql`NULL::jsonb`
      } AS groups,
      coalesce((SELECT jsonb_agg(jsonb_build_object(
        'source', source, 'entity', entity, 'id', id, 'name', name, 'key', key,
        'family', family, 'executor', executor, 'reason', reason, 'reasonKeys', reason_keys,
        'owners', coalesce((SELECT jsonb_agg(jsonb_build_object('id', member.shortcode, 'name', member.name)
          ORDER BY member.name, member.shortcode) FROM members member WHERE member.shortcode = ANY(page.owner_codes)), '[]'::jsonb),
        'shared', shared, 'amount', amount, 'date', date
      ) ORDER BY position) FROM page), '[]'::jsonb) AS items
  `,
    "objects",
  );

  const pageRow = z.object({
    source: z.string(),
    entity: z.string().nullable(),
    id: z.string().nullable(),
    name: z.string(),
    key: z.string(),
    family: z.string(),
    executor: z.string(),
    reason: z.string(),
    reasonKeys: z.array(z.string()),
    owners: z.array(z.object({ id: z.string(), name: z.string() })),
    shared: z.boolean(),
    amount: z.number().nullable(),
    date: z.string().nullable(),
  });
  const row = z
    .object({
      total: z.number(),
      summary: workQueueOutSchema.shape.meta.shape.summary.unwrap().nullable(),
      incompleteSources: workQueueOutSchema.shape.meta.shape.incompleteSources
        .unwrap()
        .element.omit({ label: true })
        .extend({ message: z.string().nullable() })
        .array(),
      viewCounts: z.record(z.string(), z.number()),
      groups: z
        .array(
          z.object({ key: z.string(), label: z.string(), count: z.number() }),
        )
        .nullable(),
      items: z.array(pageRow),
    })
    .parse(result[0]);

  const sourceById = new Map(
    composition.sources.map((source) => [source.id, source]),
  );
  const items: WorkQueueRow[] = row.items.map(({ source, ...item }) => {
    const declared = sourceById.get(source);
    return workQueueOutSchema.shape.items.element.parse({
      ...item,
      gaps: [],
      dataQuality: null,
      displayImages: [],
      link: declared?.link ?? { kind: "record" },
      actions: (declared?.actions ?? []).filter(
        (action) => action.scope === "item",
      ),
    });
  });
  await stateRowQualities(db, items, read.record);
  // Member routing fences rows, not imagery borrowed through linked records,
  // so member reads carry none; neither does the record's own strip.
  if (!read.memberOnly && !read.record) await attachDisplayImages(db, items);
  const groupActions = (key: string) =>
    choice?.key === "reason"
      ? (composition.sources
          .find((source) => source.reasons.some((reason) => reason.key === key))
          ?.actions?.filter((action) => action.scope === "group") ?? [])
      : [];
  return workQueueOutSchema.parse({
    items,
    meta: {
      pageIndex: input.pageIndex,
      pageSize: input.pageSize,
      incompleteProjectIds: published
        ? published.meta?.incompleteProjectIds
        : await composition.incompleteProjectIds?.(),
      incompleteDiagnosticSources: published
        ? published.meta?.incompleteDiagnosticSources
        : await composition.incompleteDiagnosticSources?.(),
      incompleteSources: row.incompleteSources.map((input) => ({
        source: input.source,
        count: input.count,
        ...(input.message ? { message: input.message } : {}),
        label: sourceById.get(input.source)?.inputLabel ?? input.source,
      })),
      totalCount: row.total,
      ...(published
        ? {
            publication: {
              publishedAt: published.publishedAt.toISOString(),
              error: published.error,
            },
          }
        : {}),
      ...(row.summary ? { summary: row.summary } : {}),
      viewCounts: row.viewCounts,
      reasons,
      ...(row.groups
        ? {
            groups: row.groups.map((group) => ({
              ...group,
              actions: groupActions(group.key),
            })),
          }
        : {}),
    },
  });
}

/** Each row carries its record's quality score, and a gap row states its own
 * gaps (an Email's missing original) as check ids with messages. */
async function stateRowQuality<E extends ScoredEntity & ShortcodeEntity>(
  db: Database,
  entity: E,
  rows: WorkQueueRow[],
  record?: WorkScope["record"],
) {
  const ids = await resolveLiveShortcodes(
    db,
    rows.flatMap((item) => (item.id ? [item.id] : [])),
    entity,
  );
  const liveId =
    record?.entity === entity && record.quality
      ? ids.get(record.id)
      : undefined;
  const qualities = await loadDataQualities(
    db,
    entity,
    [...ids.values()].filter((id) => id !== liveId),
    "stored",
  );
  if (liveId && record?.quality) qualities.set(liveId, record.quality);
  for (const item of rows) {
    const id = item.id ? ids.get(item.id) : undefined;
    const quality = id ? qualities.get(id) : undefined;
    if (!quality) continue;
    item.dataQuality = {
      status: quality.status,
      score: null,
      gaps: quality.gaps,
    };
    const gapView = workQueueGapViews.find(
      (view) => view.entity === entity && view.family === item.family,
    );
    if (!gapView) continue;
    const relevantChecks = new Set(workQueueGapChecks(gapView));
    const gaps = new Map<string, WorkQueueGap>();
    for (const gap of [...quality.gaps, ...quality.relatedGaps]) {
      const check = dataCheck.safeParse(gap.check).data;
      if (check && relevantChecks.has(check) && !gaps.has(check))
        gaps.set(check, { check, message: gap.message });
    }
    item.gaps = [...gaps.values()];
    if (item.gaps.length) {
      item.reasonKeys = item.gaps.map((gap) => gap.check);
      // Messages are sentences, so the plain-text reason reads as prose.
      item.reason = [...new Set(item.gaps.map((gap) => gap.message))].join(" ");
    }
  }
}

async function stateRowQualities(
  db: Database,
  items: WorkQueueRow[],
  record?: WorkScope["record"],
) {
  for (const entity of scoredEntities) {
    const rows = items.filter((item) => item.entity === entity);
    if (rows.length > 0) await stateRowQuality(db, entity, rows, record);
  }
}

async function attachDisplayImages(db: Database, items: WorkQueueRow[]) {
  const images = await resolvePublicEntityDisplayImageLists(
    db,
    items.flatMap((item) =>
      item.entity && item.id
        ? [{ entityKind: item.entity, entityId: item.id }]
        : [],
    ),
  );
  for (const item of items)
    if (item.entity && item.id)
      item.displayImages = images.get(entityRefKey(item.entity, item.id)) ?? [];
}

/** The household or member queue over the composed sources, or over their
 * last publication when `published` is given. */
export const readWorkQueueWith = (
  db: Database,
  composition: WorkQueueComposition,
  read: Omit<WorkQueueRead, "record">,
) => queryWorkQueue(db, composition, read);

/** One record's rows of the same projection; each source scopes itself to
 * the record, so this never plans the whole queue. */
export async function readRecordWorkQueueWith(
  db: Database,
  composition: WorkQueueComposition,
  read: Pick<WorkQueueRead, "memberPartyId" | "memberOnly"> & { id: string },
) {
  const parsed = parseShortcode(read.id);
  if (!parsed)
    throw new Error(`Work queue record ${read.id} is not a shortcode`);
  const record: RecordRead = { entity: parsed.type, id: parsed.shortcode };
  const entity = scoredEntities.find((kind) => kind === parsed.type);
  if (entity) {
    const entityId = (
      await resolveLiveShortcodes(db, [parsed.shortcode], entity)
    ).get(parsed.shortcode);
    if (entityId)
      record.quality = (
        await loadDataQualities(db, entity, [entityId], "live")
      ).get(entityId);
  }
  return queryWorkQueue(db, composition, {
    input: { pageSize: 100 },
    memberPartyId: read.memberPartyId,
    memberOnly: read.memberOnly,
    record,
  });
}
