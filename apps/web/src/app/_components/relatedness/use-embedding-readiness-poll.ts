import { useCallback, useEffect, useRef, useState } from "react";

/** How often the relatedness query re-checks readiness while an Index-now
 * refresh is outstanding. */
export const EMBEDDING_READINESS_POLL_INTERVAL_MS = 1_000;

/** Ceiling on how long to keep polling before showing "Check again" instead
 * of spinning forever on a queue message that never lands. */
export const EMBEDDING_READINESS_POLL_TIMEOUT_MS = 120_000;

type PollPhase = "idle" | "polling" | "timedOut";

export interface EmbeddingReadinessPoll {
  /** Stable — pass straight through as the relatedness query's `refetchInterval`. */
  refetchInterval: () => number | false;
  /** Feed the relatedness query's current `status` in on every render (a
   * `useEffect([status, notifyStatus])` in the caller); stable itself. */
  notifyStatus: (status: string | undefined) => void;
  isPolling: boolean;
  timedOut: boolean;
  /** Call once an Index-now refresh has been accepted. */
  start: () => void;
  /** The "Check again" affordance after a timeout: refetches and re-arms the
   * poll window. */
  checkAgain: (refetch: () => void) => void;
}

function isTerminalReadiness(status: string | undefined): boolean {
  return status === "ready" || status === "unavailable";
}

/**
 * Drives the relatedness rail's post-"Index now" readiness poll.
 *
 * `search.requestEmbeddingRefresh` only reports `{ accepted: true }` — the
 * refresh runs on the queue, and there is no batch left to watch for
 * completion. This is what actually observes it landing: the EXISTING
 * entity recommendation query, re-checked on a fixed interval instead of a
 * background-job poll.
 *
 * `status` is read via `notifyStatus` rather than as a hook argument so the
 * caller can compute `refetchInterval` and mount its `useQuery` in either
 * order — the interval decision itself only depends on `phase`, not on the
 * query's last-rendered status.
 */
export function useEmbeddingReadinessPoll(
  entityId: string,
): EmbeddingReadinessPoll {
  const [phase, setPhase] = useState<PollPhase>("idle");
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const deadlineRef = useRef<number | null>(null);

  // Switching products abandons any in-flight poll — left running, it would
  // keep re-checking (and could report readiness for) the entity the rail
  // just left behind.
  const entityRef = useRef(entityId);
  useEffect(() => {
    if (entityRef.current === entityId) return;
    entityRef.current = entityId;
    deadlineRef.current = null;
    setPhase("idle");
  }, [entityId]);

  // The timeout is a real timer, not a check inside `refetchInterval`: that
  // callback runs from the query observer's own scheduling cycle, and setting
  // state from inside it risks React's "update while rendering a different
  // component" warning. Unmounting the rail cleans this up like any effect.
  useEffect(() => {
    if (phase !== "polling") return;
    const deadline =
      deadlineRef.current ?? Date.now() + EMBEDDING_READINESS_POLL_TIMEOUT_MS;
    deadlineRef.current = deadline;
    const timer = setTimeout(
      () => setPhase("timedOut"),
      Math.max(deadline - Date.now(), 0),
    );
    return () => clearTimeout(timer);
  }, [phase]);

  const refetchInterval = useCallback(
    () =>
      phaseRef.current === "polling"
        ? EMBEDDING_READINESS_POLL_INTERVAL_MS
        : false,
    [],
  );

  const notifyStatus = useCallback((status: string | undefined) => {
    if (phaseRef.current !== "polling") return;
    if (isTerminalReadiness(status)) setPhase("idle");
  }, []);

  const start = useCallback(() => {
    deadlineRef.current = null;
    setPhase("polling");
  }, []);

  const checkAgain = useCallback(
    (refetch: () => void) => {
      start();
      void refetch();
    },
    [start],
  );

  return {
    refetchInterval,
    notifyStatus,
    isPolling: phase === "polling",
    timedOut: phase === "timedOut",
    start,
    checkAgain,
  };
}
