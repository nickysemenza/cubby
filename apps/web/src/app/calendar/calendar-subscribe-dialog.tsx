import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { calendar } from "~/app/calendar/calendar.functions";
import { ErrorDisplay } from "~/components/feedback/error-display";
import { Row, Stack } from "~/components/layout";
import { Button, buttonVariants } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { StatusText } from "~/components/ui/status-text";
import { copyText } from "~/lib/clipboard";
import { cn } from "~/lib/utils";

const FEEDS = [
  { file: "all.ics", label: "Everything" },
  { file: "meals.ics", label: "Meals" },
  { file: "tasks.ics", label: "Tasks" },
] as const;

/**
 * `webcal://` rather than `https://` — macOS hands that scheme straight to
 * Calendar.app, so subscribing is one click instead of a download-and-import.
 */
function feedUrl(origin: string, token: string, file: string): string {
  return `${origin.replace(/^https?:/, "webcal:")}/api/calendar/${token}/${file}`;
}

function FeedRow({
  origin,
  token,
  file,
  label,
}: {
  origin: string;
  token: string;
  file: string;
  label: string;
}) {
  const url = feedUrl(origin, token, file);
  return (
    <Stack gap="xs" className="rounded border border-border px-4 py-2">
      <Row align="center" justify="between" gap="sm">
        <span className="font-medium">{label}</span>
        <Row gap="xs" className="shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void copyText(url)}
          >
            Copy
          </Button>
          <a
            href={url}
            className={cn(buttonVariants({ variant: "secondary", size: "sm" }))}
          >
            Subscribe
          </a>
        </Row>
      </Row>
      {/* `break-all`, not `truncate`: a 43-char token makes these URLs far wider
          than the dialog, and truncating on one line pushed the buttons out of
          reach. Wrapping keeps the whole URL selectable for a manual copy. */}
      <span className="font-mono text-xs break-all text-muted-foreground">
        {url}
      </span>
    </Stack>
  );
}

export function CalendarSubscribeDialog() {
  const [open, setOpen] = useState(false);
  // Deliberately NOT `session.user.calendarFeedToken`: that copy comes from the
  // signed cookie cache and lags by up to 5 minutes, so a just-created feed
  // still reads as null there — and the empty state's "Create feed" button
  // rotates, which would break a subscription the user had already added.
  const feed = useQuery({
    ...calendar.getFeed.queryOptions(),
    enabled: open,
  });
  const [rotated, setRotated] = useState<string | null>(null);

  const hadFeed = (feed.data?.token ?? null) !== null;

  const rotate = useActionMutation({
    mutationFn: calendar.rotateFeed.mutationOptions,
    success: hadFeed
      ? "Calendar feed URLs regenerated"
      : "Calendar feed created",
    onSuccess: (data) => setRotated(data.token),
  });

  const token = rotated ?? feed.data?.token ?? null;
  const origin = globalThis.window?.location.origin ?? "";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            Subscribe
          </Button>
        }
      />
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Subscribe in Calendar</DialogTitle>
          <DialogDescription>
            Add these to macOS or iOS Calendar to see planned meals and task due
            dates alongside everything else. The feed is read-only and refreshes
            about hourly.
          </DialogDescription>
        </DialogHeader>

        {token ? (
          <Stack gap="sm">
            {FEEDS.map((feed) => (
              <FeedRow
                key={feed.file}
                origin={origin}
                token={token}
                {...feed}
              />
            ))}
            <StatusText tone="warning">
              Anyone with these URLs can read your meals and tasks — the token
              is the only thing protecting them. Regenerating breaks every
              existing subscription.
            </StatusText>
            <Row justify="end">
              <Button
                variant="outline"
                size="sm"
                disabled={rotate.isPending}
                onClick={() => rotate.mutate(undefined)}
              >
                Regenerate URLs
              </Button>
            </Row>
          </Stack>
        ) : feed.isPending ? (
          <StatusText>Loading…</StatusText>
        ) : feed.error ? (
          <Stack gap="sm">
            <ErrorDisplay error={feed.error} />
            <Row justify="end">
              <Button variant="outline" onClick={() => void feed.refetch()}>
                Retry feed lookup
              </Button>
            </Row>
          </Stack>
        ) : (
          <Stack gap="sm">
            <StatusText>No feed has been created yet.</StatusText>
            <Row justify="end">
              <Button
                disabled={rotate.isPending}
                onClick={() => rotate.mutate(undefined)}
              >
                Create feed
              </Button>
            </Row>
          </Stack>
        )}
      </DialogContent>
    </Dialog>
  );
}
