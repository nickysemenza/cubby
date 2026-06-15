import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useTableDensity } from "~/app/_components/data-table/useTableDensity";
import { EntityLayout } from "~/components/layouts/entity-layout";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Switch } from "~/components/ui/switch";
import { getErrorMessage } from "~/lib/error-utils";
import {
  FLAG_KEYS,
  FLAGS,
  type FlagGroup,
  type FlagKey,
  isDevBuildOnlyFlag,
  useFlags,
} from "~/lib/flags";
import { queryKeys } from "~/lib/query-keys";
import type { TimingResponse } from "~/routes/api/debug/timing";

export const Route = createFileRoute("/_authenticated/settings")({
  component: SettingsPage,
  head: () => ({ meta: [{ title: "Settings | cubby" }] }),
});

const GROUPS: { group: FlagGroup; blurb: string }[] = [
  {
    group: "Developer",
    blurb: "Diagnostics and debug tooling. Safe to leave on; off by default.",
  },
  {
    group: "Experimental",
    blurb: "Unfinished features — may change or break.",
  },
];

function SettingsPage() {
  const { flags, setFlag, resetFlags } = useFlags();
  return (
    <EntityLayout title="Settings">
      <div className="max-w-2xl space-y-4 pb-16">
        {GROUPS.map(({ group, blurb }) => {
          const keys = FLAG_KEYS.filter(
            (k) =>
              FLAGS[k].group === group &&
              // Hide toggles whose target is build-stripped in prod — flipping
              // them there does nothing, so the row would be a dead control.
              (import.meta.env.DEV || !isDevBuildOnlyFlag(k)),
          );
          if (keys.length === 0) return null;
          return (
            <Card key={group}>
              <CardHeader>
                <CardTitle>{group}</CardTitle>
                <CardDescription>{blurb}</CardDescription>
              </CardHeader>
              <CardContent className="divide-y divide-border/60">
                {keys.map((key) => (
                  <FlagRow
                    key={key}
                    flagKey={key}
                    value={flags[key]}
                    onChange={(v) => setFlag(key, v)}
                  />
                ))}
              </CardContent>
            </Card>
          );
        })}

        <DiagnosticsCard />

        <AppearanceCard />

        <Button variant="outline" size="sm" onClick={resetFlags}>
          Reset developer flags
        </Button>
      </div>
    </EntityLayout>
  );
}

function FlagRow({
  flagKey,
  value,
  onChange,
}: {
  flagKey: FlagKey;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  const def = FLAGS[flagKey];
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="space-y-0.5">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">{def.label}</span>
          <code className="font-mono text-2xs text-muted-foreground">
            {flagKey}
          </code>
        </div>
        <p className="text-muted-foreground text-xs">{def.description}</p>
      </div>
      <Switch checked={value} onCheckedChange={onChange} />
    </div>
  );
}

function DiagnosticsCard() {
  const { data, error, isFetching, refetch, dataUpdatedAt } =
    useQuery<TimingResponse>({
      queryKey: queryKeys.debug.timing,
      queryFn: async () => {
        const res = await fetch("/api/debug/timing");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<TimingResponse>;
      },
      staleTime: 60_000,
      refetchOnWindowFocus: false,
      retry: false,
    });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <CardTitle>Diagnostics</CardTitle>
            <CardDescription>
              Latency of core infrastructure — database, USDA API, and UPC
              lookup.
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="xs"
            onClick={() => refetch()}
            disabled={isFetching}
          >
            {isFetching ? "Measuring…" : "Re-run"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="divide-y divide-border/60">
        {error ? (
          <p className="py-3 text-destructive text-xs">
            Timing check failed: {getErrorMessage(error)}
          </p>
        ) : !data ? (
          <p className="py-3 text-muted-foreground text-xs">Measuring…</p>
        ) : (
          <>
            {data.results.map((result) => (
              <div
                key={result.label}
                className="flex items-start justify-between gap-4 py-2"
              >
                <div className="min-w-0 space-y-0.5">
                  <code className="block truncate font-mono text-muted-foreground text-xs">
                    {result.label}
                  </code>
                  {result.error && (
                    <p className="text-destructive text-xs">{result.error}</p>
                  )}
                </div>
                <span className="shrink-0 font-medium font-mono text-sm tabular-nums">
                  {result.durationMs} ms
                </span>
              </div>
            ))}
            <div className="flex items-center justify-between gap-4 py-2 text-muted-foreground text-xs">
              <span>
                Last run {new Date(dataUpdatedAt).toLocaleTimeString()}
              </span>
              <span className="font-mono tabular-nums">
                total {data.totalMs} ms
              </span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

const DENSITIES = ["comfortable", "compact", "dense"] as const;

function AppearanceCard() {
  const { density, setDensity } = useTableDensity();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Appearance</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between gap-4 py-1">
          <div className="space-y-0.5">
            <span className="font-medium text-sm">Table density</span>
            <p className="text-muted-foreground text-xs">
              Row height in data tables.
            </p>
          </div>
          <div className="flex gap-1">
            {DENSITIES.map((d) => (
              <Button
                key={d}
                size="xs"
                variant={density === d ? "default" : "outline"}
                onClick={() => setDensity(d)}
                className="capitalize"
              >
                {d}
              </Button>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
