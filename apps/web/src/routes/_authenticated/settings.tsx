import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ChevronDown, Copy, RefreshCw, Wrench } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { CalendarConnectDialog } from "~/app/calendar/calendar-connect-dialog";
import { calendar } from "~/app/calendar/calendar.functions";
import { AwaitingWorkCard } from "~/app/problems/components/awaiting-work-card";
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
import { copyText } from "~/lib/clipboard";
import { getErrorMessage } from "~/lib/error-utils";
import { pageTitle } from "~/lib/page-title";
import {
  timingResponseSchema,
  type TimingResponse,
} from "~/routes/api/debug/timing";

export const Route = createFileRoute("/_authenticated/settings")({
  component: SettingsPage,
  head: () => ({ meta: [{ title: pageTitle("Settings") }] }),
});

function SettingsPage() {
  const [devOpen, setDevOpen] = useState(false);
  return (
    <Page variant="list" title="Settings">
      <Stack gap="md" className="max-w-2xl pb-6 md:gap-6">
        {/* User-facing settings — the everyday prefs, kept above the fold. */}
        <CalendarAccessCard />

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
                  Diagnostics and force-run batch fixes.
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
              <DiagnosticsCard />

              <CalendarFeedInspectorCard enabled={devOpen} />

              <AwaitingWorkCard />

              <MaintenanceCard />
            </Stack>
          </CollapsibleContent>
        </Collapsible>
      </Stack>
    </Page>
  );
}

function CalendarAccessCard() {
  return (
    <Card className="max-md:border-x-0">
      <CardHeader>
        <Row
          align="start"
          justify="between"
          gap="md"
          className="max-md:flex-col"
        >
          <Stack gap="tight">
            <CardTitle>Calendar</CardTitle>
            <CardDescription>
              Set up editable Calendar access or read-only subscriptions.
            </CardDescription>
          </Stack>
          <div className="shrink-0">
            <CalendarConnectDialog />
          </div>
        </Row>
      </CardHeader>
    </Card>
  );
}

function CalendarFeedInspectorCard({ enabled }: { enabled: boolean }) {
  const { data, error, isFetching, refetch } = useQuery({
    ...calendar.inspectFeed.queryOptions(),
    enabled,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const json = data ? JSON.stringify(data, null, 2) : null;
  const clearWrite = useActionMutation({
    mutationFn: calendar.clearUncertainWrite.mutationOptions,
    success: "Uncertain write cleared",
    error: "The uncertain write could not be cleared. Try again.",
  });

  return (
    <Card>
      <CardHeader>
        <Row
          align="start"
          justify="between"
          gap="md"
          className="max-md:flex-col"
        >
          <Stack gap="sm">
            <CardTitle>Calendar state</CardTitle>
            <CardDescription>
              Durable Object metadata only. Credentials and calendar contents
              are omitted; jurisdiction is not the active colo.
            </CardDescription>
          </Stack>
          <Row gap="xs" justify="end" className="shrink-0 max-md:w-full">
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => void refetch()}
              disabled={isFetching}
            >
              <RefreshCw
                className={`size-3 ${isFetching ? "animate-spin" : ""}`}
              />
              {isFetching ? "Reading…" : "Refresh"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={!json}
              onClick={() => {
                if (!json) return;
                void copyText(json).then((copied) =>
                  copied
                    ? toast.success("Calendar feed state copied")
                    : toast.error("Copy failed"),
                );
              }}
            >
              <Copy className="size-3" />
              Copy JSON
            </Button>
          </Row>
        </Row>
      </CardHeader>
      <CardContent>
        {error ? (
          <StatusText as="p" tone="destructive" className="text-xs">
            Calendar state could not be loaded. Try again shortly.
          </StatusText>
        ) : json ? (
          <Stack gap="md">
            {data?.caldav?.uncertainWrites.map((write) => (
              <Stack key={`${write.collection}/${write.filename}`} gap="xs">
                <Description as="p" size="xs">
                  Uncertain write: {write.collection}/{write.filename}
                  {write.shortcode ? ` (${write.shortcode})` : ""}. Check this
                  record in Cubby before clearing. Clearing only unblocks
                  calendar edits; it never repeats or deletes a change.
                </Description>
                <Button
                  variant="outline"
                  size="xs"
                  disabled={clearWrite.isPending}
                  onClick={() =>
                    clearWrite.mutate({
                      collection: write.collection,
                      filename: write.filename,
                    })
                  }
                >
                  Clear uncertain write
                </Button>
              </Stack>
            ))}
            <pre className="max-h-[32rem] overflow-auto bg-muted/35 p-4 font-mono text-xs">
              {json}
            </pre>
          </Stack>
        ) : (
          <Description as="p" size="xs">
            {isFetching ? "Reading calendar state…" : "No state returned."}
          </Description>
        )}
      </CardContent>
    </Card>
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
        return timingResponseSchema.parse(await res.json());
      },
      refetchOnWindowFocus: false,
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
