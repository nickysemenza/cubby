import type { FieldSuggestion } from "@cubby/schemas/ai";
import type { Entity } from "@cubby/schemas/entity";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
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
import { parseEntityEditUpdateInput } from "~/entities/editing/mutation-data";
import type { EntityMutationPort } from "~/entities/editing/types";
import { useEntityCommands } from "~/entities/editing/use-entity-commands";
import type { StandardEntity } from "~/entities/entity-contracts";
import { readReferenceField } from "~/entities/entity-references";
import { generatedBrowserCrudEntities } from "~/entities/generated/entity-routes.gen";

import {
  fieldSuggestionBasisFromRecord,
  suggestTargetsFor,
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
type SuggestionRecord = z.infer<typeof recordSchema>;
type SuggestionRow = {
  record: SuggestionRecord;
  source: FieldSuggestionSource;
  suggestions: Record<string, FieldSuggestion | null>;
  pending: boolean;
};
const RecordSuggestionsContext = createContext<{
  entity: StandardEntity;
  rows: ReadonlyMap<string, SuggestionRow>;
  save: (id: string, field: string, value: string) => Promise<void>;
} | null>(null);

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

export function RecordSuggestionsProvider({
  entity,
  records,
  fieldKeys,
  children,
  operations,
  mutationPort,
}: {
  entity: Entity | undefined;
  records: readonly unknown[];
  fieldKeys: readonly string[];
  children: ReactNode;
  operations?: EntitySuggestionsOperations;
  mutationPort?: EntityMutationPort;
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
      >
        {children}
      </BoundRecordSuggestions>
    </SuggestionVisitProvider>
  );
}

function BoundRecordSuggestions({
  entity,
  records,
  fieldKeys,
  children,
  operations = productionEntitySuggestionsOperations,
  mutationPort,
}: {
  entity: StandardEntity;
  records: readonly unknown[];
  fieldKeys: readonly string[];
  children: ReactNode;
  operations?: EntitySuggestionsOperations;
  mutationPort?: EntityMutationPort;
}) {
  const visit = useSuggestionVisit();
  const parentScheduler = useContext(SuggestionSchedulerContext);
  const [ownScheduler] = useState(() => createSuggestionScheduler());
  const scheduler = parentScheduler ?? ownScheduler;
  const update = useEntityCommands(entity, { mutationPort });
  const visible = new Set(fieldKeys);
  const fields = entityFieldModels[entity].fields.filter(
    (field) =>
      visible.has(field.key) ||
      (field.reference != null && visible.has(field.key.replace(/Id$/u, ""))) ||
      visible.has(field.display.columnId ?? field.key),
  );
  const updateFields: readonly string[] = entityFieldModels[entity].update;
  const targets = suggestTargetsFor(
    entity,
    fields
      .map((field) => field.key)
      .filter((key) => updateFields.includes(key)),
  );
  const requests = records.flatMap((raw) => {
    const parsed = recordSchema.safeParse(raw);
    if (
      !parsed.success ||
      parseShortcode(parsed.data.id)?.type !== entity ||
      targets.targets.length === 0
    )
      return [];
    const basis = fieldSuggestionBasisFromRecord(entity, targets, parsed.data);
    if (!isBasisSufficient(entity, targets, basis)) return [];
    return [
      {
        record: parsed.data,
        source: {
          entity,
          basisMode: "provided" as const,
          targets: targets.targets.map((target) => target.key).sort(),
          basis,
        },
      },
    ];
  });
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
  const rows = new Map(
    requests.map(({ record, source }) => {
      const query = bySource.get(JSON.stringify(source))!;
      return [
        record.id,
        {
          record,
          source,
          suggestions: query.data?.suggestions ?? {},
          pending: query.isFetching || query.isPending,
        },
      ] as const;
    }),
  );
  const context = {
    entity,
    rows,
    save: async (id: string, field: string, value: string) => {
      await update.submit({
        operation: "update",
        intent: "full",
        id,
        data: parseEntityEditUpdateInput(entity, { [field]: value }),
      });
    },
  };
  let count = 0;
  for (const row of rows.values()) {
    for (const [key, suggestion] of Object.entries(row.suggestions)) {
      const current = recordValue(entity, row.record, key).value;
      const question = JSON.stringify([entity, row.record.id, key, row.source]);
      const dismissed = visit?.dismissed.has(
        JSON.stringify([question, current, suggestion?.value]),
      );
      if (!dismissed && actionableSuggestion(suggestion, current)) count += 1;
    }
  }
  const checking = queries.some((query) => query.isFetching || query.isPending);
  const failures = queries.filter((query) => query.isError).length;
  return (
    <SuggestionSchedulerContext value={scheduler}>
      <RecordSuggestionsContext value={context}>
        {requests.length > 0 ? (
          <Description size="xs" as="output">
            {checking ? "Checking suggestions…" : `${count} suggestions`}
            {failures ? " · Some suggestions unavailable" : ""}
          </Description>
        ) : null}
        {children}
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
  if (!context || !row || !field || !row.source.targets.includes(field))
    return children;
  const current = recordValue(context.entity, row.record, field);
  const suggestion = row.suggestions[field] ?? null;
  const questionKey = JSON.stringify([
    context.entity,
    row.record.id,
    field,
    row.source,
  ]);
  const apply = async () => {
    const latest = snapshot.current.row;
    if (
      !latest ||
      latest.record.id !== row.record.id ||
      snapshot.current.field !== field ||
      JSON.stringify(latest.source) !== JSON.stringify(row.source) ||
      recordValue(context.entity, latest.record, field).value !==
        current.value ||
      latest.suggestions[field]?.value !== suggestion?.value ||
      !suggestion?.value
    )
      throw new Error("Suggestion inputs changed");
    await context.save(row.record.id, field, suggestion.value);
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
  const fields = row.source.targets.filter((field) => {
    const current = recordValue(context.entity, row.record, field).value;
    const suggestion = row.suggestions[field] ?? null;
    const question = JSON.stringify([
      context.entity,
      row.record.id,
      field,
      row.source,
    ]);
    return (
      actionableSuggestion(suggestion, current) &&
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
