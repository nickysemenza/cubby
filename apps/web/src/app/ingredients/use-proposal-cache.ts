import { entityIdSchema, parseShortcodeFor } from "@cubby/schemas/identifiers";
import { useCallback, useRef, useState } from "react";

import { showErrorToast } from "~/components/feedback/error-details";
import { precomputeEnrichmentProposalsStream } from "~/lib/ai.functions";
import type { EnrichmentProposal } from "~/server/services/ai-enrichment/proposals";

/** One ingredient to pre-compute proposals for. */
interface ProposalRequest {
  id: string;
  name: string;
  /** Run the USDA matcher (skip for already-linked rows). */
  wantUsda: boolean;
  wantMerge: boolean;
}

function parseEnrichmentProposal(
  item: Awaited<
    ReturnType<typeof precomputeEnrichmentProposalsStream>
  > extends AsyncIterable<infer Event>
    ? Event extends { type: "progress"; item?: infer Item }
      ? NonNullable<Item>
      : never
    : never,
): EnrichmentProposal {
  return {
    ...item,
    id: parseShortcodeFor("ingredient", item.id),
    merge: item.merge
      ? {
          ...item.merge,
          target: item.merge.target
            ? {
                ...item.merge.target,
                id: entityIdSchema("ingredient").parse(item.merge.target.id),
                shortcode: parseShortcodeFor(
                  "ingredient",
                  item.merge.target.shortcode,
                ),
              }
            : null,
        }
      : null,
  };
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
      const iterable = await precomputeEnrichmentProposalsStream({
        items: page,
      });
      for await (const ev of iterable) {
        if (ev.type === "progress" && ev.item) {
          const item = ev.item;
          setCache((prev) => {
            const next = new Map(prev);
            const proposal = parseEnrichmentProposal(item);
            next.set(proposal.id, proposal);
            return next;
          });
        }
      }
    } catch (err) {
      // Page failed (network/abort): unmark so a later ensure() retries it.
      for (const it of page) requestedRef.current.delete(it.id);
      setRequested(requestedRef.current.size);
      showErrorToast(err, "Proposal prefetch failed");
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
    void pump();
  }, []);

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
