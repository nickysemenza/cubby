import type { FieldSuggestion } from "@cubby/schemas/ai";
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
} from "./field-suggestion";
import {
  actionableSuggestion,
  SuggestionReview,
  SuggestionVisitProvider,
  useSuggestionVisit,
} from "./suggestion-review";
import { createSuggestionScheduler } from "./suggestion-scheduler";

const SuggestionSchedulerContext = createContext<ReturnType<
  typeof createSuggestionScheduler
> | null>(null);

const recordSchema = z.looseObject({ id: z.string() });
const mutationPatchSchema = z.record(z.string(), z.json());
const nullableBasisValueSchema = z.string().nullable();
type SuggestionRecord = z.infer<typeof recordSchema>;
type SuggestionRow = {
  record: SuggestionRecord;
  sourceByField: ReadonlyMap<string, FieldSuggestionSource>;
  suggestions: Record<string, FieldSuggestion | null>;
  pending: boolean;
};
const RecordSuggestionsContext = createContext<{
  entity: StandardEntity;
  rows: ReadonlyMap<string, SuggestionRow>;
  save: (
    id: string,
    field: string,
    value: string,
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
    label:
      field.control?.options?.find((option) => option.value === value)?.label ??
      value,
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

function suggestionRequestsForRecord(
  entity: StandardEntity,
  record: SuggestionRecord,
  targets: ReturnType<typeof suggestTargetsFor>,
) {
  const basis = fieldSuggestionBasisFromRecord(entity, targets, record);
  for (const key of suggestionContextKeys(entity, targets)) {
    const parsed = nullableBasisValueSchema.safeParse(record[key]);
    if (parsed.success) basis[key] = parsed.data;
  }
  basis.__resolutionContext = resolutionContext(record);
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
  const suggested = available
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
  const alternatives = available
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

function requestsForRecords(
  entity: StandardEntity,
  records: readonly unknown[],
  fieldKeys: readonly string[],
) {
  const visible = new Set(fieldKeys);
  const updateFields: readonly string[] = entityFieldModels[entity].update;
  const targets = suggestTargetsFor(
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

function SuggestionQueryStatus({
  requested,
  checking,
  count,
  failures,
}: {
  requested: boolean;
  checking: boolean;
  count: number;
  failures: number;
}) {
  if (!requested) return null;
  return (
    <Description size="xs" as="output">
      {checking ? "Checking suggestions…" : `${count} suggestions`}
      {failures > 0 ? " · Some suggestions unavailable" : ""}
    </Description>
  );
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
  const requests = requestsForRecords(entity, records, fieldKeys);
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
      value: string,
      source: FieldSuggestionSource,
      expectedCurrent: string | null,
    ) => {
      // Acceptance reads the entity again without asking Jev twice. Compare
      // the authoritative inheritance fingerprint and every scalar basis key,
      // so a parent/default or line-kind change revokes the old proposal even
      // when the child row timestamp did not move.
      const fresh = await readRecord(entity, id);
      if (!fresh) throw new Error("Suggestion inputs changed");
      const freshRecord = recordSchema.parse(fresh);
      const freshTargets = suggestTargetsFor(entity, source.targets);
      const freshBasis = fieldSuggestionBasisFromRecord(
        entity,
        freshTargets,
        freshRecord,
      );
      for (const key of suggestionContextKeys(entity, freshTargets)) {
        const currentValue = nullableBasisValueSchema.safeParse(
          freshRecord[key],
        );
        if (currentValue.success) freshBasis[key] = currentValue.data;
      }
      freshBasis.__resolutionContext = resolutionContext(freshRecord);
      if (
        basisFingerprint(freshBasis) !== basisFingerprint(source.basis) ||
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
      const patch =
        usesInheritedValue && resolutionPolicy
          ? mutationPatchSchema.parse(resolutionPolicy.reset)
          : explicitSuggestionPatch(entity, field, value);
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
  return (
    <SuggestionSchedulerContext value={scheduler}>
      <RecordSuggestionsContext value={context}>
        <SuggestionQueryStatus
          requested={requests.length > 0}
          checking={checking}
          count={count}
          failures={failures}
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
export function RecordFieldSuggestion({
  record,
  field: column,
  children,
}: {
  record: unknown;
  field: string;
  children: ReactNode;
}) {
  const context = useContext(RecordSuggestionsContext);
  const parsed = recordSchema.safeParse(record);
  const row = parsed.success ? context?.rows.get(parsed.data.id) : undefined;
  const field = context
    ? entityFieldModels[context.entity].fields.find(
        (candidate) =>
          candidate.key === column ||
          candidate.display.columnId === column ||
          (candidate.reference != null &&
            candidate.key.replace(/Id$/u, "") === column),
      )?.key
    : undefined;
  const snapshot = useRef({ row, field });
  snapshot.current = { row, field };
  const source = field ? row?.sourceByField.get(field) : undefined;
  if (!context || !row || !field || !source) return children;
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
    const latest = snapshot.current.row;
    if (
      !latest ||
      latest.record.id !== row.record.id ||
      snapshot.current.field !== field ||
      JSON.stringify(latest.sourceByField.get(field)) !==
        JSON.stringify(source) ||
      recordValue(context.entity, latest.record, field).value !==
        current.value ||
      latest.suggestions[field]?.value !== suggestion?.value ||
      !suggestion?.value
    )
      throw new Error("Suggestion inputs changed");
    await context.save(
      row.record.id,
      field,
      suggestion.value,
      source,
      current.value,
    );
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
      >
        {children}
      </SuggestionReview>
    </RecordSuggestionScope>
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
