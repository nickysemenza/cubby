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
import { type ReactNode, useCallback, useMemo, useState } from "react";

import type { InfiniteScrollControls } from "~/entity/hooks/use-infinite-table-list";
import RTable from "~/entity/table/table";
import { cursorQueryOptions } from "~/integrations/tanstack-query/cursor-query-options";
import { mcp } from "~/integrations/tanstack-query/generated/domains/mcp.gen";
import { formatTimestamp } from "~/lib/date-format";
import { nivoBarChrome, nivoChartTheme } from "~/lib/nivo-theme";
import { formatCount } from "~/lib/number-format";
import { statusTone } from "~/lib/status-tone";
import { RankedBarBreakdown } from "~/ui/charts/kit";
import { ResponsiveBar } from "~/ui/charts/nivo-responsive";
import { DateDisplay } from "~/ui/common/date-display";
import { KeyNumbers } from "~/ui/common/key-numbers";
import { useTableColumnLayout } from "~/ui/data-table/column-layout";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  useCubbyTable,
} from "~/ui/data-table/table-features";
import { Section } from "~/ui/layout";
import { SidePanel, SidePanelLayout } from "~/ui/overlays/side-panel";
import { Alert, AlertDescription, AlertTitle } from "~/ui/primitives/alert";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import { Description } from "~/ui/primitives/description";
import { Input } from "~/ui/primitives/input";
import { Spinner } from "~/ui/primitives/spinner";

const windows: Array<{ label: string; value: McpUsageWindow }> = [
  { label: "7d", value: 7 },
  { label: "30d", value: 30 },
  { label: "90d", value: 90 },
  { label: "180d", value: 180 },
  { label: "Lifetime", value: "lifetime" },
];

const isNumber = (value: unknown): value is number => typeof value === "number";

function StatusBadge({ status }: { status: McpToolUsageStatus }) {
  const label = status.replaceAll("_", " ");
  return (
    <Badge variant={statusTone("mcpUsage", status)}>
      {label.charAt(0).toUpperCase() + label.slice(1)}
    </Badge>
  );
}

function formatOrNever(value: Date | null): string {
  return value ? formatTimestamp(value) : "Never";
}

function ChartCard({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <Section headingAs="h2" title={title}>
      <div className="h-[280px]">{children}</div>
    </Section>
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
        {annotations?.readOnlyHint ? "Read only" : "Write"}
      </Badge>
      {annotations?.destructiveHint ? (
        <Badge variant="destructive">Destructive</Badge>
      ) : null}
      {annotations?.openWorldHint ? (
        <Badge variant="secondary">Open world</Badge>
      ) : null}
      {annotations?.idempotentHint ? (
        <Badge variant="outline">Idempotent</Badge>
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
    <Section headingAs="h2" title={title}>
      {schema ? (
        <pre className="max-h-[360px] overflow-auto bg-muted p-4 text-xs">
          {JSON.stringify(schema, null, 2)}
        </pre>
      ) : (
        <Description>Not available for retired tools.</Description>
      )}
    </Section>
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
      <Section headingAs="h2" title="Caller breakdown">
        <div className="space-y-4">
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
        </div>
      </Section>
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
            cell: ({ getValue }) => {
              const at = getValue();
              return at ? <DateDisplay timestamp={at} /> : "Never";
            },
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
            cell: ({ getValue }) => {
              const at = getValue();
              return at ? <DateDisplay timestamp={at} /> : "Never";
            },
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
      withoutImages="Rows are MCP tools."
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
            cell: ({ getValue }) => {
              const at = getValue();
              return at ? <DateDisplay timestamp={at} /> : "Never";
            },
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
    <Section
      headingAs="h2"
      title={toolName ? `Recent calls · ${toolName}` : "Global activity"}
    >
      <div className="space-y-4">
        <RTable
          table={table}
          ariaLabel={
            toolName ? `Recent calls for ${toolName}` : "Global activity"
          }
          withoutImages="Rows are MCP calls."
          embedded
          showColumnMenu
          isLoading={query.isLoading}
          error={query.error}
          infiniteScroll={infiniteScroll}
          emptyState="No captured calls."
        />
      </div>
    </Section>
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
  const step = (direction: -1 | 1) => {
    const index = tools.findIndex((tool) => tool.toolName === selectedTool);
    const next = tools[index + direction];
    if (index >= 0 && next) setSelectedTool(next.toolName);
  };

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
    <div className="space-y-4 p-3">
      {selected.description ? (
        <Description>{selected.description}</Description>
      ) : null}
      <div className="space-y-4 pt-4">
        <ToolAnnotations tool={selected} />
        <KeyNumbers
          layout="strip"
          label={`${selected.toolName} usage`}
          items={[
            { label: "Status", value: selected.status },
            { label: "First used", value: formatOrNever(selected.firstUsedAt) },
            { label: "Last used", value: formatOrNever(selected.lastUsedAt) },
            {
              label: "Last release",
              value: selected.lastRelease?.slice(0, 10) ?? "—",
            },
          ]}
        />
      </div>
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
        <Section headingAs="h2" title="Selected-tool callers">
          <div className="grid gap-4 md:grid-cols-2">
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
          </div>
        </Section>
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

      <KeyNumbers
        layout="strip"
        label="MCP usage summary"
        items={[
          { label: "Registered", value: formatCount(data.totals.registered) },
          { label: "Active", value: formatCount(data.totals.active) },
          { label: "Inactive", value: formatCount(data.totals.inactive) },
          { label: "Never", value: formatCount(data.totals.never) },
          { label: "Retired", value: formatCount(data.totals.retired) },
          { label: "Calls", value: formatCount(data.totals.calls) },
          { label: "Error rate", value: errorRate },
        ]}
      />

      <UsageCharts data={data} />

      <SidePanelLayout
        title="Selected tool detail"
        onClose={() => setSelectedTool(null)}
        panel={
          selected ? (
            <SidePanel
              label="Selected tool detail"
              eyebrow="MCP tool"
              title={<span className="font-mono">{selected.toolName}</span>}
              code={selected.toolName}
              onClose={() => setSelectedTool(null)}
              onPrev={() => step(-1)}
              onNext={() => step(1)}
            >
              {selectedDetail}
            </SidePanel>
          ) : null
        }
      >
        <Section headingAs="h2" title="Tool pruning worklist">
          <div className="space-y-4">
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
          </div>
        </Section>
      </SidePanelLayout>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">
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
