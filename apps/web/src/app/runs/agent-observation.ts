import {
  createFlueClient,
  type AgentConversationObservation,
  type AgentConversationObservationPhase,
  type AgentConversationObservationSnapshot,
} from "@flue/sdk";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";

import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";

/** The Flue conversation route for a run's agent, not a Cubby operation. */
export const agentUrl = (publicId: string) =>
  `/api/import/runs/${encodeURIComponent(publicId)}/agent`;

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
  createFlueClient({ url: agentUrl(publicId) }).observe({ live: "sse" }),
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
    | { images: ReadonlyArray<{ cutout: string; describe: string }> }
    | undefined;
}): number | false {
  const workersPending = data?.images.some(
    (image) =>
      WORKER_PENDING_STATES.includes(image.cutout) ||
      WORKER_PENDING_STATES.includes(image.describe),
  );
  if (workersPending)
    return LIVE_RUN_STATUSES.has(runStatus) && !agentLive ? 3_000 : 15_000;
  if (!LIVE_RUN_STATUSES.has(runStatus)) return false;
  return agentLive ? 30_000 : 3_000;
}
