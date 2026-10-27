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
import {
  workExecutor,
  workQueueGapChecks,
  workQueueGapViews,
  workQueueInput,
  workQueueList,
  workQueueOutSchema,
  type WorkQueueGap,
  type WorkQueueInput,
  type WorkQueueRow,
} from "@cubby/schemas/work-queue";
import { parseShortcode } from "@cubby/shared";
import { and, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb, ilikeContains } from "~/server/db/helpers";
import { resolvePublicEntityDisplayImageLists } from "~/server/entity-kernel/repo/entity-display-image";
import { loadDataQualities } from "~/server/generic/data-quality/repo/hydrate";
import {
  compileDeclaredFilters,
  type DeclaredFilterSet,
} from "~/server/generic/list/repo/declared-filters";
import { listFilterValues } from "~/server/generic/list/repo/field-compiler";
import { resolveLiveShortcodes } from "~/server/generic/shortcode/repo/shortcode-resolver";

import {
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
}

interface WorkQueueRead {
  readonly input: WorkQueueInput;
  /** The signed-in member, for the member-only fence. */
  readonly memberPartyId: LedgerPartyId | null;
  /** Agents see shared work and work routed only to their member. */
  readonly memberOnly: boolean;
  readonly record?: WorkScope["record"];
}

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
const filterPredicate = (values: Record<string, unknown>): SQL | undefined =>
  and(...compileDeclaredFilters(filterSet, listFilterValues.parse(values)));

/** Prunes a source the request's filters would drop entirely. */
const admits = (
  source: WorkSource,
  input: z.output<typeof workQueueInput>,
  scope: WorkScope,
): boolean => {
  const pick = (include: unknown, exclude: unknown, value: string | null) => {
    if (value === null) return true;
    const included = oneOrManyValues(include as string | string[] | undefined);
    const excluded = oneOrManyValues(exclude as string | string[] | undefined);
    return (
      (!included || included.includes(value)) &&
      !(excluded ?? []).includes(value)
    );
  };
  return (
    (!scope.record || !source.entity || source.entity === scope.record.entity) &&
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
    results.push(...(await Promise.all(items.slice(start, start + 4).map(run))));
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
  const prepared = (
    await boundedAll(admitted, async (source) => source.candidates(db, scope))
  ).filter((candidates) => candidates !== null);
  const ctes = new Map<string, WorkCte>();
  for (const candidates of prepared)
    for (const cte of candidates.ctes ?? []) ctes.set(cte.name, cte);
  const queries: SQLWrapper[] = prepared.length
    ? prepared.map((candidates) => candidates.query)
    : [emptyWorkCandidates(db)];
  const union = sql.join(
    queries.map((query) => sql`(${query})`),
    sql` UNION ALL `,
  );

  const reasons = [
    ...new Map(
      composition.sources
        .flatMap((source) => source.reasons)
        .map((reason) => [reason.key, reason] as const),
    ).values(),
  ].map(({ key, label }) => ({ value: key, label }));

  const resolved = sql`cardinality(owners) > 0 AND NOT EXISTS (
    SELECT 1 FROM unnest(owners) owner
    WHERE owner IS NULL OR NOT EXISTS (SELECT 1 FROM members member WHERE member.id = owner))`;
  const memberFence = read.memberOnly
    ? sql`(shared OR (cardinality(owners) > 0 AND NOT EXISTS (
        SELECT 1 FROM unnest(owners) owner WHERE owner IS DISTINCT FROM ${read.memberPartyId}::uuid)))`
    : undefined;
  const search = input.query
    ? sql`concat_ws(' ', name, reason, id) ILIKE ${ilikeContains(input.query)}`
    : undefined;
  const { view: _view, ...requested } = input;
  const population = and(
    ...composition.deferrals.map((deferral) => sql`NOT (${deferral})`),
    memberFence,
    search,
    filterPredicate(requested),
  );
  const viewPredicates = Object.fromEntries(
    workQueueList.views.map((view) => [
      view.key,
      filterPredicate(view.filters) ?? sql`true`,
    ]),
  );
  const selectedView = input.view ? viewPredicates[input.view] : undefined;

  const sortExpressions: Record<string, SQL> = {
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
        .sortsOf(input.sort)
        .map(
          (sort) =>
            sql`${sortExpressions[sort.orderBy] ?? sql`name`} ${sort.direction === "desc" ? sql`DESC` : sql`ASC`} NULLS LAST`,
        ),
      sql`name ASC`,
      sql`key ASC`,
    ],
    sql`, `,
  );

  // The union materializes once; routing, filters, counts and the page read it.
  // oxlint-disable-next-line cubby/no-raw-enum-literal-in-sql -- JSON property names below are the response contract, not vocabulary values.
  const result = await getDb(db).execute(sql`
    WITH
    ${sql.join(
      [...ctes.values()].map(
        (cte) => sql`${column(cte.name)} AS MATERIALIZED (${cte.sql}),`,
      ),
      sql` `,
    )}
    members AS (
      SELECT id, shortcode, name FROM "LedgerParty"
      WHERE kind = ${ledgerPartyKind.enum.member} AND "deletedAt" IS NULL
    ),
    work AS MATERIALIZED (${union}),
    routed AS MATERIALIZED (
      SELECT work.*, routing.owner_codes,
        CASE WHEN shared THEN 'anyone' ELSE nullif(array_to_string(routing.owner_codes, ','), '') END AS owner_key,
        CASE WHEN shared THEN 'Anyone' ELSE (
          SELECT string_agg(member.name, ', ' ORDER BY member.name, member.shortcode)
          FROM members member WHERE member.shortcode = ANY(routing.owner_codes)
        ) END AS owner_label,
        reason_keys[1] AS primary_reason
      FROM work CROSS JOIN LATERAL (
        SELECT CASE
          WHEN shared THEN ARRAY(SELECT shortcode FROM members ORDER BY shortcode)
          WHEN ${resolved} THEN ARRAY(SELECT member.shortcode FROM members member WHERE member.id = ANY(owners) ORDER BY member.shortcode)
          ELSE ARRAY[]::text[] END AS owner_codes
      ) routing
    ),
    filtered AS MATERIALIZED (
      SELECT * FROM routed ${population ? sql`WHERE ${population}` : sql``}
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
  `);
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
      viewCounts: z.record(z.string(), z.number()),
      groups: z
        .array(z.object({ key: z.string(), label: z.string(), count: z.number() }))
        .nullable(),
      items: z.array(pageRow),
    })
    .parse(result.rows[0]);

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
      totalCount: row.total,
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
    item.dataQuality = { status: quality.status, score: quality.score };
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

/** The household or member queue over the composed sources. */
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
  if (!parsed) throw new Error(`Work queue record ${read.id} is not a shortcode`);
  const record: { entity: ShortcodeEntity; id: string; quality?: DataQuality } =
    { entity: parsed.type, id: parsed.shortcode };
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
