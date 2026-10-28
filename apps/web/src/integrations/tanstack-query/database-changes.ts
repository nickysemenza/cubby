import type { QueryClient } from "@tanstack/react-query";

import {
  doorbellRing,
  doorbellUrl,
  mergeDatabaseChanges,
  type DatabaseChanges,
} from "~/lib/doorbell";
import { showErrorToast } from "~/ui/feedback/error-details";

import {
  invalidateDatabaseChanges,
  resyncOperationQueries,
} from "./operation-cache";

/** One socket per authenticated shell; records still come from authoritative queries. */
export function subscribeDatabaseChanges(client: QueryClient): () => void {
  let stopped = false;
  let socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let hasConnected = false;
  let refreshing = false;
  let resync = false;
  let fullRing = false;
  let pending: DatabaseChanges = {};
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  let lastRingRefresh: number | undefined;

  async function refresh() {
    if (refreshing || stopped) return;
    const recovery = resync;
    const full = recovery || fullRing;
    if (!full && !Object.keys(pending).length) return;
    const delay =
      lastRingRefresh === undefined
        ? 0
        : Math.max(0, lastRingRefresh + 5_000 - Date.now());
    if (!recovery && delay > 0) {
      if (scheduled === undefined)
        scheduled = setTimeout(() => {
          scheduled = undefined;
          requestRefresh();
        }, delay);
      return;
    }
    if (scheduled !== undefined) clearTimeout(scheduled);
    scheduled = undefined;
    const changes = pending;
    pending = {};
    resync = false;
    fullRing = false;
    // Recovery reads bypass the ring throttle; the next ring still has a leading edge.
    lastRingRefresh = recovery ? undefined : Date.now();
    refreshing = true;
    try {
      if (full) await resyncOperationQueries(client);
      else await invalidateDatabaseChanges(client, changes);
    } finally {
      refreshing = false;
      if (!stopped && (resync || fullRing || Object.keys(pending).length))
        requestRefresh();
    }
  }

  function requestRefresh() {
    void refresh().catch((error: unknown) =>
      console.error("Change notification refresh failed", error),
    );
  }

  function connect() {
    if (stopped || socket || navigator.onLine === false) return;
    if (retry !== undefined) clearTimeout(retry);
    retry = undefined;
    const current = new WebSocket(
      doorbellUrl("household.changed", window.location.origin),
    );
    socket = current;
    current.addEventListener("open", () => {
      attempt = 0;
      // First connection reuses SSR. Missed hints may leave display data stale;
      // reconnect and resume still provide an explicit recovery opportunity.
      if (hasConnected) {
        resync = true;
        requestRefresh();
      }
      hasConnected = true;
    });
    current.addEventListener("message", (event: MessageEvent<unknown>) => {
      try {
        const ring = doorbellRing.parse(JSON.parse(String(event.data)));
        if (ring.topic !== "household.changed") return;
        if (ring.changes === undefined) fullRing = true;
        else mergeDatabaseChanges(pending, ring.changes);
        requestRefresh();
      } catch (error) {
        showErrorToast(error);
        current.close(1002, "Invalid change notification");
      }
    });
    current.addEventListener("close", () => {
      if (socket === current) socket = undefined;
      if (!stopped)
        retry = setTimeout(
          connect,
          Math.min(30_000, 1_000 * 2 ** Math.min(attempt++, 5)),
        );
    });
    current.addEventListener("error", () => current.close());
  }

  function resume() {
    if (document.visibilityState !== "visible") return;
    if (socket?.readyState === WebSocket.OPEN) {
      resync = true;
      requestRefresh();
    } else connect();
  }
  connect();
  window.addEventListener("online", resume);
  document.addEventListener("visibilitychange", resume);
  return () => {
    stopped = true;
    if (retry !== undefined) clearTimeout(retry);
    if (scheduled !== undefined) clearTimeout(scheduled);
    socket?.close();
    window.removeEventListener("online", resume);
    document.removeEventListener("visibilitychange", resume);
  };
}
