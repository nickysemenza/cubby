import { useState } from "react";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
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
import { useTRPC } from "~/integrations/trpc/react";
import { authClient } from "~/lib/auth-client";
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
    <Row
      align="center"
      justify="between"
      gap="sm"
      className="rounded border border-border px-4 py-2"
    >
      <Stack gap="tight" className="min-w-0">
        <span className="font-medium">{label}</span>
        <span
          className="truncate font-mono text-muted-foreground text-xs"
          title={url}
        >
          {url}
        </span>
      </Stack>
      <Row gap="xs" className="shrink-0">
        <Button variant="outline" size="sm" onClick={() => void copyText(url)}>
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
  );
}

export function CalendarSubscribeDialog() {
  const api = useTRPC();
  const session = authClient.useSession();
  // The freshly-minted token wins over the session copy: `session.cookieCache`
  // serves `user` from a signed cookie for up to 5 minutes, so straight after a
  // rotate the session still carries the token that just stopped working.
  const [rotated, setRotated] = useState<string | null>(null);

  const rotate = useActionMutation({
    mutationFn: api.calendar.rotateFeed.mutationOptions,
    success: "Calendar feed URLs regenerated",
    onSuccess: (data) => setRotated(data.token),
  });

  const token = rotated ?? session.data?.user.calendarFeedToken ?? null;
  const origin = typeof window === "undefined" ? "" : window.location.origin;

  return (
    <Dialog>
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
