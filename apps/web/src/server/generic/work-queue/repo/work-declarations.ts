import {
  dataCheckMessage,
  dataChecksByEntity,
  type DataCheck,
} from "@cubby/schemas/data-quality";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import { entitySummary } from "@cubby/schemas/entity-summary";
import {
  workQueueGapChecks,
  workQueueGapViews,
  type WorkAction,
} from "@cubby/schemas/work-queue";
import { sql, type SQL } from "drizzle-orm";

import { problemActionsFor } from "~/entity/problems/problem-actions";
import { compileProblemFilters } from "~/entity/problems/problem-filter-semantics";
import type { FilterAssembly } from "~/entity/problems/problem-query";
import { problemQueryDeclarations } from "~/entity/problems/problem-registry";
import type { Database } from "~/server/db";
import {
  gapCondition,
  relatedGapCondition,
} from "~/server/generic/data-quality/repo/sql";

import {
  admittedReasons,
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

export const gapDeclaration = (entity: GapEntity) => ({
  id: `${gapView(entity).family}:${entity}`,
  family: gapView(entity).family,
  executor: entity === "email" ? ("human" as const) : ("agent" as const),
  entity,
  link: { kind: "record" as const },
  carriesGaps: true,
  reasons: workQueueGapChecks(gapView(entity)).map((check) => ({
    key: check,
    label: dataCheckMessage[check],
    check,
  })),
});

/** Narrow admission to requested checks, while retaining every row membership
 * for overlapping negative reason filters. Record reads use fresh verdicts. */
export const gapFilters = (scope: WorkScope, entity: GapEntity) => {
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

export const gapColumns = (scope: WorkScope, entity: GapEntity) => {
  const checks = workQueueGapChecks(gapView(entity));
  const own = new Set<DataCheck>(dataChecksByEntity[entity].options);
  const failed = (check: DataCheck): SQL => {
    if (scope.record?.quality)
      return sql`${[...scope.record.quality.gaps, ...scope.record.quality.relatedGaps].some((gap) => gap.check === check)}`;
    return own.has(check)
      ? gapCondition(entity, check)
      : relatedGapCondition(entity, check);
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
    id: `${key}:${action.id}`,
    scope: action.scope === "bulk" ? "group" : "item",
  }));

/** Domain readers supply their own query; declaration metadata stays shared. */
export const entityProblemSources = (
  entity: ShortcodeEntity,
  candidates: (
    db: Database,
    source: WorkSource,
    scope: WorkScope,
    filters: FilterAssembly,
  ) => Promise<WorkCandidates | null>,
): WorkSource[] =>
  problemQueryDeclarations().flatMap((definition) => {
    if (
      definition.source.kind !== "entity" ||
      definition.source.entity !== entity
    )
      return [];
    const filters = definition.source.filters;
    const source: WorkSource = {
      id: definition.key,
      family: ["purchase", "expense", "financialTransaction"].includes(entity)
        ? "reconciliation"
        : "problem",
      executor: "human",
      entity,
      link: { kind: "record" },
      reasons: [{ key: definition.key, label: definition.title }],
      actions: workProblemActions(definition.key),
      candidates: (db, scope) => candidates(db, source, scope, filters),
    };
    return [source];
  });
