import type {
  CalendarCredential,
  CalendarRotateCredential,
} from "@cubby/schemas/calendar";
import { ArrowsClockwiseIcon as CalendarSync } from "@phosphor-icons/react/dist/csr/ArrowsClockwise";
import { CopyIcon as Copy } from "@phosphor-icons/react/dist/csr/Copy";
import { KeyIcon as KeyRound } from "@phosphor-icons/react/dist/csr/Key";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { toast } from "sonner";

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

const caldavUrl = (origin: string) => `${origin}/api/caldav/`;

/** `webcal` hands subscriptions directly to Calendar.app on Apple devices. */
function feedUrl(origin: string, token: string, file: string): string {
  return `${origin.replace(/^https?:/, "webcal:")}/api/calendar/${token}/${file}`;
}

function CopyButton({ value, label }: { value: string; label: string }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => {
        void copyText(value).then((copied) =>
          copied
            ? toast.success(`${label} copied`)
            : toast.error("Copy failed"),
        );
      }}
    >
      <Copy className="size-3" aria-hidden />
      Copy
    </Button>
  );
}

function CredentialValue({
  label,
  value,
  secret = false,
}: {
  label: string;
  value: string;
  secret?: boolean;
}) {
  return (
    <Stack gap="xs" className="rounded border border-border px-4 py-3">
      <Row align="center" justify="between" gap="sm">
        <span className="text-sm font-medium">{label}</span>
        <CopyButton value={value} label={label} />
      </Row>
      <code
        className={`font-mono text-xs break-all ${
          secret ? "text-foreground select-all" : "text-muted-foreground"
        }`}
      >
        {value}
      </code>
    </Stack>
  );
}

function CalendarAccessError({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}) {
  return (
    <ErrorDisplay error={error} title="calendar access" onRetry={onRetry} />
  );
}

export function CalendarConnectionStatus({
  caldav,
  error,
  isPending,
}: {
  caldav:
    | {
        ready: boolean;
        refreshFailedAt?: string | null;
      }
    | null
    | undefined;
  error: unknown;
  isPending: boolean;
}) {
  if (isPending) return <StatusText>Checking Calendar connection…</StatusText>;
  if (error !== null && error !== undefined) {
    return <ErrorDisplay error={error} title="calendar connection status" />;
  }
  if (caldav?.refreshFailedAt) {
    return (
      <StatusText tone="warning">
        Calendar refresh needs attention. Recent changes may take longer to
        appear.
      </StatusText>
    );
  }
  if (caldav?.ready)
    return <StatusText>Calendar connection is ready.</StatusText>;
  return (
    <StatusText>
      Calendar is preparing its first publication. Try again shortly.
    </StatusText>
  );
}

function SetupNotes() {
  return (
    <Stack
      gap="xs"
      className="rounded border border-border bg-muted/25 px-4 py-3"
    >
      <span className="text-sm font-medium">Calendar.app setup</span>
      <p className="text-xs text-muted-foreground">
        On macOS, open Calendar → Settings → Accounts → + → Other CalDAV
        Account, choose Manual, then enter the server, username, and app
        password. Cubby exposes editable Tasks, Completed Tasks, and Meals
        calendars.
      </p>
      <p className="text-xs text-muted-foreground">
        Create, rename, and reschedule Tasks and Meals in Calendar. Delete
        events and complete or reopen Tasks in Cubby. Timed meals snap to Cubby
        meal slots; notes, locations, alerts, and other Calendar-only fields are
        discarded.
      </p>
    </Stack>
  );
}

export function CalendarAppPasswordSection({
  credential,
  issued,
  isRotating,
  isRevoking,
  onRotate,
  onRevoke,
}: {
  credential: CalendarCredential | undefined;
  issued: CalendarRotateCredential | null;
  isRotating: boolean;
  isRevoking: boolean;
  onRotate: () => void;
  onRevoke: () => void;
}) {
  const username = issued?.username ?? credential?.username ?? "";
  const origin = globalThis.window?.location.origin ?? "";

  if (issued) {
    return (
      <Stack gap="md">
        <StatusText tone="warning">
          Copy this password now. Cubby stores only its hash and cannot show it
          again.
        </StatusText>
        <CredentialValue label="Server" value={caldavUrl(origin)} />
        <CredentialValue label="Username" value={issued.username} />
        <CredentialValue label="App password" value={issued.password} secret />
        <SetupNotes />
        <Row justify="end">
          <Button variant="outline" onClick={onRotate} disabled={isRotating}>
            {isRotating ? "Generating…" : "Replace password"}
          </Button>
        </Row>
      </Stack>
    );
  }

  if (!credential) return <StatusText>Loading Calendar access…</StatusText>;

  return (
    <Stack gap="md">
      {credential.configured ? (
        <>
          <StatusText>
            A Calendar app password is active. Generate a replacement to add
            another device; the old password will stop working.
          </StatusText>
          <CredentialValue label="Server" value={caldavUrl(origin)} />
          <CredentialValue label="Username" value={username} />
          <SetupNotes />
          <Row justify="end" gap="sm" wrap>
            <Button variant="outline" disabled={isRevoking} onClick={onRevoke}>
              {isRevoking ? "Revoking…" : "Revoke access"}
            </Button>
            <Button disabled={isRotating} onClick={onRotate}>
              {isRotating ? "Generating…" : "Replace password"}
            </Button>
          </Row>
        </>
      ) : (
        <>
          <StatusText>
            Create a separate app password to add Cubby as a CalDAV account in
            Calendar. It is distinct from read-only subscriptions below.
          </StatusText>
          <SetupNotes />
          <Row justify="end">
            <Button disabled={isRotating} onClick={onRotate}>
              <KeyRound className="size-3" aria-hidden />
              {isRotating ? "Generating…" : "Create app password"}
            </Button>
          </Row>
        </>
      )}
    </Stack>
  );
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
          <CopyButton value={url} label={`${label} URL`} />
          <a
            href={url}
            className={cn(buttonVariants({ variant: "secondary", size: "sm" }))}
          >
            Subscribe
          </a>
        </Row>
      </Row>
      <span className="font-mono text-xs break-all text-muted-foreground">
        {url}
      </span>
    </Stack>
  );
}

export function CalendarSubscriptionSection({
  token,
  isPending,
  error,
  isRotating,
  onCreateOrRotate,
  onRetry,
}: {
  token: string | null;
  isPending: boolean;
  error: unknown;
  isRotating: boolean;
  onCreateOrRotate: () => void;
  onRetry: () => void;
}) {
  const origin = globalThis.window?.location.origin ?? "";

  return (
    <Stack gap="sm">
      <Stack gap="xs">
        <span className="text-sm font-medium">Read-only subscriptions</span>
        <p className="text-xs text-muted-foreground">
          Subscribe for an hourly view of planned meals and task due dates.
          These calendars cannot create or edit Cubby records.
        </p>
      </Stack>
      {token ? (
        <>
          {FEEDS.map((feed) => (
            <FeedRow key={feed.file} origin={origin} token={token} {...feed} />
          ))}
          <StatusText tone="warning">
            Anyone with these URLs can read your meals and tasks. Regenerating
            them breaks every existing subscription.
          </StatusText>
          <Row justify="end">
            <Button
              variant="outline"
              size="sm"
              disabled={isRotating}
              onClick={onCreateOrRotate}
            >
              {isRotating ? "Regenerating…" : "Regenerate URLs"}
            </Button>
          </Row>
        </>
      ) : isPending ? (
        <StatusText>Loading subscriptions…</StatusText>
      ) : error !== null && error !== undefined ? (
        <CalendarAccessError error={error} onRetry={onRetry} />
      ) : (
        <Row justify="end">
          <Button disabled={isRotating} onClick={onCreateOrRotate}>
            {isRotating ? "Creating…" : "Create subscriptions"}
          </Button>
        </Row>
      )}
    </Stack>
  );
}

export function CalendarConnectDialog() {
  const [queryEnabled, setQueryEnabled] = useState(false);
  const credential = useQuery({
    ...calendar.getCredential.queryOptions(),
    enabled: queryEnabled,
  });
  const feed = useQuery({
    ...calendar.getFeed.queryOptions(),
    enabled: queryEnabled,
  });
  const inspection = useQuery({
    ...calendar.inspectFeed.queryOptions(),
    enabled: queryEnabled,
  });
  const rotateCredential = useActionMutation({
    mutationFn: calendar.rotateCredential.mutationOptions,
    success: "Calendar app password created",
    error: "Calendar app password could not be updated. Try again.",
  });
  const revokeCredential = useActionMutation({
    mutationFn: calendar.revokeCredential.mutationOptions,
    success: "Calendar app access revoked",
    error: "Calendar app access could not be revoked. Try again.",
  });
  const hadFeed = (feed.data?.token ?? null) !== null;
  const rotateFeed = useActionMutation({
    mutationFn: calendar.rotateFeed.mutationOptions,
    success: hadFeed
      ? "Calendar feed URLs regenerated"
      : "Calendar feed created",
    error: "Calendar subscriptions could not be updated. Try again.",
  });
  const [issued, setIssued] = useState<CalendarRotateCredential | null>(null);
  const [rotatedToken, setRotatedToken] = useState<string | null>(null);
  const issuanceEpoch = useRef(0);
  const [open, setOpen] = useState(false);
  const onOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    setQueryEnabled(nextOpen);
    if (!nextOpen) {
      issuanceEpoch.current += 1;
      setIssued(null);
      rotateCredential.reset();
      revokeCredential.reset();
    }
  };
  const issuePassword = async () => {
    const epoch = issuanceEpoch.current + 1;
    issuanceEpoch.current = epoch;
    const nextIssued = await rotateCredential.mutateAsync(undefined);
    if (issuanceEpoch.current === epoch) setIssued(nextIssued);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            <CalendarSync className="size-3" aria-hidden />
            Connect Calendar
          </Button>
        }
      />
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Connect Calendar</DialogTitle>
          <DialogDescription>
            Use Calendar as an editable Cubby account or add read-only
            subscriptions.
          </DialogDescription>
        </DialogHeader>
        {credential.error ? (
          <CalendarAccessError
            error={credential.error}
            onRetry={() => void credential.refetch()}
          />
        ) : (
          <Stack gap="lg">
            <CalendarAppPasswordSection
              credential={credential.data}
              issued={issued}
              isRotating={rotateCredential.isPending}
              isRevoking={revokeCredential.isPending}
              // SILENT: `useActionMutation` already toasts the failure; the
              // dialog stays open for a retry.
              onRotate={() => void issuePassword().catch(() => undefined)}
              // SILENT: `useActionMutation` already toasts the failure.
              onRevoke={() =>
                void revokeCredential
                  .mutateAsync(undefined)
                  .then(() => {
                    setIssued(null);
                    void credential.refetch();
                  })
                  .catch(() => undefined)
              }
            />
            <CalendarConnectionStatus
              caldav={inspection.data?.caldav}
              error={inspection.error}
              isPending={inspection.isPending}
            />
            <CalendarSubscriptionSection
              token={rotatedToken ?? feed.data?.token ?? null}
              isPending={feed.isPending}
              error={feed.error}
              isRotating={rotateFeed.isPending}
              // SILENT: `useActionMutation` already toasts the failure.
              onCreateOrRotate={() =>
                void rotateFeed
                  .mutateAsync(undefined)
                  .then((data) => setRotatedToken(data.token))
                  .catch(() => undefined)
              }
              onRetry={() => void feed.refetch()}
            />
          </Stack>
        )}
      </DialogContent>
    </Dialog>
  );
}
