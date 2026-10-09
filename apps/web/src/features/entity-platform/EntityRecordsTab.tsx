import { scoredEntities } from "@cubby/schemas/data-quality";
import { shortcodeEntities } from "@cubby/schemas/entity-manifest";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  functionalUpdate,
  type ColumnFiltersState,
  type PaginationState,
  type SortingState,
} from "@tanstack/react-table";
import { useCallback, useMemo } from "react";

import {
  entityRecordsInputSchema,
  entityRecordSortSchema,
  type EntityRecord,
  type EntityRecordsInput,
} from "~/contracts/entity-records.schema";
import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { DataQualityValue } from "~/entity/data-quality-value";
import {
  entities,
  EntityIcon,
  entityDetailParams,
  entityLabel,
  isBrowserRoutedEntity,
} from "~/entity/entities";
import { entityGraph } from "~/integrations/tanstack-query/generated/catalog.gen";
import { renderScalarValue } from "~/ui/common/scalar-value";
import {
  numberCellData,
  textCellData,
  timestampCellData,
} from "~/ui/data-table/cell-data";
import { useTableColumnLayout } from "~/ui/data-table/column-layout";
import {
  filterStateToBarFilters,
  type FilterBarField,
} from "~/ui/data-table/filter-bar-core";
import { FilterBar, MobileFilterTier } from "~/ui/data-table/FilterBar";
import RTable from "~/ui/data-table/Table";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  useCubbyTable,
} from "~/ui/data-table/table-features";
import { attachCubbyColumnMeta } from "~/ui/data-table/table-meta";
import { useFilterBarDraft } from "~/ui/data-table/useFilterBarDraft";
import { Stack } from "~/ui/layout";
import { EnumPill } from "~/ui/primitives/enum-pill";
import { ImageThumbnail } from "~/ui/table/ImageThumbnail";

const EMPTY_ROWS: EntityRecord[] = [];
const helper = createCubbyColumnHelper<EntityRecord>();
const columns = createCubbyColumnCollection<EntityRecord>((add) => {
  add(
    helper.accessor((row) => row.hasImage, {
      id: "hasImage",
      header: "Image",
      enableSorting: true,
      enableHiding: false,
      enablePinning: false,
      meta: attachCubbyColumnMeta<EntityRecord>({
        entityColumnRole: "image",
        className: "h-px w-16 overflow-hidden px-0 py-0",
        mobile: { slot: "image", priority: -10 },
      }),
      cell: ({ row }) => (
        <ImageThumbnail
          images={row.original.displayImages}
          alt={row.original.name}
          entity={row.original.kind}
        />
      ),
    }),
  );
  add(
    helper.accessor((row) => row.name, {
      id: "name",
      header: "Name",
      meta: attachCubbyColumnMeta<EntityRecord>({
        entityColumnRole: "identity",
        className: "w-64",
        mobile: { slot: "title" },
        cellData: textCellData<EntityRecord>("text", (row) => row.name),
      }),
      cell: ({ row }) =>
        isBrowserRoutedEntity(row.original.kind) ? (
          <EntityRefLink
            variant="table"
            tone="identity"
            to={entities[row.original.kind].routes.detail}
            params={entityDetailParams(row.original.id)}
            title={row.original.name}
          >
            {row.original.name}
          </EntityRefLink>
        ) : (
          row.original.name
        ),
    }),
  );
  add(
    helper.accessor((row) => row.kind, {
      id: "kind",
      header: "Type",
      meta: attachCubbyColumnMeta<EntityRecord>({
        className: "w-32",
        mobile: { slot: "subtitle" },
        cellData: textCellData<EntityRecord>("select", (row) =>
          entityLabel(row.kind),
        ),
      }),
      cell: (info) => (
        <EnumPill icon={<EntityIcon entity={info.getValue()} colored />}>
          {entityLabel(info.getValue())}
        </EnumPill>
      ),
    }),
  );
  add(
    helper.accessor((row) => row.id, {
      id: "id",
      header: "Shortcode",
      meta: attachCubbyColumnMeta<EntityRecord>({
        className: "w-32",
        mono: true,
        mobile: { slot: "meta" },
        cellData: textCellData<EntityRecord>("text", (row) => row.id),
      }),
    }),
  );
  add(
    helper.accessor((row) => row.quality, {
      id: "quality",
      header: "Quality",
      sortDescFirst: false,
      meta: attachCubbyColumnMeta<EntityRecord>({
        className: "w-20",
        numeric: true,
        mobile: { slot: "meta" },
        cellData: numberCellData<EntityRecord>("number", (row) => row.quality),
        explanation: {
          resolve: (row) => ({
            entity: row.kind,
            field: "dataQuality",
            label: "Data quality",
          }),
        },
      }),
      cell: ({ row: { original } }) => (
        <DataQualityValue
          quality={
            original.qualityStatus !== null
              ? { score: original.quality, status: original.qualityStatus }
              : undefined
          }
          scored={scoredEntities.some((entity) => entity === original.kind)}
        />
      ),
    }),
  );
  for (const [id, header] of [
    ["createdAt", "Created"],
    ["updatedAt", "Updated"],
  ] as const) {
    add(
      helper.accessor((row) => row[id], {
        id,
        header,
        meta: attachCubbyColumnMeta<EntityRecord>({
          className: "w-32",
          mobile: { slot: "meta" },
          cellData: timestampCellData<EntityRecord>((row) => row[id]),
        }),
        cell: (info) =>
          renderScalarValue({ kind: "timestamp", raw: info.getValue() }),
      }),
    );
  }
});

const FILTER_KEYS = [
  "q",
  "kind",
  "image",
  "qualityMin",
  "qualityMax",
  "createdFrom",
  "createdTo",
  "updatedFrom",
  "updatedTo",
] as const satisfies readonly (keyof EntityRecordsInput)[];

const QUALITY_RANGE_DESCRIPTION =
  "Quality ranges exclude records with no score.";
const filterFields: FilterBarField[] = [
  { key: "q", label: "Records", type: "text" },
  {
    key: "kind",
    label: "Type",
    type: "select",
    options: shortcodeEntities.map((kind) => ({
      value: kind,
      label: entityLabel(kind),
    })),
  },
  {
    key: "image",
    label: "Image",
    type: "select",
    options: [
      { value: "has", label: "Has image" },
      { value: "none", label: "No image" },
    ],
    description: "Image sorting uses image presence.",
  },
  ...(
    [
      ["qualityMin", "Minimum quality"],
      ["qualityMax", "Maximum quality"],
    ] as const
  ).map(([key, label]): FilterBarField => ({
    key,
    label,
    type: "text",
    inputType: "number",
    min: 0,
    max: 100,
    description: QUALITY_RANGE_DESCRIPTION,
  })),
  ...(
    [
      ["createdFrom", "Created from"],
      ["createdTo", "Created through"],
      ["updatedFrom", "Updated from"],
      ["updatedTo", "Updated through"],
    ] as const
  ).map(([key, label]): FilterBarField => ({
    key,
    label,
    type: "text",
    inputType: "date",
  })),
];

/** One server-owned roster; changes to sorting or filters reset its page. */
export function EntityRecordsTab({
  search,
  onChange,
}: {
  search: EntityRecordsInput;
  onChange: (patch: Partial<EntityRecordsInput>) => void;
}) {
  const query = useQuery({
    ...entityGraph.records.queryOptions(search),
    placeholderData: keepPreviousData,
  });
  const data = query.data?.items ?? EMPTY_ROWS;
  const sorting = useMemo<SortingState>(
    () => [{ id: search.orderBy, desc: search.direction === "desc" }],
    [search.orderBy, search.direction],
  );
  const pagination = useMemo<PaginationState>(
    () => ({ pageIndex: search.page - 1, pageSize: search.pageSize }),
    [search.page, search.pageSize],
  );
  const onSortingChange = useCallback(
    (updater: SortingState | ((previous: SortingState) => SortingState)) => {
      const next = functionalUpdate(updater, sorting)[0];
      if (next)
        onChange({
          orderBy: entityRecordSortSchema.parse(next.id),
          direction: next.desc ? "desc" : "asc",
          page: 1,
        });
    },
    [onChange, sorting],
  );
  const onPaginationChange = useCallback(
    (
      updater:
        | PaginationState
        | ((previous: PaginationState) => PaginationState),
    ) => {
      const next = functionalUpdate(updater, pagination);
      onChange({
        page: next.pageSize === pagination.pageSize ? next.pageIndex + 1 : 1,
        pageSize: next.pageSize,
      });
    },
    [onChange, pagination],
  );
  const { columns: normalizedColumns, defaultLayout } = useTableColumnLayout({
    columns,
  });
  const table = useCubbyTable({
    data,
    columns: normalizedColumns,
    getRowId: (row) => row.id,
    initialState: { ...defaultLayout },
    state: { sorting, pagination },
    onSortingChange,
    onPaginationChange,
    rowCount: query.data?.totalCount ?? 0,
    manualSorting: true,
    manualFiltering: true,
    manualPagination: true,
    enableMultiSort: false,
    enableSortingRemoval: false,
    enableRowSelection: false,
    meta: {
      defaultLayout,
      scrollRestorationId: "entity-records",
    },
  });
  const externalFilters = useMemo(
    () =>
      filterStateToBarFilters(
        FILTER_KEYS.flatMap((id) =>
          search[id] === undefined ? [] : [{ id, value: search[id] }],
        ),
        filterFields,
      ),
    [search],
  );
  const commit = useCallback(
    (filters: ColumnFiltersState) => {
      const values = new Map(
        filters.map((filter) => [filter.id, filter.value]),
      );
      const patch = Object.fromEntries(
        FILTER_KEYS.map((key) => [key, values.get(key)]),
      );
      const next = entityRecordsInputSchema.safeParse({
        ...search,
        ...patch,
        page: 1,
      });
      if (next.success) {
        onChange({
          q: next.data.q,
          kind: next.data.kind,
          image: next.data.image,
          qualityMin: next.data.qualityMin,
          qualityMax: next.data.qualityMax,
          createdFrom: next.data.createdFrom,
          createdTo: next.data.createdTo,
          updatedFrom: next.data.updatedFrom,
          updatedTo: next.data.updatedTo,
          page: 1,
        });
      }
    },
    [search, onChange],
  );
  const { draftFilters, handleChange } = useFilterBarDraft({
    externalFilters,
    fields: filterFields,
    commit,
  });
  return (
    <Stack gap="md">
      <p className="text-sm text-muted-foreground">
        Records across all entity types.
      </p>
      <div className="hidden md:block">
        <FilterBar
          fields={filterFields}
          filters={draftFilters}
          onChange={handleChange}
          searchKey="q"
          searchPlaceholder="Name or shortcode"
        />
      </div>
      <div className="md:hidden">
        <MobileFilterTier
          table={table}
          fields={filterFields}
          filters={draftFilters}
          onChange={handleChange}
          searchKey="q"
          searchPlaceholder="Name or shortcode"
        />
      </div>
      <RTable
        table={table}
        ariaLabel="All entity records"
        embedded
        showColumnMenu
        isLoading={query.isPending || query.isPlaceholderData}
        error={query.error}
        getMobileDetailsHref={(row) =>
          isBrowserRoutedEntity(row.kind)
            ? `/${entities[row.kind].basePath}/${row.id}`
            : undefined
        }
      />
    </Stack>
  );
}
