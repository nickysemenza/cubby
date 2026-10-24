import type { RunOut } from "@cubby/schemas/run";
import { humanize } from "@cubby/shared";
import { ACTIVE_RUN_STATUSES } from "@cubby/shared/client-constants";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import RTable from "~/entity/table/table";
import { run as runOperations } from "~/integrations/tanstack-query/generated/catalog/run.gen";
import { useSectionCount } from "~/ui/data-table/detail-section-state";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
} from "~/ui/data-table/table-features";
import { attachCubbyColumnMeta } from "~/ui/data-table/table-meta";
import { useLocalTable } from "~/ui/data-table/use-local-table";
import { EmptyState } from "~/ui/feedback/empty-state";
import { useHydratedLoading } from "~/ui/hooks/use-hydrated";
import { SidePanel, useTableRowStep } from "~/ui/overlays/side-panel";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import { StatusText } from "~/ui/primitives/status-text";

import {
  stableTargetRows,
  targetName,
  targetNeedsAttention,
  type RunTarget,
} from "./run-targets-model";

const activeStatuses = new Set<string>(ACTIVE_RUN_STATUSES);
const helper = createCubbyColumnHelper<RunTarget>();
const rowId = (row: RunTarget) => row.id;
const search = {
  text: (row: RunTarget) =>
    [
      targetName(row),
      row.state,
      row.outcome,
      row.warning,
      row.sourceLabel,
      row.vendorAccountLabel,
    ]
      .filter(Boolean)
      .join(" "),
  placeholder: "Search records, outcomes, sources",
};
function TargetStatus({ target }: { target: RunTarget }) {
  return (
    <Badge
      variant={
        target.state === "completed"
          ? "positive"
          : ["unresolved", "needs_evidence", "unavailable"].includes(
                target.state,
              )
            ? "warning"
            : "secondary"
      }
    >
      {humanize(target.state)}
    </Badge>
  );
}
function TargetLink({ target }: { target: RunTarget }) {
  return target.targetShortcode ? (
    <EntityRefLink
      entity={target.targetType}
      id={target.targetShortcode}
      name={targetName(target)}
    />
  ) : (
    <span>{targetName(target)}</span>
  );
}
function TargetEvidence({
  target,
  onClose,
}: {
  target: RunTarget;
  onClose: () => void;
}) {
  const step = useTableRowStep();
  return (
    <SidePanel
      label="Run target evidence"
      title={targetName(target)}
      onClose={onClose}
      onPrev={() => step(-1)}
      onNext={() => step(1)}
    >
      <div className="space-y-4 text-sm">
        <TargetLink target={target} />
        <TargetStatus target={target} />
        {target.outcome ? <p>{target.outcome}</p> : null}
        {target.warning ? (
          <StatusText tone="warning">{target.warning}</StatusText>
        ) : null}
        <p className="break-words text-muted-foreground">
          {[target.sourceLabel, target.vendorAccountLabel]
            .filter(Boolean)
            .join(" · ") || "No source selected"}
        </p>
        {target.completedAt ? (
          <p className="text-xs text-muted-foreground">
            Completed {target.completedAt}
          </p>
        ) : null}
        {target.diff !== null ? (
          <div>
            <h3 className="mb-2 font-medium">Recorded difference</h3>
            <pre className="max-h-96 overflow-auto bg-muted p-2 text-xs break-words whitespace-pre-wrap">
              {JSON.stringify(target.diff, null, 2)}
            </pre>
          </div>
        ) : null}
      </div>
    </SidePanel>
  );
}

export function RunTargetsTable({ rows }: { rows: readonly RunTarget[] }) {
  const [admittedIds, setAdmittedIds] = useState(() => rows.map(rowId));
  const [attention, setAttention] = useState(() =>
    rows.some(targetNeedsAttention),
  );
  const [attentionIds, setAttentionIds] = useState(() =>
    rows.filter(targetNeedsAttention).map(rowId),
  );
  const [openId, setOpenId] = useState<string | null>(null);
  const admitted = useMemo(
    () => stableTargetRows(rows, admittedIds),
    [rows, admittedIds],
  );
  const visible = useMemo(
    () =>
      attention
        ? admitted.filter((row) => attentionIds.includes(row.id))
        : admitted,
    [admitted, attention, attentionIds],
  );
  const arrivals = rows.filter((row) => !admittedIds.includes(row.id));
  const columns = useMemo(
    () =>
      createCubbyColumnCollection<RunTarget>((add) => {
        add(
          helper.accessor(targetName, {
            id: "record",
            header: "Record",
            size: 260,
            meta: attachCubbyColumnMeta<RunTarget>({
              mobile: { slot: "title", priority: 0 },
            }),
            cell: ({ row }) => <TargetLink target={row.original} />,
          }),
        );
        add(
          helper.accessor("state", {
            header: "Status",
            size: 130,
            filterFn: "equals",
            meta: attachCubbyColumnMeta<RunTarget>({
              mobile: { slot: "trailing", priority: 0 },
              filterConfig: {
                filterType: "select",
                placeholder: "Filter status",
                options: [...new Set(rows.map((row) => row.state))].map(
                  (state) => ({ value: state, label: humanize(state) }),
                ),
                facetCount: true,
              },
            }),
            cell: ({ row }) => <TargetStatus target={row.original} />,
          }),
        );
        add(
          helper.accessor((row) => row.warning ?? row.outcome ?? "—", {
            id: "outcome",
            header: "Outcome / reason",
            size: 340,
            meta: attachCubbyColumnMeta<RunTarget>({
              mobile: { slot: "meta", priority: 1 },
            }),
            cell: ({ getValue }) => (
              <span className="block truncate" title={getValue()}>
                {getValue()}
              </span>
            ),
          }),
        );
        add(
          helper.accessor(
            (row) =>
              [row.sourceLabel, row.vendorAccountLabel]
                .filter(Boolean)
                .join(" · "),
            {
              id: "source",
              header: "Source",
              size: 220,
              meta: attachCubbyColumnMeta<RunTarget>({
                mobile: { slot: "meta", priority: 2 },
              }),
              cell: ({ getValue }) => (
                <span className="block truncate" title={getValue()}>
                  {getValue() || "No source selected"}
                </span>
              ),
            },
          ),
        );
      }),
    [rows],
  );
  const table = useLocalTable({
    rows: visible,
    columns,
    getRowId: rowId,
    search,
  });
  // An update may resolve the inspected target. Keep its evidence open until the member closes it.
  const open = admitted.find((row) => row.id === openId);
  const close = () => setOpenId(null);
  return (
    <div className="min-w-0" data-testid="run-targets">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant={attention ? "default" : "outline"}
          aria-pressed={attention}
          onClick={() => {
            setAttentionIds(admitted.filter(targetNeedsAttention).map(rowId));
            setAttention(true);
          }}
        >
          Needs attention
        </Button>
        <Button
          size="sm"
          variant={!attention ? "default" : "outline"}
          aria-pressed={!attention}
          onClick={() => setAttention(false)}
        >
          Results
        </Button>
        {arrivals.length ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setAdmittedIds((ids) => [...ids, ...arrivals.map(rowId)]);
              setAttentionIds((ids) => [
                ...ids,
                ...arrivals.filter(targetNeedsAttention).map(rowId),
              ]);
            }}
          >
            Show {arrivals.length} new items
          </Button>
        ) : null}
      </div>
      <RTable
        table={table}
        embedded
        ariaLabel="Items and outcomes"
        withoutImages="Run targets retain their record links; evidence appears in the inspector."
        currentRowId={open?.id}
        onRowClick={(row) => setOpenId(row.id)}
        disableMobileDetailsHref
        inspector={{
          content: open ? (
            <TargetEvidence target={open} onClose={close} />
          ) : null,
          title: "Run target evidence",
          onClose: close,
        }}
        emptyState={
          <EmptyState
            size="inline"
            description={
              attention
                ? "Results contains all recorded targets, including outcomes without a linked record."
                : "Clear filters to see recorded targets."
            }
          >
            {attention ? "No targets need attention" : "No targets match"}
          </EmptyState>
        }
      />
      <p className="py-2 text-xs text-muted-foreground">
        {table.getFilteredRowModel().rows.length} shown · {admitted.length}{" "}
        recorded targets loaded.{" "}
        {rows.some(
          (row) =>
            ["unresolved", "needs_evidence", "unavailable"].includes(
              row.state,
            ) && !row.targetShortcode,
        )
          ? `${rows.filter((row) => ["unresolved", "needs_evidence", "unavailable"].includes(row.state) && !row.targetShortcode).length} blocked targets without record links in Results. `
          : ""}
        Opening evidence does not change a record.
      </p>
    </div>
  );
}

export function RunTargets({ record }: { record: RunOut }) {
  const query = useQuery({
    ...runOperations.work.queryOptions({ runId: record.id }),
    refetchInterval: (current) =>
      current.state.data && activeStatuses.has(current.state.data.status)
        ? 3_000
        : false,
  });
  useSectionCount(query.data?.targets.length);
  const loading = useHydratedLoading(query.isPending);
  if (loading) return <StatusText>Loading targets…</StatusText>;
  return (
    <>
      {query.isError ? (
        <div>
          <StatusText tone="destructive">{query.error.message}</StatusText>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void query.refetch()}
          >
            Retry targets
          </Button>
        </div>
      ) : null}
      {query.data ? (
        query.data.targets.length ? (
          <RunTargetsTable key={record.id} rows={query.data.targets} />
        ) : (
          <EmptyState
            size="inline"
            description="This run has no explicit target records."
          >
            No targets recorded
          </EmptyState>
        )
      ) : query.isPending ? (
        <StatusText>Loading targets…</StatusText>
      ) : null}
    </>
  );
}
