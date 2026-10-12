import type { Entity } from "@cubby/schemas/entity";
import { entitySummary } from "@cubby/schemas/entity-summary";
import {
  workQueueHouseholdInput,
  workQueueKindSchema,
  workQueueSourceSchema,
  type WorkQueueKind,
  type WorkQueueMember,
  type WorkQueueRow,
  type WorkWaitingFor,
} from "@cubby/schemas/work-queue";
import { humanize } from "@cubby/shared";
import { EyeIcon } from "@phosphor-icons/react/dist/csr/Eye";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { WrenchIcon } from "@phosphor-icons/react/dist/csr/Wrench";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  functionalUpdate,
  type ColumnFiltersState,
  type PaginationState,
} from "@tanstack/react-table";
import { useCallback, useMemo, type ReactNode } from "react";
import type { z } from "zod";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import {
  EntityIcon,
  entities,
  entityDetailParams,
  isBrowserRoutedEntity,
} from "~/entity/entities";
import { workQueue } from "~/integrations/tanstack-query/generated/catalog.gen";
import { colorizeSelectOptions } from "~/lib/select-options";
import { selectCellData, textCellData } from "~/ui/data-table/cell-data";
import { useTableColumnLayout } from "~/ui/data-table/column-layout";
import {
  createImageColumn,
  renderOptionCell,
} from "~/ui/data-table/columnHelpers";
import RTable from "~/ui/data-table/Table";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  useCubbyTable,
} from "~/ui/data-table/table-features";
import { attachCubbyColumnMeta } from "~/ui/data-table/table-meta";
import { useHydratedLoading } from "~/ui/hooks/useHydrated";
import {
  domainForEntity,
  domainWayfinding,
} from "~/ui/navigation/domain-wayfinding";
import { Page, usePageCount } from "~/ui/page/Page";
import type { FilterableComboboxItem } from "~/ui/primitives/combobox";
import { EnumPill } from "~/ui/primitives/enum-pill";

const PAGE_SIZES = [25, 50, 100];
const EMPTY_ROWS: WorkQueueRow[] = [];
const EMPTY_MEMBERS: WorkQueueMember[] = [];
const INITIAL_VISIBILITY = { nextAction: false };
const helper = createCubbyColumnHelper<WorkQueueRow>();
type QueueInput = z.infer<typeof workQueueHouseholdInput>;

const KIND_ICONS = {
  research: <MagnifyingGlassIcon />,
  review: <EyeIcon />,
  repair: <WrenchIcon />,
} satisfies Record<WorkQueueKind, ReactNode>;
const KIND_OPTIONS = workQueueKindSchema.options.map((value) => ({
  value,
  label: humanize(value),
  icon: KIND_ICONS[value],
}));
const SOURCE_OPTIONS = workQueueSourceSchema.options.map((value) => ({
  value,
  label: humanize(value),
}));

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

function WaitingForCell({
  waitingFor,
  memberOptions,
}: {
  waitingFor: WorkWaitingFor;
  memberOptions: FilterableComboboxItem[];
}) {
  switch (waitingFor.kind) {
    case "either":
      return (
        <EnumPill description="Either member can do this work">Either</EnumPill>
      );
    case "unresolved":
      return (
        <EnumPill color="var(--warning)" description={waitingFor.reason}>
          Unresolved
        </EnumPill>
      );
    case "members":
      return (
        <span className="flex min-w-0 gap-1">
          {waitingFor.members.map((member) => (
            <span key={member.id} className="min-w-0">
              {renderOptionCell(member.id, memberOptions)}
            </span>
          ))}
        </span>
      );
  }
}

function entityTypeOption(entity: Entity) {
  const domain = domainForEntity(entity);
  return {
    value: entity,
    label: entitySummary[entity].singular,
    icon: <EntityIcon entity={entity} />,
    color: domain ? `var(${domainWayfinding(domain).accentToken})` : undefined,
  };
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
  const memberOptions = colorizeSelectOptions(
    members.map((member) => ({ value: member.id, label: member.name })),
  );
  return createCubbyColumnCollection<WorkQueueRow>((add) => {
    add(
      createImageColumn(helper, {
        rowEntity: (row) => row.entity ?? undefined,
      }),
    );
    add(
      helper.accessor((row) => row.name, {
        id: "name",
        header: "Record",
        size: 320,
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
      helper.accessor((row) => row.entity, {
        id: "entity",
        header: "Type",
        size: 128,
        meta: attachCubbyColumnMeta<WorkQueueRow>({
          mobile: { slot: "meta", priority: 1, label: "Type" },
          cellData: textCellData<WorkQueueRow>("text", (row) =>
            row.entity ? entitySummary[row.entity].singular : "Problem",
          ),
        }),
        cell: ({ row }) =>
          row.original.entity
            ? renderOptionCell(row.original.entity, [
                entityTypeOption(row.original.entity),
              ])
            : renderOptionCell("problem", [
                { value: "problem", label: "Problem" },
              ]),
      }),
    );
    add(
      helper.accessor((row) => row.kind, {
        id: "kind",
        header: "Kind",
        size: 112,
        meta: attachCubbyColumnMeta<WorkQueueRow>({
          mobile: { slot: "meta", priority: 0, label: "Kind" },
          cellData: selectCellData<WorkQueueRow>(
            (row) => row.kind,
            KIND_OPTIONS,
          ),
          filterConfig: {
            placeholder: "Filter kind",
            filterType: "select",
            options: KIND_OPTIONS,
          },
        }),
        cell: ({ row }) => renderOptionCell(row.original.kind, KIND_OPTIONS),
      }),
    );
    add(
      helper.accessor((row) => row.reason, {
        id: "reason",
        header: "Reason",
        size: 320,
        meta: attachCubbyColumnMeta<WorkQueueRow>({
          mobile: { slot: "subtitle", priority: 0, label: "Reason" },
          cellData: textCellData<WorkQueueRow>("text", (row) => row.reason),
        }),
        // The rule's next action is the reason's description; its own column
        // starts hidden because it repeats for every row of one rule.
        cell: ({ row }) => (
          <span className="block truncate" title={row.original.nextAction}>
            {row.original.reason}
          </span>
        ),
      }),
    );
    add(
      helper.accessor((row) => row.nextAction, {
        id: "nextAction",
        header: "Next action",
        size: 320,
        meta: attachCubbyColumnMeta<WorkQueueRow>({
          mobile: { slot: "subtitle", priority: 1, label: "Next action" },
          cellData: textCellData<WorkQueueRow>("text", (row) => row.nextAction),
        }),
        cell: ({ row }) => (
          <span title={row.original.nextAction}>{row.original.nextAction}</span>
        ),
      }),
    );
    add(
      helper.accessor((row) => waitingForLabel(row.waitingFor), {
        id: "waitingFor",
        header: "Waiting for",
        size: 136,
        meta: attachCubbyColumnMeta<WorkQueueRow>({
          mobile: { slot: "meta", priority: 2, label: "Waiting for" },
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
              ...memberOptions,
            ],
          },
        }),
        cell: ({ row }) => (
          <WaitingForCell
            waitingFor={row.original.waitingFor}
            memberOptions={memberOptions}
          />
        ),
      }),
    );
    add(
      helper.accessor((row) => row.source, {
        id: "source",
        header: "Source",
        size: 144,
        meta: attachCubbyColumnMeta<WorkQueueRow>({
          mobile: { slot: "meta", priority: 3, label: "Source" },
          cellData: selectCellData<WorkQueueRow>(
            (row) => row.source,
            SOURCE_OPTIONS,
          ),
          filterConfig: {
            placeholder: "Filter source",
            filterType: "select",
            options: SOURCE_OPTIONS,
          },
        }),
        cell: ({ row }) =>
          renderOptionCell(row.original.source, SOURCE_OPTIONS),
      }),
    );
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
      layout="full"
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
    initialColumnVisibility: INITIAL_VISIBILITY,
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
