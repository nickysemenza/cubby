import type {
  McpToolUsageStatus,
  McpUsageDashboardOut,
  McpUsageWindow,
} from "@cubby/schemas/telemetry";
import { ResponsiveBar } from "@nivo/bar";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Description } from "~/components/ui/description";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { useTRPC } from "~/integrations/trpc/react";
import { nivoBarChrome, nivoChartTheme } from "~/lib/nivo-theme";
import { formatCount } from "~/lib/utils";

const windows: Array<{ label: string; value: McpUsageWindow }> = [
  { label: "7d", value: 7 },
  { label: "30d", value: 30 },
  { label: "90d", value: 90 },
  { label: "180d", value: 180 },
  { label: "Lifetime", value: "lifetime" },
];

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="border border-border bg-card p-4">
      <div className="font-mono text-muted-foreground text-xs uppercase tracking-wide">
        {label}
      </div>
      <div className="mt-1 font-semibold text-2xl">
        {typeof value === "number" ? formatCount(value) : value}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: McpToolUsageStatus }) {
  const variant =
    status === "active"
      ? "default"
      : status === "never" || status === "retired"
        ? "outline"
        : "secondary";
  return <Badge variant={variant}>{status.toUpperCase()}</Badge>;
}

function formatDate(value: Date | null): string {
  if (!value) return "Never";
  return new Date(value).toLocaleString();
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
        <CardTitle className="font-mono text-xs uppercase tracking-wide">
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
        (typeof a === "number" && typeof b === "number"
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
    .slice(0, 15)
    .reverse()
    .map((tool) => ({ tool: tool.toolName, calls: tool.periodCalls }));
  const callers = data.clients.slice(0, 12).reverse();

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
        {ranked.length === 0 ? (
          <Description>No tools used in this window.</Description>
        ) : (
          <ResponsiveBar
            data={ranked}
            keys={["calls"]}
            indexBy="tool"
            layout="horizontal"
            colors={["var(--chart-2)"]}
            margin={{ top: 10, right: 20, bottom: 40, left: 180 }}
            padding={0.25}
            {...nivoBarChrome}
            theme={nivoChartTheme}
            enableLabel={false}
            axisBottom={{ tickValues: 5 }}
            axisLeft={{ tickSize: 0, tickPadding: 8 }}
          />
        )}
      </ChartCard>
      <ChartCard title="Calls by client">
        {callers.length === 0 ? (
          <Description>No caller data in this window.</Description>
        ) : (
          <ResponsiveBar
            data={callers}
            keys={["count"]}
            indexBy="label"
            layout="horizontal"
            colors={["var(--chart-3)"]}
            margin={{ top: 10, right: 20, bottom: 40, left: 180 }}
            padding={0.25}
            {...nivoBarChrome}
            theme={nivoChartTheme}
            enableLabel={false}
            axisBottom={{ tickValues: 5 }}
            axisLeft={{ tickSize: 0, tickPadding: 8 }}
          />
        )}
      </ChartCard>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="font-mono text-xs uppercase tracking-wide">
            Caller breakdown
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <div className="mb-2 text-muted-foreground text-xs">Surfaces</div>
            {data.surfaces.map((row) => (
              <div key={row.key} className="flex justify-between border-t py-2">
                <span>{row.label}</span>
                <span className="font-mono">{formatCount(row.count)}</span>
              </div>
            ))}
          </div>
          <div>
            <div className="mb-2 text-muted-foreground text-xs">Users</div>
            {data.users.map((row) => (
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

function ActivityTable({
  window,
  toolName,
}: {
  window: McpUsageWindow;
  toolName: string | null;
}) {
  const api = useTRPC();
  const query = useInfiniteQuery({
    ...api.mcp.usageActivity.infiniteQueryOptions(
      { window, toolName: toolName ?? undefined, limit: 25 },
      { getNextPageParam: (page) => page.nextCursor },
    ),
  });
  const entries = query.data?.pages.flatMap((page) => page.entries) ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {toolName ? `Recent calls · ${toolName}` : "Global activity"}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 overflow-x-auto">
        {query.isLoading ? (
          <Spinner />
        ) : query.error ? (
          <Description className="text-destructive">
            Failed to load activity: {query.error.message}
          </Description>
        ) : entries.length === 0 ? (
          <Description>No captured calls.</Description>
        ) : (
          <Table className="table-auto">
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Tool</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead>User</TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Surface</TableHead>
                <TableHead>Release</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell className="whitespace-nowrap">
                    {formatDate(entry.occurredAt)}
                  </TableCell>
                  <TableCell className="font-mono">{entry.toolName}</TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        entry.outcome === "success" ? "outline" : "destructive"
                      }
                    >
                      {entry.outcome}
                    </Badge>
                  </TableCell>
                  <TableCell>{entry.user.name ?? entry.user.email}</TableCell>
                  <TableCell>
                    {entry.client.name ?? entry.client.id ?? "Unknown"}
                  </TableCell>
                  <TableCell>{entry.surface.replaceAll("_", " ")}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {entry.release.slice(0, 10)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {query.hasNextPage ? (
          <Button
            variant="outline"
            onClick={() => query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
          >
            {query.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function McpUsageDashboard() {
  const api = useTRPC();
  const [window, setWindow] = useState<McpUsageWindow>(90);
  const [status, setStatus] = useState<McpToolUsageStatus | "all">("all");
  const [search, setSearch] = useState("");
  const [selectedTool, setSelectedTool] = useState<string | null>(null);
  const [sort, setSort] = useState<{
    key: ToolSort;
    descending: boolean;
  }>({ key: "periodCalls", descending: true });
  const query = useQuery(api.mcp.usageDashboard.queryOptions({ window }));
  const data = query.data;
  const tools = useMemo(() => {
    if (!data) return [];
    return filterAndSortMcpTools(data.tools, { search, status }, sort);
  }, [data, search, sort, status]);
  const selected = data?.tools.find((tool) => tool.toolName === selectedTool);

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
          <AlertTriangle />
          <AlertTitle>Incomplete observation window</AlertTitle>
          <AlertDescription>
            {data.observationStartedAt
              ? `Telemetry began ${formatDate(data.observationStartedAt)}. `
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

      <Card>
        <CardHeader>
          <CardTitle>Tool pruning worklist</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 overflow-x-auto">
          <div className="flex flex-wrap gap-2">
            <Input
              className="max-w-sm"
              placeholder="Search tools…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            {(["all", "active", "inactive", "never", "retired"] as const).map(
              (value) => (
                <Button
                  key={value}
                  variant={status === value ? "secondary" : "outline"}
                  onClick={() => setStatus(value)}
                >
                  {value}
                </Button>
              ),
            )}
          </div>
          <Table className="table-auto">
            <TableHeader>
              <TableRow>
                {(
                  [
                    ["toolName", "Tool"],
                    ["status", "Status"],
                    ["periodCalls", "Window"],
                    ["lifetimeCalls", "Lifetime"],
                  ] as const
                ).map(([key, label]) => (
                  <TableHead key={key}>
                    <button
                      type="button"
                      className="font-medium"
                      onClick={() =>
                        setSort((current) => ({
                          key,
                          descending:
                            current.key === key ? !current.descending : false,
                        }))
                      }
                    >
                      {label}
                      {sort.key === key ? (sort.descending ? " ↓" : " ↑") : ""}
                    </button>
                  </TableHead>
                ))}
                <TableHead>Success</TableHead>
                <TableHead>First used</TableHead>
                <TableHead>
                  <button
                    type="button"
                    className="font-medium"
                    onClick={() =>
                      setSort((current) => ({
                        key: "lastUsedAt",
                        descending:
                          current.key === "lastUsedAt"
                            ? !current.descending
                            : true,
                      }))
                    }
                  >
                    Last used
                    {sort.key === "lastUsedAt"
                      ? sort.descending
                        ? " ↓"
                        : " ↑"
                      : ""}
                  </button>
                </TableHead>
                <TableHead>Release</TableHead>
                <TableHead>Users</TableHead>
                <TableHead>Clients</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tools.map((tool) => (
                <TableRow
                  key={tool.toolName}
                  className="cursor-pointer"
                  onClick={() => setSelectedTool(tool.toolName)}
                >
                  <TableCell className="font-mono">{tool.toolName}</TableCell>
                  <TableCell>
                    <StatusBadge status={tool.status} />
                  </TableCell>
                  <TableCell>{formatCount(tool.periodCalls)}</TableCell>
                  <TableCell>{formatCount(tool.lifetimeCalls)}</TableCell>
                  <TableCell>
                    {tool.periodCalls === 0
                      ? "—"
                      : `${((tool.periodSuccesses / tool.periodCalls) * 100).toFixed(1)}%`}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {formatDate(tool.firstUsedAt)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {formatDate(tool.lastUsedAt)}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {tool.lastRelease?.slice(0, 10) ?? "—"}
                  </TableCell>
                  <TableCell>{tool.users.length || "—"}</TableCell>
                  <TableCell>
                    {tool.clients
                      .map((client) => client.name ?? client.id ?? "Unknown")
                      .join(", ") || "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {selected ? (
        <div className="space-y-4">
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
                  value={formatDate(selected.firstUsedAt)}
                />
                <Metric
                  label="Last used"
                  value={formatDate(selected.lastUsedAt)}
                />
                <Metric
                  label="Last release"
                  value={selected.lastRelease?.slice(0, 10) ?? "—"}
                />
              </div>
            </CardContent>
          </Card>
          <div className="grid gap-4 xl:grid-cols-2">
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
                  <div className="mb-2 text-muted-foreground text-xs">
                    Users
                  </div>
                  {selected.users.map((user) => (
                    <div key={user.id} className="border-t py-2">
                      {user.name ?? user.email}
                    </div>
                  ))}
                </div>
                <div>
                  <div className="mb-2 text-muted-foreground text-xs">
                    Clients
                  </div>
                  {selected.clients.map((client) => (
                    <div key={client.id ?? "unknown"} className="border-t py-2">
                      {client.name ?? client.id ?? "Unknown"}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>
          <div className="grid gap-4 xl:grid-cols-2">
            <SchemaCard title="Input schema" schema={selected.inputSchema} />
            <SchemaCard title="Output schema" schema={selected.outputSchema} />
          </div>
          <ActivityTable window={window} toolName={selected.toolName} />
        </div>
      ) : null}

      <ActivityTable window={window} toolName={null} />
    </div>
  );
}
