/**
 * Pure queue-pass logic: the walk order, the settle bookkeeping, and the
 * advance cursor for any flow that works a list of items one at a time.
 *
 * Three flows independently grew this shape — the location photo pass, the
 * inventory recount session, and the ingredient enrichment review queue — and
 * each picked a different membership model, a different cursor, and a
 * different meaning for "skip". The divergence was not cosmetic: the review
 * queue *filtered* handled rows out of its queue, so handling one renumbered
 * every position after it mid-pass. This module fixes the semantics in one
 * place so a flow cannot pick the wrong one.
 *
 * Deliberately dependency-free (no React, no transport, no `~/` imports) so vitest's
 * `unit` project can exercise the invariants on plain fixtures, matching the
 * discipline of `entities/view-manifest.ts`.
 */

/** Anything walkable by a pass: a stable id is the only requirement. */
export interface QueueStop {
  id: string;
}

/**
 * How a stop left the outstanding set.
 *
 * Both dispositions settle a stop, and they are kept disjoint (see
 * {@link settleStop}) so `completed + skipped` always equals the settled total
 * and a summary can report the two separately without double-counting.
 */
export type StopDisposition = "completed" | "skipped";

/**
 * A pass's settle bookkeeping.
 *
 * `skipped` means **deferred**, never removed — a skipped stop stays in the
 * queue, keeps its position, and is reachable again via
 * {@link outstandingAfterUnsettling} or a "revisit skipped" affordance. That is
 * the one semantic all three flows now share; previously the review queue
 * dropped a skipped row for good.
 */
export interface PassProgress {
  completed: ReadonlySet<string>;
  skipped: ReadonlySet<string>;
}

export const emptyPassProgress = (): PassProgress => ({
  completed: new Set(),
  skipped: new Set(),
});

/** Every stop handled this pass, whichever way it went. */
export function settledIds(progress: PassProgress): ReadonlySet<string> {
  return new Set([...progress.completed, ...progress.skipped]);
}

export function isSettled(progress: PassProgress, id: string): boolean {
  return progress.completed.has(id) || progress.skipped.has(id);
}

/**
 * Record a disposition, keeping the two sets disjoint.
 *
 * Completing a previously-skipped stop un-skips it, so a pass that defers a bin
 * and comes back to it reports one completion rather than one of each. Returns
 * the same object when nothing changed, so callers can use it directly in a
 * `useState` updater without forcing a render.
 */
export function settleStop(
  progress: PassProgress,
  id: string,
  disposition: StopDisposition,
): PassProgress {
  const inTarget =
    disposition === "completed"
      ? progress.completed.has(id)
      : progress.skipped.has(id);
  const other =
    disposition === "completed" ? progress.skipped : progress.completed;
  if (inTarget && !other.has(id)) return progress;

  const completed = new Set(progress.completed);
  const skipped = new Set(progress.skipped);
  if (disposition === "completed") {
    completed.add(id);
    skipped.delete(id);
  } else {
    skipped.add(id);
    completed.delete(id);
  }
  return { completed, skipped };
}

/**
 * Return a stop to the outstanding set — the undo behind "retake this photo"
 * and "revisit this location".
 */
export function unsettleStop(progress: PassProgress, id: string): PassProgress {
  if (!isSettled(progress, id)) return progress;
  const completed = new Set(progress.completed);
  const skipped = new Set(progress.skipped);
  completed.delete(id);
  skipped.delete(id);
  return { completed, skipped };
}

/** Clear every deferral, so a "revisit skipped" pass has somewhere to go. */
export function clearSkipped(progress: PassProgress): PassProgress {
  if (progress.skipped.size === 0) return progress;
  return { completed: progress.completed, skipped: new Set() };
}

/**
 * The next stop that still needs attention: scan forward from `currentIndex`,
 * then wrap to the first outstanding stop before it. Returns `currentIndex`
 * when everything is settled, so the caller's "pass complete" check stays a
 * separate, explicit test rather than a sentinel.
 *
 * Callers must pass a `settled` set that already includes the stop they just
 * finished — the React state holding it has not flushed yet at call time.
 */
export function advanceToOutstanding<T extends QueueStop>(
  stops: readonly T[],
  currentIndex: number,
  settled: ReadonlySet<string>,
): number {
  const after = stops.findIndex(
    (stop, index) => index > currentIndex && !settled.has(stop.id),
  );
  if (after >= 0) return after;
  const wrapped = stops.findIndex((stop) => !settled.has(stop.id));
  return wrapped >= 0 ? wrapped : currentIndex;
}

/**
 * Where the cursor should land after a stop is returned to the outstanding set:
 * on that stop, if the queue still holds it. Falls back to the current index so
 * an unsettle of an off-queue id is a no-op rather than a jump to zero.
 */
export function outstandingAfterUnsettling<T extends QueueStop>(
  stops: readonly T[],
  currentIndex: number,
  id: string,
): number {
  const index = stops.findIndex((stop) => stop.id === id);
  return index >= 0 ? index : currentIndex;
}

/**
 * True once every stop has been handled.
 *
 * An empty queue is "nothing to do", not a finished pass — reporting it as
 * complete would show a summary for a pass that never ran, so the flows render
 * their own empty state instead.
 */
export function isPassComplete<T extends QueueStop>(
  stops: readonly T[],
  settled: ReadonlySet<string>,
): boolean {
  return stops.length > 0 && stops.every((stop) => settled.has(stop.id));
}

export interface PassCounts {
  total: number;
  completed: number;
  skipped: number;
  settled: number;
  outstanding: number;
}

/**
 * Counts for the pass header, computed against the frozen queue rather than the
 * progress sets. A stop that left the queue's scope still sits in `completed`,
 * so counting the sets directly can report more done than there are stops.
 */
export function passCounts<T extends QueueStop>(
  stops: readonly T[],
  progress: PassProgress,
): PassCounts {
  let completed = 0;
  let skipped = 0;
  for (const stop of stops) {
    if (progress.completed.has(stop.id)) completed += 1;
    else if (progress.skipped.has(stop.id)) skipped += 1;
  }
  const settled = completed + skipped;
  return {
    total: stops.length,
    completed,
    skipped,
    settled,
    outstanding: stops.length - settled,
  };
}

/**
 * Resolve a frozen id list against the live contents.
 *
 * Membership is captured once per scope and never recomputed, while the content
 * behind each id stays live. Recomputing membership is the bug this prevents:
 * photographing a location drops it from the "needs a photo" filter, which
 * would renumber every stop after it and move the queue out from under the
 * person walking it. Ids whose content has gone are dropped, so a deleted row
 * shortens the queue instead of rendering a hole.
 */
export function resolveStops<T extends QueueStop>(
  frozenIds: readonly string[],
  byId: ReadonlyMap<string, T>,
): T[] {
  const out: T[] = [];
  for (const id of frozenIds) {
    const stop = byId.get(id);
    if (stop) out.push(stop);
  }
  return out;
}

/**
 * Whether stored progress already settles every stop in the current queue.
 *
 * A finished pass has nothing to resume, so offering "Resume or start over"
 * for one is a dead end — it must reopen on its summary instead. Measured
 * against the live queue rather than the stored total, so a pass whose scope
 * has since grown correctly reads as unfinished.
 */
export function isStoredPassComplete(
  stored: { completed: readonly string[]; skipped: readonly string[] },
  queueIds: readonly string[],
): boolean {
  if (queueIds.length === 0) return false;
  const settled = new Set([...stored.completed, ...stored.skipped]);
  return queueIds.every((id) => settled.has(id));
}
