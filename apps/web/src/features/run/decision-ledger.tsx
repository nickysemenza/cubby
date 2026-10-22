import {
  functionalUpdate,
  type ColumnFiltersState,
} from "@tanstack/react-table";
import { useMemo, useState } from "react";

import type { RunDecision } from "~/contracts/run-detail.contract";
import RTable from "~/entity/table/table";
import { formatCount } from "~/lib/number-format";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
} from "~/ui/data-table/table-features";
import { attachCubbyColumnMeta } from "~/ui/data-table/table-meta";
import { useLocalTable } from "~/ui/data-table/use-local-table";
import { EmptyState } from "~/ui/feedback/empty-state";
import { SidePanel, useTableRowStep } from "~/ui/overlays/side-panel";

import { StatusPill } from "../job/job-status";
import type { DecisionPresenter } from "./decision-presenters";

const helper = createCubbyColumnHelper<RunDecision>();
const decisionId = (row: RunDecision) => row.id;

function DecisionEvidence({
  row,
  presenter,
  onClose,
}: {
  row: RunDecision;
  presenter: DecisionPresenter;
  onClose: () => void;
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
      <presenter.Evidence row={row} />
    </SidePanel>
  );
}

/** A Run's bounded publication, using the shared list filters and inspector. */
export function DecisionLedger({
  rows,
  total,
  presenter,
  facet,
  onFacet,
  caption,
}: {
  rows: readonly RunDecision[];
  total: number;
  presenter: DecisionPresenter;
  facet: string | null;
  onFacet: (facet: string | null) => void;
  caption?: string;
}) {
  const [otherFilters, setOtherFilters] = useState<ColumnFiltersState>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const filters = useMemo(
    () => [...otherFilters, ...(facet ? [{ id: "status", value: facet }] : [])],
    [otherFilters, facet],
  );
  const columns = useMemo(
    () =>
      createCubbyColumnCollection<RunDecision>((add) => {
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
    [presenter],
  );
  const search = useMemo(
    () => ({
      text: presenter.searchText,
      placeholder: "Search account, amount, ID",
    }),
    [presenter],
  );
  const table = useLocalTable({
    rows,
    totalCount: total,
    columns,
    getRowId: decisionId,
    search,
    columnFilters: filters,
    onColumnFiltersChange: (update) => {
      const next = functionalUpdate(update, filters);
      const status = next.find((filter) => filter.id === "status")?.value;
      onFacet(typeof status === "string" && status ? status : null);
      setOtherFilters(next.filter((filter) => filter.id !== "status"));
    },
  });
  const shown = table.getFilteredRowModel().rows;
  const open = shown.find((row) => row.id === openId)?.original;
  const close = () => setOpenId(null);
  return (
    <div className="min-w-0" data-testid="decision-ledger">
      <p className="pb-2 text-xs text-muted-foreground">
        {facet
          ? presenter.facets.find((def) => def.key === facet)?.description
          : "Recommendations change records only when applied. Opening evidence does not apply a recommendation."}
      </p>
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
            />
          ) : null,
          title: "Decision evidence",
          onClose: close,
        }}
        emptyState={
          <EmptyState
            size="inline"
            description="Clear the filters to see all decisions."
          >
            No decisions match
          </EmptyState>
        }
      />
      <p className="py-2 text-xs text-muted-foreground">
        {formatCount(shown.length)} of {formatCount(total)} decisions
        {caption ? ` · ${caption}` : ""}
        {total > rows.length
          ? ` · newest ${formatCount(rows.length)} loaded`
          : ""}
      </p>
    </div>
  );
}
