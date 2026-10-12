import {
  workQueueHouseholdInput,
  workQueueKindSchema,
  workQueueSourceSchema,
  type WorkQueueMember,
  type WorkQueueRow,
  type WorkWaitingFor,
} from "@cubby/schemas/work-queue";
import { humanize } from "@cubby/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  functionalUpdate,
  type ColumnFiltersState,
  type PaginationState,
} from "@tanstack/react-table";
import { useCallback, useMemo } from "react";
import type { z } from "zod";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import {
  entities,
  entityDetailParams,
  isBrowserRoutedEntity,
} from "~/entity/entities";
import { workQueue } from "~/integrations/tanstack-query/generated/catalog.gen";
import { textCellData } from "~/ui/data-table/cell-data";
import { useTableColumnLayout } from "~/ui/data-table/column-layout";
import RTable from "~/ui/data-table/Table";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  useCubbyTable,
} from "~/ui/data-table/table-features";
import { attachCubbyColumnMeta } from "~/ui/data-table/table-meta";
import { useHydratedLoading } from "~/ui/hooks/useHydrated";
import { Page, usePageCount } from "~/ui/page/Page";

const PAGE_SIZES = [25, 50, 100];
const EMPTY_ROWS: WorkQueueRow[] = [];
const EMPTY_MEMBERS: WorkQueueMember[] = [];
const helper = createCubbyColumnHelper<WorkQueueRow>();
type QueueInput = z.infer<typeof workQueueHouseholdInput>;

function waitingForLabel(waitingFor: WorkWaitingFor) {
  switch (waitingFor.kind) {
    case "either":
      return "Either";
    case "unresolved":
      return "Unresolved";
    case "members":
      return waitingFor.members.map((member) => member.name).join(", ");
  }
}

function queueHref(row: WorkQueueRow) {
  // Run detail recovers pending execution on read (#1905); use passive Problems.
  if (row.entity === null || row.id === null || row.entity === "run")
    return "/problems";
  return isBrowserRoutedEntity(row.entity)
    ? `/${entities[row.entity].basePath}/${row.id}`
    : undefined;
}

function WorkRecordLink({ row }: { row: WorkQueueRow }) {
  if (row.entity === null || row.id === null || row.entity === "run") {
    return (
      <Link
        to="/problems"
        title={row.name}
        className="block truncate font-medium"
      >
        {row.name}
      </Link>
    );
  }
  return isBrowserRoutedEntity(row.entity) ? (
    <EntityRefLink
      variant="table"
      tone="identity"
      to={entities[row.entity].routes.detail}
      params={entityDetailParams(row.id)}
      title={row.name}
    >
      {row.name}
    </EntityRefLink>
  ) : (
    row.name
  );
}

function queueColumns(members: WorkQueueMember[]) {
  return createCubbyColumnCollection<WorkQueueRow>((add) => {
    add(
      helper.accessor((row) => row.name, {
        id: "name",
        header: "Record",
        size: 280,
        meta: attachCubbyColumnMeta<WorkQueueRow>({
          entityColumnRole: "identity",
          surplus: true,
          mobile: { slot: "title" },
          cellData: textCellData<WorkQueueRow>("text", (row) => row.name),
          filterConfig: { placeholder: "Search work", filterType: "text" },
        }),
        cell: ({ row }) => <WorkRecordLink row={row.original} />,
      }),
    );
    add(
      helper.accessor((row) => waitingForLabel(row.waitingFor), {
        id: "waitingFor",
        header: "Waiting for",
        size: 176,
        meta: attachCubbyColumnMeta<WorkQueueRow>({
          mobile: { slot: "meta", priority: 0, label: "Waiting for" },
          cellData: textCellData<WorkQueueRow>("text", (row) =>
            waitingForLabel(row.waitingFor),
          ),
          filterConfig: {
            placeholder: "Filter waiting for",
            filterType: "select",
            options: [
              { value: "me", label: "Me or Either" },
              { value: "either", label: "Either" },
              { value: "unresolved", label: "Unresolved" },
              ...members.map((member) => ({
                value: member.id,
                label: member.name,
              })),
            ],
          },
        }),
        cell: ({ row }) => (
          <span
            title={
              row.original.waitingFor.kind === "unresolved"
                ? row.original.waitingFor.reason
                : waitingForLabel(row.original.waitingFor)
            }
          >
            {waitingForLabel(row.original.waitingFor)}
          </span>
        ),
      }),
    );
    for (const [key, label, size] of [
      ["reason", "Reason", 260],
      ["nextAction", "Next action", 320],
    ] as const) {
      add(
        helper.accessor((row) => row[key], {
          id: key,
          header: label,
          size,
          meta: attachCubbyColumnMeta<WorkQueueRow>({
            mobile: {
              slot: "subtitle",
              priority: key === "reason" ? 0 : 1,
              label,
            },
            cellData: textCellData<WorkQueueRow>("text", (row) => row[key]),
          }),
          cell: ({ row }) => (
            <span title={row.original[key]}>{row.original[key]}</span>
          ),
        }),
      );
    }
    for (const [key, label, values] of [
      ["source", "Source", workQueueSourceSchema.options],
      ["kind", "Kind", workQueueKindSchema.options],
    ] as const) {
      add(
        helper.accessor((row) => humanize(row[key]), {
          id: key,
          header: label,
          size: 128,
          meta: attachCubbyColumnMeta<WorkQueueRow>({
            mobile: { slot: "meta", label },
            cellData: textCellData<WorkQueueRow>("text", (row) =>
              humanize(row[key]),
            ),
            filterConfig: {
              placeholder: `Filter ${label.toLowerCase()}`,
              filterType: "select",
              options: values.map((value) => ({
                value,
                label: humanize(value),
              })),
            },
          }),
        }),
      );
    }
  });
}

/** The queue projects canonical work; filters never write assignment or source state. */
type WorkQueuePageProps = {
  search: QueueInput;
  onChange: (patch: Partial<QueueInput>) => void;
};

export function WorkQueuePage(props: WorkQueuePageProps) {
  return (
    <Page
      variant="list"
      listChrome="workbench"
      title="Work queue"
      bodyGutter="none"
    >
      <WorkQueueTable {...props} />
    </Page>
  );
}

function WorkQueueTable({ search, onChange }: WorkQueuePageProps) {
  const query = useQuery({
    ...workQueue.list.queryOptions(search),
    placeholderData: keepPreviousData,
  });
  usePageCount(query.data?.meta.totalCount);
  const members = query.data?.members ?? EMPTY_MEMBERS;
  const columns = useMemo(() => queueColumns(members), [members]);
  const { columns: tableColumns, defaultLayout } = useTableColumnLayout({
    columns,
  });
  const pagination = useMemo<PaginationState>(
    () => ({ pageIndex: search.pageIndex, pageSize: search.pageSize }),
    [search.pageIndex, search.pageSize],
  );
  const columnFilters = useMemo<ColumnFiltersState>(
    () => [
      ...(search.query ? [{ id: "name", value: search.query }] : []),
      ...(search.waitingFor !== "all"
        ? [{ id: "waitingFor", value: search.waitingFor }]
        : []),
      ...(search.source ? [{ id: "source", value: search.source }] : []),
      ...(search.kind ? [{ id: "kind", value: search.kind }] : []),
    ],
    [search.query, search.waitingFor, search.source, search.kind],
  );
  const onColumnFiltersChange = useCallback(
    (updater: Parameters<typeof functionalUpdate<ColumnFiltersState>>[0]) => {
      const values = new Map(
        functionalUpdate(updater, columnFilters).map((filter) => [
          filter.id,
          filter.value,
        ]),
      );
      const next = workQueueHouseholdInput.parse({
        ...search,
        query: values.get("name") || undefined,
        waitingFor: values.get("waitingFor") || "all",
        source: values.get("source") || undefined,
        kind: values.get("kind") || undefined,
        pageIndex: 0,
      });
      onChange(next);
    },
    [columnFilters, onChange, search],
  );
  const onPaginationChange = useCallback(
    (updater: Parameters<typeof functionalUpdate<PaginationState>>[0]) => {
      const next = functionalUpdate(updater, pagination);
      onChange({
        ...next,
        pageIndex: next.pageSize === pagination.pageSize ? next.pageIndex : 0,
      });
    },
    [onChange, pagination],
  );
  const table = useCubbyTable({
    data: query.data?.items ?? EMPTY_ROWS,
    columns: tableColumns,
    getRowId: (row) => row.key,
    initialState: { ...defaultLayout },
    state: { columnFilters, pagination },
    onColumnFiltersChange,
    onPaginationChange,
    rowCount: query.data?.meta.totalCount ?? 0,
    manualFiltering: true,
    manualPagination: true,
    enableSorting: false,
    enableRowSelection: false,
    meta: { defaultLayout, pageSizeOptions: PAGE_SIZES },
  });
  const isLoading = useHydratedLoading(query.isPending);
  return (
    <RTable
      table={table}
      ariaLabel="Work queue"
      isLoading={isLoading}
      error={query.error}
      showColumnMenu
      getMobileDetailsHref={queueHref}
      emptyState="No work matches these filters."
    />
  );
}
