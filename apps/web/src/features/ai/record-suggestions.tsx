import type {
  FieldSuggestion,
  FieldSuggestionOutcome,
  FieldSuggestionsOut,
  SuggestionReviewBatchOut,
  SuggestionReviewRow,
} from "@cubby/schemas/ai";
import { SUGGESTION_LIST_LIMIT_MAX } from "@cubby/schemas/ai";
import type { Entity } from "@cubby/schemas/entity";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import { fieldResolutionsSchema } from "@cubby/schemas/field-resolution";
import { productCategorySummary } from "@cubby/schemas/product-category-fields";
import { parseShortcode } from "@cubby/shared";
import { ArrowRightIcon } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { SparkleIcon } from "@phosphor-icons/react/dist/csr/Sparkle";
import {
  useMutation,
  useQueries,
  useQueryClient,
  type UseQueryResult,
  type UseQueryOptions,
} from "@tanstack/react-query";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ContextType,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { z } from "zod";

import { detailEditRequest } from "~/entity/editing/editor-requests";
import {
  EntityEditDialog,
  type EntityEditDialogRequest,
} from "~/entity/editing/entity-edit-dialog";
import { parseEntityEditUpdateInput } from "~/entity/editing/mutation-data";
import type { EditableEntity } from "~/entity/editing/types";
import type { EntityMutationPort } from "~/entity/editing/types";
import { useEntityCommands } from "~/entity/editing/use-entity-commands";
import type { EntityEditValueBag } from "~/entity/editing/value-schema";
import type { StandardEntity } from "~/entity/entity-contracts";
import { entityDetailFor } from "~/entity/entity-detail";
import { renderSuggestedListFieldValue } from "~/entity/entity-display";
import { readReferenceField } from "~/entity/entity-references";
import { enumFieldLabel } from "~/entity/enum-field-display";
import { generatedBrowserCrudEntities } from "~/entity/generated/entity-routes.gen";
import { entityRipple } from "~/integrations/tanstack-query/cache-tags";
import { ai } from "~/integrations/tanstack-query/generated/catalog.gen";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
import { createConcurrencyLimiter } from "~/lib/concurrency-limiter";
import { CellFrame } from "~/ui/data-table/cell-frame";
import { showErrorToast } from "~/ui/feedback/error-details";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { useHydrated } from "~/ui/hooks/useHydrated";
import { Stack } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import { Description } from "~/ui/primitives/description";
import { Pill } from "~/ui/primitives/pill";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/ui/primitives/popover";
import { Spinner } from "~/ui/primitives/spinner";

import {
  fieldSuggestionBasisFromRecord,
  suggestTargetsFor,
  suggestionContextKeys,
  isBasisSufficient,
  basisValueOf,
  financeSuggestionEntityId,
  productionEntitySuggestionsOperations,
  type EntitySuggestionsOperations,
  type FieldSuggestionSource,
  type SuggestTargets,
} from "./field-suggestion";
import {
  SuggestionBody,
  suggestionBasisLabels,
  type SuggestionProvenance,
} from "./suggestion-body";
import {
  actionableSuggestion,
  suggestionReviewKey,
  SuggestionReview,
  useSuggestionActions,
  SuggestionVisitProvider,
  useSuggestionVisit,
} from "./suggestion-review";
import {
  SuggestionStatus,
  type SuggestionStatusField,
} from "./suggestion-status";
import { useFinanceCategoryApply } from "./use-finance-category-apply";

const SuggestionSchedulerContext = createContext<ReturnType<
  typeof createConcurrencyLimiter
> | null>(null);

const recordSchema = z.looseObject({ id: z.string() });
const mutationPatchSchema = z.record(z.string(), z.json());
const nullableBasisValueSchema = z.string().nullable();
const textArraySchema = z.array(z.string());
type SuggestionRecord = z.infer<typeof recordSchema>;
type JsonValue = z.infer<ReturnType<typeof z.json>>;
type SuggestionRow = {
  record: SuggestionRecord;
  sourceByField: ReadonlyMap<string, FieldSuggestionSource>;
  suggestions: Record<string, FieldSuggestion | null>;
  outcomes: Record<string, FieldSuggestionOutcome>;
  pendingByField: ReadonlyMap<string, boolean>;
  errorByField: ReadonlyMap<string, unknown>;
};
/** Folds independently keyed field queries into their record's review state. */
function mergeSuggestionRow(
  previous: SuggestionRow | undefined,
  record: SuggestionRecord,
  source: FieldSuggestionSource,
  query: {
    data?: Pick<FieldSuggestionsOut, "suggestions" | "outcomes">;
    isFetching: boolean;
    isPending: boolean;
    error: unknown;
  },
): SuggestionRow {
  const sourceByField = new Map(previous?.sourceByField);
  const pendingByField = new Map(previous?.pendingByField);
  const errorByField = new Map(previous?.errorByField);
  for (const field of source.targets) {
    sourceByField.set(field, source);
    pendingByField.set(
      field,
      query.data === undefined && (query.isFetching || query.isPending),
    );
    errorByField.set(field, query.error);
  }
  return {
    record,
    sourceByField,
    suggestions: {
      ...previous?.suggestions,
      ...query.data?.suggestions,
    },
    // Each field's outcome belongs to its own question.
    outcomes: {
      ...previous?.outcomes,
      ...query.data?.outcomes,
    },
    pendingByField,
    errorByField,
  };
}

const RecordSuggestionsContext = createContext<{
  entity: StandardEntity;
  runKey: string;
  rows: ReadonlyMap<string, SuggestionRow>;
  save: (
    id: string,
    field: string,
    suggestion: FieldSuggestion,
    source: FieldSuggestionSource,
    expectedCurrent: string | null,
  ) => Promise<void>;
  recordMiss: (
    id: string,
    field: string,
    suggestion: FieldSuggestion,
    currentValue: string | null,
  ) => Promise<void>;
  stored: ReadonlyMap<string, SuggestionReviewRow>;
  accepted: ReadonlyMap<string, AcceptedSuggestion>;
  acceptValue: (
    record: SuggestionRecord,
    field: string,
    value: JsonValue,
    label: string | undefined,
    accept: () => Promise<void>,
  ) => Promise<void>;
  acceptStored: (id: string) => Promise<void>;
  acceptStoredMany: (ids: string[]) => Promise<SuggestionReviewBatchOut>;
  rejectStored: (id: string, correctValue?: JsonValue) => Promise<void>;
  storedCountFor: (records: readonly unknown[]) => number;
} | null>(null);

export interface StoredSuggestionOperations {
  list: (input: {
    entity: StandardEntity;
    recordIds: string[];
    fields: string[];
  }) => Promise<SuggestionReviewRow[]>;
  accept: (input: {
    id: string;
  }) => Promise<{ id: string; status: "applied" | "rejected" }>;
  acceptMany: (input: { ids: string[] }) => Promise<SuggestionReviewBatchOut>;
  reject: (input: {
    id: string;
    correctValue?: JsonValue;
  }) => Promise<{ id: string; status: "applied" | "rejected" }>;
}

type PendingPageInput = Parameters<StoredSuggestionOperations["list"]>[0];

/**
 * Every pending row for a list page's records: no confidence floor, and a
 * read that fills the row limit is split by record until none does, so a page
 * with many suggestible fields is never silently truncated.
 */
export const everyPendingSuggestion =
  (
    read: (
      input: PendingPageInput & { minConfidence: number; limit: number },
    ) => Promise<SuggestionReviewRow[]>,
  ) =>
  async (input: PendingPageInput): Promise<SuggestionReviewRow[]> => {
    const rows = await read({
      ...input,
      minConfidence: 0,
      limit: SUGGESTION_LIST_LIMIT_MAX,
    });
    if (rows.length < SUGGESTION_LIST_LIMIT_MAX || input.recordIds.length < 2)
      return rows;
    const middle = Math.ceil(input.recordIds.length / 2);
    const halves = await Promise.all(
      [input.recordIds.slice(0, middle), input.recordIds.slice(middle)].map(
        (recordIds) => everyPendingSuggestion(read)({ ...input, recordIds }),
      ),
    );
    return halves.flat();
  };

const productionStoredSuggestionOperations: StoredSuggestionOperations = {
  list: everyPendingSuggestion((input) =>
    ai.listSuggestionReviewQueue.call(input),
  ),
  accept: (input) => ai.acceptSuggestion.call(input),
  acceptMany: (input) => ai.acceptSuggestions.call(input),
  reject: (input) => ai.rejectSuggestion.call(input),
};

const recordPublicId = (record: unknown) => {
  const parsed = z
    .looseObject({
      id: z.string(),
    })
    .safeParse(record);
  return parsed.success ? parsed.data.id : null;
};

const storedSuggestionKey = (recordId: string, field: string) =>
  `${recordId}:${field}`;

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

function resolutionContext(
  record: SuggestionRecord,
  keys: readonly string[],
): string | null {
  const parsed = fieldResolutionsSchema.safeParse(record.fieldResolutions);
  if (!parsed.success) return null;
  const relevant = new Set(keys);
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(parsed.data).filter(([field]) => relevant.has(field)),
    ),
  );
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
  basis.__resolutionContext = resolutionContext(record, [
    ...targets.basisKeys,
    ...targets.targets.map((target) => target.key),
  ]);
  return basis;
}

/** Each target owns its question: deferred sibling projections and accepted
 * sibling assignments cannot replace an unchanged field's query observer. */
function suggestionRequestsForRecord(
  entity: StandardEntity,
  record: SuggestionRecord,
  targets: SuggestTargets,
  runKey: string,
) {
  return targets.targets.flatMap((target) => {
    const ownTargets = suggestTargetsFor(entity, [target.key]);
    const basis = recordSuggestionBasis(
      entity,
      {
        ...ownTargets,
        basisKeys: [...new Set([...ownTargets.basisKeys, target.key])],
      },
      record,
    );
    const field = entityFieldModels[entity].fields.find(
      (entry) => entry.key === target.key,
    );
    const resolutions = recordFieldResolutions(record);
    const loaded =
      record[field?.readKey ?? target.key] !== undefined ||
      (field?.reference != null &&
        record[target.key.replace(/Ids?$/u, "")] !== undefined) ||
      resolutions[target.key] !== undefined ||
      recordValue(entity, record, target.key).value !== null;
    if (
      !loaded ||
      !isBasisSufficient(entity, ownTargets, basis) ||
      (entity === "expense" &&
        target.key === "projectId" &&
        record.lineKind !== "principal")
    )
      return [];
    const resolution = resolutions[target.key];
    const empty =
      target.mode !== "prune" &&
      recordValue(entity, record, target.key).value === null &&
      (resolution === undefined ||
        (resolution.mode === "inherit" && resolution.value === null));
    return [
      {
        record,
        source: {
          entity,
          entityId: financeSuggestionEntityId(entity, record),
          basisMode: empty ? ("suggested" as const) : ("provided" as const),
          targets: [target.key],
          basis,
          runKey,
        },
      },
    ];
  });
}

type AcceptedSuggestion = {
  actionKey: string;
  previousValue: string | null;
  confirmed: boolean;
  recordId: string;
  field: string;
  basis: string;
  value: JsonValue;
  label: string | undefined;
  pending: boolean;
};

/** Acceptance changes its own assignment; only dependencies can revoke the
 * retained choice. The authoritative write still checks the full request basis. */
function acceptedBasis(
  entity: StandardEntity,
  record: SuggestionRecord,
  field: string,
) {
  const targets = suggestTargetsFor(entity, [field]);
  const definition = entityFieldModels[entity].fields.find(
    (candidate) => candidate.key === field,
  );
  const ownKeys = new Set([
    field,
    ...Object.keys(definition?.resolution?.reset ?? {}),
  ]);
  const dependencies = {
    ...targets,
    basisKeys: targets.basisKeys.filter((key) => !ownKeys.has(key)),
  };
  const basis = recordSuggestionBasis(entity, dependencies, record);
  for (const key of ownKeys) delete basis[key];
  basis.__resolutionContext = resolutionContext(
    record,
    suggestionContextKeys(entity, dependencies).filter(
      (key) => !ownKeys.has(key),
    ),
  );
  basis.__acceptedFallback = JSON.stringify(
    recordFieldResolutions(record)[field]?.fallbackValue ?? null,
  );
  return basisFingerprint(basis);
}

function activeAcceptedSuggestions(
  entity: StandardEntity,
  records: readonly unknown[],
  accepted: ReadonlyMap<string, AcceptedSuggestion>,
) {
  const byId = new Map(
    records.flatMap((raw) => {
      const parsed = recordSchema.safeParse(raw);
      return parsed.success ? [[parsed.data.id, parsed.data] as const] : [];
    }),
  );
  const active = new Map<string, AcceptedSuggestion>();
  for (const [key, entry] of accepted) {
    const record = byId.get(entry.recordId);
    if (!record || entry.basis !== acceptedBasis(entity, record, entry.field))
      continue;
    const current = recordValue(entity, record, entry.field).value;
    const confirmed = current === basisValueOf(entry.value);
    if (confirmed || (!entry.confirmed && current === entry.previousValue)) {
      active.set(
        key,
        confirmed && !entry.confirmed ? { ...entry, confirmed: true } : entry,
      );
    }
  }
  return active;
}

export function RecordSuggestionsProvider({
  entity,
  records,
  fieldKeys,
  children,
  statusTarget,
  operations,
  mutationPort,
  readRecord,
  storedSuggestionOperations,
}: {
  entity: Entity | undefined;
  records: readonly unknown[];
  fieldKeys: readonly string[];
  children: ReactNode;
  statusTarget?: HTMLElement | null;
  operations?: EntitySuggestionsOperations;
  mutationPort?: EntityMutationPort;
  readRecord?: (
    entity: StandardEntity,
    id: string,
  ) => Promise<SuggestionRecord | null>;
  storedSuggestionOperations?: StoredSuggestionOperations;
}) {
  const crud = generatedBrowserCrudEntities.find(
    (candidate) => candidate === entity,
  );
  if (!crud) return children;
  return (
    <SuggestionVisitProvider key={crud}>
      <BoundRecordSuggestions
        statusTarget={statusTarget}
        entity={crud}
        records={records}
        fieldKeys={fieldKeys}
        operations={operations}
        mutationPort={mutationPort}
        readRecord={readRecord}
        storedSuggestionOperations={storedSuggestionOperations}
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
 * as the thing to fill in before the decision model has anything to evaluate. */
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
  runKey: string,
  stored: ReadonlyMap<string, SuggestionReviewRow>,
) {
  return records.flatMap((raw) => {
    const parsed = recordSchema.safeParse(raw);
    if (
      !parsed.success ||
      parseShortcode(parsed.data.id)?.type !== entity ||
      targets.targets.length === 0
    )
      return [];
    const available = suggestTargetsFor(
      entity,
      targets.targets
        .filter(
          (target) =>
            !stored.has(
              storedSuggestionKey(
                recordPublicId(raw) ?? parsed.data.id,
                target.key,
              ),
            ),
        )
        .map((target) => target.key),
    );
    return suggestionRequestsForRecord(entity, parsed.data, available, runKey);
  });
}

function storedSuggestionIndex(
  rows: readonly SuggestionReviewRow[] | undefined,
  entity: StandardEntity,
  records: readonly unknown[],
) {
  const categories = new Map<string, z.infer<typeof productCategorySummary>>();
  if (entity === "product") {
    for (const record of records) {
      const parsed = z
        .object({
          id: z.string(),
          categoryId: z.string().nullable(),
          category: productCategorySummary,
        })
        .safeParse(record);
      if (parsed.success && parsed.data.categoryId === parsed.data.category.id)
        categories.set(parsed.data.id, parsed.data.category);
    }
  }
  const index = new Map<string, SuggestionReviewRow>();
  for (const suggestion of (rows ?? []).filter((suggestion) => {
    const current = categories.get(suggestion.recordId);
    if (
      entity === "product" &&
      suggestion.field === "categoryId" &&
      suggestion.kind === "correction" &&
      !current
    )
      return false;
    return !(
      suggestion.field === "categoryId" &&
      current &&
      suggestion.currentValue === current.id &&
      suggestion.suggestedValue !== current.id &&
      current.path.some((node) => node.id === suggestion.suggestedValue)
    );
  })) {
    // Siblings share a key; the strongest wins regardless of read order.
    const key = storedSuggestionKey(suggestion.recordId, suggestion.field);
    const held = index.get(key);
    if (
      !held ||
      suggestion.confidence > held.confidence ||
      (suggestion.confidence === held.confidence && suggestion.id < held.id)
    )
      index.set(key, suggestion);
  }
  return index;
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
        !dismissed?.has(suggestionReviewKey(question, current, suggestion)) &&
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

type StoredPageRead = {
  recordIds: readonly string[];
  rows: Awaited<ReturnType<StoredSuggestionOperations["list"]>>;
};
const firstStoredPageQuery = (results: UseQueryResult<StoredPageRead>[]) =>
  results[0];
const combineFieldQueries = (results: UseQueryResult<FieldSuggestionsOut>[]) =>
  results.map(({ data, isFetching, isPending, isError, error, refetch }) => ({
    data,
    isFetching,
    isPending,
    isError,
    error,
    refetch,
  }));

const NO_RECORDS: readonly unknown[] = [];

function SuggestionStatusPlacement({
  target,
  children,
}: {
  target?: HTMLElement | null;
  children: ReactNode;
}) {
  return target ? createPortal(children, target) : children;
}

function BoundRecordSuggestions({
  entity,
  records: allRecords,
  fieldKeys,
  children,
  statusTarget,
  operations = productionEntitySuggestionsOperations,
  mutationPort,
  readRecord = async (currentEntity, id) =>
    recordSchema.parse(await entityDetailFor(currentEntity).readFresh(id)),
  storedSuggestionOperations = productionStoredSuggestionOperations,
}: {
  entity: StandardEntity;
  records: readonly unknown[];
  fieldKeys: readonly string[];
  children: ReactNode;
  statusTarget?: HTMLElement | null;
  operations?: EntitySuggestionsOperations;
  mutationPort?: EntityMutationPort;
  readRecord?: (
    entity: StandardEntity,
    id: string,
  ) => Promise<SuggestionRecord | null>;
  storedSuggestionOperations?: StoredSuggestionOperations;
}) {
  const visit = useSuggestionVisit();
  const parentScheduler = useContext(SuggestionSchedulerContext);
  // A page keeps its limiter across input changes; obsolete work cannot open a
  // second pool. Each in-flight suggestion pins a Neon backend and an AI Gateway call:
  // on 2026-09-21 a 32-wide burst from one page pinned enough backends to OOM
  // the 0.25 CU compute for ~80s and produced 135 AI Gateway 429s. Batched
  // transport does not relax this — Hyperdrive's origin slots are the limit,
  // and 16 in flight measurably starved the list's own page reads (3.4 s).
  const [ownScheduler] = useState(() => createConcurrencyLimiter(4));
  const scheduler = parentScheduler ?? ownScheduler;
  const financeApply = useFinanceCategoryApply(operations);
  const update = useEntityCommands(entity, { mutationPort });
  const [correctionRecord, setCorrectionRecord] =
    useState<SuggestionRecord | null>(null);
  // One id per page mount, groups every suggestFields call this provider
  // makes into one `ai_suggest` run instead of a run per row/field.
  const [runKey] = useState(() => crypto.randomUUID());
  // Suggestions only ever resolve in the browser. Deriving a request basis and
  // a query observer per row during SSR cost list pages hundreds of ms of
  // Worker CPU for nothing; skipping it until hydration keeps the server render
  // and the first client render identical.
  const hydrated = useHydrated();
  const records = hydrated ? allRecords : NO_RECORDS;
  const targets = visibleSuggestTargets(entity, fieldKeys);
  const pageRecordIds = [
    ...new Set(
      records.map(recordPublicId).filter((id): id is string => id !== null),
    ),
  ];
  const pageFields = entityFieldModels[entity].fields
    .filter((field) => field.control?.suggest)
    .map((field) => field.key);
  const storedQueryKey = [
    "ai",
    "page-pending-suggestions",
    entity,
    pageRecordIds,
    pageFields,
  ] as const;
  const storedQueries: UseQueryOptions<StoredPageRead>[] =
    hydrated && pageRecordIds.length > 0 && pageFields.length > 0
      ? [
          {
            queryKey: storedQueryKey,
            queryFn: async (): Promise<StoredPageRead> => ({
              recordIds: pageRecordIds,
              rows: await storedSuggestionOperations.list({
                entity,
                recordIds: pageRecordIds,
                fields: pageFields,
              }),
            }),
            retry: false,
            meta: { cacheTags: [[entity]] },
          },
        ]
      : [];
  const storedQuery = useQueries({
    queries: storedQueries,
    combine: firstStoredPageQuery,
  });
  // A growing roster keeps completed reads for the old rows. Only newly seen
  // rows wait for the next stored read; a failed refresh retains its data.
  const completedStoredRead = useRef<StoredPageRead | undefined>(undefined);
  if (storedQuery?.data && !storedQuery.isPlaceholderData)
    completedStoredRead.current = storedQuery.data;
  const storedData = storedQuery?.data ?? completedStoredRead.current;
  const knownRecordIds = new Set(storedData?.recordIds);
  const queryClient = useQueryClient();
  const [acceptedValues, setAcceptedValues] = useState<
    ReadonlyMap<string, AcceptedSuggestion>
  >(new Map());
  const accepted = activeAcceptedSuggestions(entity, records, acceptedValues);
  useEffect(() => {
    setAcceptedValues((previous) => {
      const active = activeAcceptedSuggestions(entity, records, previous);
      return active.size === previous.size &&
        [...active].every(([key, entry]) => previous.get(key) === entry)
        ? previous
        : active;
    });
  }, [entity, records]);
  const afterStoredReview = (...ids: string[]) => {
    if (ids.length === 0) return;
    const settled = new Set(ids);
    queryClient.setQueryData<StoredPageRead>(storedQueryKey, (previous) =>
      previous
        ? {
            ...previous,
            rows: previous.rows.filter((item) => !settled.has(item.id)),
          }
        : previous,
    );
    void Promise.all([
      invalidateOperationTags(
        queryClient,
        ai.acceptSuggestions.invalidates({ ids }),
      ),
      invalidateOperationTags(queryClient, entityRipple(entity)),
    ]);
  };
  const acceptStoredMutation = useMutation({
    mutationFn: storedSuggestionOperations.accept,
    onSuccess: (_result, input) => afterStoredReview(input.id),
  });
  const rejectStoredMutation = useMutation({
    mutationFn: storedSuggestionOperations.reject,
    onSuccess: (_result, input) => afterStoredReview(input.id),
  });
  const stored = storedSuggestionIndex(storedData?.rows, entity, records);
  for (const key of accepted.keys()) stored.delete(key);
  const readyRecords =
    pageFields.length === 0
      ? records
      : records.filter((record) =>
          knownRecordIds.has(recordPublicId(record) ?? ""),
        );
  const requests = requestsForRecords(
    entity,
    readyRecords,
    targets,
    runKey,
    stored,
  ).filter(
    ({ record, source }) =>
      !source.targets.some((field) =>
        accepted.has(storedSuggestionKey(record.id, field)),
      ),
  );
  // Identical records can share one query, while each row retains its own review state.
  const sources = [
    ...new Map(
      requests.map(({ source }) => [JSON.stringify(source), source]),
    ).values(),
  ];
  const queries = useQueries({
    combine: combineFieldQueries,
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
    rows.set(
      record.id,
      mergeSuggestionRow(rows.get(record.id), record, source, query),
    );
  }
  const context = {
    entity,
    runKey,
    rows,
    stored,
    accepted,
    acceptValue: async (
      record: SuggestionRecord,
      field: string,
      value: JsonValue,
      label: string | undefined,
      accept: () => Promise<void>,
    ) => {
      const key = storedSuggestionKey(record.id, field);
      const entry: AcceptedSuggestion = {
        actionKey: crypto.randomUUID(),
        previousValue: recordValue(entity, record, field).value,
        confirmed: false,
        recordId: record.id,
        field,
        basis: acceptedBasis(entity, record, field),
        value,
        label,
        pending: true,
      };
      setAcceptedValues((previous) => new Map(previous).set(key, entry));
      try {
        await accept();
        setAcceptedValues((previous) => {
          const current = previous.get(key);
          if (current?.actionKey !== entry.actionKey) return previous;
          return new Map(previous).set(key, { ...current, pending: false });
        });
      } catch (error) {
        setAcceptedValues((previous) => {
          if (previous.get(key)?.actionKey !== entry.actionKey) return previous;
          const next = new Map(previous);
          next.delete(key);
          return next;
        });
        throw error;
      }
    },
    acceptStored: async (id: string) => {
      await acceptStoredMutation.mutateAsync({ id });
    },
    acceptStoredMany: async (ids: string[]) => {
      const results = await storedSuggestionOperations.acceptMany({ ids });
      afterStoredReview(
        ...results.flatMap((result) => (result.ok ? [result.id] : [])),
      );
      return results;
    },
    rejectStored: async (id: string, correctValue?: JsonValue) => {
      await rejectStoredMutation.mutateAsync({ id, correctValue });
    },
    storedCountFor: (items: readonly unknown[]) => {
      const ids = new Set(
        items.map(recordPublicId).filter((id): id is string => id !== null),
      );
      return [...stored.values()].filter((item) => ids.has(item.recordId))
        .length;
    },
    recordMiss: async (
      id: string,
      field: string,
      suggestion: FieldSuggestion,
      currentValue: string | null,
    ) => {
      if (!suggestion.value) return;
      await operations.recordFieldSuggestionMiss?.call({
        entity,
        entityId: id,
        field,
        runKey,
        currentValue,
        suggestedValue: suggestion.value,
        confidence: suggestion.probability ?? 0,
      });
    },
    save: async (
      id: string,
      field: string,
      suggestion: FieldSuggestion,
      source: FieldSuggestionSource,
      expectedCurrent: string | null,
    ) => {
      if (suggestion.financeReview) {
        try {
          await financeApply.apply(suggestion);
        } catch (error) {
          await bySource.get(JSON.stringify(source))?.refetch();
          throw error;
        }
        return;
      }
      // Acceptance reads the entity again without asking the decision model twice. Rebuild
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
  // Before hydration no query exists yet, but checking is about to start;
  // saying so keeps the status line (and the table below it) where it lands.
  const checking =
    (!hydrated && allRecords.length > 0 && targets.targets.length > 0) ||
    ((storedQuery?.isFetching ?? false) &&
      readyRecords.length < records.length) ||
    queries.some((query) => query.isFetching || query.isPending);
  const failures =
    queries.filter((query) => query.isError).length +
    Number(storedQuery?.isError ?? false);
  // The client never asked at all — every requestable target's basis fell
  // short of `isBasisSufficient`, not that the decision model declined once asked. Name the
  // first basis field that would unblock a request, e.g. "name".
  const unasked =
    requests.length === 0 &&
    readyRecords.length > 0 &&
    targets.targets.length > 0 &&
    stored.size === 0 &&
    accepted.size === 0 &&
    !storedQuery?.isFetching
      ? firstBasisFieldLabel(entity, targets)
      : null;
  const status = (
    <>
      <SuggestionStatus
        checking={checking}
        failures={failures}
        count={count}
        fields={statusFieldsForRows(entity, rows)}
        unasked={unasked}
      />
      {storedQuery?.error ? (
        <ErrorDisplay
          error={storedQuery.error}
          title="stored suggestions"
          onRetry={() => void storedQuery.refetch()}
        />
      ) : null}
    </>
  );
  return (
    <SuggestionSchedulerContext value={scheduler}>
      <RecordSuggestionsContext value={context}>
        <SuggestionStatusPlacement target={statusTarget}>
          {status}
        </SuggestionStatusPlacement>
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
    suggestionFingerprint: string | undefined;
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
  return (
    row.suggestions[expected.field]?.value !== expected.suggestionValue ||
    row.suggestions[expected.field]?.financeReview?.fingerprint !==
      expected.suggestionFingerprint
  );
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
  const [editOpen, setEditOpen] = useState(false);
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
        suggestionFingerprint: suggestion?.financeReview?.fingerprint,
      })
    )
      throw new Error("Suggestion inputs changed");
    await context.save(row.record.id, field, suggestion, source, current.value);
  };
  const dismiss = async () => {
    if (suggestion)
      await context.recordMiss(row.record.id, field, suggestion, current.value);
  };
  if (surface === "cell" && !row.errorByField.get(field)) {
    // Prune proposals keep the popover review: removing chips has no pill.
    if (
      suggestion?.operation !== "remove" &&
      suggestion?.value &&
      suggestion.value !== current.value &&
      suggestion.probability !== null
    )
      return (
        <RecordSuggestionScope value={row}>
          <LiveSuggestionCell
            context={context}
            record={row.record}
            field={field}
            suggestion={{
              ...suggestion,
              value: suggestion.value,
              probability: suggestion.probability,
            }}
            currentValue={current.value}
            questionKey={questionKey}
            pending={row.pendingByField.get(field) ?? false}
            inline={actionableSuggestion(
              suggestion,
              current.value,
              source.basisMode === "provided",
            )}
            apply={apply}
            dismiss={dismiss}
          >
            {children}
          </LiveSuggestionCell>
        </RecordSuggestionScope>
      );
    // Keep the row scope: a nested FieldSuggestionApply (an inline cell
    // editor) reads it to reuse this row's answer instead of asking again.
    if (suggestion?.operation !== "remove")
      return (
        <RecordSuggestionScope value={row}>{children}</RecordSuggestionScope>
      );
  }
  return (
    <RecordSuggestionScope value={row}>
      <SuggestionReview
        suggestion={suggestion}
        currentValue={current.value}
        currentLabel={current.label}
        questionKey={questionKey}
        pending={row.pendingByField.get(field) ?? false}
        error={row.errorByField.get(field)}
        onApply={apply}
        onDismiss={dismiss}
        onUseDifferent={
          suggestion?.operation === "remove" || suggestion?.financeReview
            ? undefined
            : () => setEditOpen(true)
        }
        basis={suggestionBasisLabels(context.entity, field)}
        notice={usesInheritedValue ? "Uses the inherited value" : undefined}
        alternative={source.basisMode === "provided"}
        outcome={row.outcomes[field]}
        surface={surface}
        prune={prune}
      >
        {children}
      </SuggestionReview>
      {editOpen ? (
        <DifferentValueDialog
          entity={context.entity}
          record={row.record}
          field={field}
          open
          onOpenChange={setEditOpen}
          onSubmitted={() => void dismiss().catch(showErrorToast)}
        />
      ) : null}
    </RecordSuggestionScope>
  );
}

export function RecordFieldSuggestion({
  record,
  field: column,
  children,
  surface = "inline",
  renderValue,
}: {
  record: unknown;
  field: string;
  children: ReactNode;
  /** `"cell"` folds the review into the outcome mark's popover for a dense
   * 32px table row; `"inline"` (detail facts, phone cards) renders it directly. */
  surface?: "inline" | "cell";
  renderValue?: (value: JsonValue) => ReactNode;
}) {
  const context = useContext(RecordSuggestionsContext);
  const parsed = recordSchema.safeParse(record);
  const row = parsed.success ? context?.rows.get(parsed.data.id) : undefined;
  const fieldModel = context
    ? findEntityField(context.entity, column)
    : undefined;
  const field = fieldModel?.key;
  if (!context || !field) return children;
  const accepted = parsed.success
    ? context.accepted.get(storedSuggestionKey(parsed.data.id, field))
    : undefined;
  if (accepted && parsed.success) {
    if (accepted.confirmed && !accepted.pending) return children;
    const value =
      renderValue?.(accepted.value) ??
      renderSuggestedListFieldValue(
        context.entity,
        parsed.data,
        field,
        accepted.value,
        accepted.label,
      );
    return (
      <CellFrame
        trailing={
          accepted.pending ? (
            <Spinner
              className="size-3 shrink-0"
              aria-label="Saving suggested value"
            />
          ) : null
        }
      >
        <span
          aria-busy={accepted.pending}
          inert={accepted.pending ? true : undefined}
        >
          {value}
        </span>
      </CellFrame>
    );
  }
  const storedSuggestion = context.stored.get(
    storedSuggestionKey(recordPublicId(record) ?? "", field),
  );
  if (storedSuggestion)
    return (
      <StoredSuggestionField
        context={context}
        record={parsed.success ? parsed.data : { id: "" }}
        field={field}
        suggestion={storedSuggestion}
        surface={surface}
        renderValue={renderValue}
      >
        {children}
      </StoredSuggestionField>
    );
  if (!row) return children;
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

function StoredSuggestionField({
  context,
  record,
  field,
  suggestion,
  renderValue,
  surface,
  children,
}: {
  context: RecordSuggestionsCtx;
  record: SuggestionRecord;
  field: string;
  suggestion: SuggestionReviewRow;
  renderValue?: (value: JsonValue) => ReactNode;
  surface: "inline" | "cell";
  children: ReactNode;
}) {
  const runnerUp = suggestion.runnerUpValue;
  return (
    <GhostSuggestionCell
      context={context}
      record={record}
      field={field}
      kind={suggestion.kind}
      compact={surface === "inline"}
      value={suggestion.suggestedValue}
      probability={suggestion.confidence}
      runnerUp={
        runnerUp === null
          ? null
          : {
              label:
                renderValue?.(runnerUp) ??
                renderSuggestedListFieldValue(
                  context.entity,
                  record,
                  field,
                  runnerUp,
                ),
              probability: suggestion.runnerUpConfidence,
            }
      }
      provenance={{
        model: suggestion.model,
        runId: suggestion.runId,
        at: suggestion.createdAt,
      }}
      renderValue={renderValue}
      accept={() => context.acceptStored(suggestion.id)}
      reject={() => context.rejectStored(suggestion.id)}
      correct={(value) => context.rejectStored(suggestion.id, value)}
    >
      {children}
    </GhostSuggestionCell>
  );
}

/** Strong live proposals share stored-pill chrome; weaker proposals remain
 * available for review beside the current value. */
function LiveSuggestionCell({
  context,
  record,
  field,
  suggestion,
  currentValue,
  questionKey,
  pending,
  inline,
  apply,
  dismiss,
  children,
}: {
  context: RecordSuggestionsCtx;
  record: SuggestionRecord;
  field: string;
  suggestion: FieldSuggestion & { value: string; probability: number };
  currentValue: string | null;
  questionKey: string;
  pending: boolean;
  inline: boolean;
  apply: () => Promise<void>;
  dismiss: () => Promise<void>;
  children: ReactNode;
}) {
  const actions = useSuggestionActions(
    suggestionReviewKey(questionKey, currentValue, suggestion),
    apply,
    pending,
    dismiss,
  );
  if (actions.dismissed) return children;
  const runnerUp = suggestion.alternatives[0];
  return (
    <GhostSuggestionCell
      context={context}
      record={record}
      field={field}
      kind={currentValue?.trim() ? "correction" : "addition"}
      value={suggestion.value}
      probability={suggestion.probability}
      label={suggestion.detail ?? suggestion.label ?? undefined}
      reasoning={suggestion.reasoning}
      runnerUp={
        runnerUp
          ? { label: runnerUp.label, probability: runnerUp.probability }
          : null
      }
      provenance={{ model: null, runId: null, at: null }}
      inline={inline}
      pending={pending}
      accept={apply}
      reject={actions.dismiss}
      onCorrected={actions.dismiss}
    >
      {children}
    </GhostSuggestionCell>
  );
}

/** Edits one field in the full editor; its saved value answers a rejected
 * suggestion ("Use a different value…"). */
function DifferentValueDialog({
  entity,
  record,
  field,
  open,
  onOpenChange,
  onSubmitted,
  onSubmitOverride,
}: {
  entity: StandardEntity;
  record: SuggestionRecord;
  field: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmitted?: () => void;
  onSubmitOverride?: (values: EntityEditValueBag) => Promise<void>;
}) {
  return (
    <EntityEditDialog<EditableEntity>
      open={open}
      onOpenChange={onOpenChange}
      request={
        // SAFETY: BoundRecordSuggestions only mounts for generated CRUD
        // entities, and detailEditRequest builds that entity's update:full request.
        detailEditRequest(
          entity,
          record as never,
          field,
        ) as EntityEditDialogRequest<EditableEntity>
      }
      onSubmitted={onSubmitted}
      onSubmitOverride={onSubmitOverride}
    />
  );
}

/** The live text of a rendered subtree — a reference value resolves its
 * label asynchronously, so this follows the DOM rather than reading once. */
function useRenderedText() {
  const ref = useRef<HTMLSpanElement>(null);
  const [text, setText] = useState("");
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const read = () => setText(element.textContent?.trim() ?? "");
    read();
    const observer = new MutationObserver(read);
    observer.observe(element, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    return () => observer.disconnect();
  }, []);
  return { ref, text };
}

function suggestionAcceptLabel(text: string) {
  return text ? `Accept suggested value: ${text}` : "Accept suggested value";
}

/** A stored or strong live suggestion beside its field: the ghost pill accepts
 * in one tap, and its mark opens the shared suggestion body. */
function GhostSuggestionCell({
  context,
  record,
  field,
  kind,
  value,
  probability,
  label,
  reasoning,
  runnerUp = null,
  provenance,
  inline = true,
  compact = false,
  pending = false,
  renderValue,
  accept,
  reject,
  correct,
  onCorrected,
  children,
}: {
  context: RecordSuggestionsCtx;
  record: SuggestionRecord;
  field: string;
  kind: SuggestionReviewRow["kind"];
  value: JsonValue;
  probability: number;
  label?: string;
  reasoning?: string;
  runnerUp?: { label: ReactNode; probability: number | null } | null;
  provenance: SuggestionProvenance;
  inline?: boolean;
  compact?: boolean;
  pending?: boolean;
  renderValue?: (value: JsonValue) => ReactNode;
  accept: () => Promise<void>;
  reject: () => Promise<void>;
  /** Owns the "different value" commit (a stored Suggestion's atomic
   * correct+reject); without it the editor saves normally. */
  correct?: (value: JsonValue) => Promise<void>;
  onCorrected?: () => Promise<void>;
  children: ReactNode;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const [bodyOpen, setBodyOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const active = useRef(false);
  const busy = pending || saving;
  const run = async (action: () => Promise<void>) => {
    if (active.current || busy) return;
    active.current = true;
    setSaving(true);
    try {
      await action();
      setBodyOpen(false);
    } catch (error) {
      showErrorToast(error);
    } finally {
      active.current = false;
      setSaving(false);
    }
  };
  const acceptImmediately = () =>
    context.acceptValue(record, field, value, label, accept);
  const valueText = useRenderedText();
  const proposed =
    renderValue?.(value) ??
    renderSuggestedListFieldValue(context.entity, record, field, value, label);
  // Inert: a reference value renders as a navigating link, which would
  // swallow the click meant to accept it (and nest a link in a button).
  // Inert content leaves the accessibility tree, so the button's name
  // carries the rendered value text instead.
  const ghost = (
    <span
      ref={valueText.ref}
      inert
      className="pointer-events-none inline-flex min-w-0 items-center gap-1"
    >
      {busy ? (
        <Spinner className="size-3 shrink-0" />
      ) : (
        <SparkleIcon aria-hidden className="size-3 shrink-0" />
      )}
      {proposed}
    </span>
  );
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      {compact ? (
        <SuggestionBody
          compact
          current={kind === "correction" ? children : null}
          proposed={proposed}
          probability={probability}
          runnerUp={runnerUp}
          reasoning={reasoning}
          basis={suggestionBasisLabels(context.entity, field)}
          provenance={provenance}
          saving={busy}
          onAccept={() => void run(acceptImmediately)}
          onReject={() => void run(reject)}
          onUseDifferent={() => setEditOpen(true)}
        />
      ) : (
        <>
          {kind === "correction" || !inline ? (
            <>
              {children}
              {inline ? (
                <ArrowRightIcon
                  aria-label="Suggested replacement"
                  className="size-3 shrink-0"
                />
              ) : null}
            </>
          ) : null}
          {inline ? (
            <Pill
              mode="suggestion"
              render={
                <button
                  type="button"
                  disabled={busy}
                  aria-label={suggestionAcceptLabel(valueText.text)}
                  onClick={(event) => {
                    event.stopPropagation();
                    void run(acceptImmediately);
                  }}
                />
              }
              aria-busy={busy}
              className="max-w-full min-w-0 cursor-pointer gap-1 overflow-hidden hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-wait max-md:min-h-11"
            >
              {ghost}
            </Pill>
          ) : null}
          <Popover open={bodyOpen} onOpenChange={setBodyOpen}>
            <PopoverTrigger
              aria-label="Suggestion actions"
              disabled={busy}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
              className="relative inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none after:absolute after:-inset-3 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring md:after:hidden"
            >
              <span aria-hidden>···</span>
            </PopoverTrigger>
            <PopoverContent side="bottom" className="w-auto max-w-xs p-2">
              <SuggestionBody
                current={kind === "correction" ? children : null}
                proposed={proposed}
                probability={probability}
                runnerUp={runnerUp}
                reasoning={reasoning}
                basis={suggestionBasisLabels(context.entity, field)}
                provenance={provenance}
                saving={busy}
                onAccept={() => void run(acceptImmediately)}
                onReject={() => void run(reject)}
                onUseDifferent={() => {
                  setBodyOpen(false);
                  setEditOpen(true);
                }}
              />
            </PopoverContent>
          </Popover>
        </>
      )}
      <DifferentValueDialog
        entity={context.entity}
        record={record}
        field={field}
        open={editOpen}
        onOpenChange={setEditOpen}
        onSubmitted={() => void onCorrected?.()}
        onSubmitOverride={
          correct
            ? async (values) => {
                await correct(z.json().parse(values[field]));
                setEditOpen(false);
              }
            : undefined
        }
      />
    </span>
  );
}

/** Accepts every stored suggestion on the visible records in one batch; each
 * failure names its record and keeps its raw diagnostic. */
export function RecordSuggestionsBulkAction({
  records,
}: {
  records: readonly unknown[];
}) {
  const context = useContext(RecordSuggestionsContext);
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  if (!context) return null;
  const ids = new Set(
    records.map(recordPublicId).filter((id): id is string => id !== null),
  );
  const suggestions = [...context.stored.values()].filter((item) =>
    ids.has(item.recordId),
  );
  if (suggestions.length === 0) return null;
  const recordById = new Map(suggestions.map((item) => [item.id, item]));
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        size="sm"
        disabled={saving}
        onClick={async () => {
          setSaving(true);
          try {
            const results = await context.acceptStoredMany(
              suggestions.map((item) => item.id),
            );
            setErrors(
              results.flatMap((result) =>
                result.ok
                  ? []
                  : [
                      `${recordById.get(result.id)?.recordId ?? result.id}: ${result.error}`,
                    ],
              ),
            );
          } catch (error) {
            showErrorToast(error);
          } finally {
            setSaving(false);
          }
        }}
      >
        {saving ? "Accepting…" : `Accept suggestions (${suggestions.length})`}
      </Button>
      {errors.length ? <span role="alert">{errors.join(" · ")}</span> : null}
    </span>
  );
}

/** Phone summaries truncate ordinary facts; proposals get their own full-width rows. */
export function RecordRowSuggestions({ record }: { record: unknown }) {
  const context = useContext(RecordSuggestionsContext);
  const visit = useSuggestionVisit();
  const parsed = recordSchema.safeParse(record);
  const row = parsed.success ? context?.rows.get(parsed.data.id) : undefined;
  if (!context || !parsed.success) return null;
  const storedFields = [...context.stored.values()]
    .filter((suggestion) => suggestion.recordId === parsed.data.id)
    .map((suggestion) => suggestion.field);
  const fields = [
    ...new Set([...(row?.sourceByField.keys() ?? []), ...storedFields]),
  ].filter((field) => {
    if (context.stored.has(storedSuggestionKey(parsed.data.id, field)))
      return true;
    if (!row) return false;
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
      !visit?.dismissed.has(suggestionReviewKey(question, current, suggestion))
    );
  });
  if (fields.length === 0) return null;
  return (
    <Stack gap="sm">
      {fields.map((field) => {
        const stored = context.stored.get(
          storedSuggestionKey(parsed.data.id, field),
        );
        const current = recordValue(context.entity, parsed.data, field);
        return (
          <Stack key={field} gap="xs">
            <Description size="xs">
              {
                entityFieldModels[context.entity].fields.find(
                  (candidate) => candidate.key === field,
                )?.label
              }
            </Description>
            <RecordFieldSuggestion record={record} field={field}>
              {stored?.kind === "correction"
                ? renderSuggestedListFieldValue(
                    context.entity,
                    parsed.data,
                    field,
                    current.value ?? "—",
                  )
                : null}
            </RecordFieldSuggestion>
          </Stack>
        );
      })}
    </Stack>
  );
}
