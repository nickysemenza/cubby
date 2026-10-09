import {
  ACTIVITY_KIND_LABEL,
  activityKind,
  type ActivityRun,
  type ActivityListInput,
} from "@cubby/schemas/activity";
import { runTrigger } from "@cubby/schemas/run-fields";
import {
  useInfiniteQuery,
  useQueries,
  useQuery,
  type QueryObserverResult,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

import { ActivityRunDetail } from "~/app/activity/activity-run-detail";
import { RunSubject, RunTargetChips } from "~/app/runs/run-work-summary";
import { createEntityDisplayColumns } from "~/entity/entity-display";
import { cursorQueryOptions } from "~/integrations/tanstack-query/cursor-query-options";
import { activity } from "~/integrations/tanstack-query/generated/catalog.gen";
import { formatInstant } from "~/lib/date-format";
import { formatCurrency } from "~/lib/utils";
import { useTableColumnLayout } from "~/ui/data-table/column-layout";
import RTable from "~/ui/data-table/Table";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  useCubbyTable,
} from "~/ui/data-table/table-features";
import type { InfiniteScrollControls } from "~/ui/hooks/useInfiniteTableList";
import { Row, Stack } from "~/ui/layout";
import { usePageCount } from "~/ui/page/Page";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import { Input } from "~/ui/primitives/input";
import { NativeSelect } from "~/ui/primitives/native-select";
import { Sheet, SheetContent, SheetTitle } from "~/ui/primitives/sheet";

const combineChildPages = (
  results: QueryObserverResult<
    Awaited<ReturnType<typeof activity.groupChildren.call>>,
    Error
  >[],
) =>
  results.map((result) => ({
    data: result.data,
    loading: result.isLoading,
    error: result.error?.message ?? "",
  }));

export interface RunHistoryFilters extends Partial<ActivityListInput> {
  selected?: string;
  group?: "run";
  /** `none`: the declared default filter was cleared. */
  filters?: "none";
  /** The Run declaration carries a default filter (its Clear writes `none`). */
  hasDefaultFilter?: boolean;
}
type HistoryRow = ActivityRun & {
  depth?: number;
  childCount?: number;
  contextOnly?: boolean;
  loadingChildren?: boolean;
};
const kinds = activityKind.options;
const label = (value: string) => value.replaceAll("_", " ");
const duration = (value: number | null) =>
  value == null ? "—" : `${(value / 1_000).toFixed(1)} s`;
const localDateTime = (value?: string) =>
  value
    ? new Date(
        new Date(value).getTime() -
          new Date(value).getTimezoneOffset() * 60_000,
      )
        .toISOString()
        .slice(0, 16)
    : "";
const toIso = (value: string) =>
  value ? new Date(value).toISOString() : undefined;
const presentation = () => {
  if (!globalThis.window) return "mobile";
  if (window.matchMedia("(min-width: 1280px)").matches) return "dock";
  return window.matchMedia("(min-width: 768px)").matches ? "sheet" : "mobile";
};
const subscribe = (callback: () => void) => {
  if (!globalThis.window) return () => undefined;
  const media = [
    window.matchMedia("(min-width: 1280px)"),
    window.matchMedia("(min-width: 768px)"),
  ];
  for (const item of media) item.addEventListener("change", callback);
  return () => {
    for (const item of media) item.removeEventListener("change", callback);
  };
};

// oxlint-disable-next-line complexity -- one list owns the flat and grouped queries, expansion, and three inspector presentations.
export function RunHistory({
  filters,
  onFilterChange,
  onSelect,
  onGroupChange,
}: {
  filters: RunHistoryFilters;
  onFilterChange: (patch: Partial<RunHistoryFilters>) => void;
  onSelect: (id: string | undefined) => void;
  onGroupChange: (grouped: boolean) => void;
}) {
  const navigate = useNavigate();
  const mode = useSyncExternalStore(subscribe, presentation, () => "mobile");
  useEffect(() => {
    if (
      mode !== "mobile" ||
      !filters.selected ||
      !window.matchMedia("(max-width: 767px)").matches
    )
      return;
    void navigate({
      to: filters.selected.startsWith("RUN-")
        ? `/runs/${filters.selected}`
        : `/runs/jobs/${filters.selected}`,
      replace: true,
    });
  }, [filters.selected, mode, navigate]);
  const grouped = filters.group === "run";
  const [more, setMore] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const devices = useQuery(activity.devices.queryOptions({}));
  const input = useMemo<ActivityListInput>(
    () => ({
      limit: 20,
      sort: filters.sort ?? "newest",
      executor: filters.executor ?? "all",
      recordType: filters.recordType,
      kind: filters.kind,
      state: filters.state,
      trigger: filters.trigger,
      excludeTriggers: filters.excludeTriggers,
      routine: filters.routine,
      vendorAccountId: filters.vendorAccountId,
      vendorId: filters.vendorId,
      ledgerPartyId: filters.ledgerPartyId,
      subjectId: filters.subjectId,
      submissionId: filters.submissionId,
      deviceId: filters.deviceId,
      from: filters.from,
      to: filters.to,
    }),
    [
      filters.sort,
      filters.executor,
      filters.recordType,
      filters.kind,
      filters.state,
      filters.trigger,
      filters.excludeTriggers,
      filters.routine,
      filters.vendorAccountId,
      filters.vendorId,
      filters.ledgerPartyId,
      filters.subjectId,
      filters.submissionId,
      filters.deviceId,
      filters.from,
      filters.to,
    ],
  );
  const filterKey = JSON.stringify(input);
  useEffect(() => {
    setExpanded({});
  }, [filterKey]);
  const flat = useInfiniteQuery({
    ...cursorQueryOptions(activity.list, input),
    enabled: !grouped,
  });
  const groups = useInfiniteQuery({
    ...cursorQueryOptions(activity.groups, input),
    enabled: grouped,
  });
  const groupRows = useMemo(
    () => groups.data?.pages.flatMap((page) => page.items) ?? [],
    [groups.data],
  );
  const childGroups = useMemo(
    () =>
      groupRows.filter(
        (group) => group.root.recordType === "run" && group.childCount > 0,
      ),
    [groupRows],
  );
  const childQueryOptions = useMemo(
    () =>
      childGroups.map((group) => ({
        ...activity.groupChildren.queryOptions({
          ...input,
          rootId: group.root.id,
          limit: 100,
        }),
        enabled:
          grouped && Boolean(expanded[group.root.id]) && group.childCount > 0,
        queryFn: async ({ signal }: { signal: AbortSignal }) => {
          const items: ActivityRun[] = [];
          let cursor: string | undefined;
          let page;
          do {
            page = await activity.groupChildren.call(
              { ...input, rootId: group.root.id, limit: 100, cursor },
              { signal },
            );
            items.push(...page.items);
            cursor = page.nextCursor ?? undefined;
          } while (cursor);
          return { ...page, items };
        },
        refetchInterval: (query: {
          state: {
            data?: Awaited<ReturnType<typeof activity.groupChildren.call>>;
          };
        }) =>
          group.active || query.state.data?.items.some((item) => item.active)
            ? 15_000
            : false,
        staleTime: 0,
      })),
    [childGroups, input, grouped, expanded],
  );
  const childPages = useQueries({
    queries: childQueryOptions,
    combine: combineChildPages,
  });
  const children = useMemo(
    () =>
      Object.fromEntries(
        childGroups.map((group, index) => [
          group.root.id,
          childPages[index]?.data?.items ?? [],
        ]),
      ),
    [childGroups, childPages],
  );
  const loading = useMemo(
    () =>
      Object.fromEntries(
        childGroups.map((group, index) => [
          group.root.id,
          childPages[index]?.loading ?? false,
        ]),
      ),
    [childGroups, childPages],
  );
  const childErrors = useMemo(
    () =>
      Object.fromEntries(
        childGroups.map((group, index) => [
          group.root.id,
          childPages[index]?.error ?? "",
        ]),
      ),
    [childGroups, childPages],
  );
  const rows = useMemo<HistoryRow[]>(
    () =>
      grouped
        ? groupRows.flatMap(({ root, childCount, contextOnly }) => [
            { ...root, childCount, contextOnly },
            ...(expanded[root.id] && childCount > 0
              ? (children[root.id] ?? []).map((item) => ({ ...item, depth: 1 }))
              : []),
          ])
        : (flat.data?.pages.flatMap((page) => page.items) ?? []),
    [grouped, groupRows, expanded, children, flat.data],
  );
  usePageCount(
    grouped ? groups.data?.pages[0]?.totalItems : flat.data?.pages[0]?.total,
  );
  const query = grouped ? groups : flat;
  const active = grouped
    ? groupRows.some((group) => group.active)
    : rows.some((row) => row.active);
  const refetch = query.refetch;
  useEffect(() => {
    if (!active) return;
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void refetch();
    }, 15_000);
    return () => window.clearInterval(interval);
  }, [active, refetch]);
  const toggle = useCallback((root: HistoryRow) => {
    setExpanded((value) => ({ ...value, [root.id]: !value[root.id] }));
  }, []);
  const select = (row: HistoryRow) => {
    if (mode === "mobile") {
      void navigate({
        to:
          row.recordType === "run" ? `/runs/${row.id}` : `/runs/jobs/${row.id}`,
      });
    } else onSelect(row.id);
  };
  const helper = useMemo(() => createCubbyColumnHelper<HistoryRow>(), []);
  const columns = useMemo(
    () =>
      createCubbyColumnCollection<HistoryRow>((add) => {
        createEntityDisplayColumns("run", helper, undefined, {
          only: ["dataQuality"],
        }).visit(add);
        add(
          helper.accessor("subjectName", {
            header: "Subject",
            size: 240,
            meta: {
              entityColumnRole: "identity",
              surplus: true,
              mobile: { slot: "title", priority: 1 },
            },
            cell: ({ row }) => (
              <div
                className={`flex min-w-0 items-center gap-1 ${row.original.depth ? "pl-6" : ""}`}
              >
                {grouped &&
                row.original.recordType === "run" &&
                (row.original.childCount ?? 0) > 0 ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`${expanded[row.original.id] ? "Collapse" : "Expand"} jobs for ${row.original.id}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      void toggle(row.original);
                    }}
                  >
                    {expanded[row.original.id] ? "▾" : "▸"}{" "}
                    {row.original.childCount}
                  </Button>
                ) : null}
                <RunSubject run={row.original} />
                {row.original.contextOnly ? (
                  <Badge variant="outline" className="ml-2">
                    Context
                  </Badge>
                ) : null}
                {loading[row.original.id] ? (
                  <span className="ml-2 text-muted-foreground">
                    Loading jobs…
                  </span>
                ) : null}
                {childErrors[row.original.id] ? (
                  <span role="alert" className="ml-2 text-destructive">
                    {childErrors[row.original.id]}
                  </span>
                ) : null}
              </div>
            ),
          }),
        );
        add(
          helper.accessor("state", {
            header: "State",
            size: 110,
            cell: ({ getValue }) => (
              <Badge variant="secondary">{label(getValue())}</Badge>
            ),
            meta: { mobile: { slot: "meta", priority: 20 } },
          }),
        );
        add(
          helper.accessor("workLabel", {
            header: "Work",
            size: 170,
            meta: { mobile: { slot: "meta", priority: 10 } },
          }),
        );
        add(
          helper.accessor("targetSummary", {
            header: "Progress",
            size: 340,
            enableSorting: false,
            cell: ({ row }) => {
              const summary = row.original.targetSummary;
              const step = row.original.active
                ? row.original.currentStep
                : null;
              return (
                <span
                  className="block truncate"
                  title={row.original.currentStep ?? undefined}
                >
                  <span className="tabular-nums">{summary ?? "—"}</span>
                  {step ? (
                    <span className="text-muted-foreground"> · {step}</span>
                  ) : null}
                </span>
              );
            },
            meta: { mobile: { slot: "meta", priority: 30 } },
          }),
        );
        add(
          helper.accessor("targetPreview", {
            header: "Targets",
            size: 300,
            enableSorting: false,
            cell: ({ row }) => <RunTargetChips run={row.original} />,
          }),
        );
        add(
          helper.accessor("changedCount", {
            header: "Changed",
            size: 80,
            cell: ({ getValue }) => getValue() || "—",
            meta: { mono: true, numeric: true },
          }),
        );
        add(
          helper.accessor("executors", {
            header: "Executor",
            size: 150,
            enableSorting: false,
            cell: ({ getValue }) =>
              getValue()
                .map((item) => item.name)
                .join(", ") || "Unknown",
          }),
        );
        add(
          helper.accessor("attempts", {
            header: "Attempts / ops",
            size: 90,
            meta: { mono: true, numeric: true },
          }),
        );
        add(
          helper.accessor("durationMs", {
            header: "Duration",
            size: 90,
            cell: ({ getValue }) => duration(getValue()),
            meta: { mono: true, numeric: true },
          }),
        );
        add(
          helper.accessor("estimatedCost", {
            header: "Cost",
            size: 90,
            cell: ({ getValue, row }) => (
              <span
                title={
                  row.original.recordType === "image_job" &&
                  row.original.parentRunId
                    ? "Job cost may be included in parent Run total"
                    : "Recorded cost"
                }
              >
                {getValue() == null ? "—" : formatCurrency(getValue() ?? 0)}
                {row.original.recordType === "image_job" &&
                row.original.parentRunId
                  ? "*"
                  : ""}
              </span>
            ),
            meta: { mono: true, numeric: true },
          }),
        );
        add(
          helper.accessor("createdAt", {
            header: "Submitted",
            size: 180,
            cell: ({ getValue }) => formatInstant(getValue(), "dateTime"),
            meta: { mono: true, mobile: { slot: "meta", priority: 40 } },
          }),
        );
      }),
    [helper, grouped, expanded, toggle, loading, childErrors],
  );
  const { columns: tableColumns, defaultLayout } = useTableColumnLayout({
    columns,
  });
  const table = useCubbyTable({
    data: rows,
    columns: tableColumns,
    initialState: {
      columnOrder: defaultLayout.columnOrder,
      columnPinning: defaultLayout.columnPinning,
      columnVisibility: defaultLayout.columnVisibility,
    },
    meta: { defaultLayout },
    getRowId: (row) => row.id,
    manualFiltering: true,
    manualPagination: true,
    enableSorting: false,
    enableRowSelection: false,
    enableCellSelection: false,
  });
  const infiniteScroll = useMemo<InfiniteScrollControls<HistoryRow>>(
    () => ({
      fetchNextPage: () => {
        void query.fetchNextPage();
      },
      hasNextPage: query.hasNextPage,
      isFetchingNextPage: query.isFetchingNextPage,
      isTransitioning: false,
      loadAllPages: async () => rows,
    }),
    [query, rows],
  );
  const clear = () =>
    onFilterChange({
      recordType: undefined,
      kind: undefined,
      state: undefined,
      trigger: undefined,
      vendorAccountId: undefined,
      vendorId: undefined,
      ledgerPartyId: undefined,
      subjectId: undefined,
      submissionId: undefined,
      executor: undefined,
      deviceId: undefined,
      from: undefined,
      to: undefined,
      sort: undefined,
      // Clearing means everything, declared default included; the URL keeps
      // that choice, since an empty filter alone would reopen the default.
      filters: filters.hasDefaultFilter ? "none" : undefined,
    });
  const selectFilter = (key: keyof RunHistoryFilters, value: string) =>
    onFilterChange({ [key]: value || undefined });
  const inspector = filters.selected ? (
    <ActivityRunDetail
      id={filters.selected}
      onClose={() => onSelect(undefined)}
      variant="inspector"
    />
  ) : null;
  return (
    <Stack gap="sm">
      <Row gap="sm" align="center" wrap>
        <NativeSelect
          aria-label="Record type"
          value={filters.recordType ?? ""}
          onChange={(event) => selectFilter("recordType", event.target.value)}
        >
          <option value="">All records</option>
          <option value="run">Runs</option>
          <option value="image_job">Image jobs</option>
        </NativeSelect>
        <NativeSelect
          aria-label="Work type"
          value={filters.kind ?? ""}
          onChange={(event) => selectFilter("kind", event.target.value)}
        >
          <option value="">All work</option>
          {kinds.map((kind) => (
            <option key={kind} value={kind}>
              {ACTIVITY_KIND_LABEL[kind]}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          aria-label="Run order"
          value={filters.sort ?? "newest"}
          onChange={(event) => selectFilter("sort", event.target.value)}
        >
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
        </NativeSelect>
        <Button
          type="button"
          variant={grouped ? "secondary" : "outline"}
          size="sm"
          aria-pressed={grouped}
          onClick={() => onGroupChange(!grouped)}
        >
          Group by run
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-expanded={more}
          onClick={() => setMore(!more)}
        >
          More
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={clear}>
          Clear
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          Refresh
        </Button>
      </Row>
      {more ? (
        <Row gap="sm" wrap>
          <NativeSelect
            aria-label="Execution location"
            value={filters.executor ?? "all"}
            onChange={(event) => selectFilter("executor", event.target.value)}
          >
            <option value="all">All executors</option>
            <option value="cloud">Cloud</option>
            <option value="device">Device</option>
            <option value="unknown">Unknown</option>
          </NativeSelect>
          <NativeSelect
            aria-label="Execution device"
            value={filters.deviceId ?? ""}
            onChange={(event) => selectFilter("deviceId", event.target.value)}
          >
            <option value="">All devices</option>
            {devices.data?.items.map((device) =>
              device.deviceId ? (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.name}
                </option>
              ) : null,
            )}
          </NativeSelect>
          <Input
            aria-label="Filter state"
            placeholder="State"
            className="w-28"
            value={filters.state ?? ""}
            onChange={(event) => selectFilter("state", event.target.value)}
          />
          <Input
            aria-label="Filter subject"
            placeholder="Subject"
            className="w-32"
            value={filters.subjectId ?? ""}
            onChange={(event) => selectFilter("subjectId", event.target.value)}
          />
          <Input
            aria-label="Filter submission"
            placeholder="Submission"
            className="w-32"
            value={filters.submissionId ?? ""}
            onChange={(event) =>
              selectFilter("submissionId", event.target.value)
            }
          />
          <Input
            aria-label="Filter vendor account"
            placeholder="Vendor account"
            className="w-32"
            value={filters.vendorAccountId ?? ""}
            onChange={(event) =>
              selectFilter("vendorAccountId", event.target.value)
            }
          />
          <Input
            aria-label="Filter vendor"
            placeholder="Vendor"
            className="w-32"
            value={filters.vendorId ?? ""}
            onChange={(event) => selectFilter("vendorId", event.target.value)}
          />
          <Input
            aria-label="Filter party"
            placeholder="Party"
            className="w-32"
            value={filters.ledgerPartyId ?? ""}
            onChange={(event) =>
              selectFilter("ledgerPartyId", event.target.value)
            }
          />
          <NativeSelect
            aria-label="Trigger"
            value={
              filters.trigger ??
              (filters.hasDefaultFilter && filters.filters !== "none"
                ? ""
                : "all")
            }
            onChange={(event) =>
              onFilterChange({
                trigger:
                  event.target.value === "" || event.target.value === "all"
                    ? undefined
                    : runTrigger.parse(event.target.value),
                filters: event.target.value === "all" ? "none" : undefined,
              })
            }
          >
            <option value="">Hide ephemeral and routine runs</option>
            <option value="all">All triggers</option>
            <option value="foreground">Foreground</option>
            <option value="discovery">Discovery</option>
            <option value="manual">Manual</option>
            <option value="backfill">Backfill</option>
            <option value="scheduled">Scheduled</option>
            <option value="ephemeral">Ephemeral</option>
          </NativeSelect>
          <Input
            type="datetime-local"
            aria-label="Runs from"
            className="w-44"
            value={localDateTime(filters.from)}
            onChange={(event) =>
              onFilterChange({ from: toIso(event.target.value) })
            }
          />
          <Input
            type="datetime-local"
            aria-label="Runs through"
            className="w-44"
            value={localDateTime(filters.to)}
            onChange={(event) =>
              onFilterChange({ to: toIso(event.target.value) })
            }
          />
        </Row>
      ) : null}
      <RTable
        table={table}
        ariaLabel="Runs and image jobs"
        isLoading={query.isLoading}
        error={query.error}
        infiniteScroll={infiniteScroll}
        emptyState="No work matches these filters."
        currentRowId={filters.selected}
        onRowClick={(row) => select(row.original)}
        getMobileDetailsHref={(row) =>
          row.recordType === "run" ? `/runs/${row.id}` : `/runs/jobs/${row.id}`
        }
        desktopInspector={mode === "dock" ? inspector : null}
        refreshControls={{
          onRefresh: async () => {
            await query.refetch();
          },
          isRefreshing: query.isRefetching,
        }}
      />
      {filters.selected && mode === "sheet" ? (
        <Sheet
          open
          onOpenChange={(open) => {
            if (!open) onSelect(undefined);
          }}
        >
          <SheetContent
            side="right"
            showCloseButton={false}
            className="!w-[25rem] !max-w-[calc(100vw-2rem)] overflow-y-auto p-0"
          >
            <SheetTitle className="sr-only">Work detail</SheetTitle>
            {inspector}
          </SheetContent>
        </Sheet>
      ) : null}
      <p className="text-xs text-muted-foreground">
        * A linked image job’s cost may already be included in its parent Run
        total.
      </p>
    </Stack>
  );
}
