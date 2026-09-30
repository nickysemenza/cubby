import { shortcodeEntities } from "@cubby/schemas/entity-manifest";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  functionalUpdate,
  type PaginationState,
  type SortingState,
} from "@tanstack/react-table";
import { useCallback, useMemo, useId } from "react";

import { useTableColumnLayout } from "~/app/_components/data-table/column-layout";
import RTable from "~/app/_components/data-table/Table";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  useCubbyTable,
} from "~/app/_components/data-table/table-features";
import { ImageThumbnail } from "~/app/_components/table/ImageThumbnail";
import { renderScalarValue } from "~/components/common/scalar-value";
import { EntityRefLink } from "~/components/entity/entity-ref-link";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { NativeSelect } from "~/components/ui/native-select";
import {
  entityRecordsInputSchema,
  entityRecordSortSchema,
  type EntityRecord,
  type EntityRecordsInput,
} from "~/contracts/entity-records.schema";
import {
  entities,
  entityDetailParams,
  entityLabel,
  isBrowserRoutedEntity,
} from "~/entities/entities";
import { entityGraph } from "~/integrations/tanstack-query/generated/catalog.gen";

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
      meta: {
        entityColumnRole: "image",
        className: "h-px w-16 overflow-hidden px-0 py-0",
        mobile: { slot: "image", priority: -10 },
      },
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
      meta: {
        entityColumnRole: "identity",
        className: "w-64",
        mobile: { slot: "title" },
      },
      cell: ({ row }) =>
        isBrowserRoutedEntity(row.original.kind) ? (
          <EntityRefLink
            variant="table"
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
      meta: { className: "w-32", mobile: { slot: "subtitle" } },
      cell: (info) => entityLabel(info.getValue()),
    }),
  );
  add(
    helper.accessor((row) => row.id, {
      id: "id",
      header: "Shortcode",
      meta: { className: "w-32", mono: true, mobile: { slot: "meta" } },
    }),
  );
  add(
    helper.accessor((row) => row.quality, {
      id: "quality",
      header: "Quality (0–100)",
      meta: { className: "w-32", numeric: true, mobile: { slot: "meta" } },
      cell: (info) =>
        info.getValue() === null ? "Not scored" : Math.round(info.getValue()!),
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
        meta: { className: "w-32", mobile: { slot: "meta" } },
        cell: (info) =>
          renderScalarValue({ kind: "timestamp", raw: info.getValue() }),
      }),
    );
  }
});

type FilterKey =
  | "q"
  | "kind"
  | "image"
  | "qualityMin"
  | "qualityMax"
  | "createdFrom"
  | "createdTo"
  | "updatedFrom"
  | "updatedTo";
const dateFilters = [
  ["createdFrom", "Created from"],
  ["createdTo", "Created through"],
  ["updatedFrom", "Updated from"],
  ["updatedTo", "Updated through"],
] as const;

/** One server-owned roster; changes to sorting or filters reset its page. */
export function EntityRecordsTab({
  search,
  onChange,
}: {
  search: EntityRecordsInput;
  onChange: (patch: Partial<EntityRecordsInput>) => void;
}) {
  const filterId = useId();
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
    meta: { defaultLayout, scrollRestorationId: "entity-records" },
  });
  const filter = (key: FilterKey, value: string) => {
    const next = entityRecordsInputSchema.safeParse({
      ...search,
      [key]: value === "" ? undefined : value,
      page: 1,
    });
    if (next.success) onChange({ [key]: next.data[key], page: 1 });
  };
  return (
    <Stack gap="md">
      <p className="text-sm text-muted-foreground">
        Live records across all entity types. Image sorting uses image presence;
        quality ranges exclude records that have no score.
      </p>
      <Row gap="sm" wrap>
        <Input
          aria-label="Search records"
          placeholder="Name or shortcode"
          type="search"
          value={search.q ?? ""}
          onChange={(event) => filter("q", event.target.value)}
          className="w-64"
        />
        <NativeSelect
          aria-label="Filter entity type"
          value={search.kind ?? ""}
          onChange={(event) => filter("kind", event.target.value)}
        >
          <option value="">All types</option>
          {shortcodeEntities.map((kind) => (
            <option key={kind} value={kind}>
              {entityLabel(kind)}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          aria-label="Filter image presence"
          value={search.image ?? ""}
          onChange={(event) => filter("image", event.target.value)}
        >
          <option value="">Any image state</option>
          <option value="has">Has image</option>
          <option value="none">No image</option>
        </NativeSelect>
        <label className="text-xs" htmlFor={`${filterId}-qualityMin`}>
          Minimum quality
          <Input
            id={`${filterId}-qualityMin`}
            aria-label="Minimum quality"
            type="number"
            min={0}
            max={100}
            value={search.qualityMin ?? ""}
            onChange={(event) => filter("qualityMin", event.target.value)}
            className="w-28"
          />
        </label>
        <label className="text-xs" htmlFor={`${filterId}-qualityMax`}>
          Maximum quality
          <Input
            id={`${filterId}-qualityMax`}
            aria-label="Maximum quality"
            type="number"
            min={0}
            max={100}
            value={search.qualityMax ?? ""}
            onChange={(event) => filter("qualityMax", event.target.value)}
            className="w-28"
          />
        </label>
      </Row>
      <Row gap="sm" wrap>
        {dateFilters.map(([key, label]) => (
          <label key={key} className="text-xs" htmlFor={`${filterId}-${key}`}>
            {label}
            <Input
              id={`${filterId}-${key}`}
              aria-label={label}
              type="date"
              value={search[key] ?? ""}
              onChange={(event) => filter(key, event.target.value)}
            />
          </label>
        ))}
        <Button
          variant="ghost"
          onClick={() =>
            onChange({
              q: undefined,
              kind: undefined,
              image: undefined,
              qualityMin: undefined,
              qualityMax: undefined,
              createdFrom: undefined,
              createdTo: undefined,
              updatedFrom: undefined,
              updatedTo: undefined,
              page: 1,
            })
          }
        >
          Clear filters
        </Button>
      </Row>
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
