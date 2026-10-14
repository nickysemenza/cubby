import {
  formatConfidence,
  suggestionReviewListInput,
  suggestionStatus,
  type SuggestionReviewRow,
} from "@cubby/schemas/ai";
import type { AssessmentReviewBatchOut } from "@cubby/schemas/assessment";
import { auditEntitySchema } from "@cubby/schemas/audit";
import { entityFieldByKey } from "@cubby/schemas/entity-fields";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import { entitySummary } from "@cubby/schemas/entity-summary";
import { humanize, parseShortcode } from "@cubby/shared";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState, type ReactNode } from "react";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { enumFieldLabel } from "~/entity/enum-field-display";
import { entityRipple } from "~/integrations/tanstack-query/cache-tags";
import {
  ai,
  assessment,
} from "~/integrations/tanstack-query/generated/catalog.gen";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
import { formatCount } from "~/lib/utils";
import { Picker } from "~/ui/combobox/picker";
import type { PickerOption } from "~/ui/combobox/picker-option";
import { DateDisplay } from "~/ui/common/date-display";
import type { BulkActionsConfig } from "~/ui/data-table/bulk-actions.types";
import { BulkActionBar } from "~/ui/data-table/BulkActionBar";
import { useTableColumnLayout } from "~/ui/data-table/column-layout";
import { buildSelectColumn } from "~/ui/data-table/row-selection";
import RTable from "~/ui/data-table/Table";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  useCubbyTable,
} from "~/ui/data-table/table-features";
import { attachCubbyColumnMeta } from "~/ui/data-table/table-meta";
import { useBulkActions } from "~/ui/data-table/useBulkActions";
import { Row, Stack } from "~/ui/layout";
import { Input } from "~/ui/primitives/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/ui/primitives/popover";

import { SuggestionBody, suggestionBasisLabels } from "./suggestion-body";
import {
  suggestionReviewFiltersSchema,
  type SuggestionReviewFilters,
} from "./suggestion-review-filters";

type Outcome = AssessmentReviewBatchOut[number];
type ReviewState = {
  key: string;
  generation: number;
  outcomes: ReadonlyMap<string, Outcome>;
  failedRows: ReadonlyMap<string, SuggestionReviewRow>;
};
const emptyReview = (key: string, generation: number): ReviewState => ({
  key,
  generation,
  outcomes: new Map(),
  failedRows: new Map(),
});
const helper = createCubbyColumnHelper<SuggestionReviewRow>();
const MIN_CONFIDENCE_DEFAULT = 0.5;
const KIND_OPTIONS = ["correction", "addition"] as const;

const KIND_PICKER_OPTIONS: readonly PickerOption[] = [
  { value: "", label: "Any kind" },
  ...KIND_OPTIONS.map((kind) => ({ value: kind, label: humanize(kind) })),
];

const STATUS_PICKER_OPTIONS: readonly PickerOption[] =
  suggestionStatus.options.map((status) => ({
    value: status,
    label: humanize(status),
  }));

const fieldLabel = (entity: ShortcodeEntity, field: string) =>
  entityFieldByKey(entity, field)?.label ?? field;

/** A named link to the record a shortcode identifies. */
function RecordRef({ entity, id }: { entity: string; id: string }) {
  const kind = auditEntitySchema.safeParse(entity);
  return kind.success ? (
    <EntityRefLink
      variant="byId"
      entityKind={kind.data}
      entityId={id}
      compact
    />
  ) : (
    <span className="font-mono">{id}</span>
  );
}

/** A stored value as its field shows it: a record link for a shortcode, the
 * manifest label for an enum member, the text otherwise. */
function SuggestionValue({
  entity,
  field,
  value,
}: {
  entity: ShortcodeEntity;
  field: string;
  value: SuggestionReviewRow["suggestedValue"] | null;
}): ReactNode {
  if (value === null || value === "") return <span>—</span>;
  if (typeof value === "string") {
    const shortcode = parseShortcode(value);
    if (shortcode) return <RecordRef entity={shortcode.type} id={value} />;
    return <span>{enumFieldLabel(entity, field, value) ?? value}</span>;
  }
  return <span className="font-mono">{JSON.stringify(value)}</span>;
}

function OutcomeCell({ outcome }: { outcome: Outcome | undefined }) {
  if (!outcome) return null;
  return outcome.ok ? (
    <span className="text-xs text-muted-foreground">
      {outcome.status === "applied" ? "Accepted" : "Rejected"}
    </span>
  ) : (
    <span role="alert" className="text-xs text-destructive">
      {outcome.error}
    </span>
  );
}

function RowReview({
  row,
  onSettle,
}: {
  row: SuggestionReviewRow;
  onSettle: (action: "accept" | "reject", ids: string[]) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const settle = async (action: "accept" | "reject") => {
    setSaving(true);
    try {
      await onSettle(action, [row.id]);
      setOpen(false);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={`Review suggestion for ${row.recordId}`}
        onClick={(event) => event.stopPropagation()}
        className="relative inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground outline-none after:absolute after:-inset-3 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring md:after:hidden"
      >
        <span aria-hidden>···</span>
      </PopoverTrigger>
      <PopoverContent side="bottom" className="w-auto max-w-xs p-2">
        <SuggestionBody
          current={
            row.kind === "correction" ? (
              <SuggestionValue
                entity={row.entity}
                field={row.field}
                value={row.currentValue}
              />
            ) : null
          }
          proposed={
            <SuggestionValue
              entity={row.entity}
              field={row.field}
              value={row.suggestedValue}
            />
          }
          probability={row.confidence}
          runnerUp={
            row.runnerUpValue === null
              ? null
              : {
                  label: (
                    <SuggestionValue
                      entity={row.entity}
                      field={row.field}
                      value={row.runnerUpValue}
                    />
                  ),
                  probability: row.runnerUpConfidence,
                }
          }
          basis={suggestionBasisLabels(row.entity, row.field)}
          provenance={{
            model: row.model,
            runId: row.runId,
            at: row.createdAt,
          }}
          saving={saving}
          disabled={row.status !== "pending"}
          onAccept={() => void settle("accept")}
          onReject={() => void settle("reject")}
        />
      </PopoverContent>
    </Popover>
  );
}

function reviewColumns(
  outcomes: ReadonlyMap<string, Outcome>,
  listed: ReadonlySet<string>,
  onSettle: (action: "accept" | "reject", ids: string[]) => Promise<void>,
) {
  return createCubbyColumnCollection<SuggestionReviewRow>((add) => {
    add(buildSelectColumn<SuggestionReviewRow>());
    add(
      helper.accessor((row) => row.recordId, {
        id: "record",
        header: "Record",
        size: 220,
        enableSorting: false,
        meta: attachCubbyColumnMeta<SuggestionReviewRow>({
          entityColumnRole: "identity",
          mobile: { slot: "title" },
        }),
        cell: ({ row }) => (
          <RecordRef entity={row.original.entity} id={row.original.recordId} />
        ),
      }),
    );
    add(
      helper.accessor((row) => fieldLabel(row.entity, row.field), {
        id: "field",
        header: "Field",
        size: 140,
        enableSorting: false,
        meta: attachCubbyColumnMeta<SuggestionReviewRow>({
          mobile: { slot: "meta", priority: 0, label: "Field" },
        }),
        cell: ({ row }) =>
          `${entitySummary[row.original.entity].singular} · ${fieldLabel(row.original.entity, row.original.field)}`,
      }),
    );
    add(
      helper.accessor((row) => JSON.stringify(row.currentValue), {
        id: "current",
        header: "Current",
        size: 160,
        enableSorting: false,
        meta: attachCubbyColumnMeta<SuggestionReviewRow>({
          mobile: { slot: "meta", priority: 3, label: "Current" },
        }),
        cell: ({ row }) => (
          <SuggestionValue
            entity={row.original.entity}
            field={row.original.field}
            value={row.original.currentValue}
          />
        ),
      }),
    );
    add(
      helper.accessor((row) => JSON.stringify(row.suggestedValue), {
        id: "suggested",
        header: "Suggested",
        size: 180,
        enableSorting: false,
        meta: attachCubbyColumnMeta<SuggestionReviewRow>({
          mobile: { slot: "subtitle", priority: 0, label: "Suggested" },
        }),
        cell: ({ row }) => (
          <span className="text-primary">
            <SuggestionValue
              entity={row.original.entity}
              field={row.original.field}
              value={row.original.suggestedValue}
            />
          </span>
        ),
      }),
    );
    add(
      helper.accessor((row) => row.confidence, {
        id: "confidence",
        header: "Confidence",
        size: 104,
        enableSorting: false,
        meta: attachCubbyColumnMeta<SuggestionReviewRow>({
          mobile: { slot: "meta", priority: 1, label: "Confidence" },
        }),
        cell: ({ row }) => (
          <span className="tabular-nums">
            {formatConfidence(row.original.confidence)}
          </span>
        ),
      }),
    );
    add(
      helper.accessor((row) => row.runnerUpConfidence, {
        id: "runnerUp",
        header: "Runner-up",
        size: 160,
        enableSorting: false,
        meta: attachCubbyColumnMeta<SuggestionReviewRow>({
          mobile: { slot: "meta", priority: 4, label: "Runner-up" },
        }),
        cell: ({ row }) =>
          row.original.runnerUpValue === null ? null : (
            <span className="inline-flex min-w-0 gap-1">
              <SuggestionValue
                entity={row.original.entity}
                field={row.original.field}
                value={row.original.runnerUpValue}
              />
              {row.original.runnerUpConfidence !== null ? (
                <span className="text-muted-foreground tabular-nums">
                  {formatConfidence(row.original.runnerUpConfidence)}
                </span>
              ) : null}
            </span>
          ),
      }),
    );
    add(
      helper.accessor((row) => row.kind, {
        id: "kind",
        header: "Kind",
        size: 96,
        enableSorting: false,
        meta: attachCubbyColumnMeta<SuggestionReviewRow>({
          mobile: { slot: "meta", priority: 5, label: "Kind" },
        }),
        cell: ({ row }) => humanize(row.original.kind),
      }),
    );
    add(
      helper.accessor((row) => row.status, {
        id: "status",
        header: "Status",
        size: 96,
        enableSorting: false,
        meta: attachCubbyColumnMeta<SuggestionReviewRow>({
          mobile: { slot: "meta", priority: 2, label: "Status" },
        }),
        cell: ({ row }) => humanize(row.original.status),
      }),
    );
    add(
      helper.accessor((row) => row.createdAt, {
        id: "provenance",
        header: "Model · Run",
        size: 200,
        enableSorting: false,
        meta: attachCubbyColumnMeta<SuggestionReviewRow>({
          mobile: { slot: "meta", priority: 6, label: "Model" },
        }),
        cell: ({ row }) => (
          <span className="truncate text-muted-foreground">
            {row.original.model} · {row.original.runId} ·{" "}
            <DateDisplay timestamp={row.original.createdAt} />
          </span>
        ),
      }),
    );
    add(
      helper.accessor((row) => row.id, {
        id: "result",
        header: "Result",
        size: 200,
        enableSorting: false,
        meta: attachCubbyColumnMeta<SuggestionReviewRow>({
          mobile: { slot: "subtitle", priority: 1, label: "Result" },
        }),
        cell: ({ row }) => (
          <Row gap="xs" align="center">
            {listed.has(row.original.id) ? (
              <RowReview row={row.original} onSettle={onSettle} />
            ) : null}
            <OutcomeCell outcome={outcomes.get(row.original.id)} />
          </Row>
        ),
      }),
    );
  });
}

function ReviewFilters({
  filters,
  onChange,
  entities,
}: {
  filters: SuggestionReviewFilters;
  onChange: (patch: Partial<SuggestionReviewFilters>) => void;
  entities: readonly ShortcodeEntity[];
}) {
  const entityOptions = useMemo<PickerOption[]>(
    () => [
      { value: "", label: "All entities" },
      ...entities.map((entity) => ({
        value: entity,
        label: entitySummary[entity].singular,
      })),
    ],
    [entities],
  );
  return (
    <Row gap="sm" wrap align="center">
      <Picker
        label="Entity"
        className="w-40"
        options={entityOptions}
        value={filters.entity ?? ""}
        onValueChange={(value) =>
          onChange({
            entity: suggestionReviewFiltersSchema.shape.entity.parse(
              value || undefined,
            ),
            field: undefined,
          })
        }
      />
      <Input
        aria-label="Field"
        placeholder="Field"
        className="w-36"
        value={filters.field ?? ""}
        onChange={(event) =>
          onChange({ field: event.target.value || undefined })
        }
      />
      <Picker
        mode="choose"
        label="Status"
        className="w-36"
        options={STATUS_PICKER_OPTIONS}
        value={filters.status ?? "pending"}
        onValueChange={(value) => {
          if (value != null)
            onChange({ status: suggestionStatus.parse(value) });
        }}
      />
      <Picker
        mode="choose"
        label="Kind"
        className="w-36"
        options={KIND_PICKER_OPTIONS}
        value={filters.kind ?? ""}
        onValueChange={(value) =>
          onChange({
            kind: suggestionReviewFiltersSchema.shape.kind.parse(
              value || undefined,
            ),
          })
        }
      />
      <label
        htmlFor="suggestion-review-min-confidence"
        className="inline-flex items-center gap-1 text-xs text-muted-foreground"
      >
        Min confidence
        <Input
          id="suggestion-review-min-confidence"
          aria-label="Minimum confidence"
          type="number"
          min={0}
          max={100}
          step={5}
          className="w-16"
          value={Math.round(
            (filters.minConfidence ?? MIN_CONFIDENCE_DEFAULT) * 100,
          )}
          onChange={(event) => {
            const percent = Number(event.target.value);
            if (Number.isFinite(percent))
              onChange({
                minConfidence: Math.min(1, Math.max(0, percent / 100)),
              });
          }}
        />
        %
      </label>
      {filters.runId ? (
        <button
          type="button"
          className="text-xs text-muted-foreground underline-offset-2 hover:underline"
          onClick={() => onChange({ runId: undefined })}
        >
          Run {filters.runId} ×
        </button>
      ) : null}
    </Row>
  );
}

/**
 * The Review tab: stored Suggestions on the shared table, filtered from the
 * URL, settled one at a time from each row's body or in bulk through
 * `assessment.reviewBatch`, whose per-id results stay
 * beside their rows.
 */
export function SuggestionReviewList({
  filters,
  onFiltersChange,
}: {
  filters: SuggestionReviewFilters;
  onFiltersChange: (patch: Partial<SuggestionReviewFilters>) => void;
}) {
  const queryClient = useQueryClient();
  const input = suggestionReviewListInput.parse({
    ...filters,
    minConfidence: filters.minConfidence ?? MIN_CONFIDENCE_DEFAULT,
  });
  const list = useQuery(ai.listSuggestionReviewQueue.queryOptions(input));
  const counts = useQuery(ai.suggestionCounts.queryOptions({}));
  // Outcomes and failed rows belong to one visit of a filtered query. Every
  // filter change (back/forward included, and a return to earlier filters)
  // starts a new generation with nothing shown, and a settlement commits only
  // into the generation it started in; refetching the same query keeps it.
  const reviewKey = JSON.stringify(input);
  const [review, setReview] = useState<ReviewState>(() =>
    emptyReview(reviewKey, 0),
  );
  if (review.key !== reviewKey)
    setReview(emptyReview(reviewKey, review.generation + 1));
  const { outcomes, failedRows } = useMemo(
    () =>
      review.key === reviewKey
        ? review
        : emptyReview(reviewKey, review.generation + 1),
    [review, reviewKey],
  );
  const settle = async (action: "accept" | "reject", ids: string[]) => {
    const generation = review.generation;
    const shown = list.data ?? [];
    const idsByAssessment = new Map(
      shown.map((row) => [row.id, row.assessmentId]),
    );
    const results = await assessment.reviewBatch.call({
      items: ids.map((id) => ({
        assessmentId: idsByAssessment.get(id)!,
        operationId: crypto.randomUUID(),
        verdict: action === "accept" ? "correct" : "wrong",
        correction: { present: false },
        intent: action === "accept" ? "apply" : "history",
        reason: null,
        evidence: null,
      })),
    });
    const failed = new Set(
      results
        .filter((result) => !result.ok)
        .map((result) => {
          return [...idsByAssessment].find(
            ([, assessmentId]) => assessmentId === result.assessmentId,
          )?.[0];
        }),
    );
    setReview((previous) =>
      previous.generation !== generation
        ? previous
        : {
            ...previous,
            outcomes: new Map([
              ...previous.outcomes,
              ...results.map(
                (result) =>
                  [
                    [...idsByAssessment].find(
                      ([, assessmentId]) =>
                        assessmentId === result.assessmentId,
                    )?.[0] ?? "",
                    result,
                  ] as const,
              ),
            ]),
            // Failed rows as they were when settled: accepting one selected
            // row can supersede another, which then fails and leaves the
            // refetch.
            failedRows: new Map([
              ...[...previous.failedRows].filter(([id]) => !ids.includes(id)),
              ...shown
                .filter((row) => failed.has(row.id))
                .map((row) => [row.id, row] as const),
            ]),
          },
    );
    const touched = new Set<ShortcodeEntity>(
      shown.filter((row) => ids.includes(row.id)).map((row) => row.entity),
    );
    await Promise.all([
      list.refetch(),
      counts.refetch(),
      ...[...touched].map((entity) =>
        invalidateOperationTags(queryClient, entityRipple(entity)),
      ),
    ]);
    return results;
  };
  // Settled rows leave the pending list on refetch. A failed row stays beside
  // its Result even when the refetch dropped it; only a listed row reselects.
  const listed = useMemo(
    () => new Set((list.data ?? []).map((row) => row.id)),
    [list.data],
  );
  const rows = useMemo(
    () => [
      ...(list.data ?? []),
      ...[...failedRows.values()].filter((row) => !listed.has(row.id)),
    ],
    [list.data, failedRows, listed],
  );
  const settleRef = useRef(settle);
  settleRef.current = settle;
  const columns = useMemo(
    () =>
      reviewColumns(outcomes, listed, async (action, ids) => {
        await settleRef.current(action, ids);
      }),
    [outcomes, listed],
  );
  const bulk: BulkActionsConfig<SuggestionReviewRow> = {
    actions: (["accept", "reject"] as const).map((action) => ({
      id: action,
      label: action === "accept" ? "Accept" : "Reject",
      icon: action === "accept" ? <CheckIcon /> : <XIcon />,
      tone: action === "reject" ? "destructive" : undefined,
      availability: (selected) =>
        selected.every(
          (row) =>
            row.original.status === "pending" && listed.has(row.original.id),
        )
          ? { status: "available" }
          : { status: "disabled", reason: "Only pending suggestions settle." },
      onExecute: async (selected) => {
        const results = await settle(
          action,
          selected.map((row) => row.original.id),
        );
        return { success: results.every((result) => result.ok) };
      },
    })),
  };
  const selection = useBulkActions({ config: bulk });
  const listedSelection = Object.fromEntries(
    Object.entries(selection.rowSelection).filter(([id]) => listed.has(id)),
  );
  const { columns: tableColumns, defaultLayout } = useTableColumnLayout({
    columns,
  });
  const table = useCubbyTable({
    data: rows,
    columns: tableColumns,
    meta: { defaultLayout },
    getRowId: (row) => row.id,
    enableSorting: false,
    enableFilters: false,
    enableRowSelection: (row) =>
      row.original.status === "pending" && listed.has(row.original.id),
    // A row the refetch dropped leaves the selection with it.
    state: { rowSelection: listedSelection },
    onRowSelectionChange: selection.onRowSelectionChange,
    initialState: {
      columnOrder: defaultLayout.columnOrder,
      columnPinning: defaultLayout.columnPinning,
      columnVisibility: defaultLayout.columnVisibility,
    },
  });
  const entities = useMemo(
    () => [...new Set((counts.data ?? []).map((row) => row.entity))],
    [counts.data],
  );
  const failures = [...outcomes.values()].filter((outcome) => !outcome.ok);
  const selectedRows = table.getSelectedRowModel().rows;
  return (
    <Stack gap="sm">
      <ReviewFilters
        filters={filters}
        entities={entities}
        onChange={(patch) => {
          selection.clearSelection();
          onFiltersChange(patch);
        }}
      />
      <p
        className="text-xs text-muted-foreground tabular-nums"
        aria-live="polite"
      >
        {list.data ? `${formatCount(rows.length)} suggestions` : "Loading…"}
        {failures.length > 0
          ? ` · ${formatCount(failures.length)} could not be settled — see Result`
          : ""}
      </p>
      <RTable
        table={table}
        ariaLabel="Suggestions"
        isLoading={list.isLoading}
        error={list.error}
        embedded
        bulkActionBar={
          <BulkActionBar
            selectedCount={selectedRows.length}
            selectedRows={selectedRows}
            actions={selection.getAvailableActions(selectedRows)}
            onExecute={selection.executeAction}
            onClearSelection={selection.clearSelection}
            isExecuting={selection.isExecuting}
            currentAction={selection.currentAction}
          />
        }
        emptyState="No suggestions match these filters."
      />
    </Stack>
  );
}
