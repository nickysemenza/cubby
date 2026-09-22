import { activityKind, type ActivityRun } from "@cubby/schemas/activity";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { z } from "zod";

import { useTableColumnLayout } from "~/app/_components/data-table/column-layout";
import RTable from "~/app/_components/data-table/Table";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  useCubbyTable,
} from "~/app/_components/data-table/table-features";
import type { InfiniteScrollControls } from "~/app/_components/hooks/useInfiniteTableList";
import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { NativeSelect } from "~/components/ui/native-select";
import { activity } from "~/lib/activity.functions";
import { formatCurrency } from "~/lib/utils";

type ActivityKind = z.output<typeof activityKind>;

const kinds: readonly ActivityKind[] = [
  "purchase_import",
  "purchase_validation",
  "product_enrichment",
  "photo_inventory",
  "describe_image",
  "subject_lift",
];

const label = (value: string) => value.replaceAll("_", " ");
const moment = (value: string) => new Date(value).toLocaleString();
const localDateTime = (value?: string) => {
  if (!value) return "";
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
};
const duration = (value: number | null) =>
  value == null ? "—" : `${(value / 1_000).toFixed(1)} s`;

export function ActivityRuns({
  kind,
  state,
  subjectId,
  submissionId,
  from,
  to,
  sort,
  deviceId,
  executor,
  onKindChange,
  onStateChange,
  onSubjectIdChange,
  onSubmissionIdChange,
  onFromChange,
  onToChange,
  onSortChange,
  onDeviceIdChange,
  onExecutorChange,
  onSelect,
}: {
  kind: ActivityKind | undefined;
  state: string | undefined;
  subjectId: string | undefined;
  submissionId: string | undefined;
  from: string | undefined;
  to: string | undefined;
  sort: "newest" | "oldest";
  deviceId: string | undefined;
  executor: "all" | "cloud" | "device" | "unknown";
  onKindChange: (value: ActivityKind | undefined) => void;
  onStateChange: (value: string | undefined) => void;
  onSubjectIdChange: (value: string | undefined) => void;
  onSubmissionIdChange: (value: string | undefined) => void;
  onFromChange: (value: string | undefined) => void;
  onToChange: (value: string | undefined) => void;
  onSortChange: (value: "newest" | "oldest") => void;
  onDeviceIdChange: (value: string | undefined) => void;
  onExecutorChange: (value: "all" | "cloud" | "device" | "unknown") => void;
  onSelect: (id: string) => void;
}) {
  const devices = useQuery(activity.devices.queryOptions({}));
  const query = useInfiniteQuery(
    activity.list.infiniteQueryOptions(
      {
        limit: 20,
        kind,
        state,
        subjectId,
        submissionId,
        from,
        to,
        sort,
        executor,
        deviceId,
      },
      {
        pageParamSchema: z.nullable(z.string()),
        initialPageParam: null,
        getNextPageParam: (page) => page.nextCursor ?? undefined,
        page: (input, cursor) => {
          const next = { ...input };
          if (cursor !== null) next.cursor = cursor;
          return next;
        },
      },
    ),
  );
  const rows = useMemo(
    () => query.data?.pages.flatMap((page) => page.items) ?? [],
    [query.data],
  );
  const hasActiveRun = rows.some((row) => row.active);
  useEffect(() => {
    if (!hasActiveRun) return;
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void query.refetch();
    }, 15_000);
    return () => window.clearInterval(interval);
  }, [hasActiveRun, query]);
  const helper = useMemo(() => createCubbyColumnHelper<ActivityRun>(), []);
  const columns = useMemo(
    () =>
      createCubbyColumnCollection<ActivityRun>((add) => {
        add(
          helper.accessor("subjectName", {
            header: "Subject",
            size: 260,
            meta: { surplus: true, mobile: { slot: "title", priority: 1 } },
            cell: ({ row, getValue }) =>
              row.original.subjectHref ? (
                <a
                  className="text-primary hover:underline"
                  href={row.original.subjectHref}
                >
                  {getValue()}
                </a>
              ) : (
                getValue()
              ),
          }),
        );
        add(
          helper.accessor("kind", {
            header: "Run",
            size: 150,
            cell: ({ getValue }) => label(getValue()),
            meta: { mobile: { slot: "meta", priority: 10 } },
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
          helper.accessor("executors", {
            header: "Executor",
            size: 150,
            enableSorting: false,
            cell: ({ getValue }) =>
              getValue()
                .map((item) => item.name)
                .join(", ") || "Unknown",
            meta: { mobile: { slot: "meta", priority: 30 } },
          }),
        );
        add(
          helper.accessor("attempts", {
            header: "Attempts",
            size: 75,
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
            cell: ({ getValue }) => {
              const value = getValue();
              return value === null ? "—" : formatCurrency(value);
            },
            meta: { mono: true, numeric: true },
          }),
        );
        add(
          helper.accessor("hasDiagnostics", {
            header: "Diagnostics",
            size: 95,
            cell: ({ getValue }) => (getValue() ? "Available" : "—"),
          }),
        );
        add(
          helper.accessor("createdAt", {
            header: "Submitted",
            size: 180,
            cell: ({ getValue }) => moment(getValue()),
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

  return (
    <Stack gap="sm">
      <Row justify="between" align="center" gap="sm" wrap>
        <p className="text-muted-foreground">
          {query.data?.pages[0]?.total ?? 0} runs · Background and device work
          across the household.
        </p>
        <Row gap="sm" wrap>
          <NativeSelect
            value={kind ?? ""}
            aria-label="Work type"
            onChange={(event) =>
              onKindChange(activityKind.safeParse(event.target.value).data)
            }
          >
            <option value="">All work</option>
            {kinds.map((item) => (
              <option key={item} value={item}>
                {label(item)}
              </option>
            ))}
          </NativeSelect>
          <NativeSelect
            value={executor}
            aria-label="Execution location"
            onChange={(event) => {
              const parsed = z
                .enum(["all", "cloud", "device", "unknown"])
                .safeParse(event.target.value);
              if (parsed.success) onExecutorChange(parsed.data);
            }}
          >
            <option value="all">All executors</option>
            <option value="cloud">Cloud</option>
            <option value="device">Device</option>
            <option value="unknown">Unknown</option>
          </NativeSelect>
          <NativeSelect
            value={deviceId ?? ""}
            aria-label="Execution device"
            onChange={(event) =>
              onDeviceIdChange(event.target.value || undefined)
            }
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
          <NativeSelect
            value={sort}
            aria-label="Run order"
            onChange={(event) =>
              onSortChange(
                event.target.value === "oldest" ? "oldest" : "newest",
              )
            }
          >
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
          </NativeSelect>
          <Input
            value={state ?? ""}
            onChange={(event) => onStateChange(event.target.value || undefined)}
            placeholder="State"
            aria-label="Filter run state"
            className="w-28"
          />
          <Input
            value={subjectId ?? ""}
            onChange={(event) =>
              onSubjectIdChange(event.target.value || undefined)
            }
            placeholder="Subject"
            aria-label="Filter run subject"
            className="w-32"
          />
          <Input
            value={submissionId ?? ""}
            onChange={(event) =>
              onSubmissionIdChange(event.target.value || undefined)
            }
            placeholder="Submission"
            aria-label="Filter submission"
            className="w-32"
          />
          <Input
            type="datetime-local"
            value={localDateTime(from)}
            onChange={(event) =>
              onFromChange(
                event.target.value
                  ? new Date(event.target.value).toISOString()
                  : undefined,
              )
            }
            aria-label="Runs from"
            className="w-44"
          />
          <Input
            type="datetime-local"
            value={localDateTime(to)}
            onChange={(event) =>
              onToChange(
                event.target.value
                  ? new Date(event.target.value).toISOString()
                  : undefined,
              )
            }
            aria-label="Runs through"
            className="w-44"
          />
        </Row>
      </Row>
      <RTable
        table={table}
        ariaLabel="Activity runs"
        isLoading={query.isLoading}
        error={query.error}
        infiniteScroll={infiniteScroll}
        emptyState="No activity runs match these filters."
        onRowClick={(row) => onSelect(row.original.id)}
      />
      <Button
        variant="outline"
        size="sm"
        disabled={query.isFetching}
        onClick={() => void query.refetch()}
      >
        Refresh runs
      </Button>
    </Stack>
  );
}
