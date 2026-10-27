import type { QueueHealthSnapshot, WorkStream } from "~/contracts/job.contract";

/** Plain names for the work a Job kind (or AI feature) does. */
const KIND_LABEL = new Map<string, string>(
  Object.entries({
    "embedding.refresh": "Search embeddings",
    "embedding.cleanup": "Embedding cleanup",
    "image.device": "Photo processing on Apple devices",
    "image.cloud": "Photo processing in the cloud",
    "discovery.connections": "Connection discovery",
    "assessment.correction": "Suggestion corrections",
    "purchase.dispatch": "Purchase import",
    "run.execute": "Runs",
  }),
);
const FEATURE_LABEL = new Map<string, string>(
  Object.entries({
    "entity-connections": "Connection suggestions",
    "product-identity": "Product matching",
    "mailbox-relevance": "Mail relevance",
    "mailbox-triage": "Mail triage",
    "field-suggestion": "Field suggestions",
  }),
);

const sentence = (value: string) => {
  const words = value.replace(/[._:-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

export function workStreamLabel(stream: Pick<WorkStream, "kind" | "feature">) {
  if (stream.feature)
    return (
      FEATURE_LABEL.get(stream.feature) ??
      (stream.feature.startsWith("field:")
        ? `${sentence(stream.feature.slice("field:".length))} suggestions`
        : sentence(stream.feature))
    );
  return KIND_LABEL.get(stream.kind) ?? sentence(stream.kind);
}

export type WorkStreamStatus =
  | "working"
  | "waiting"
  | "stuck"
  | "failed"
  | "stale"
  | "backing_off"
  | "paused"
  | "done";

/** Due work that has waited this long with nothing running reads as stuck. */
export const STUCK_AFTER_SECONDS = 10 * 60;

export type WorkStreamView = {
  key: string;
  label: string;
  status: WorkStreamStatus;
  /** Work that is not finished: running, due, backing off or scheduled. */
  remaining: number;
  /** Minutes to finish `remaining` at the measured pace; null without pace. */
  minutesLeft: number | null;
  /** Seconds the oldest due item has waited; null when nothing is due. */
  oldestWaitSeconds: number | null;
  stream: WorkStream;
  alertReason: string | null;
};

export function workStreamView(
  stream: WorkStream,
  now: number,
  health?: QueueHealthSnapshot | null,
): WorkStreamView {
  const remaining =
    stream.running + stream.due + stream.backingOff + stream.scheduled;
  const oldestWaitSeconds = stream.oldestDueAt
    ? Math.max(0, Math.round((now - Date.parse(stream.oldestDueAt)) / 1000))
    : null;
  const alertReason = watchdogReason(stream.kind, health);
  const status: WorkStreamStatus = alertReason
    ? "stuck"
    : stream.running > 0
      ? "working"
      : stream.due > 0
        ? (oldestWaitSeconds ?? 0) >= STUCK_AFTER_SECONDS &&
          stream.completedPerMinute === 0
          ? "stuck"
          : "waiting"
        : stream.backingOff > 0
          ? "backing_off"
          : stream.paused > 0 && remaining === 0
            ? "paused"
            : remaining > 0
              ? "waiting"
              : stream.failed > 0
                ? "failed"
                : "done";
  return {
    key: `${stream.kind}:${stream.feature ?? ""}`,
    label: workStreamLabel(stream),
    status,
    remaining,
    minutesLeft:
      remaining > 0 && stream.completedPerMinute > 0
        ? remaining / stream.completedPerMinute
        : null,
    oldestWaitSeconds,
    stream,
    alertReason,
  };
}

const STATUS_ORDER = {
  stuck: 0,
  failed: 0,
  stale: 0,
  working: 1,
  backing_off: 2,
  waiting: 3,
  paused: 4,
  done: 5,
} satisfies Record<WorkStreamStatus, number>;

/** Problems first, then live work by size, then finished work by recency. */
export function orderWorkStreams(views: readonly WorkStreamView[]) {
  return [...views].sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      b.remaining - a.remaining ||
      (b.stream.lastCompletedAt ?? "").localeCompare(
        a.stream.lastCompletedAt ?? "",
      ),
  );
}

/** "about 12 min", "about 3 h", "under a minute". */
export function formatMinutesLeft(minutes: number) {
  if (minutes < 1) return "under a minute";
  if (minutes < 90) return `about ${Math.round(minutes)} min`;
  if (minutes < 48 * 60) return `about ${Math.round(minutes / 60)} h`;
  return `about ${Math.round(minutes / (24 * 60))} days`;
}

/** "950/min", "4.5/min", "0.2/min". */
export function formatPace(perMinute: number) {
  return perMinute >= 10
    ? `${Math.round(perMinute).toLocaleString()}/min`
    : `${Math.round(perMinute * 10) / 10}/min`;
}

/** Infrastructure Jobs never become member-facing streams. */
export function isVisibleWorkStream(stream: Pick<WorkStream, "kind">) {
  return !["derived.drain", "jobs.retention", "image.device.wake"].includes(
    stream.kind,
  );
}

/** Translate conditions, never parse the watchdog's diagnostic prose. */
export function watchdogReason(
  kind: string,
  health?: QueueHealthSnapshot | null,
) {
  const alerts = health?.alerts.filter((alert) => alert.kind === kind) ?? [];
  if (!alerts.length) return null;
  const conditions = health?.kinds.find((entry) => entry.kind === kind);
  const reasons: string[] = alerts.map((alert) => {
    switch (alert.code) {
      case "no_claims":
        return "Waiting work is not being picked up";
      case "oldest_due":
        return "Waiting work is overdue";
      case "due_growth":
        return "Waiting work is growing";
      case "expired_leases":
        return "Work was not finished before its claim expired";
      case "image_disagreement":
        return "Photo work needs reconciliation";
      case "over_capacity":
        return "More work queued than the processing limit";
    }
  });
  const oldest = conditions?.oldestDueSeconds;
  if (oldest !== null && oldest !== undefined)
    reasons.push(`oldest waiting ${Math.round(oldest / 60)} min`);
  return reasons.join(" · ");
}
