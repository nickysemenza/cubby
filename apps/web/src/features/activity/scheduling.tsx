import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { job } from "~/integrations/tanstack-query/generated/domains/job.gen";
import { RecordList, RecordRow } from "~/ui/common/record-list";
import { Section, Row, Stack } from "~/ui/layout";
import { Disclosure } from "~/ui/layout/disclosure";
import { Button } from "~/ui/primitives/button";
import { StatusText } from "~/ui/primitives/status-text";

import { workStreamLabel } from "./work-streams";

const time = (instant: string) =>
  new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "America/Los_Angeles",
  }).format(new Date(instant));

/** A read-on-demand snapshot; observing idle scheduling must not create a polling loop. */
export function Scheduling({
  attentionOnly = false,
}: {
  attentionOnly?: boolean;
}) {
  const status = useQuery({
    ...job.schedule.queryOptions({}),
    refetchInterval: false,
  });
  if (status.isPending)
    return attentionOnly ? null : (
      <StatusText>Reading scheduling status…</StatusText>
    );
  if (status.isError)
    return <StatusText tone="destructive">{status.error.message}</StatusText>;
  const snapshot = status.data;
  const next = snapshot.deadlines[0];
  const nextAt = snapshot.alarmAt;
  const nextReason = snapshot.deliveryPendingSince
    ? "Wake delivery retry"
    : snapshot.observationError
      ? "Schedule observation retry"
      : next?.reason === "lease-expiry"
        ? "Lease recovery"
        : "Work becomes available";
  // Compare to the actual observation, not a client clock aging an old snapshot.
  const pendingSince = snapshot.deliveryPendingSince ?? snapshot.alarmAt;
  const overdue =
    pendingSince &&
    Date.parse(snapshot.readAt) - Date.parse(pendingSince) > 5 * 60_000;
  if (
    attentionOnly &&
    !overdue &&
    !snapshot.lastRecovery?.error &&
    !snapshot.observationError
  )
    return null;
  return (
    <Section
      headingAs="h2"
      title={attentionOnly ? "Scheduling needs attention" : "Scheduling"}
    >
      <Stack gap="md">
        <Row gap="md" wrap>
          <span>
            <strong>Running</strong> {snapshot.running}
          </span>
          <span>
            <strong>Next wake</strong>{" "}
            {nextAt
              ? `${time(nextAt)} · ${nextReason}`
              : snapshot.deliveryPendingSince || snapshot.observationError
                ? "Awaiting recovery"
                : snapshot.observedAt
                  ? "No scheduled work"
                  : "Not yet observed"}
          </span>
          <span>
            <strong>Waiting</strong> {snapshot.waiting}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={status.isFetching}
            onClick={() => void status.refetch()}
          >
            Refresh status
          </Button>
        </Row>
        {overdue ? (
          <StatusText tone="destructive">
            A scheduled wake is over five minutes overdue. Inspect wake history
            for details.
          </StatusText>
        ) : null}
        {snapshot.observationError ? (
          <StatusText tone="destructive">
            Scheduling observation failed. Inspect wake history for the raw
            diagnostic.
          </StatusText>
        ) : null}
        {snapshot.lastRecovery?.error ? (
          <StatusText tone="destructive">
            Recovery enrollment failed. Inspect wake history for the raw
            diagnostic.
          </StatusText>
        ) : null}
        {attentionOnly ? (
          <Link
            to="/activity"
            search={{ tab: "now" }}
            className="text-sm text-link hover:underline"
          >
            View scheduling history
          </Link>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Observed {time(snapshot.readAt)} · Status may have changed. Refreshing
          work status can wake the database.
        </p>
        <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-muted-foreground">Daily recovery</dt>
          <dd>7 a.m. America/Los_Angeles · follows daylight saving time</dd>
          <dt className="text-muted-foreground">Last recovery</dt>
          <dd>
            {snapshot.lastRecovery
              ? `${time(snapshot.lastRecovery.at)} · ${snapshot.lastRecovery.cause} · ${snapshot.lastRecovery.error ? "Partially failed" : "Enrollment completed"}`
              : "Not yet observed"}
          </dd>
          <dt className="text-muted-foreground">Deadline observation</dt>
          <dd>
            {snapshot.observedAt
              ? time(snapshot.observedAt)
              : "Not yet observed"}
          </dd>
        </dl>
        {!attentionOnly ? (
          <>
            <RecordList
              aria-label="Scheduled deadlines"
              empty="No known job deadlines. Daily recovery remains scheduled separately; this does not establish whether Neon is suspended."
            >
              {snapshot.deadlines.map((deadline) => (
                <RecordRow
                  key={`${deadline.job}:${deadline.reason}`}
                  primary={
                    <Link
                      to="/jobs/$shortcode"
                      params={{ shortcode: deadline.job }}
                      className="text-link hover:underline"
                    >
                      {deadline.job}
                    </Link>
                  }
                  secondary={workStreamLabel({ kind: deadline.kind })}
                  facts={[
                    {
                      label: "Reason",
                      value:
                        deadline.reason === "lease-expiry"
                          ? "Recover if execution stops"
                          : "Work becomes available",
                    },
                  ]}
                  trailing={
                    <time dateTime={deadline.at}>{time(deadline.at)}</time>
                  }
                />
              ))}
            </RecordList>
            <Disclosure summary="Wake and recovery history">
              <RecordList
                variant="timeline"
                empty="No scheduling transitions recorded yet."
              >
                {[...snapshot.events].reverse().map((entry) => (
                  <RecordRow
                    key={entry.key}
                    primary={entry.event.replaceAll("-", " ")}
                    secondary={
                      entry.job ? (
                        <Link
                          to="/jobs/$shortcode"
                          params={{ shortcode: entry.job }}
                          className="text-link hover:underline"
                        >
                          {entry.job} · {entry.cause}
                        </Link>
                      ) : (
                        entry.cause
                      )
                    }
                    trailing={<time dateTime={entry.at}>{time(entry.at)}</time>}
                    detail={
                      entry.error ? (
                        <pre className="break-words whitespace-pre-wrap text-destructive">
                          {entry.error}
                        </pre>
                      ) : undefined
                    }
                  />
                ))}
              </RecordList>
            </Disclosure>
          </>
        ) : null}
      </Stack>
    </Section>
  );
}
