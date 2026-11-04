import type { DerivedBacklog } from "@cubby/schemas/derived-backlog";
import { entityRoster } from "@cubby/schemas/entity-roster";
import { humanize } from "@cubby/shared";

import { formatCount } from "~/lib/number-format";

export const refreshStateSummary = (
  states: NonNullable<DerivedBacklog["kinds"][number]["states"]>,
) =>
  `${formatCount(states.queued)} queued · ${formatCount(states.running)} running · ${formatCount(states.waiting)} waiting · ${formatCount(states.failed)} failed`;

/** Internal publications share execution observations, not public Entity fields. */
export function backlogRefreshes(backlog: DerivedBacklog) {
  return [
    ...backlog.kinds.map((kind) => ({
      ...kind,
      key: `${kind.entity}.${kind.field}`,
      label: `${entityRoster[kind.entity].singular} · ${humanize(kind.field)}`,
      triggerLabel: `${entityRoster[kind.entity].singular} ${humanize(kind.field).toLowerCase()}`,
    })),
    ...(backlog.internal ?? []).map((source) => ({
      ...source,
      key: source.target,
      triggerLabel: source.label,
    })),
  ].filter((source) => source.count > 0);
}

/** Queue observations alone establish execution state; publication age does not. */
export function backlogStates(backlog: DerivedBacklog) {
  const known = backlogRefreshes(backlog).reduce(
    (sum, source) => ({
      queued: sum.queued + (source.states?.queued ?? 0),
      running: sum.running + (source.states?.running ?? 0),
      waiting: sum.waiting + (source.states?.waiting ?? 0),
      failed: sum.failed + (source.states?.failed ?? 0),
    }),
    { queued: 0, running: 0, waiting: 0, failed: 0 },
  );
  return {
    ...known,
    unknown: Math.max(
      0,
      backlog.total -
        known.queued -
        known.running -
        known.waiting -
        known.failed,
    ),
  };
}

export function describeRecentPublications(backlog: DerivedBacklog) {
  const sources = backlog.recent.sources?.length
    ? backlog.recent.sources
    : [{ label: "Current results", perMinute: backlog.recent.perMinute }];
  return `Current publications from the last ${backlog.recent.windowMinutes} min · ${sources
    .map(
      (source) =>
        `${source.label}: ${formatCount(source.perMinute.reduce((sum, n) => sum + n, 0))}`,
    )
    .join(" · ")}`;
}
