import type {
  FieldSuggestion,
  FieldSuggestionOutcome,
  SuggestionReviewRow,
} from "@cubby/schemas/ai";
import type { Entity } from "@cubby/schemas/entity";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import { fieldResolutionsSchema } from "@cubby/schemas/field-resolution";
import { parseShortcode } from "@cubby/shared";
import { ArrowRightIcon } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { SparkleIcon } from "@phosphor-icons/react/dist/csr/Sparkle";
import {
  useMutation,
  useQueries,
  useQueryClient,
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
import { useHydrated } from "~/ui/hooks/useHydrated";
import { Stack } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import { Description } from "~/ui/primitives/description";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";

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
  pending: boolean;
  error: unknown;
};
/** Folds one request group's query into its record's row. A record can be
 * asked in several groups (suggested/provided/prune), one query each. */
function mergeSuggestionRow(
  previous: SuggestionRow | undefined,
  record: SuggestionRecord,
  source: FieldSuggestionSource,
  query: {
    data?: {
      suggestions: Record<string, FieldSuggestion | null>;
      outcomes?: Record<string, FieldSuggestionOutcome>;
    };
    isFetching: boolean;
    isPending: boolean;
    error: unknown;
  },
): SuggestionRow {
  const sourceByField = new Map(previous?.sourceByField);
  for (const field of source.targets) sourceByField.set(field, source);
  return {
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
    error: previous?.error ?? query.error,
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
  acceptStored: (id: string) => Promise<void>;
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
  reject: (input: {
    id: string;
    correctValue?: JsonValue;
  }) => Promise<{ id: string; status: "applied" | "rejected" }>;
}

const productionStoredSuggestionOperations: StoredSuggestionOperations = {
  list: (input) => ai.listSuggestionReviewQueue.call(input),
  accept: (input) => ai.acceptSuggestion.call(input),
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
  runKey: string,
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
              entityId: financeSuggestionEntityId(entity, record),
              basisMode: "suggested" as const,
              targets: suggested,
              basis,
              runKey,
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
              entityId: financeSuggestionEntityId(entity, record),
              basisMode: "provided" as const,
              targets: alternatives,
              basis,
              runKey,
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
              entityId: financeSuggestionEntityId(entity, record),
              basisMode: "provided" as const,
              targets: pruneTargets,
              basis,
              runKey,
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

function liveRequestsAfterStoredRead(
  hydrated: boolean,
  recordIds: readonly string[],
  fields: readonly string[],
  storedReadSucceeded: boolean,
  entity: StandardEntity,
  records: readonly unknown[],
  targets: SuggestTargets,
  runKey: string,
  stored: ReadonlyMap<string, SuggestionReviewRow>,
) {
  if (
    hydrated &&
    recordIds.length > 0 &&
    fields.length > 0 &&
    !storedReadSucceeded
  )
    return [];
  return requestsForRecords(entity, records, targets, runKey, stored);
}

function storedSuggestionIndex(
  rows: readonly SuggestionReviewRow[] | undefined,
) {
  return new Map(
    (rows ?? []).map((suggestion) => [
      storedSuggestionKey(suggestion.recordId, suggestion.field),
      suggestion,
    ]),
  );
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
  // second pool. Each in-flight row pins a Neon backend and an AI Gateway call:
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
  const storedQueryOptions: UseQueryOptions<SuggestionReviewRow[]>[] = [];
  if (hydrated && pageRecordIds.length > 0 && pageFields.length > 0) {
    storedQueryOptions.push({
      queryKey: storedQueryKey,
      queryFn: () =>
        storedSuggestionOperations.list({
          entity,
          recordIds: pageRecordIds,
          fields: pageFields,
        }),
      retry: false,
      meta: { cacheTags: [[entity]] },
    });
  }
  const storedQueryResults = useQueries({ queries: storedQueryOptions });
  const storedQuery = storedQueryResults[0];
  const queryClient = useQueryClient();
  const afterStoredReview = async (id: string) => {
    queryClient.setQueryData<SuggestionReviewRow[]>(
      storedQueryKey,
      (previous = []) => previous.filter((item) => item.id !== id),
    );
    await Promise.all([
      invalidateOperationTags(
        queryClient,
        ai.acceptSuggestion.invalidates({ id }),
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
  const stored = storedSuggestionIndex(storedQuery?.data);
  const requests = liveRequestsAfterStoredRead(
    hydrated,
    pageRecordIds,
    pageFields,
    storedQuery?.isSuccess === true,
    entity,
    records,
    targets,
    runKey,
    stored,
  );
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
    acceptStored: async (id: string) => {
      await acceptStoredMutation.mutateAsync({ id });
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
          await Promise.all(queries.map((query) => query.refetch()));
          throw error;
        }
        return;
      }
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
  // Before hydration no query exists yet, but checking is about to start;
  // saying so keeps the status line (and the table below it) where it lands.
  const checking =
    (!hydrated && allRecords.length > 0 && targets.targets.length > 0) ||
    queries.some((query) => query.isFetching || query.isPending);
  const failures = queries.filter((query) => query.isError).length;
  // The client never asked at all — every requestable target's basis fell
  // short of `isBasisSufficient`, not that Jev declined once asked. Name the
  // first basis field that would unblock a request, e.g. "name".
  const unasked =
    requests.length === 0 && records.length > 0 && targets.targets.length > 0
      ? firstBasisFieldLabel(entity, targets)
      : null;
  const status = (
    <SuggestionStatus
      checking={checking}
      failures={failures}
      count={count}
      fields={statusFieldsForRows(entity, rows)}
      unasked={unasked}
    />
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
  if (surface === "cell" && !row.error) {
    // Prune proposals keep the popover review: removing chips has no pill.
    if (
      suggestion?.operation !== "remove" &&
      actionableSuggestion(
        suggestion,
        current.value,
        source.basisMode === "provided",
      ) &&
      suggestion.probability !== null
    )
      return (
        <RecordSuggestionScope value={row}>
          <LiveSuggestionCell
            context={context}
            record={row.record}
            field={field}
            suggestion={{ ...suggestion, probability: suggestion.probability }}
            currentValue={current.value}
            questionKey={questionKey}
            pending={row.pending}
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
        pending={row.pending}
        error={row.error}
        onApply={apply}
        onDismiss={dismiss}
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
  children,
}: {
  context: RecordSuggestionsCtx;
  record: SuggestionRecord;
  field: string;
  suggestion: SuggestionReviewRow;
  renderValue?: (value: JsonValue) => ReactNode;
  children: ReactNode;
}) {
  return (
    <GhostSuggestionCell
      context={context}
      record={record}
      field={field}
      kind={suggestion.kind}
      value={suggestion.suggestedValue}
      confidence={suggestion.confidence}
      renderValue={renderValue}
      accept={() => context.acceptStored(suggestion.id)}
      reject={() => context.rejectStored(suggestion.id)}
      correct={(value) => context.rejectStored(suggestion.id, value)}
    >
      {children}
    </GhostSuggestionCell>
  );
}

/** A live answer in a table cell reads like a stored one — a ghost pill, not
 * a hover-only glyph — and a cell with nothing confident to offer shows only
 * its value. */
function LiveSuggestionCell({
  context,
  record,
  field,
  suggestion,
  currentValue,
  questionKey,
  pending,
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
  return (
    <GhostSuggestionCell
      context={context}
      record={record}
      field={field}
      kind={currentValue?.trim() ? "correction" : "addition"}
      value={suggestion.value}
      confidence={suggestion.probability}
      accept={actions.apply}
      reject={actions.dismiss}
      onCorrected={actions.dismiss}
    >
      {children}
    </GhostSuggestionCell>
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

function GhostSuggestionCell({
  context,
  record,
  field,
  kind,
  value,
  confidence,
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
  confidence: number;
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
  const valueText = useRenderedText();
  // Inert: a reference value renders as a navigating link, which would
  // swallow the click meant to accept it (and nest a link in a button).
  // Inert content leaves the accessibility tree, so the button's name
  // carries the rendered value text instead.
  const ghost = (
    <span
      ref={valueText.ref}
      inert
      className="pointer-events-none inline-flex min-w-0 items-center gap-1 rounded-sm border border-dashed border-muted-foreground/50 px-1 opacity-65"
    >
      <SparkleIcon aria-hidden className="size-3 shrink-0" />
      {renderValue?.(value) ??
        renderSuggestedListFieldValue(context.entity, record, field, value)}
    </span>
  );
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      {kind === "correction" ? (
        <>
          {children}
          <ArrowRightIcon
            aria-label="Suggested replacement"
            className="size-3 shrink-0"
          />
        </>
      ) : null}
      <span title={`${Math.floor(confidence * 100)}% confidence`}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 max-w-full min-w-0 px-1"
          aria-label={
            valueText.text
              ? `Accept suggested value: ${valueText.text}`
              : "Accept suggested value"
          }
          onClick={(event) => {
            event.stopPropagation();
            void accept();
          }}
        >
          {ghost}
        </Button>
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-6"
              aria-label="Suggestion actions"
            />
          }
        >
          <span aria-hidden>···</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => void accept()}>
            Accept
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => void reject()}>
            Reject (Miss)
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setEditOpen(true)}>
            Use a different value
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <EntityEditDialog<EditableEntity>
        open={editOpen}
        onOpenChange={setEditOpen}
        request={
          // SAFETY: BoundRecordSuggestions only mounts for generated CRUD
          // entities, and detailEditRequest builds that entity's update:full request.
          detailEditRequest(
            context.entity,
            record as never,
            field,
          ) as EntityEditDialogRequest<EditableEntity>
        }
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

export function RecordSuggestionsBulkAction({
  records,
}: {
  records: readonly unknown[];
}) {
  const context = useContext(RecordSuggestionsContext);
  const [errors, setErrors] = useState<string[]>([]);
  if (!context) return null;
  const ids = new Set(
    records.map(recordPublicId).filter((id): id is string => id !== null),
  );
  const suggestions = [...context.stored.values()].filter((item) =>
    ids.has(item.recordId),
  );
  if (suggestions.length === 0) return null;
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        size="sm"
        onClick={async () => {
          const failures: string[] = [];
          for (const item of suggestions) {
            try {
              await context.acceptStored(item.id);
            } catch (error) {
              failures.push(`${item.recordId}: ${String(error)}`);
            }
          }
          setErrors(failures);
        }}
      >
        Accept suggestions ({suggestions.length})
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
