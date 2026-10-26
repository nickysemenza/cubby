import { entitySummary } from "@cubby/schemas/entity-summary";
import { humanize } from "@cubby/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { derived } from "~/integrations/tanstack-query/generated/catalog/derived.gen";
import { formatCount } from "~/lib/number-format";
import { RecordList, RecordRow } from "~/ui/common/record-list";

import {
  backlogEstimate,
  type BacklogSample,
  sampleBacklog,
} from "./backlog-progress";

/** The shell status slot's derived backlog: shown only while values are updating. */
export function DerivedBacklogStatus({
  compact = false,
}: {
  compact?: boolean;
}) {
  const { data } = useQuery(derived.backlog.queryOptions({}));
  if (!data?.total) return null;
  const label = `Updating ${data.total} values`;
  return (
    <Link
      to="/activity"
      hash="derived-values"
      aria-label={compact ? label : undefined}
      className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-info" />
      {!compact && <span>{label}</span>}
    </Link>
  );
}

export function DerivedBacklogOverview() {
  const result = useQuery({
    ...derived.backlog.queryOptions({}),
    refetchInterval: 15_000,
  });
  const [observed, setObserved] = useState(0);
  const [samples, setSamples] = useState<readonly BacklogSample[]>([]);
  if (result.isSuccess && result.dataUpdatedAt !== observed) {
    setObserved(result.dataUpdatedAt);
    setSamples(
      sampleBacklog(samples, {
        at: result.dataUpdatedAt,
        total: result.data.total,
      }),
    );
  }
  const estimate = backlogEstimate(samples);
  const firstSample = samples[0];
  const lastSample = samples.at(-1);
  const hasWindow =
    firstSample && lastSample && lastSample.at - firstSample.at >= 60_000;
  const minutes = estimate
    ? Math.max(1, Math.ceil(estimate.seconds / 60))
    : null;
  const duration =
    minutes === null
      ? null
      : minutes < 60
        ? `${minutes} min`
        : `${Math.ceil(minutes / 60)} h`;
  return (
    <RecordList
      state={
        result.isPending
          ? { status: "pending", rows: 2 }
          : result.isError
            ? {
                status: "error",
                error: result.error,
                title: "Couldn't load derived values",
                onRetry: () => void result.refetch(),
              }
            : { status: "success" }
      }
      empty={<span>No values waiting to update.</span>}
    >
      {result.data && result.data.total > 0 && (
        <RecordRow
          primary={`${formatCount(result.data.total)} values remaining`}
          trailing={
            result.isError
              ? "Estimate unavailable"
              : duration
                ? `About ${duration} remaining`
                : hasWindow
                  ? "No ETA yet"
                  : "Estimating…"
          }
          secondary={
            estimate && !result.isError
              ? `${formatCount(Math.round(estimate.perMinute))} fewer/min while this page is open. New work can change the estimate.`
              : hasWindow
                ? "The backlog is not decreasing over recent samples."
                : "Needs at least a minute of decreasing backlog while this page is open."
          }
        />
      )}
      {result.data?.kinds.map((kind) => (
        <RecordRow
          key={`${kind.entity}.${kind.field}`}
          primary={`${entitySummary[kind.entity].singular} · ${humanize(kind.field)}`}
          trailing={`${kind.count} updating`}
        />
      ))}
    </RecordList>
  );
}
