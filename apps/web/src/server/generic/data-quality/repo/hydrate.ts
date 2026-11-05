import {
  type DataCheck,
  dataCheck,
  type DataQuality,
  type DataQualityException,
  type DataQualityGap,
  dataCheckFacet,
  dataCheckKind,
  dataCheckLabel,
  dataCheckPresentation,
  dataCheckMessage,
  dataCheckAssessed,
  dataExceptionReasonLabel,
  relatedDataQualityEntities,
  type QualityTerm,
  qualityStatusOf,
  type ScoredEntity,
} from "@cubby/schemas/data-quality";
import { qualityBreakdown } from "@cubby/schemas/field-explanation";
import { type EntityId } from "@cubby/schemas/identifiers";
import { sql } from "drizzle-orm";
import { uniq, uniqBy } from "es-toolkit";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import { unwrapDb, uuidArrayParam } from "~/server/db/helpers";
import { exceptionReasonsFor } from "~/server/generic/data-quality/repo/exception-reasons";
import {
  qualityTerms,
  isExpected,
  evaluateRow,
} from "~/server/generic/data-quality/repo/presentation";
import { liveQualityRow } from "~/server/generic/data-quality/repo/registry";

import { storedEntryFor } from "./entry";
import { checksOf } from "./sql";
import {
  evaluateLiveQuality,
  loadPublishedQuality,
  type StoredEvaluation,
} from "./stored";

const exceptionOf = (
  recorded: readonly DataQualityException[],
  check: string,
) => {
  const found = recorded.find((exception) => exception.check === check);
  return found
    ? {
        exception: {
          reason: found.reason,
          note: found.note,
          state: found.state,
        },
      }
    : {};
};

/** What is missing, for a client to show verbatim. */
const missingSummary = (
  terms: ReadonlyArray<QualityTerm & { check: DataCheck }>,
) => {
  const gaps = terms.filter((term) => term.state === "gap");
  if (gaps.length > 0)
    return `${gaps.length} unresolved: ${gaps.map((term) => dataCheckLabel[term.check]).join(", ")}.`;
  if (terms.length === 0)
    return "No applicable checks: quality is not assessed.";
  if (terms.some((term) => term.state === "excepted"))
    return "Nothing is missing; accepted exceptions count as satisfied.";
  return terms.some((term) => term.assessed)
    ? "Nothing is missing from the checks defined for this record."
    : "No applicable assessed checks: quality is not assessed. Diagnostics remain visible below.";
};

export const buildQualityBreakdown = (
  expectedChecks: readonly DataCheck[],
  unresolvedChecks: readonly DataCheck[],
  activeExceptions: readonly DataCheck[],
  recorded: readonly DataQualityException[] = [],
): z.infer<typeof qualityBreakdown> => {
  const terms = qualityTerms(
    expectedChecks,
    unresolvedChecks,
    activeExceptions,
  );
  const assessed = terms.filter((term) => term.assessed);
  return qualityBreakdown.parse({
    score: null,
    status: qualityStatusOf(terms),
    weightedScore: null,
    scoreCap: null,
    expectedWeight: assessed.length,
    satisfiedWeight: assessed.filter((term) => term.state !== "gap").length,
    summary: missingSummary(terms),
    checks: terms.map(({ check, state }) => ({
      check,
      label:
        state === "satisfied"
          ? dataCheckPresentation[check].satisfiedLabel
          : dataCheckLabel[check],
      facet: dataCheckFacet[check],
      kind: dataCheckKind[check],
      weight: dataCheckAssessed[check] ? 1 : 0,
      scoreCap: 100,
      state,
      stateLabel:
        state === "gap"
          ? dataCheckKind[check] === "defect"
            ? "Defect"
            : "Missing data"
          : state === "excepted"
            ? "Accepted exception"
            : "Satisfied",
      weightLabel: dataCheckAssessed[check] ? "Check" : "Diagnostic",
      description: dataCheckMessage[check],
      exceptionReasons: exceptionReasonsFor(check).map((reason) => ({
        reason,
        label: dataExceptionReasonLabel[reason],
      })),
      ...exceptionOf(recorded, check),
    })),
  });
};

/** The lazy explanation uses current inputs, sharing the registered check functions. */
export const loadQualityBreakdown = async (
  db: Database | DrizzleTransaction,
  entity: ScoredEntity,
  id: string,
) => {
  const entry = storedEntryFor(entity);
  const selected = z
    .array(z.object({ id: z.string() }))
    .parse(
      (
        await unwrapDb(db).execute(
          sql`SELECT ${entry.table.id} AS "id" FROM ${entry.table} WHERE ${entry.table.shortcode} = ${id} AND ${liveQualityRow(entry.table)}`,
        )
      ).rows,
    );
  const target = selected[0];
  if (!target)
    throw new Error(`No live ${entity} record for quality explanation`);
  const [row] = await loadEvaluations(db, entity, [target.id], "live");
  if (!row) throw new Error("Quality evaluation was not loaded");
  const evaluation = evaluateRow(entity, row);
  const expected = checksOf(entity).filter((check) => isExpected(row, check));
  return buildQualityBreakdown(
    expected,
    evaluation.gaps.map((gap) => dataCheck.parse(gap.check)),
    evaluation.exceptions
      .filter(
        (exception) =>
          exception.state === "active" &&
          row.checks[dataCheck.parse(exception.check)] === "waived",
      )
      .map((exception) => dataCheck.parse(exception.check)),
    evaluation.exceptions,
  );
};

/** Published rows for list pages, or the same TypeScript checks evaluated live. */
const loadEvaluations = async (
  db: Database | DrizzleTransaction,
  entity: ScoredEntity,
  ids: readonly string[],
  source: "stored" | "live" = "stored",
): Promise<Array<StoredEvaluation & { score?: number | null }>> =>
  source === "live"
    ? evaluateLiveQuality(db, storedEntryFor(entity), ids)
    : loadPublishedQuality(db, entity, ids);

type Evaluated = ReturnType<typeof evaluateRow>;

const targetKey = (target: { targetType: string; targetId: string }) =>
  `${target.targetType}:${target.targetId}`;

/** `(ownerId, relatedId)` pairs for every declared roll-up relation. */
const loadRelatedIds = async (
  db: Database | DrizzleTransaction,
  entity: ScoredEntity,
  ids: readonly string[],
): Promise<Map<string, Array<{ entity: ScoredEntity; id: string }>>> => {
  const entry = storedEntryFor(entity);
  const related = new Map<
    string,
    Array<{ entity: ScoredEntity; id: string }>
  >();
  for (const target of relatedDataQualityEntities[entity]) {
    const link = entry.related?.[target];
    if (!link) throw new Error(`${entity} declares no link to ${target}.`);
    const t = entry.table;
    const r = storedEntryFor(target).table;
    const result = await unwrapDb(db).execute(sql`SELECT
  ${t.id} AS "ownerId", ${r.id} AS "relatedId"
FROM ${t}, ${r}
WHERE ${t.id} = ANY(${uuidArrayParam(ids)}) AND ${liveQualityRow(t)}
  AND ${liveQualityRow(r)} AND ${link(t, sql`${r.id}`)}`);
    for (const row of z
      .array(z.object({ ownerId: z.string(), relatedId: z.string() }))
      .parse(result.rows)) {
      const list = related.get(row.ownerId) ?? [];
      list.push({ entity: target, id: row.relatedId });
      related.set(row.ownerId, list);
    }
  }
  return related;
};

/**
 * Real, computed `DataQuality` for live rows of one entity, keyed by id. A
 * requested id that is deleted or unknown is absent from the map. Record
 * reads, including record-scoped Work strips, evaluate stored-mode checks
 * live; list pages and population Work queues pass `"stored"` so displayed
 * quality matches the published rows they sort by.
 */
export const loadDataQualities = async <E extends ScoredEntity>(
  db: Database | DrizzleTransaction,
  entity: E,
  ids: readonly EntityId<E>[],
  source: "stored" | "live" = "live",
): Promise<Map<EntityId<E>, DataQuality>> => {
  const uniqueIds = uniq(ids);
  const result = new Map<EntityId<E>, DataQuality>();
  if (uniqueIds.length === 0) return result;
  const [rows, relatedIds] = await Promise.all([
    loadEvaluations(db, entity, uniqueIds, source),
    loadRelatedIds(db, entity, uniqueIds),
  ]);
  // Roll-ups are one hop (the generator rejects chains): a related row
  // contributes its own gaps and exceptions, never its own roll-ups.
  const relatedQualities = new Map<ScoredEntity, Map<string, Evaluated>>();
  for (const target of relatedDataQualityEntities[entity]) {
    const targetIds = uniq(
      [...relatedIds.values()].flatMap((links) =>
        links.filter((link) => link.entity === target).map((link) => link.id),
      ),
    );
    const evaluated = new Map<string, Evaluated>();
    if (targetIds.length > 0)
      for (const row of await loadEvaluations(db, target, targetIds, source))
        evaluated.set(row.id, evaluateRow(target, row));
    relatedQualities.set(target, evaluated);
  }
  for (const row of rows) {
    const relatedGaps: DataQualityGap[] = [];
    const relatedExceptions: DataQualityException[] = [];
    for (const link of relatedIds.get(row.id) ?? []) {
      const quality = relatedQualities.get(link.entity)?.get(link.id);
      relatedGaps.push(...(quality?.gaps ?? []));
      relatedExceptions.push(...(quality?.exceptions ?? []));
    }
    // SAFETY: the row was selected by `id = ANY(ids)` from the entity's table.
    result.set(row.id as EntityId<E>, {
      ...evaluateRow(entity, row),
      relatedGaps: uniqBy(
        relatedGaps,
        (gap) => `${targetKey(gap)}:${gap.check}`,
      ),
      relatedExceptions: uniqBy(
        relatedExceptions,
        (exception) => `${targetKey(exception)}:${exception.check}`,
      ),
    });
  }
  return result;
};
