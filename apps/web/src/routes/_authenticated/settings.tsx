import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ChevronDown, Wrench } from "lucide-react";
import { useState } from "react";

import { useTableDensity } from "~/app/_components/data-table/useTableDensity";
import { CategoryAudit } from "~/app/_components/insights/category-audit";
import { MaintenanceCard } from "~/app/problems/components/maintenance-card";
import { Row, Stack } from "~/components/layout";
import { Page } from "~/components/page/Page";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "~/components/ui/collapsible";
import { Description } from "~/components/ui/description";
import { Eyebrow } from "~/components/ui/eyebrow";
import { StatusText } from "~/components/ui/status-text";
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
import { pageTitle } from "~/lib/page-title";
import type { TimingResponse } from "~/routes/api/debug/timing";

export const Route = createFileRoute("/_authenticated/settings")({
  component: SettingsPage,
  head: () => ({ meta: [{ title: pageTitle("Settings") }] }),
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
  const [devOpen, setDevOpen] = useState(false);
  return (
    <Page variant="list" title="Settings">
      <Stack gap="md" className="max-w-2xl pb-6 md:gap-6">
        {/* User-facing settings — the everyday prefs, kept above the fold. */}
        <AppearanceCard />

        {/* Everything dev/debug/maintenance lives behind one collapsed
            disclosure so the user-facing prefs above aren't drowned in flags. */}
        <Collapsible open={devOpen} onOpenChange={setDevOpen}>
          <CollapsibleTrigger
            render={
              <button
                type="button"
                aria-label="Toggle developer tools"
                className="flex min-h-11 w-full items-center justify-between border border-[var(--border)] bg-muted/40 px-2 py-2 text-left transition-colors hover:bg-muted md:px-4"
              />
            }
          >
            <Row align="center" gap="sm">
              <Wrench className="size-4 text-muted-foreground" />
              <Stack gap="tight">
                <Eyebrow as="span">Developer / Maintenance</Eyebrow>
                <Description size="xs">
                  Feature flags, diagnostics, and force-run batch fixes.
                </Description>
              </Stack>
            </Row>
            <ChevronDown
              className={`size-4 shrink-0 text-muted-foreground transition-transform ${
                devOpen ? "rotate-180" : ""
              }`}
            />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <Stack gap="lg" className="pt-4">
              {GROUPS.map(({ group, blurb }) => {
                const keys = FLAG_KEYS.filter(
                  (k) =>
                    FLAGS[k].group === group &&
                    // Hide toggles whose target is build-stripped in prod —
                    // flipping them there does nothing, so the row would be a
                    // dead control.
                    (import.meta.env.DEV || !isDevBuildOnlyFlag(k)),
                );
                if (keys.length === 0) return null;
                return (
                  <Card key={group} className="max-md:border-x-0">
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

              <MaintenanceCard />

              <CategoryAudit />

              <Button variant="outline" size="sm" onClick={resetFlags}>
                Reset developer flags
              </Button>
            </Stack>
          </CollapsibleContent>
        </Collapsible>
      </Stack>
    </Page>
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
    <Row align="start" justify="between" gap="md" className="py-4">
      <Stack gap="tight">
        <Row align="center" gap="sm">
          <span className="text-sm font-medium">{def.label}</span>
          <code className="font-mono text-2xs text-muted-foreground">
            {flagKey}
          </code>
        </Row>
        <Description size="xs">{def.description}</Description>
      </Stack>
      <Switch
        checked={value}
        onCheckedChange={onChange}
        className="relative before:absolute before:-inset-x-1 before:-inset-y-3"
      />
    </Row>
  );
}

function DiagnosticsCard() {
  const { data, error, isFetching, refetch, dataUpdatedAt } =
    useQuery<TimingResponse>({
      // The one query in the app that is not an operation: a raw fetch of
      // `/api/debug/timing`, so it owns its key rather than deriving one.
      queryKey: ["debug", "timing"] as const,
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
        <Row align="start" justify="between" gap="md">
          <Stack gap="sm">
            <CardTitle>Diagnostics</CardTitle>
            <CardDescription>
              Latency of core infrastructure — database, USDA API, and UPC
              lookup.
            </CardDescription>
          </Stack>
          <Button
            variant="outline"
            size="xs"
            onClick={() => refetch()}
            disabled={isFetching}
          >
            {isFetching ? "Measuring…" : "Re-run"}
          </Button>
        </Row>
      </CardHeader>
      <CardContent className="divide-y divide-border/60">
        {error ? (
          <StatusText as="p" tone="destructive" className="py-4 text-xs">
            Timing check failed: {getErrorMessage(error)}
          </StatusText>
        ) : !data ? (
          <Description as="p" size="xs" className="py-4">
            Measuring…
          </Description>
        ) : (
          <>
            {data.results.map((result) => (
              <Row
                key={result.label}
                align="start"
                justify="between"
                gap="md"
                className="py-2"
              >
                <Stack gap="tight" className="min-w-0">
                  <code className="block truncate font-mono text-xs text-muted-foreground">
                    {result.label}
                  </code>
                  {result.error && (
                    <p className="text-xs text-destructive">{result.error}</p>
                  )}
                </Stack>
                <span className="shrink-0 font-mono text-sm font-medium tabular-nums">
                  {result.durationMs} ms
                </span>
              </Row>
            ))}
            <Row
              align="center"
              justify="between"
              gap="md"
              className="py-2 text-xs text-muted-foreground"
            >
              <span>
                Last run {new Date(dataUpdatedAt).toLocaleTimeString()}
              </span>
              <span className="font-mono tabular-nums">
                total {data.totalMs} ms
              </span>
            </Row>
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
    <Card className="max-md:border-x-0">
      <CardHeader className="max-md:px-2">
        <CardTitle>Appearance</CardTitle>
      </CardHeader>
      <CardContent className="max-md:px-2">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 py-1 max-md:grid-cols-1">
          <Stack gap="tight">
            <span className="text-sm font-medium">Table density</span>
            <Description size="xs">Row height in data tables.</Description>
          </Stack>
          <div className="grid grid-cols-3 gap-1">
            {DENSITIES.map((d) => (
              <Button
                key={d}
                size="xs"
                variant={density === d ? "default" : "outline"}
                onClick={() => setDensity(d)}
                className="min-h-11 capitalize md:min-h-0"
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
