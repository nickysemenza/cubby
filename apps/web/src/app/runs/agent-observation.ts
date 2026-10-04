import {
  agentConversationSchema,
  type AgentConversation,
} from "@cubby/schemas/agent-conversation";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { EventSourceParserStream } from "eventsource-parser/stream";
import { useEffect, useSyncExternalStore } from "react";

import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
import type { UnparsedError } from "~/lib/error-utils";

/** The Cubby agent conversation route for a run's agent (`GET`/`POST`/`stream`/`abort`). */
export const agentUrl = (publicId: string) =>
  `/api/import/runs/${encodeURIComponent(publicId)}/agent`;

/** The client's connection phase, distinct from the conversation's own `status`. */
export type AgentConversationObservationPhase =
  | "connecting"
  | "live"
  | "absent"
  | "closed"
  | "error";

export interface AgentConversationObservationSnapshot {
  phase: AgentConversationObservationPhase;
  conversation?: AgentConversation;
  error?: Error;
}

export interface AgentConversationObservation {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => AgentConversationObservationSnapshot;
  /** A one-off GET, for a run with no agent yet (the stream has nothing to push). */
  refresh: () => void;
  close: () => void;
}

const INITIAL_SNAPSHOT: AgentConversationObservationSnapshot = {
  phase: "connecting",
};

/** Every event's `data` is a full snapshot; a malformed one is dropped, not applied. */
function parseSnapshotData(data: string): AgentConversation | undefined {
  if (!data || data === "[DONE]") return undefined;
  try {
    const parsed = agentConversationSchema.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Decodes and parses SSE framing (tolerating a `data:` line split across
 * chunk boundaries — `EventSourceParserStream` buffers a partial line itself).
 */
async function readEvents(
  body: ReadableStream<BufferSource>,
  onData: (data: string) => void,
) {
  const reader = body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream())
    .getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      onData(value.data);
    }
  } finally {
    // SILENT: canceling an already-closed or already-errored reader just
    // rejects; the stream is ending either way, so there is nothing left to
    // surface it to.
    await reader.cancel().catch(() => {});
  }
}

const phaseForStatus = (
  status: AgentConversation["status"],
): AgentConversationObservationPhase =>
  status === "absent" ? "absent" : "live";

/**
 * Opens the run's agent conversation: an SSE connection to `${url}/stream`
 * (reconnected with backoff while open) plus a `refresh` escape hatch for a
 * plain `GET ${url}` snapshot. Every reader of a run shares one of these
 * through the registry below.
 */
export function openAgentObservation(
  url: string,
): AgentConversationObservation {
  const listeners = new Set<() => void>();
  let snapshot = INITIAL_SNAPSHOT;
  let closed = false;
  let controller: AbortController | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;

  const emit = () => {
    for (const listener of listeners) listener();
  };
  const setSnapshot = (next: AgentConversationObservationSnapshot) => {
    snapshot = next;
    emit();
  };

  const scheduleReconnect = () => {
    if (closed) return;
    attempt += 1;
    const delayMs = Math.min(30_000, 1_000 * 2 ** (attempt - 1));
    reconnectTimer = setTimeout(connect, delayMs);
  };

  function connect() {
    if (closed) return;
    controller = new AbortController();
    const { signal } = controller;
    // Keep the last-good conversation visible across a reconnect; only the
    // very first connect (no conversation yet) shows the connecting state.
    if (!snapshot.conversation)
      setSnapshot({ ...snapshot, phase: "connecting" });
    fetch(`${url}/stream`, {
      credentials: "same-origin",
      headers: { accept: "text/event-stream" },
      signal,
    })
      .then(async (response) => {
        if (!response.ok || !response.body) {
          throw new Error(`Agent stream responded ${response.status}`);
        }
        attempt = 0;
        await readEvents(response.body, (data) => {
          const conversation = parseSnapshotData(data);
          if (conversation)
            setSnapshot({
              phase: phaseForStatus(conversation.status),
              conversation,
            });
        });
        if (closed || signal.aborted) return;
        // The server closed the stream; reconnect rather than going stale.
        scheduleReconnect();
      })
      .catch((error: UnparsedError) => {
        if (closed || signal.aborted) return;
        setSnapshot({
          ...snapshot,
          phase: "error",
          error: error instanceof Error ? error : new Error(String(error)),
        });
        scheduleReconnect();
      });
  }

  connect();

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    refresh: () => {
      fetch(url, { credentials: "same-origin" })
        .then(async (response) => {
          if (!response.ok) return;
          const parsed = agentConversationSchema.safeParse(
            await response.json().catch(() => null),
          );
          if (parsed.success)
            setSnapshot({
              phase: phaseForStatus(parsed.data.status),
              conversation: parsed.data,
            });
        })
        .catch(() => {
          // SILENT: `refresh` is a best-effort escape hatch alongside the
          // live SSE connection, which already owns error/reconnect
          // handling; a failed one-off refresh leaves the current snapshot
          // in place.
        });
    },
    close: () => {
      closed = true;
      controller?.abort();
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      setSnapshot({ ...snapshot, phase: "closed" });
      listeners.clear();
    },
  };
}

interface Entry {
  observation: AgentConversationObservation;
  retainers: number;
  reviewWatchers: number;
  stopReviewWatch: (() => void) | undefined;
}

/**
 * One observation per run, shared by everything on the page that reads the
 * agent conversation. Refcounted so the stream opens once and closes with its
 * last reader. `open` is injected so a test can supply a fake stream.
 */
export function createObservationRegistry(
  open: (publicId: string) => AgentConversationObservation,
) {
  const entries = new Map<string, Entry>();
  const entryFor = (publicId: string): Entry => {
    const existing = entries.get(publicId);
    if (existing) return existing;
    const entry: Entry = {
      observation: open(publicId),
      retainers: 0,
      reviewWatchers: 0,
      stopReviewWatch: undefined,
    };
    entries.set(publicId, entry);
    return entry;
  };
  /** Keep the run's observation open until the returned release runs. */
  const retain = (publicId: string): (() => void) => {
    const entry = entryFor(publicId);
    entry.retainers += 1;
    return () => {
      entry.retainers -= 1;
      // Deferred so a synchronous remount (a key change, StrictMode) keeps the
      // stream instead of reconnecting it.
      queueMicrotask(() => {
        if (entry.retainers > 0 || entries.get(publicId) !== entry) return;
        entries.delete(publicId);
        entry.observation.close();
      });
    };
  };
  return { entryFor, retain };
}

const registry = createObservationRegistry((publicId) =>
  openAgentObservation(agentUrl(publicId)),
);
const { entryFor } = registry;
const retainAgentObservation = registry.retain;

/** Whether a run has an agent whose conversation this page can observe. */
export const runHasAgent = (run: {
  dispatch?: { eventId?: string | null | undefined } | null;
}): boolean => Boolean(run.dispatch?.eventId);

/**
 * The shared observation for a run, open while the caller is mounted. It is
 * created in render (as a per-surface `useMemo` would) and retained from the
 * effect.
 */
export function useAgentObservation(publicId: string) {
  const { observation } = entryFor(publicId);
  useEffect(() => retainAgentObservation(publicId), [publicId]);
  return observation;
}

const noopSubscribe = () => () => {};

function usePhase(
  observation: AgentConversationObservation | undefined,
): AgentConversationObservationPhase | undefined {
  return useSyncExternalStore(
    observation?.subscribe ?? noopSubscribe,
    () => observation?.getSnapshot().phase,
    () => undefined,
  );
}

/** What a reader of the conversation would see change: phase, messages, parts, settlements. */
function conversationSignature({
  conversation,
  phase,
}: AgentConversationObservationSnapshot) {
  const messages = conversation?.messages ?? [];
  const parts = messages.reduce((total, { parts }) => total + parts.length, 0);
  return `${phase}|${messages.length}|${parts}|${conversation?.settlements.length ?? 0}`;
}

/**
 * Calls `onChange` when the conversation gains a message, part or settlement
 * or the stream changes phase — not on every token delta inside a part. The
 * first change fires at once; a burst after it collapses to one trailing call.
 */
export function watchAgentChanges(
  observation: AgentConversationObservation,
  onChange: () => void,
  throttleMs = 1_000,
): () => void {
  let last = conversationSignature(observation.getSnapshot());
  let lastFiredAt = Number.NEGATIVE_INFINITY;
  let trailing: ReturnType<typeof setTimeout> | undefined;
  const fire = () => {
    trailing = undefined;
    lastFiredAt = Date.now();
    onChange();
  };
  const unsubscribe = observation.subscribe(() => {
    const next = conversationSignature(observation.getSnapshot());
    if (next === last) return;
    last = next;
    if (trailing !== undefined) return;
    const wait = lastFiredAt + throttleMs - Date.now();
    if (wait <= 0) fire();
    else trailing = setTimeout(fire, wait);
  });
  return () => {
    unsubscribe();
    if (trailing !== undefined) clearTimeout(trailing);
  };
}

/**
 * One review invalidation per run however many readers ask: the first watcher
 * installs it, the last removes it.
 */
function retainReviewWatch(publicId: string, queryClient: QueryClient) {
  const entry = entryFor(publicId);
  entry.reviewWatchers += 1;
  if (entry.reviewWatchers === 1)
    entry.stopReviewWatch = watchAgentChanges(entry.observation, () => {
      // `photoImport.review` carries the run tag with the rest of the page.
      void invalidateOperationTags(queryClient, ripple.runOnly);
    });
  return () => {
    entry.reviewWatchers -= 1;
    if (entry.reviewWatchers === 0) {
      entry.stopReviewWatch?.();
      entry.stopReviewWatch = undefined;
    }
  };
}

/**
 * While `observing`, keeps a photo run's review query fresh from the shared
 * agent stream and reports whether that stream is live. `false` when the run
 * has no agent, is no longer live, or the stream has not connected.
 */
export function useAgentReviewSync(publicId: string, observing: boolean) {
  const queryClient = useQueryClient();
  const observation = observing ? entryFor(publicId).observation : undefined;
  useEffect(() => {
    if (!observing) return;
    const release = retainAgentObservation(publicId);
    const releaseWatch = retainReviewWatch(publicId, queryClient);
    return () => {
      releaseWatch();
      release();
    };
  }, [observing, publicId, queryClient]);
  return usePhase(observation) === "live";
}

const WORKER_PENDING_STATES = ["pending", "waiting_for_device", "leased"];

/** Statuses during which the agent or the device may still change the run. */
export const LIVE_RUN_STATUSES = new Set([
  "running",
  "paused_auth",
  "paused_offline",
  "paused_approval",
]);

/**
 * How often a photo run's review refetches. A live agent stream reports the
 * agent's changes, so the poll relaxes to a safety net; the cutout and
 * describe workers report through no stream, so their poll stays.
 */
export function photoReviewPollInterval({
  runStatus,
  agentLive,
  data,
}: {
  runStatus: string;
  agentLive: boolean;
  data:
    | {
        images: ReadonlyArray<{
          cutout: string | null;
          describe: string | null;
        }>;
      }
    | undefined;
}): number | false {
  const workersPending = data?.images.some((image) =>
    WORKER_PENDING_STATES.some(
      (state) => image.cutout === state || image.describe === state,
    ),
  );
  if (workersPending)
    return LIVE_RUN_STATUSES.has(runStatus) && !agentLive ? 3_000 : 15_000;
  if (!LIVE_RUN_STATUSES.has(runStatus)) return false;
  return agentLive ? 30_000 : 3_000;
}
