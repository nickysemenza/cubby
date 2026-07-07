import { useCallback, useRef, useState } from "react";
import type { EnrichmentProposal } from "~/server/services/ai-enrichment/proposals";
import { useTRPCClient } from "~/trpc/react";

/** One ingredient to pre-compute proposals for. */
interface ProposalRequest {
  id: string;
  name: string;
  /** Run the USDA matcher (skip for already-linked rows). */
  wantUsda: boolean;
  wantMerge: boolean;
}

// One request = one server window (concurrency 5). A small page keeps each
// streamed request short so cancel/pause is responsive and the lookahead window
// fills a card at a time.
const PAGE_SIZE = 5;

/**
 * Client-side cache + driver for the review queue's read-only AI pre-compute.
 * `ensure(window)` enqueues the not-yet-requested ingredients (the caller passes
 * them in priority order — the lookahead window first); a single streamed
 * request at a time drains pages of {@link PAGE_SIZE}, writing each settled
 * proposal into the cache so the card it belongs to is ready before the user
 * reaches it. Pausing stops opening new pages (the current one finishes — it's
 * cheap and read-only). Nothing here writes/links/merges.
 */
export function useProposalCache() {
  const client = useTRPCClient();
  const [cache, setCache] = useState<Map<string, EnrichmentProposal>>(
    () => new Map(),
  );
  // ids already sent to a page (or in the queue) so ensure() doesn't re-enqueue.
  const requestedRef = useRef<Set<string>>(new Set());
  const queueRef = useRef<ProposalRequest[]>([]);
  const runningRef = useRef(false);
  const pausedRef = useRef(false);
  const [running, setRunning] = useState(false);
  const [paused, setPausedState] = useState(false);
  const [requested, setRequested] = useState(0);

  const pump = useCallback(async () => {
    if (runningRef.current || pausedRef.current) return;
    const page = queueRef.current.splice(0, PAGE_SIZE);
    if (page.length === 0) return;
    runningRef.current = true;
    setRunning(true);
    try {
      const iterable = await client.ai.precomputeEnrichmentProposals.mutate({
        items: page,
      });
      for await (const ev of iterable) {
        if (ev.type === "progress" && ev.item) {
          const item = ev.item;
          setCache((prev) => {
            const next = new Map(prev);
            next.set(item.id, item);
            return next;
          });
        }
      }
    } catch (err) {
      // Page failed (network/abort): unmark so a later ensure() retries it.
      for (const it of page) requestedRef.current.delete(it.id);
      setRequested(requestedRef.current.size);
      console.error("[useProposalCache] page failed", err);
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
    void pump();
  }, [client]);

  /** Enqueue any not-yet-requested ingredients, in the order given (priority first). */
  const ensure = useCallback(
    (items: ProposalRequest[]) => {
      const fresh = items.filter((it) => !requestedRef.current.has(it.id));
      if (fresh.length === 0) return;
      for (const it of fresh) requestedRef.current.add(it.id);
      setRequested(requestedRef.current.size);
      queueRef.current.push(...fresh);
      void pump();
    },
    [pump],
  );

  const setPaused = useCallback(
    (p: boolean) => {
      pausedRef.current = p;
      setPausedState(p);
      if (!p) void pump();
    },
    [pump],
  );

  const get = useCallback((id: string) => cache.get(id), [cache]);

  return {
    get,
    ensure,
    setPaused,
    paused,
    running,
    stats: { requested, ready: cache.size },
  };
}
