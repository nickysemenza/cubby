import type { QueryClient } from "@tanstack/react-query";

import {
  DATABASE_CHANGES_SOCKET_PATH,
  databaseChangeMessage,
} from "~/lib/database-changes";
import { showErrorToast } from "~/ui/feedback/error-details";

import { combineRippleTags, entityRipple } from "./cache-tags";
import {
  cancelQueriesByTags,
  invalidateOperationTags,
  resyncOperationQueries,
} from "./operation-cache";

/** One socket per authenticated shell; records still come from authoritative queries. */
export function subscribeDatabaseChanges(client: QueryClient): () => void {
  let stopped = false;
  let socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let refreshing = false;
  let resync = false;
  const pending = new Set<string>();

  async function refresh() {
    if (refreshing || stopped) return;
    refreshing = true;
    try {
      while (resync || pending.size) {
        if (stopped) break;
        const full = resync;
        const categories = [...pending];
        resync = false;
        pending.clear();
        if (full) {
          await resyncOperationQueries(client);
        } else {
          const tags = combineRippleTags(...categories.map(entityRipple));
          await cancelQueriesByTags(client, tags);
          await invalidateOperationTags(client, tags, { removeInactive: true });
        }
      }
    } finally {
      refreshing = false;
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
    const url = new URL(DATABASE_CHANGES_SOCKET_PATH, window.location.origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const current = new WebSocket(url);
    socket = current;
    current.addEventListener("open", () => {
      attempt = 0;
      // Subscribe before reading: writes during initial load/reconnect cannot fall between them.
      resync = true;
      requestRefresh();
    });
    current.addEventListener("message", (event: MessageEvent<unknown>) => {
      try {
        const message = databaseChangeMessage.parse(
          JSON.parse(String(event.data)),
        );
        for (const category of message.categories) pending.add(category);
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
    socket?.close();
    window.removeEventListener("online", resume);
    document.removeEventListener("visibilitychange", resume);
  };
}
