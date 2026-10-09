import { entitySchema, type Entity } from "@cubby/schemas/entity-core";
import type {
  McpUsageActivityOut,
  McpToolUsageStatus,
  McpUsageDashboardOut,
  McpUsageWindow,
} from "@cubby/schemas/telemetry";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { OnChangeFn, SortingState } from "@tanstack/react-table";
import {
  type ReactNode,
  useCallback,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

import { cursorQueryOptions } from "~/integrations/tanstack-query/cursor-query-options";
import { mcp } from "~/integrations/tanstack-query/generated/mcp.gen";
import { formatInstant } from "~/lib/date-format";
import { nivoBarChrome, nivoChartTheme } from "~/lib/nivo-theme";
import { statusTone } from "~/lib/status-tone";
import { formatCount } from "~/lib/utils";
import { RankedBarBreakdown } from "~/ui/charts/kit";
import { ResponsiveBar } from "~/ui/charts/nivo-responsive";
import { useTableColumnLayout } from "~/ui/data-table/column-layout";
import RTable from "~/ui/data-table/Table";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  useCubbyTable,
} from "~/ui/data-table/table-features";
import type { InfiniteScrollControls } from "~/ui/hooks/useInfiniteTableList";
import { Alert, AlertDescription, AlertTitle } from "~/ui/primitives/alert";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/ui/primitives/card";
import { Description } from "~/ui/primitives/description";
import { Input } from "~/ui/primitives/input";
import { Sheet, SheetContent, SheetTitle } from "~/ui/primitives/sheet";
import { Spinner } from "~/ui/primitives/spinner";

const windows: Array<{ label: string; value: McpUsageWindow }> = [
  { label: "7d", value: 7 },
  { label: "30d", value: 30 },
  { label: "90d", value: 90 },
  { label: "180d", value: 180 },
  { label: "Lifetime", value: "lifetime" },
];
const toolInspectorWidth = "(min-width: 1280px)";
const isToolInspectorDocked = () =>
  globalThis.window.matchMedia(toolInspectorWidth).matches;
const subscribeToolInspectorWidth = (callback: () => void) => {
  const media = globalThis.window.matchMedia(toolInspectorWidth);
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
};

const isNumber = (value: unknown): value is number => typeof value === "number";

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="border border-border bg-card p-4">
      <div className="font-mono text-xs tracking-wide text-muted-foreground uppercase">
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold">
        {isNumber(value) ? formatCount(value) : value}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: McpToolUsageStatus }) {
  return (
    <Badge variant={statusTone("mcpUsage", status)}>
      {status.toUpperCase()}
    </Badge>
  );
}

function formatOrNever(value: Date | null): string {
  return value ? formatInstant(value, "dateTime") : "Never";
}

function ChartCard({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="font-mono text-xs tracking-wide uppercase">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="h-[280px]">{children}</CardContent>
    </Card>
  );
}

type ToolRow = McpUsageDashboardOut["tools"][number];
type ToolSort =
  | "toolName"
  | "status"
  | "periodCalls"
  | "lifetimeCalls"
  | "lastUsedAt";

type ActivityRow = McpUsageActivityOut["entries"][number];

const DEFAULT_TOOL_SORT = {
  key: "periodCalls",
  descending: true,
} satisfies { key: ToolSort; descending: boolean };

function isToolSort(value: string): value is ToolSort {
  return (
    value === "toolName" ||
    value === "status" ||
    value === "periodCalls" ||
    value === "lifetimeCalls" ||
    value === "lastUsedAt"
  );
}

export function filterAndSortMcpTools(
  tools: ToolRow[],
  filter: { search: string; status: McpToolUsageStatus | "all" },
  sort: { key: ToolSort; descending: boolean },
): ToolRow[] {
  const needle = filter.search.trim().toLowerCase();
  return tools
    .filter(
      (tool) =>
        (filter.status === "all" || tool.status === filter.status) &&
        (!needle || tool.toolName.toLowerCase().includes(needle)),
    )
    .sort((left, right) => {
      const direction = sort.descending ? -1 : 1;
      if (sort.key === "lastUsedAt") {
        return (
          ((left.lastUsedAt?.getTime() ?? 0) -
            (right.lastUsedAt?.getTime() ?? 0)) *
          direction
        );
      }
      const a = left[sort.key];
      const b = right[sort.key];
      return (
        (isNumber(a) && isNumber(b)
          ? a - b
          : String(a).localeCompare(String(b))) * direction
      );
    });
}

function ToolAnnotations({ tool }: { tool: ToolRow }) {
  const annotations = tool.annotations;
  return (
    <div className="flex flex-wrap gap-2">
      <Badge variant={annotations?.readOnlyHint ? "outline" : "default"}>
        {annotations?.readOnlyHint ? "READ ONLY" : "WRITE"}
      </Badge>
      {annotations?.destructiveHint ? (
        <Badge variant="destructive">DESTRUCTIVE</Badge>
      ) : null}
      {annotations?.openWorldHint ? (
        <Badge variant="secondary">OPEN WORLD</Badge>
      ) : null}
      {annotations?.idempotentHint ? (
        <Badge variant="outline">IDEMPOTENT</Badge>
      ) : null}
    </div>
  );
}

function SchemaCard({
  title,
  schema,
}: {
  title: string;
  schema: object | null;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="font-mono text-xs uppercase">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {schema ? (
          <pre className="max-h-[360px] overflow-auto bg-muted p-4 text-xs">
            {JSON.stringify(schema, null, 2)}
          </pre>
        ) : (
          <Description>Not available for retired tools.</Description>
        )}
      </CardContent>
    </Card>
  );
}

function UsageCharts({ data }: { data: McpUsageDashboardOut }) {
  const ranked = data.tools
    .filter((tool) => tool.periodCalls > 0)
    .map((tool) => ({ tool: tool.toolName, calls: tool.periodCalls }));
  const callers = data.clients;

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <ChartCard title="Calls by day">
        {data.daily.length === 0 ? (
          <Description>No calls in this window.</Description>
        ) : (
          <ResponsiveBar
            data={data.daily}
            keys={["success", "error"]}
            indexBy="day"
            groupMode="stacked"
            colors={["var(--chart-1)", "var(--destructive)"]}
            margin={{ top: 10, right: 20, bottom: 55, left: 50 }}
            padding={0.25}
            {...nivoBarChrome}
            theme={nivoChartTheme}
            enableLabel={false}
            axisBottom={{ tickRotation: -45, tickSize: 0, tickPadding: 8 }}
            axisLeft={{ tickValues: 5 }}
          />
        )}
      </ChartCard>
      <ChartCard title="Most-used tools">
        <RankedBarBreakdown
          data={ranked}
          valueKey="calls"
          labelKey="tool"
          topN={15}
          height={280}
          margin={{ top: 10, right: 20, bottom: 40, left: 180 }}
          color={() => "var(--chart-2)"}
          formatValue={formatCount}
          axisBottomFormat={formatCount}
          emptyTitle="No tools used in this window."
        />
      </ChartCard>
      <ChartCard title="Calls by client">
        <RankedBarBreakdown
          data={callers}
          valueKey="count"
          labelKey="label"
          topN={12}
          height={280}
          margin={{ top: 10, right: 20, bottom: 40, left: 180 }}
          color={() => "var(--chart-3)"}
          formatValue={formatCount}
          axisBottomFormat={formatCount}
          emptyTitle="No caller data in this window."
        />
      </ChartCard>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="font-mono text-xs tracking-wide uppercase">
            Caller breakdown
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <div className="mb-2 text-xs text-muted-foreground">Surfaces</div>
            {data.surfaces.map((row) => (
              <div key={row.key} className="flex justify-between border-t py-2">
                <span>{row.label}</span>
                <span className="font-mono">{formatCount(row.count)}</span>
              </div>
            ))}
          </div>
          <div>
            <div className="mb-2 text-xs text-muted-foreground">Users</div>
            {data.users.map((row) => (
              <div key={row.key} className="flex justify-between border-t py-2">
                <span>{row.label}</span>
                <span className="font-mono">{formatCount(row.count)}</span>
              </div>
            ))}
          </div>
          <div>
            <div className="mb-2 text-xs text-muted-foreground">
              Entities acted on
            </div>
            {data.entities.map((row) => (
              <div key={row.key} className="flex justify-between border-t py-2">
                <span>{row.label}</span>
                <span className="font-mono">{formatCount(row.count)}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function ToolRosterTable({
  tools,
  sort,
  onSortChange,
  selectedTool,
  onSelectTool,
  search,
  additionalToolbarContent,
}: {
  tools: ToolRow[];
  sort: { key: ToolSort; descending: boolean };
  onSortChange: (next: { key: ToolSort; descending: boolean }) => void;
  selectedTool: string | null;
  onSelectTool: (toolName: string) => void;
  search: string;
  additionalToolbarContent: ReactNode;
}) {
  const helper = useMemo(() => createCubbyColumnHelper<ToolRow>(), []);
  const columns = useMemo(
    () =>
      createCubbyColumnCollection<ToolRow>((add) => {
        add(
          helper.accessor("toolName", {
            header: "Tool",
            size: 240,
            meta: {
              mono: true,
              mobile: { slot: "title", priority: 0 },
            },
          }),
        );
        add(
          helper.accessor("status", {
            header: "Status",
            size: 120,
            meta: { mobile: { slot: "subtitle", priority: 0 } },
            cell: ({ getValue }) => <StatusBadge status={getValue()} />,
          }),
        );
        add(
          helper.accessor("periodCalls", {
            header: "Window",
            size: 100,
            meta: {
              numeric: true,
              mobile: { slot: "trailing", priority: 0 },
            },
            cell: ({ getValue }) => formatCount(getValue()),
          }),
        );
        add(
          helper.accessor("lifetimeCalls", {
            header: "Lifetime",
            size: 100,
            meta: {
              numeric: true,
              mobile: { slot: "trailing", priority: 10 },
            },
            cell: ({ getValue }) => formatCount(getValue()),
          }),
        );
        add(
          helper.accessor(
            (row) =>
              row.periodCalls === 0
                ? "—"
                : `${((row.periodSuccesses / row.periodCalls) * 100).toFixed(1)}%`,
            {
              id: "success",
              header: "Success",
              size: 100,
              enableSorting: false,
              meta: { mobile: { slot: "meta", priority: 10 } },
            },
          ),
        );
        add(
          helper.accessor("firstUsedAt", {
            header: "First used",
            size: 190,
            enableSorting: false,
            meta: { mobile: { slot: "meta", priority: 20 } },
            cell: ({ getValue }) => formatOrNever(getValue()),
          }),
        );
        add(
          helper.accessor("lastUsedAt", {
            header: "Last used",
            size: 190,
            sortDescFirst: true,
            sortFn: (left, right, id) =>
              (left.getValue<Date | null>(id)?.getTime() ?? 0) -
              (right.getValue<Date | null>(id)?.getTime() ?? 0),
            meta: { mobile: { slot: "meta", priority: 30 } },
            cell: ({ getValue }) => formatOrNever(getValue()),
          }),
        );
        add(
          helper.accessor("lastRelease", {
            header: "Release",
            size: 120,
            enableSorting: false,
            meta: {
              mono: true,
              mobile: { slot: "meta", priority: 40 },
            },
            cell: ({ getValue }) => getValue()?.slice(0, 10) ?? "—",
          }),
        );
        add(
          helper.accessor((row) => row.users.length, {
            id: "users",
            header: "Users",
            size: 90,
            enableSorting: false,
            meta: {
              numeric: true,
              mobile: { slot: "meta", priority: 50 },
            },
            cell: ({ getValue }) => getValue() || "—",
          }),
        );
        add(
          helper.accessor(
            (row) =>
              row.clients
                .map((client) => client.name ?? client.id ?? "Unknown")
                .join(", "),
            {
              id: "clients",
              header: "Clients",
              size: 220,
              enableSorting: false,
              meta: { mobile: { slot: "meta", priority: 60 } },
              cell: ({ getValue }) => getValue() || "—",
            },
          ),
        );
      }),
    [helper],
  );
  const { columns: tableColumns, defaultLayout } = useTableColumnLayout({
    columns,
  });
  const sorting = useMemo<SortingState>(
    () => [{ id: sort.key, desc: sort.descending }],
    [sort],
  );
  const onSortingChange = useCallback<OnChangeFn<SortingState>>(
    (updater) => {
      // TanStack's controlled updater is a value-or-function by contract.
      // oxlint-disable-next-line anti-slop/no-runtime-typeof
      const next = typeof updater === "function" ? updater(sorting) : updater;
      const active = next[0];
      if (!active || !isToolSort(active.id)) {
        onSortChange(DEFAULT_TOOL_SORT);
        return;
      }
      onSortChange({
        key: active.id,
        descending: active.desc,
      });
    },
    [onSortChange, sorting],
  );
  const table = useCubbyTable({
    data: tools,
    columns: tableColumns,
    initialState: {
      columnOrder: defaultLayout.columnOrder,
      columnPinning: defaultLayout.columnPinning,
      columnVisibility: defaultLayout.columnVisibility,
    },
    meta: { defaultLayout },
    getRowId: (row) => row.toolName,
    manualFiltering: true,
    manualSorting: true,
    enableSortingRemoval: false,
    enableRowSelection: false,
    enableCellSelection: false,
    state: { sorting },
    onSortingChange,
  });

  return (
    <RTable
      table={table}
      ariaLabel="MCP tool pruning worklist"
      embedded
      showColumnMenu
      additionalToolbarContent={additionalToolbarContent}
      onRowClick={(row) => onSelectTool(row.original.toolName)}
      currentRowId={selectedTool ?? undefined}
      emptyState={
        search ? "No tools match this search." : "No registered tools."
      }
    />
  );
}

function ActivityTable({
  window,
  toolName,
  entity,
}: {
  window: McpUsageWindow;
  toolName: string | null;
  entity: Entity | null;
}) {
  const activityScope = useMemo(
    () => ({
      window,
      toolName: toolName ?? undefined,
      entity: entity ?? undefined,
      limit: 25,
    }),
    [entity, toolName, window],
  );
  const query = useInfiniteQuery(
    cursorQueryOptions(mcp.usageActivity, activityScope),
  );
  const entries = useMemo(
    () => query.data?.pages.flatMap((page) => page.entries) ?? [],
    [query.data],
  );
  const helper = useMemo(() => createCubbyColumnHelper<ActivityRow>(), []);
  const columns = useMemo(
    () =>
      createCubbyColumnCollection<ActivityRow>((add) => {
        add(
          helper.accessor("occurredAt", {
            header: "Time",
            size: 190,
            enableSorting: false,
            meta: {
              mono: true,
              mobile: { slot: "subtitle", priority: 0 },
            },
            cell: ({ getValue }) => formatOrNever(getValue()),
          }),
        );
        add(
          helper.accessor("toolName", {
            header: "Tool",
            size: 220,
            enableSorting: false,
            meta: {
              mono: true,
              mobile: { slot: "title", priority: 0 },
            },
          }),
        );
        add(
          helper.accessor("entity", {
            header: "Entity",
            size: 130,
            enableSorting: false,
            meta: {
              mono: true,
              mobile: { slot: "meta", priority: 10 },
            },
            cell: ({ getValue }) => getValue() ?? "—",
          }),
        );
        add(
          helper.accessor("outcome", {
            header: "Outcome",
            size: 110,
            enableSorting: false,
            meta: { mobile: { slot: "trailing", priority: 0 } },
            cell: ({ getValue }) => (
              <Badge
                variant={getValue() === "success" ? "outline" : "destructive"}
              >
                {getValue()}
              </Badge>
            ),
          }),
        );
        add(
          helper.accessor((row) => row.user.name ?? row.user.email, {
            id: "user",
            header: "User",
            size: 190,
            enableSorting: false,
            meta: { mobile: { slot: "meta", priority: 20 } },
          }),
        );
        add(
          helper.accessor(
            (row) => row.client.name ?? row.client.id ?? "Unknown",
            {
              id: "client",
              header: "Client",
              size: 170,
              enableSorting: false,
              meta: { mobile: { slot: "meta", priority: 30 } },
            },
          ),
        );
        add(
          helper.accessor((row) => row.surface.replaceAll("_", " "), {
            id: "surface",
            header: "Surface",
            size: 150,
            enableSorting: false,
            meta: { mobile: { slot: "meta", priority: 40 } },
          }),
        );
        add(
          helper.accessor("release", {
            header: "Release",
            size: 120,
            enableSorting: false,
            meta: {
              mono: true,
              mobile: { slot: "meta", priority: 50 },
            },
            cell: ({ getValue }) => getValue().slice(0, 10),
          }),
        );
      }),
    [helper],
  );
  const { columns: tableColumns, defaultLayout } = useTableColumnLayout({
    columns,
  });
  const table = useCubbyTable({
    data: entries,
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
  const { fetchNextPage, hasNextPage, isFetchingNextPage } = query;
  const infiniteScroll = useMemo<InfiniteScrollControls<ActivityRow>>(
    () => ({
      fetchNextPage: () => {
        void fetchNextPage();
      },
      hasNextPage,
      isFetchingNextPage,
      isTransitioning: false,
      loadAllPages: async () => entries,
    }),
    [entries, fetchNextPage, hasNextPage, isFetchingNextPage],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {toolName ? `Recent calls · ${toolName}` : "Global activity"}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <RTable
          table={table}
          ariaLabel={
            toolName ? `Recent calls for ${toolName}` : "Global activity"
          }
          embedded
          showColumnMenu
          isLoading={query.isLoading}
          error={query.error}
          infiniteScroll={infiniteScroll}
          emptyState="No captured calls."
        />
      </CardContent>
    </Card>
  );
}

export function McpUsageDashboard() {
  const [window, setWindow] = useState<McpUsageWindow>(90);
  const [status, setStatus] = useState<McpToolUsageStatus | "all">("all");
  const [search, setSearch] = useState("");
  const [selectedTool, setSelectedTool] = useState<string | null>(null);
  const [entityFilter, setEntityFilter] = useState<Entity | null>(null);
  const [sort, setSort] = useState<{
    key: ToolSort;
    descending: boolean;
  }>(DEFAULT_TOOL_SORT);
  const query = useQuery(mcp.usageDashboard.queryOptions({ window }));
  const data = query.data;
  const tools = useMemo(() => {
    if (!data) return [];
    return filterAndSortMcpTools(data.tools, { search, status }, sort);
  }, [data, search, sort, status]);
  const selected = data?.tools.find((tool) => tool.toolName === selectedTool);

  const wide = useSyncExternalStore(
    subscribeToolInspectorWidth,
    isToolInspectorDocked,
    () => false,
  );

  if (query.isLoading) return <Spinner />;
  if (query.error) {
    return (
      <Description className="text-destructive">
        Failed to load MCP usage: {query.error.message}
      </Description>
    );
  }
  if (!data) return null;

  const errorRate =
    data.totals.calls === 0
      ? "0%"
      : `${((data.totals.errors / data.totals.calls) * 100).toFixed(1)}%`;

  const selectedDetail = selected ? (
    <div className="space-y-4 p-4">
      <Card>
        <CardHeader>
          <CardTitle className="font-mono">{selected.toolName}</CardTitle>
          {selected.description ? (
            <Description>{selected.description}</Description>
          ) : null}
        </CardHeader>
        <CardContent className="space-y-4">
          <ToolAnnotations tool={selected} />
          <div className="grid gap-4 md:grid-cols-4">
            <Metric label="Status" value={selected.status} />
            <Metric
              label="First used"
              value={formatOrNever(selected.firstUsedAt)}
            />
            <Metric
              label="Last used"
              value={formatOrNever(selected.lastUsedAt)}
            />
            <Metric
              label="Last release"
              value={selected.lastRelease?.slice(0, 10) ?? "—"}
            />
          </div>
        </CardContent>
      </Card>
      <div className="grid gap-4">
        <ChartCard title="Selected-tool trend">
          {selected.daily.length === 0 ? (
            <Description>No calls in this window.</Description>
          ) : (
            <ResponsiveBar
              data={selected.daily}
              keys={["success", "error"]}
              indexBy="day"
              groupMode="stacked"
              colors={["var(--chart-1)", "var(--destructive)"]}
              margin={{ top: 10, right: 20, bottom: 55, left: 50 }}
              {...nivoBarChrome}
              theme={nivoChartTheme}
              enableLabel={false}
              axisBottom={{ tickRotation: -45, tickSize: 0 }}
            />
          )}
        </ChartCard>
        <Card>
          <CardHeader>
            <CardTitle>Selected-tool callers</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <div>
              <div className="mb-2 text-xs text-muted-foreground">Users</div>
              {selected.users.map((user) => (
                <div key={user.id} className="border-t py-2">
                  {user.name ?? user.email}
                </div>
              ))}
            </div>
            <div>
              <div className="mb-2 text-xs text-muted-foreground">Clients</div>
              {selected.clients.map((client) => (
                <div key={client.id ?? "unknown"} className="border-t py-2">
                  {client.name ?? client.id ?? "Unknown"}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
      <div className="grid gap-4">
        <SchemaCard title="Input schema" schema={selected.inputSchema} />
        <SchemaCard title="Output schema" schema={selected.outputSchema} />
      </div>
      <ActivityTable
        window={window}
        toolName={selected.toolName}
        entity={entityFilter}
      />
    </div>
  ) : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2">
        {windows.map((item) => (
          <Button
            key={item.label}
            variant={window === item.value ? "secondary" : "outline"}
            onClick={() => setWindow(item.value)}
          >
            {item.label}
          </Button>
        ))}
      </div>

      {!data.observationComplete && window !== "lifetime" ? (
        <Alert>
          <WarningIcon />
          <AlertTitle>Incomplete observation window</AlertTitle>
          <AlertDescription>
            {data.observationStartedAt
              ? `Telemetry began ${formatOrNever(data.observationStartedAt)}. `
              : "No MCP calls have been captured yet. "}
            Never and inactive classifications are provisional until the full
            window has elapsed.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
        <Metric label="Registered" value={data.totals.registered} />
        <Metric label="Active" value={data.totals.active} />
        <Metric label="Inactive" value={data.totals.inactive} />
        <Metric label="Never" value={data.totals.never} />
        <Metric label="Retired" value={data.totals.retired} />
        <Metric label="Calls" value={data.totals.calls} />
        <Metric label="Error rate" value={errorRate} />
      </div>

      <UsageCharts data={data} />

      <div className={selected ? "relative xl:pr-[25rem]" : "relative"}>
        <Card>
          <CardHeader>
            <CardTitle>Tool pruning worklist</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <ToolRosterTable
              tools={tools}
              sort={sort}
              onSortChange={setSort}
              selectedTool={selectedTool}
              onSelectTool={setSelectedTool}
              search={search}
              additionalToolbarContent={
                <div className="flex flex-wrap gap-2">
                  <Input
                    className="max-w-sm"
                    placeholder="Search tools…"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                  {(
                    ["all", "active", "inactive", "never", "retired"] as const
                  ).map((value) => (
                    <Button
                      key={value}
                      variant={status === value ? "secondary" : "outline"}
                      onClick={() => setStatus(value)}
                    >
                      {value}
                    </Button>
                  ))}
                </div>
              }
            />
          </CardContent>
        </Card>

        {selected && wide ? (
          <aside
            aria-label="Selected tool detail"
            className="absolute inset-y-0 right-0 w-[25rem] overflow-y-auto border-l border-border bg-background"
          >
            <Button
              variant="ghost"
              size="sm"
              className="m-3"
              onClick={() => setSelectedTool(null)}
            >
              Close
            </Button>
            {selectedDetail}
          </aside>
        ) : null}
        {selected && !wide ? (
          <Sheet
            open
            onOpenChange={(open) => {
              if (!open) setSelectedTool(null);
            }}
          >
            <SheetContent
              side="right"
              showCloseButton={false}
              className="!w-[25rem] !max-w-[calc(100vw-2rem)] overflow-y-auto p-0"
            >
              <SheetTitle className="sr-only">Selected tool detail</SheetTitle>
              <Button
                variant="ghost"
                size="sm"
                className="m-3"
                onClick={() => setSelectedTool(null)}
              >
                Close
              </Button>
              {selectedDetail}
            </SheetContent>
          </Sheet>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs tracking-wide text-muted-foreground uppercase">
          Entity
        </span>
        <Button
          variant={entityFilter === null ? "secondary" : "outline"}
          onClick={() => setEntityFilter(null)}
        >
          All
        </Button>
        {data.entities
          .filter((row) => row.key !== "unknown")
          .map((row) => (
            <Button
              key={row.key}
              variant={entityFilter === row.key ? "secondary" : "outline"}
              onClick={() => {
                const entity = entitySchema.safeParse(row.key).data;
                if (entity) setEntityFilter(entity);
              }}
            >
              {row.label}
            </Button>
          ))}
      </div>

      <ActivityTable window={window} toolName={null} entity={entityFilter} />
    </div>
  );
}
