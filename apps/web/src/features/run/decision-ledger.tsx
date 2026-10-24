import type { RunOut } from "@cubby/schemas/run";
import type { SuggestionListRow } from "@cubby/schemas/suggestion-list";
import { useQuery } from "@tanstack/react-query";
import {
  functionalUpdate,
  type ColumnFiltersState,
  type RowSelectionState,
} from "@tanstack/react-table";
import { useMemo, useState } from "react";

import type { RunDecision } from "~/contracts/run-detail.contract";
import { SuggestionActions } from "~/entity/suggestions/queue/suggestion-actions";
import { SuggestionEvidence } from "~/entity/suggestions/queue/suggestion-evidence";
import { acceptItem } from "~/entity/suggestions/queue/suggestion-review";
import { useSuggestionReview } from "~/entity/suggestions/queue/suggestion-review-context";
import { SuggestionReviewProvider } from "~/entity/suggestions/queue/suggestion-review-context";
import {
  WhatChanges,
  ImpactLabels,
} from "~/entity/suggestions/queue/suggestion-values";
import RTable from "~/entity/table/table";
import { suggestions } from "~/integrations/tanstack-query/generated/catalog/suggestions.gen";
import { formatCount } from "~/lib/number-format";
import { buildSelectColumn } from "~/ui/data-table/row-selection";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
} from "~/ui/data-table/table-features";
import { attachCubbyColumnMeta } from "~/ui/data-table/table-meta";
import { useLocalTable } from "~/ui/data-table/use-local-table";
import { EmptyState } from "~/ui/feedback/empty-state";
import { useHydratedLoading } from "~/ui/hooks/use-hydrated";
import { Disclosure } from "~/ui/layout/disclosure";
import { SidePanel, useTableRowStep } from "~/ui/overlays/side-panel";
import { Button } from "~/ui/primitives/button";
import { StatusText } from "~/ui/primitives/status-text";

import { StatusPill } from "../job/job-status";
import type { DecisionPresenter } from "./decision-presenters";

const helper = createCubbyColumnHelper<RunDecision>();
const decisionId = (row: RunDecision) => row.id;

function DecisionEvidence({
  row,
  presenter,
  onClose,
  suggestion,
}: {
  row: RunDecision;
  presenter: DecisionPresenter;
  onClose: () => void;
  suggestion?: SuggestionListRow;
}) {
  const step = useTableRowStep();
  return (
    <SidePanel
      label="Decision evidence"
      eyebrow={
        <StatusPill tone={presenter.facetOf(row).tone}>
          {presenter.facetOf(row).label}
        </StatusPill>
      }
      title={presenter.title(row)}
      onClose={onClose}
      onPrev={() => step(-1)}
      onNext={() => step(1)}
    >
      {suggestion && row.active && row.status === "pending" ? (
        <SuggestionActions suggestion={suggestion} />
      ) : null}
      {suggestion ? (
        <SuggestionEvidence row={suggestion} />
      ) : (
        <presenter.Evidence row={row} />
      )}
    </SidePanel>
  );
}

/** A Run's bounded publication, using the shared list filters and inspector. */
function DecisionLedgerBody({
  rows,
  total,
  presenter,
  facet,
  onFacet,
  caption,
  actionableRows,
  reviewReady,
}: {
  rows: readonly RunDecision[];
  total: number;
  presenter: DecisionPresenter;
  facet: string | null;
  onFacet: (facet: string | null) => void;
  caption?: string;
  actionableRows?: readonly SuggestionListRow[];
  reviewReady?: (rows: SuggestionListRow[]) => Promise<number>;
}) {
  const attentionFor = (row: RunDecision) =>
    row.active &&
    row.status === "pending" &&
    (actionableRows
      ? actionableRows.some(
          (item) => item.assessmentId === row.id && item.actions.length > 0,
        )
      : presenter.facetOf(row).key === "ready_to_apply");
  const [admittedIds, setAdmittedIds] = useState(() => rows.map(decisionId));
  const [attentionIds, setAttentionIds] = useState(() =>
    rows.filter(attentionFor).map(decisionId),
  );
  const [attention, setAttention] = useState(() => rows.some(attentionFor));
  const byId = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);
  const admitted = useMemo(
    () =>
      admittedIds.flatMap((id) => {
        const row = byId.get(id);
        return row ? [row] : [];
      }),
    [admittedIds, byId],
  );
  // A step's explicit facet drills into all admitted decisions, independently of the initial review view.
  const reviewRows = useMemo(
    () =>
      attention && !facet
        ? admitted.filter((row) => attentionIds.includes(row.id))
        : admitted,
    [admitted, attention, attentionIds, facet],
  );
  const arrivals = rows.filter((row) => !admittedIds.includes(row.id));
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [reviewing, setReviewing] = useState(false);
  const [reviewMessage, setReviewMessage] = useState<string | null>(null);
  const [otherFilters, setOtherFilters] = useState<ColumnFiltersState>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const filters = useMemo(
    () => [...otherFilters, ...(facet ? [{ id: "status", value: facet }] : [])],
    [otherFilters, facet],
  );
  const columns = useMemo(
    () =>
      createCubbyColumnCollection<RunDecision>((add) => {
        if (reviewReady) add(buildSelectColumn<RunDecision>());
        add(
          helper.accessor((row) => presenter.facetOf(row).key, {
            id: "status",
            header: "Status",
            size: 112,
            filterFn: "equals",
            meta: attachCubbyColumnMeta<RunDecision>({
              mobile: { slot: "trailing", priority: 0 },
              filterConfig: {
                filterType: "select",
                placeholder: "Filter status",
                options: presenter.facets.map((def) => ({
                  value: def.key,
                  label: def.label,
                })),
                facetCount: true,
              },
            }),
            cell: ({ row }) => {
              const def = presenter.facetOf(row.original);
              return (
                <span title={presenter.explanation(row.original)}>
                  <StatusPill tone={def.tone}>{def.label}</StatusPill>
                </span>
              );
            },
          }),
        );
        presenter.columns.forEach((column, index) =>
          add(
            helper.accessor(column.value, {
              id: column.id,
              header: column.header,
              size: index < 2 ? 280 : 140,
              meta: attachCubbyColumnMeta<RunDecision>({
                className: column.className,
                numeric: column.align === "right",
                mobile: {
                  slot: index === 0 ? "title" : "meta",
                  priority: index,
                },
              }),
              cell: ({ row }) => column.cell(row.original),
            }),
          ),
        );
      }),
    [presenter, reviewReady],
  );
  const search = useMemo(
    () => ({
      text: presenter.searchText,
      placeholder: "Search account, amount, ID",
    }),
    [presenter],
  );
  const table = useLocalTable({
    rows: reviewRows,
    totalCount: total,
    columns,
    getRowId: decisionId,
    search,
    selection: reviewReady
      ? {
          rowSelection,
          onRowSelectionChange: (update) =>
            setRowSelection(functionalUpdate(update, rowSelection)),
        }
      : undefined,
    columnFilters: filters,
    onColumnFiltersChange: (update) => {
      const next = functionalUpdate(update, filters);
      const status = next.find((filter) => filter.id === "status")?.value;
      onFacet(typeof status === "string" && status ? status : null);
      setOtherFilters(next.filter((filter) => filter.id !== "status"));
    },
  });
  const shown = table.getFilteredRowModel().rows;
  const selectedIds = Object.keys(rowSelection).filter(
    (id) => rowSelection[id],
  );
  const scoped = selectedIds.length
    ? admitted.filter((row) => selectedIds.includes(row.id))
    : shown.map((row) => row.original);
  const readyFor = (row: RunDecision) =>
    row.active && row.status === "pending"
      ? actionableRows?.find(
          (item) =>
            item.assessmentId === row.id &&
            item.clean &&
            item.actions.some(
              (action) => action.verb === "accept" && !action.ownerOnly,
            ) &&
            acceptItem(item) !== null,
        )
      : undefined;
  const readyScope = scoped.flatMap((row) => {
    const item = readyFor(row);
    return item ? [item] : [];
  });
  const impacts = [
    ...new Map(
      readyScope
        .flatMap((row) => row.impact)
        .map((impact) => [`${impact.kind}:${impact.label}`, impact]),
    ).values(),
  ];
  const eligible =
    !selectedIds.length || readyScope.length === selectedIds.length;
  const applyReady = async () => {
    if (!reviewReady || reviewing || !eligible || !readyScope.length) return;
    const snapshot = readyScope;
    const actedIds = new Set(snapshot.map((row) => row.assessmentId));
    setReviewing(true);
    try {
      const failures = await reviewReady(snapshot);
      setReviewMessage(
        failures
          ? `${failures} reviews failed. Open evidence to inspect the errors and retry.`
          : `${snapshot.length} recommendations accepted.`,
      );
      if (!failures)
        setRowSelection((current) =>
          Object.fromEntries(
            Object.entries(current).filter(([id]) => !actedIds.has(id)),
          ),
        );
    } finally {
      setReviewing(false);
    }
  };
  const open = admitted.find((row) => row.id === openId);
  const close = () => setOpenId(null);
  return (
    <div className="min-w-0" data-testid="decision-ledger">
      <p className="pb-2 text-xs text-muted-foreground">
        {facet
          ? presenter.facets.find((def) => def.key === facet)?.description
          : "Recommendations change records only when applied. Opening evidence does not apply a recommendation."}
      </p>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant={attention && !facet ? "default" : "outline"}
          aria-pressed={attention && !facet}
          onClick={() => {
            onFacet(null);
            setAttentionIds(admitted.filter(attentionFor).map(decisionId));
            setAttention(true);
          }}
        >
          Needs attention ({admitted.filter(attentionFor).length})
        </Button>
        <Button
          size="sm"
          variant={!attention && !facet ? "default" : "outline"}
          aria-pressed={!attention && !facet}
          onClick={() => {
            onFacet(null);
            setAttention(false);
          }}
        >
          Results
        </Button>
        {arrivals.length ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setAdmittedIds((ids) => [...ids, ...arrivals.map(decisionId)]);
              setAttentionIds((ids) => [
                ...ids,
                ...arrivals.filter(attentionFor).map(decisionId),
              ]);
            }}
          >
            Show {arrivals.length} new items
          </Button>
        ) : null}
      </div>
      {reviewReady ? (
        <div className="mb-2 space-y-2">
          <p className="text-xs text-muted-foreground">
            {selectedIds.length
              ? `${selectedIds.length} selected decisions override the filtered view.`
              : "Scope: ready recommendations in the filtered, loaded view."}{" "}
            {readyScope.length} clean recommendations can be accepted.
            {!eligible
              ? " Every selected decision must be clean and offer acceptance."
              : ""}
          </p>
          {readyScope.length ? (
            <div>
              <p className="text-xs text-muted-foreground">
                On accept:{" "}
                {impacts.map((impact) => impact.label).join(" · ") ||
                  "Apply the recorded recommendations"}
              </p>
              <Disclosure
                summary={`Review changes and impact for ${readyScope.length} recommendations`}
              >
                <ul className="space-y-2 py-2 text-xs">
                  {readyScope.map((row) => (
                    <li key={row.id}>
                      <WhatChanges row={row} />
                      <ImpactLabels impact={row.impact} />
                    </li>
                  ))}
                </ul>
              </Disclosure>
            </div>
          ) : null}
          <Button
            size="sm"
            disabled={reviewing || !eligible || !readyScope.length}
            onClick={() => void applyReady()}
          >
            Accept {readyScope.length} ready{" "}
            {selectedIds.length ? "selected" : "in view"}
          </Button>
          {reviewMessage ? <StatusText>{reviewMessage}</StatusText> : null}
        </div>
      ) : null}
      <RTable
        table={table}
        embedded
        ariaLabel="Decisions"
        withoutImages="Assessment publications are judgments, not image-bearing records."
        currentRowId={open?.id}
        onRowClick={(row) => setOpenId(row.id)}
        disableMobileDetailsHref
        inspector={{
          content: open ? (
            <DecisionEvidence
              row={open}
              presenter={presenter}
              onClose={close}
              suggestion={
                open.active && open.status === "pending"
                  ? actionableRows?.find(
                      (item) => item.assessmentId === open.id,
                    )
                  : undefined
              }
            />
          ) : null,
          title: "Decision evidence",
          onClose: close,
        }}
        emptyState={
          <EmptyState
            size="inline"
            description="Results contains all admitted decisions, including blocked and unsupported recommendations. Clear filters to see more."
          >
            No decisions match
          </EmptyState>
        }
      />
      <p className="py-2 text-xs text-muted-foreground">
        {formatCount(shown.length)} of {formatCount(total)} decisions
        {attention && !facet ? " · actionable review view" : ""}
        {caption ? ` · ${caption}` : ""}
        {total > rows.length
          ? ` · newest ${formatCount(rows.length)} loaded`
          : ""}
      </p>
    </div>
  );
}

type LedgerProps = Parameters<typeof DecisionLedgerBody>[0];
const EMPTY_ACTIONS: readonly SuggestionListRow[] = [];

/** Queue receipts own review authority; a stored judgment alone never authorizes a write. */
function RunDecisionQueue({
  runId,
  poll,
  ...props
}: LedgerProps & { runId: RunOut["id"]; poll: boolean }) {
  const query = useQuery({
    ...suggestions.list.queryOptions({ runId, limit: 200 }),
    refetchInterval: poll ? 3_000 : false,
  });
  const loading = useHydratedLoading(query.isPending);
  if (loading) return <StatusText>Loading review actions…</StatusText>;
  return (
    <SuggestionReviewProvider scope={runId}>
      {query.isError ? (
        <div>
          <StatusText tone="destructive">{query.error.message}</StatusText>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void query.refetch()}
          >
            Retry review actions
          </Button>
        </div>
      ) : null}
      {query.data?.next ? (
        <p className="pb-2 text-xs text-muted-foreground">
          Review actions are available for the first 200 queued suggestions.
          Other decisions retain their source links and evidence.
        </p>
      ) : null}
      <QueueDecisionLedger
        {...props}
        actionableRows={query.data?.items ?? EMPTY_ACTIONS}
      />
    </SuggestionReviewProvider>
  );
}

export function DecisionLedger({
  runId,
  poll = false,
  ...props
}: LedgerProps & { runId?: RunOut["id"]; poll?: boolean }) {
  return runId ? (
    <RunDecisionQueue key={runId} runId={runId} poll={poll} {...props} />
  ) : (
    <DecisionLedgerBody {...props} />
  );
}

function QueueDecisionLedger(props: LedgerProps) {
  const review = useSuggestionReview();
  return (
    <DecisionLedgerBody
      {...props}
      reviewReady={async (rows) =>
        (
          await review.review(rows, (row) =>
            acceptItem(row, review.statementChoice(row)),
          )
        ).length
      }
    />
  );
}
