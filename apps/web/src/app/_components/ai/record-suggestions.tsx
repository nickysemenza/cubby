import type {
  FieldSuggestion,
  FieldSuggestionOutcome,
} from "@cubby/schemas/ai";
import type { Entity } from "@cubby/schemas/entity";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import { fieldResolutionsSchema } from "@cubby/schemas/field-resolution";
import { parseShortcode } from "@cubby/shared";
import { useQueries } from "@tanstack/react-query";
import {
  createContext,
  useContext,
  useRef,
  useState,
  type ContextType,
  type ReactNode,
} from "react";
import { z } from "zod";

import { Stack } from "~/components/layout";
import { Description } from "~/components/ui/description";
import { detailEditRequest } from "~/entities/editing/editor-requests";
import {
  EntityEditDialog,
  type EntityEditDialogRequest,
} from "~/entities/editing/entity-edit-dialog";
import { parseEntityEditUpdateInput } from "~/entities/editing/mutation-data";
import type { EditableEntity } from "~/entities/editing/types";
import type { EntityMutationPort } from "~/entities/editing/types";
import { useEntityCommands } from "~/entities/editing/use-entity-commands";
import type { StandardEntity } from "~/entities/entity-contracts";
import { entityDetailFor } from "~/entities/entity-detail.functions";
import { readReferenceField } from "~/entities/entity-references";
import { enumFieldLabel } from "~/entities/enum-field-display";
import { generatedBrowserCrudEntities } from "~/entities/generated/entity-routes.gen";

import {
  fieldSuggestionBasisFromRecord,
  suggestTargetsFor,
  suggestionContextKeys,
  isBasisSufficient,
  basisValueOf,
  productionEntitySuggestionsOperations,
  type EntitySuggestionsOperations,
  type FieldSuggestionSource,
  type SuggestTargets,
} from "./field-suggestion";
import {
  actionableSuggestion,
  SuggestionReview,
  SuggestionVisitProvider,
  useSuggestionVisit,
} from "./suggestion-review";
import { createSuggestionScheduler } from "./suggestion-scheduler";
import {
  SuggestionStatus,
  type SuggestionStatusField,
} from "./suggestion-status";

const SuggestionSchedulerContext = createContext<ReturnType<
  typeof createSuggestionScheduler
> | null>(null);

const recordSchema = z.looseObject({ id: z.string() });
const mutationPatchSchema = z.record(z.string(), z.json());
const nullableBasisValueSchema = z.string().nullable();
const textArraySchema = z.array(z.string());
type SuggestionRecord = z.infer<typeof recordSchema>;
type SuggestionRow = {
  record: SuggestionRecord;
  sourceByField: ReadonlyMap<string, FieldSuggestionSource>;
  suggestions: Record<string, FieldSuggestion | null>;
  outcomes: Record<string, FieldSuggestionOutcome>;
  pending: boolean;
};
const RecordSuggestionsContext = createContext<{
  entity: StandardEntity;
  rows: ReadonlyMap<string, SuggestionRow>;
  save: (
    id: string,
    field: string,
    suggestion: FieldSuggestion,
    source: FieldSuggestionSource,
    expectedCurrent: string | null,
  ) => Promise<void>;
} | null>(null);

function explicitSuggestionPatch(
  entity: StandardEntity,
  field: string,
  value: string,
): z.output<typeof mutationPatchSchema> {
  if (entity === "task" && field === "projectId") {
    return { projectId: value, projectMode: "explicit" };
  }
  if (entity === "task" && field === "subjectProductId") {
    return { subjectProductId: value, subjectProductMode: "explicit" };
  }
  return { [field]: value };
}

/** For a `remove` proposal, drops the target field's own key from the basis
 * used to fingerprint drift (Amendment 1's self-basis) — an unrelated tag
 * added after the proposal was computed shouldn't spuriously revoke it, only
 * a drift in a *sibling* restating field (manufacturer, classification)
 * should. A `set` proposal has no self-basis to drop. */
function basisForFingerprint(
  basis: FieldSuggestionSource["basis"],
  field: string,
  isRemove: boolean,
): FieldSuggestionSource["basis"] {
  if (!isRemove) return basis;
  const { [field]: _omitted, ...rest } = basis;
  return rest;
}

/** Generic over whichever text-array field the prune target names: re-reads
 * the field's current entries and only patches when every proposed removal
 * is still present — `collection:*` entries always survive since a removal
 * never names one. */
function removeFieldPatch(
  entity: StandardEntity,
  field: string,
  suggestion: FieldSuggestion,
  freshRecord: SuggestionRecord,
): z.output<typeof mutationPatchSchema> {
  const readKey =
    entityFieldModels[entity].fields.find(
      (candidate) => candidate.key === field,
    )?.readKey ?? field;
  const current = textArraySchema.safeParse(freshRecord[readKey]);
  const removedValues = new Set(
    suggestion.removals.map((removal) => removal.value),
  );
  if (
    !current.success ||
    ![...removedValues].every((value) => current.data.includes(value))
  ) {
    throw new Error("Suggestion inputs changed");
  }
  return {
    [field]: current.data.filter((value) => !removedValues.has(value)),
  };
}

function setFieldPatch(
  entity: StandardEntity,
  field: string,
  suggestion: FieldSuggestion,
  freshRecord: SuggestionRecord,
  expectedCurrent: string | null,
): z.output<typeof mutationPatchSchema> {
  const value = suggestion.value;
  if (
    !value ||
    recordValue(entity, freshRecord, field).value !== expectedCurrent
  ) {
    throw new Error("Suggestion inputs changed");
  }
  const resolution = recordFieldResolutions(freshRecord)[field];
  const resolutionPolicy = entityFieldModels[entity].fields.find(
    (candidate) => candidate.key === field,
  )?.resolution;
  const usesInheritedValue =
    resolution?.canReset === true &&
    resolutionPolicy?.redundancy === "eligible" &&
    resolution.fallbackValue === value;
  return usesInheritedValue && resolutionPolicy
    ? mutationPatchSchema.parse(resolutionPolicy.reset)
    : explicitSuggestionPatch(entity, field, value);
}

export const RecordSuggestionScope = createContext<SuggestionRow | null>(null);

function recordValue(
  entity: ShortcodeEntity,
  record: SuggestionRecord,
  key: string,
) {
  const field = entityFieldModels[entity].fields.find(
    (candidate) => candidate.key === key,
  );
  if (!field) return { value: null, label: null };
  if (field.reference) {
    const item = readReferenceField(record, field)?.items[0];
    return { value: item?.id ?? null, label: item?.name ?? item?.id ?? null };
  }
  const value = basisValueOf(record[field.readKey ?? key]);
  return {
    value,
    label: field.kind === "enum" ? enumFieldLabel(entity, key, value) : value,
  };
}

function recordFieldResolutions(record: SuggestionRecord) {
  const parsed = fieldResolutionsSchema.safeParse(record.fieldResolutions);
  return parsed.success ? parsed.data : {};
}

function resolutionContext(record: SuggestionRecord): string | null {
  const parsed = fieldResolutionsSchema.safeParse(record.fieldResolutions);
  return parsed.success ? JSON.stringify(parsed.data) : null;
}

const basisFingerprint = (basis: Record<string, string | null>) =>
  JSON.stringify(
    Object.entries(basis).sort(([left], [right]) => left.localeCompare(right)),
  );

/** The basis snapshot a suggestion request is computed against: the target
 * set's own basis keys, its inheritance-resolver context keys, and the
 * record's resolution fingerprint. Shared by request-building and by
 * `save`'s re-check so both sides agree on what "the same inputs" means for
 * a given key set. */
function recordSuggestionBasis(
  entity: StandardEntity,
  targets: SuggestTargets,
  record: SuggestionRecord,
) {
  const basis = fieldSuggestionBasisFromRecord(entity, targets, record);
  for (const key of suggestionContextKeys(entity, targets)) {
    const parsed = nullableBasisValueSchema.safeParse(record[key]);
    if (parsed.success) basis[key] = parsed.data;
  }
  basis.__resolutionContext = resolutionContext(record);
  return basis;
}

function suggestionRequestsForRecord(
  entity: StandardEntity,
  record: SuggestionRecord,
  targets: ReturnType<typeof suggestTargetsFor>,
) {
  const basis = recordSuggestionBasis(entity, targets, record);
  if (!isBasisSufficient(entity, targets, basis)) return [];
  const resolutions = recordFieldResolutions(record);
  const available = targets.targets.filter(
    (target) =>
      !(
        entity === "expense" &&
        target.key === "projectId" &&
        record.lineKind !== "principal"
      ),
  );
  // A `mode: "prune"` target always provides its own current entries as
  // basis — it is never an empty field waiting to be filled, so it gets its
  // own request group rather than joining the fill suggested/alternatives
  // split below (Amendment 2: prune suggestions are their own basis mode,
  // not lumped in with "provided" alternatives).
  const pruneTargets = available
    .filter((target) => target.mode === "prune")
    .map((target) => target.key)
    .sort();
  const fillTargets = available.filter((target) => target.mode !== "prune");
  const suggested = fillTargets
    .filter((target) => {
      const resolution = resolutions[target.key];
      return (
        recordValue(entity, record, target.key).value === null &&
        (resolution === undefined ||
          (resolution.mode === "inherit" && resolution.value === null))
      );
    })
    .map((target) => target.key)
    .sort();
  const suggestedSet = new Set(suggested);
  const alternatives = fillTargets
    .filter((target) => !suggestedSet.has(target.key))
    .map((target) => target.key)
    .sort();
  return [
    ...(suggested.length > 0
      ? [
          {
            record,
            source: {
              entity,
              basisMode: "suggested" as const,
              targets: suggested,
              basis,
            },
          },
        ]
      : []),
    ...(alternatives.length > 0
      ? [
          {
            record,
            source: {
              entity,
              basisMode: "provided" as const,
              targets: alternatives,
              basis,
            },
          },
        ]
      : []),
    ...(pruneTargets.length > 0
      ? [
          {
            record,
            source: {
              entity,
              basisMode: "provided" as const,
              targets: pruneTargets,
              basis,
            },
          },
        ]
      : []),
  ];
}

export function RecordSuggestionsProvider({
  entity,
  records,
  fieldKeys,
  children,
  operations,
  mutationPort,
  readRecord,
}: {
  entity: Entity | undefined;
  records: readonly unknown[];
  fieldKeys: readonly string[];
  children: ReactNode;
  operations?: EntitySuggestionsOperations;
  mutationPort?: EntityMutationPort;
  readRecord?: (
    entity: StandardEntity,
    id: string,
  ) => Promise<SuggestionRecord | null>;
}) {
  const crud = generatedBrowserCrudEntities.find(
    (candidate) => candidate === entity,
  );
  if (!crud) return children;
  return (
    <SuggestionVisitProvider key={crud}>
      <BoundRecordSuggestions
        entity={crud}
        records={records}
        fieldKeys={fieldKeys}
        operations={operations}
        mutationPort={mutationPort}
        readRecord={readRecord}
      >
        {children}
      </BoundRecordSuggestions>
    </SuggestionVisitProvider>
  );
}

/** The suggest targets a roster of visible field keys makes reachable —
 * shared by request-building and the "never asked" status line, so both
 * agree on what "this entity's suggestable fields" means for a given view. */
function visibleSuggestTargets(
  entity: StandardEntity,
  fieldKeys: readonly string[],
) {
  const visible = new Set(fieldKeys);
  const updateFields: readonly string[] = entityFieldModels[entity].update;
  return suggestTargetsFor(
    entity,
    entityFieldModels[entity].fields
      .filter(
        (field) =>
          visible.has(field.key) ||
          (field.reference != null &&
            visible.has(field.key.replace(/Id$/u, ""))) ||
          visible.has(field.display.columnId ?? field.key),
      )
      .map((field) => field.key)
      .filter((key) => updateFields.includes(key)),
  );
}

/** The label of the first non-reference basis field a suggest target
 * declares — what the "Not checked — add a `name` first" status line names
 * as the thing to fill in before Jev has anything to evaluate. */
function firstBasisFieldLabel(
  entity: StandardEntity,
  targets: SuggestTargets,
): string | null {
  for (const key of targets.basisKeys) {
    if (key.startsWith("__")) continue;
    const field = entityFieldModels[entity].fields.find(
      (candidate) => candidate.key === key,
    );
    if (field && !field.reference) return field.label.toLowerCase();
  }
  return null;
}

function requestsForRecords(
  entity: StandardEntity,
  records: readonly unknown[],
  targets: SuggestTargets,
) {
  return records.flatMap((raw) => {
    const parsed = recordSchema.safeParse(raw);
    if (
      !parsed.success ||
      parseShortcode(parsed.data.id)?.type !== entity ||
      targets.targets.length === 0
    )
      return [];
    return suggestionRequestsForRecord(entity, parsed.data, targets);
  });
}

function actionableRowSuggestionCount(
  entity: StandardEntity,
  rows: ReadonlyMap<string, SuggestionRow>,
  dismissed: ReadonlySet<string> | undefined,
) {
  let count = 0;
  for (const row of rows.values()) {
    for (const [key, suggestion] of Object.entries(row.suggestions)) {
      const current = recordValue(entity, row.record, key).value;
      const question = JSON.stringify([
        entity,
        row.record.id,
        key,
        row.sourceByField.get(key),
      ]);
      if (
        !dismissed?.has(
          JSON.stringify([question, current, suggestion?.value]),
        ) &&
        actionableSuggestion(
          suggestion,
          current,
          row.sourceByField.get(key)?.basisMode === "provided",
        )
      )
        count += 1;
    }
  }
  return count;
}

/** One row per requested (row, field) pair whose outcome has settled — what
 * `SuggestionStatus` lists or aggregates. A field whose query hasn't
 * returned yet (no `outcomes[field]` entry) is left out; `checking` already
 * covers that state. */
function statusFieldsForRows(
  entity: StandardEntity,
  rows: ReadonlyMap<string, SuggestionRow>,
): SuggestionStatusField[] {
  const fields: SuggestionStatusField[] = [];
  for (const row of rows.values()) {
    for (const field of row.sourceByField.keys()) {
      const outcome = row.outcomes[field];
      if (!outcome) continue;
      const model = entityFieldModels[entity].fields.find(
        (candidate) => candidate.key === field,
      );
      const value = recordValue(entity, row.record, field);
      fields.push({
        label: model?.label ?? field,
        outcome,
        suggestion: row.suggestions[field] ?? null,
        currentValue: value.value,
        currentLabel: value.label,
      });
    }
  }
  return fields;
}

function BoundRecordSuggestions({
  entity,
  records,
  fieldKeys,
  children,
  operations = productionEntitySuggestionsOperations,
  mutationPort,
  readRecord = async (currentEntity, id) =>
    recordSchema.parse(await entityDetailFor(currentEntity).readFresh(id)),
}: {
  entity: StandardEntity;
  records: readonly unknown[];
  fieldKeys: readonly string[];
  children: ReactNode;
  operations?: EntitySuggestionsOperations;
  mutationPort?: EntityMutationPort;
  readRecord?: (
    entity: StandardEntity,
    id: string,
  ) => Promise<SuggestionRecord | null>;
}) {
  const visit = useSuggestionVisit();
  const parentScheduler = useContext(SuggestionSchedulerContext);
  const [ownScheduler] = useState(() => createSuggestionScheduler());
  const scheduler = parentScheduler ?? ownScheduler;
  const update = useEntityCommands(entity, { mutationPort });
  const [correctionRecord, setCorrectionRecord] =
    useState<SuggestionRecord | null>(null);
  const targets = visibleSuggestTargets(entity, fieldKeys);
  const requests = requestsForRecords(entity, records, targets);
  // Identical records can share one query, while each row retains its own review state.
  const sources = [
    ...new Map(
      requests.map(({ source }) => [JSON.stringify(source), source]),
    ).values(),
  ];
  const queries = useQueries({
    queries: sources.map((source) => ({
      ...operations.suggestFields.queryOptions(source),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        scheduler.run(
          () => operations.suggestFields.call(source, { signal }),
          signal,
        ),
      retry: false,
      meta: {
        ...operations.suggestFields.queryOptions(source).meta,
        silentErrors: true,
      },
    })),
  });
  const bySource = new Map(
    sources.map((source, index) => [JSON.stringify(source), queries[index]!]),
  );
  const rows = new Map<string, SuggestionRow>();
  for (const { record, source } of requests) {
    const query = bySource.get(JSON.stringify(source))!;
    const previous = rows.get(record.id);
    const sourceByField = new Map(previous?.sourceByField);
    for (const field of source.targets) sourceByField.set(field, source);
    rows.set(record.id, {
      record,
      sourceByField,
      suggestions: {
        ...previous?.suggestions,
        ...query.data?.suggestions,
      },
      // The suggested/provided/prune request groups target disjoint field
      // keys (a target belongs to exactly one group), so this merge never
      // collides — each field's outcome comes from exactly one group's response.
      outcomes: {
        ...previous?.outcomes,
        ...query.data?.outcomes,
      },
      pending:
        (previous?.pending ?? false) || query.isFetching || query.isPending,
    });
  }
  const context = {
    entity,
    rows,
    save: async (
      id: string,
      field: string,
      suggestion: FieldSuggestion,
      source: FieldSuggestionSource,
      expectedCurrent: string | null,
    ) => {
      // Acceptance reads the entity again without asking Jev twice. Rebuild
      // the basis over the request's own key set (`source.basis`'s keys,
      // not every visible target's union) so a parent/default or line-kind
      // change still revokes the proposal, while an unrelated visible
      // target's basis does not falsely invalidate this one.
      const fresh = await readRecord(entity, id);
      if (!fresh) throw new Error("Suggestion inputs changed");
      const freshRecord = recordSchema.parse(fresh);
      const basisKeys = Object.keys(source.basis).filter(
        (key) => !key.startsWith("__"),
      );
      const freshTargets: SuggestTargets = {
        targets: suggestTargetsFor(entity, source.targets).targets,
        basisKeys,
      };
      const freshBasis = recordSuggestionBasis(
        entity,
        freshTargets,
        freshRecord,
      );
      const isRemove = suggestion.operation === "remove";
      if (
        basisFingerprint(basisForFingerprint(freshBasis, field, isRemove)) !==
        basisFingerprint(basisForFingerprint(source.basis, field, isRemove))
      ) {
        throw new Error("Suggestion inputs changed");
      }
      const patch = isRemove
        ? removeFieldPatch(entity, field, suggestion, freshRecord)
        : setFieldPatch(
            entity,
            field,
            suggestion,
            freshRecord,
            expectedCurrent,
          );
      try {
        await update.submit({
          operation: "update",
          intent: "full",
          id,
          data: parseEntityEditUpdateInput(entity, patch),
        });
      } catch (error) {
        // A dependent required field can invalidate an otherwise sound
        // suggestion. Keep the record unchanged and move the person into the
        // ordinary full editor, where every correction field is available.
        setCorrectionRecord(freshRecord);
        throw error;
      }
    },
  };
  const count = actionableRowSuggestionCount(entity, rows, visit?.dismissed);
  const checking = queries.some((query) => query.isFetching || query.isPending);
  const failures = queries.filter((query) => query.isError).length;
  // The client never asked at all — every requestable target's basis fell
  // short of `isBasisSufficient`, not that Jev declined once asked. Name the
  // first basis field that would unblock a request, e.g. "name".
  const unasked =
    requests.length === 0 && records.length > 0 && targets.targets.length > 0
      ? firstBasisFieldLabel(entity, targets)
      : null;
  return (
    <SuggestionSchedulerContext value={scheduler}>
      <RecordSuggestionsContext value={context}>
        <SuggestionStatus
          checking={checking}
          failures={failures}
          count={count}
          fields={statusFieldsForRows(entity, rows)}
          unasked={unasked}
        />
        {children}
        {correctionRecord ? (
          <EntityEditDialog<EditableEntity>
            open
            onOpenChange={(open) => {
              if (!open) setCorrectionRecord(null);
            }}
            request={
              // SAFETY: StandardEntity is the generated browser-editable
              // roster, and correctionRecord is its freshly read projection.
              detailEditRequest(
                entity,
                correctionRecord as never,
              ) as EntityEditDialogRequest<EditableEntity>
            }
            mutationPort={mutationPort}
          />
        ) : null}
      </RecordSuggestionsContext>
    </SuggestionSchedulerContext>
  );
}

/** Shares the row request with specialized editors rendered outside desktop cells. */
export function RecordSuggestionBoundary({
  record,
  children,
}: {
  record: unknown;
  children: ReactNode;
}) {
  const context = useContext(RecordSuggestionsContext);
  const parsed = recordSchema.safeParse(record);
  const row = parsed.success ? context?.rows.get(parsed.data.id) : undefined;
  return (
    <RecordSuggestionScope value={row ?? null}>
      {children}
    </RecordSuggestionScope>
  );
}

/** Wraps existing cells without changing their accessor, sorting, clipboard, or normal editor. */
function findEntityField(entity: StandardEntity, column: string) {
  return entityFieldModels[entity].fields.find(
    (candidate) =>
      candidate.key === column ||
      candidate.display.columnId === column ||
      (candidate.reference != null &&
        candidate.key.replace(/Id$/u, "") === column),
  );
}

/** Re-checked at apply time against the row snapshot the closure captured —
 * true when anything the acceptance depends on (the row identity, the
 * field's source, its current value, or the suggestion itself) has moved
 * since render, so a stale click can't silently write the wrong patch. */
function suggestionWentStale(
  entity: StandardEntity,
  latest: { row: SuggestionRow | undefined; field: string | undefined },
  expected: {
    recordId: string;
    field: string;
    source: FieldSuggestionSource;
    currentValue: string | null;
    suggestionValue: string | undefined;
  },
): boolean {
  const row = latest.row;
  if (!row || row.record.id !== expected.recordId) return true;
  if (latest.field !== expected.field) return true;
  if (
    JSON.stringify(row.sourceByField.get(expected.field)) !==
    JSON.stringify(expected.source)
  )
    return true;
  if (
    recordValue(entity, row.record, expected.field).value !==
    expected.currentValue
  )
    return true;
  return row.suggestions[expected.field]?.value !== expected.suggestionValue;
}

type RecordSuggestionsCtx = NonNullable<
  ContextType<typeof RecordSuggestionsContext>
>;

/** The part of `RecordFieldSuggestion` that only runs once every lookup
 * (context, row, field, source) has resolved — split out so the "nothing to
 * wrap yet" early-return branches in `RecordFieldSuggestion` don't share a
 * complexity budget with the review wiring below. */
function ResolvedFieldSuggestion({
  context,
  row,
  field,
  source,
  prune,
  surface,
  children,
}: {
  context: RecordSuggestionsCtx;
  row: SuggestionRow;
  field: string;
  source: FieldSuggestionSource;
  prune: boolean;
  surface: "inline" | "cell";
  children: ReactNode;
}) {
  const snapshot = useRef({ row, field });
  snapshot.current = { row, field };
  const current = recordValue(context.entity, row.record, field);
  const suggestion = row.suggestions[field] ?? null;
  const questionKey = JSON.stringify([
    context.entity,
    row.record.id,
    field,
    source,
  ]);
  const resolution = recordFieldResolutions(row.record)[field];
  const resolutionPolicy = entityFieldModels[context.entity].fields.find(
    (candidate) => candidate.key === field,
  )?.resolution;
  const usesInheritedValue =
    resolution?.canReset === true &&
    resolutionPolicy?.redundancy === "eligible" &&
    resolution.fallbackValue === suggestion?.value;
  const apply = async () => {
    if (
      !suggestion?.value ||
      suggestionWentStale(context.entity, snapshot.current, {
        recordId: row.record.id,
        field,
        source,
        currentValue: current.value,
        suggestionValue: suggestion?.value,
      })
    )
      throw new Error("Suggestion inputs changed");
    await context.save(row.record.id, field, suggestion, source, current.value);
  };
  return (
    <RecordSuggestionScope value={row}>
      <SuggestionReview
        suggestion={suggestion}
        currentValue={current.value}
        currentLabel={current.label}
        questionKey={questionKey}
        pending={row.pending}
        onApply={apply}
        applyLabel={usesInheritedValue ? "Use inherited value" : undefined}
        alternative={source.basisMode === "provided"}
        outcome={row.outcomes[field]}
        surface={surface}
        prune={prune}
      >
        {children}
      </SuggestionReview>
    </RecordSuggestionScope>
  );
}

export function RecordFieldSuggestion({
  record,
  field: column,
  children,
  surface = "inline",
}: {
  record: unknown;
  field: string;
  children: ReactNode;
  /** `"cell"` folds the review into the outcome mark's popover for a dense
   * 28px table row; `"inline"` (detail facts, phone cards) renders it directly. */
  surface?: "inline" | "cell";
}) {
  const context = useContext(RecordSuggestionsContext);
  const parsed = recordSchema.safeParse(record);
  const row = parsed.success ? context?.rows.get(parsed.data.id) : undefined;
  const fieldModel = context
    ? findEntityField(context.entity, column)
    : undefined;
  const field = fieldModel?.key;
  if (!context || !row || !field) return children;
  const source = row.sourceByField.get(field);
  if (!source) return children;
  return (
    <ResolvedFieldSuggestion
      context={context}
      row={row}
      field={field}
      source={source}
      prune={fieldModel?.control?.suggest?.mode === "prune"}
      surface={surface}
    >
      {children}
    </ResolvedFieldSuggestion>
  );
}

/** Phone summaries truncate ordinary facts; proposals get their own full-width rows. */
export function RecordRowSuggestions({ record }: { record: unknown }) {
  const context = useContext(RecordSuggestionsContext);
  const visit = useSuggestionVisit();
  const parsed = recordSchema.safeParse(record);
  const row = parsed.success ? context?.rows.get(parsed.data.id) : undefined;
  if (!context || !row) return null;
  const fields = [...row.sourceByField.keys()].filter((field) => {
    const current = recordValue(context.entity, row.record, field).value;
    const suggestion = row.suggestions[field] ?? null;
    const question = JSON.stringify([
      context.entity,
      row.record.id,
      field,
      row.sourceByField.get(field),
    ]);
    return (
      actionableSuggestion(
        suggestion,
        current,
        row.sourceByField.get(field)?.basisMode === "provided",
      ) &&
      !visit?.dismissed.has(
        JSON.stringify([question, current, suggestion?.value]),
      )
    );
  });
  if (fields.length === 0) return null;
  return (
    <Stack gap="sm">
      {fields.map((field) => (
        <Stack key={field} gap="xs">
          <Description size="xs">
            {
              entityFieldModels[context.entity].fields.find(
                (candidate) => candidate.key === field,
              )?.label
            }
          </Description>
          <RecordFieldSuggestion record={record} field={field}>
            {null}
          </RecordFieldSuggestion>
        </Stack>
      ))}
    </Stack>
  );
}
