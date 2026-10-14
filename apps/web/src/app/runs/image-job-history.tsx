import {
  ACTIVITY_KIND_LABEL,
  imageProcessingJobKind,
  type ActivityRun,
  type ActivityListInput,
} from "@cubby/schemas/activity";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { ActivityRunDetail } from "~/app/activity/activity-run-detail";
import {
  WorkState,
  WorkStateDot,
  workIssueText,
  workStateLabel,
} from "~/app/activity/work-state";
import { RunSubject } from "~/app/runs/run-work-summary";
import { cursorQueryOptions } from "~/integrations/tanstack-query/cursor-query-options";
import { activity } from "~/integrations/tanstack-query/generated/catalog.gen";
import { formatDuration } from "~/lib/format-duration";
import { Picker } from "~/ui/combobox/picker";
import { AiCost } from "~/ui/common/ai-cost";
import { DateDisplay } from "~/ui/common/date-display";
import { RecordDetail, RecordList, RecordRow } from "~/ui/common/record-list";
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
import { Button } from "~/ui/primitives/button";
import { Input } from "~/ui/primitives/input";
import { Sheet, SheetContent, SheetTitle } from "~/ui/primitives/sheet";

type ImageJobFilters = Pick<
  Partial<ActivityListInput>,
  | "kind"
  | "state"
  | "attentionOnly"
  | "subjectId"
  | "submissionId"
  | "executor"
  | "deviceId"
  | "from"
  | "to"
  | "sort"
> & { selected?: string };

const kinds = imageProcessingJobKind.options;
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
const jobHref = (id: string) => `/runs/jobs/${id}`;
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

/** Image jobs and their attempts; Runs list through the generic Run table. */
export function ImageJobHistory({
  filters,
  onFilterChange,
  onSelect,
}: {
  filters: ImageJobFilters;
  onFilterChange: (patch: Partial<ImageJobFilters>) => void;
  onSelect: (id: string | undefined) => void;
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
    void navigate({ to: jobHref(filters.selected), replace: true });
  }, [filters.selected, mode, navigate]);
  const [more, setMore] = useState(false);
  const devices = useQuery(activity.devices.queryOptions({}));
  const input = useMemo<ActivityListInput>(
    () => ({
      limit: 20,
      recordType: "image_job",
      sort: filters.sort ?? "newest",
      executor: filters.executor ?? "all",
      kind: filters.kind,
      state: filters.state,
      attentionOnly: filters.attentionOnly,
      subjectId: filters.subjectId,
      submissionId: filters.submissionId,
      deviceId: filters.deviceId,
      from: filters.from,
      to: filters.to,
    }),
    [
      filters.sort,
      filters.executor,
      filters.kind,
      filters.state,
      filters.attentionOnly,
      filters.subjectId,
      filters.submissionId,
      filters.deviceId,
      filters.from,
      filters.to,
    ],
  );
  const query = useInfiniteQuery(cursorQueryOptions(activity.list, input));
  const attentionInput = useMemo<ActivityListInput>(
    () => ({ ...input, attentionOnly: true, limit: 5, sort: "newest" }),
    [input],
  );
  const attention = useQuery({
    ...activity.list.queryOptions(attentionInput),
    refetchInterval: 15_000,
  });
  const rows = useMemo(
    () => query.data?.pages.flatMap((page) => page.items) ?? [],
    [query.data],
  );
  usePageCount(query.data?.pages[0]?.total);
  const workSummary = query.data?.pages[0]?.workSummary;
  const active = rows.some((row) => row.active);
  const refetch = query.refetch;
  useEffect(() => {
    if (!active) return;
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void refetch();
    }, 15_000);
    return () => window.clearInterval(interval);
  }, [active, refetch]);
  const select = (row: ActivityRun) => {
    if (mode === "mobile") void navigate({ to: jobHref(row.id) });
    else onSelect(row.id);
  };
  const helper = useMemo(() => createCubbyColumnHelper<ActivityRun>(), []);
  const columns = useMemo(
    () =>
      createCubbyColumnCollection<ActivityRun>((add) => {
        add(
          helper.accessor("subjectName", {
            header: "Subject",
            size: 240,
            meta: {
              entityColumnRole: "identity",
              mobile: { slot: "title", priority: 1 },
            },
            cell: ({ row }) => <RunSubject run={row.original} />,
          }),
        );
        add(
          helper.accessor("state", {
            header: "State",
            size: 110,
            cell: ({ getValue, row }) => (
              <div className="space-y-1">
                <WorkState state={getValue()} />
                {row.original.state === "skipped" &&
                workIssueText(row.original) ? (
                  <p className="text-xs whitespace-normal text-muted-foreground">
                    {workIssueText(row.original)}
                  </p>
                ) : null}
              </div>
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
            size: 300,
            enableSorting: false,
            cell: ({ row }) => {
              const step = row.original.active
                ? row.original.currentStep
                : null;
              return (
                <span
                  className="block truncate"
                  title={row.original.currentStep ?? undefined}
                >
                  <span className="tabular-nums">
                    {row.original.targetSummary ?? "—"}
                  </span>
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
            header: "Attempts",
            size: 90,
            meta: { mono: true, numeric: true },
          }),
        );
        add(
          helper.accessor("durationMs", {
            header: "Duration",
            size: 90,
            cell: ({ getValue }) => {
              const value = getValue();
              return value == null ? "—" : formatDuration(value);
            },
            meta: { mono: true, numeric: true },
          }),
        );
        add(
          helper.accessor("chargedCost", {
            header: "Charged / standard",
            size: 180,
            cell: ({ row }) => (
              <AiCost
                cost={row.original}
                note={
                  row.original.parentRunId
                    ? "Job cost may be included in parent Run total"
                    : undefined
                }
              />
            ),
            meta: { mono: true, numeric: true },
          }),
        );
        add(
          helper.accessor("createdAt", {
            header: "Submitted",
            size: 180,
            cell: ({ getValue }) => <DateDisplay timestamp={getValue()} />,
            meta: { mono: true, mobile: { slot: "meta", priority: 40 } },
          }),
        );
      }),
    [helper],
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
  const infiniteScroll = useMemo<InfiniteScrollControls<ActivityRun>>(
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
      kind: undefined,
      state: undefined,
      attentionOnly: undefined,
      subjectId: undefined,
      submissionId: undefined,
      executor: undefined,
      deviceId: undefined,
      from: undefined,
      to: undefined,
      sort: undefined,
    });
  const selectFilter = (key: keyof ImageJobFilters, value: string) =>
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
      <section aria-label="Needs attention" className="space-y-3 border-b pb-3">
        <Row gap="sm" align="center" wrap>
          <h2 className="text-base font-semibold">Needs attention</h2>
          <span className="text-sm text-muted-foreground tabular-nums">
            {attention.data
              ? `${attention.data.total} matching jobs`
              : "Loading…"}
          </span>
          <Button
            type="button"
            variant={filters.attentionOnly ? "secondary" : "outline"}
            size="sm"
            aria-pressed={filters.attentionOnly === true}
            onClick={() =>
              onFilterChange({
                attentionOnly: filters.attentionOnly ? undefined : true,
              })
            }
          >
            {filters.attentionOnly
              ? "Show all statuses"
              : "Show attention only"}
          </Button>
        </Row>
        {attention.error ? (
          <p role="alert" className="text-sm break-words text-destructive">
            {attention.error.message}
          </p>
        ) : null}
        {attention.data?.total === 0 ? (
          <p className="text-sm">No matching image jobs need attention.</p>
        ) : null}
        <RecordList aria-label="Image jobs needing attention">
          {attention.data?.items.map((job) => (
            <RecordRow
              key={job.id}
              leading={<WorkStateDot state={job.state} />}
              primary={<RunSubject run={job} />}
              clip={false}
              secondary={
                <>
                  <span className="text-foreground">
                    {workStateLabel(job.state)}
                  </span>
                  {" · "}
                  {job.workLabel}
                </>
              }
              actions={
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6"
                  onClick={() => select(job)}
                >
                  Open job
                </Button>
              }
              detail={
                job.error ? (
                  <RecordDetail summary="Failure details">
                    <pre className="max-h-48 overflow-auto text-xs break-words whitespace-pre-wrap">
                      {job.error}
                    </pre>
                  </RecordDetail>
                ) : null
              }
            />
          ))}
        </RecordList>
      </section>
      {workSummary !== undefined ? (
        <output aria-label="Matching jobs" className="block text-sm">
          {workSummary || "No matching image jobs"}
        </output>
      ) : null}
      <Row gap="sm" align="center" wrap>
        <Picker
          label="Work type"
          className="w-48"
          options={[
            { value: "", label: "All image work" },
            ...kinds.map((kind) => ({
              value: kind,
              label: ACTIVITY_KIND_LABEL[kind],
            })),
          ]}
          value={filters.kind ?? ""}
          onValueChange={(value) => selectFilter("kind", value ?? "")}
        />
        <Picker
          mode="choose"
          label="Job order"
          className="w-36"
          options={[
            { value: "newest", label: "Newest first" },
            { value: "oldest", label: "Oldest first" },
          ]}
          value={filters.sort ?? "newest"}
          onValueChange={(value) => selectFilter("sort", value ?? "newest")}
        />
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
      </Row>
      {more ? (
        <Row gap="sm" wrap>
          <Picker
            mode="choose"
            label="Execution location"
            className="w-36"
            options={[
              { value: "all", label: "All executors" },
              { value: "cloud", label: "Cloud" },
              { value: "device", label: "Device" },
              { value: "unknown", label: "Unknown" },
            ]}
            value={filters.executor ?? "all"}
            onValueChange={(value) => selectFilter("executor", value ?? "all")}
          />
          <Picker
            label="Execution device"
            className="w-48"
            options={[
              { value: "", label: "All devices" },
              ...(devices.data?.items ?? []).flatMap((device) =>
                device.deviceId
                  ? [{ value: device.deviceId, label: device.name }]
                  : [],
              ),
            ]}
            isLoading={devices.isLoading}
            value={filters.deviceId ?? ""}
            onValueChange={(value) => selectFilter("deviceId", value ?? "")}
          />
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
            type="datetime-local"
            aria-label="Jobs from"
            className="w-44"
            value={localDateTime(filters.from)}
            onChange={(event) =>
              onFilterChange({ from: toIso(event.target.value) })
            }
          />
          <Input
            type="datetime-local"
            aria-label="Jobs through"
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
        ariaLabel="Image jobs"
        isLoading={query.isLoading}
        error={query.error}
        infiniteScroll={infiniteScroll}
        emptyState="No image jobs match these filters."
        currentRowId={filters.selected}
        onRowClick={(row) => select(row.original)}
        getMobileDetailsHref={(row) => jobHref(row.id)}
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
            <SheetTitle className="sr-only">Image job detail</SheetTitle>
            {inspector}
          </SheetContent>
        </Sheet>
      ) : null}
    </Stack>
  );
}
