import {
  formatConfidence,
  suggestionReviewListInput,
  suggestionStatus,
  type SuggestionReviewBatchOut,
  type SuggestionReviewRow,
} from "@cubby/schemas/ai";
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
import { ai } from "~/integrations/tanstack-query/generated/catalog.gen";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
import { formatCount } from "~/lib/utils";
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
import { formatCompactRelative } from "~/ui/HoverableTimestamp";
import { Row, Stack } from "~/ui/layout";
import { Input } from "~/ui/primitives/input";
import { NativeSelect } from "~/ui/primitives/native-select";
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

type Outcome = SuggestionReviewBatchOut[number];
const helper = createCubbyColumnHelper<SuggestionReviewRow>();
const MIN_CONFIDENCE_DEFAULT = 0.5;
const KIND_OPTIONS = ["correction", "addition"] as const;

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
export function SuggestionValue({
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
            {formatCompactRelative(new Date(row.original.createdAt))}
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
            <RowReview row={row.original} onSettle={onSettle} />
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
  return (
    <Row gap="sm" wrap align="center">
      <NativeSelect
        aria-label="Entity"
        value={filters.entity ?? ""}
        onChange={(event) =>
          onChange({
            entity: suggestionReviewFiltersSchema.shape.entity.parse(
              event.target.value || undefined,
            ),
            field: undefined,
          })
        }
      >
        <option value="">All entities</option>
        {entities.map((entity) => (
          <option key={entity} value={entity}>
            {entitySummary[entity].singular}
          </option>
        ))}
      </NativeSelect>
      <Input
        aria-label="Field"
        placeholder="Field"
        className="w-36"
        value={filters.field ?? ""}
        onChange={(event) =>
          onChange({ field: event.target.value || undefined })
        }
      />
      <NativeSelect
        aria-label="Status"
        value={filters.status ?? "pending"}
        onChange={(event) =>
          onChange({ status: suggestionStatus.parse(event.target.value) })
        }
      >
        {suggestionStatus.options.map((status) => (
          <option key={status} value={status}>
            {humanize(status)}
          </option>
        ))}
      </NativeSelect>
      <NativeSelect
        aria-label="Kind"
        value={filters.kind ?? ""}
        onChange={(event) =>
          onChange({
            kind: suggestionReviewFiltersSchema.shape.kind.parse(
              event.target.value || undefined,
            ),
          })
        }
      >
        <option value="">Any kind</option>
        {KIND_OPTIONS.map((kind) => (
          <option key={kind} value={kind}>
            {humanize(kind)}
          </option>
        ))}
      </NativeSelect>
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
 * `ai.acceptSuggestions` / `ai.rejectSuggestions`, whose per-id results stay
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
  const [outcomes, setOutcomes] = useState<ReadonlyMap<string, Outcome>>(
    new Map(),
  );
  const settle = async (action: "accept" | "reject", ids: string[]) => {
    const results =
      action === "accept"
        ? await ai.acceptSuggestions.call({ ids })
        : await ai.rejectSuggestions.call({ ids });
    setOutcomes(
      (previous) =>
        new Map([
          ...previous,
          ...results.map((result) => [result.id, result] as const),
        ]),
    );
    const touched = new Set<ShortcodeEntity>(
      (list.data ?? [])
        .filter((row) => ids.includes(row.id))
        .map((row) => row.entity),
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
  // Settled rows leave the pending list on refetch; a failed id stays pending,
  // so its error is read beside its row in Result.
  const rows = useMemo(() => list.data ?? [], [list.data]);
  const settleRef = useRef(settle);
  settleRef.current = settle;
  const columns = useMemo(
    () =>
      reviewColumns(outcomes, async (action, ids) => {
        await settleRef.current(action, ids);
      }),
    [outcomes],
  );
  const bulk: BulkActionsConfig<SuggestionReviewRow> = {
    actions: (["accept", "reject"] as const).map((action) => ({
      id: action,
      label: action === "accept" ? "Accept" : "Reject",
      icon: action === "accept" ? <CheckIcon /> : <XIcon />,
      tone: action === "reject" ? "destructive" : undefined,
      availability: (selected) =>
        selected.every((row) => row.original.status === "pending")
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
    enableRowSelection: (row) => row.original.status === "pending",
    state: { rowSelection: selection.rowSelection },
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
          setOutcomes(new Map());
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
            selectedCount={selection.selectedCount}
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
