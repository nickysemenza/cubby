import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";

import {
  advanceToOutstanding,
  clearSkipped,
  emptyPassProgress,
  isPassComplete,
  isStoredPassComplete,
  outstandingAfterUnsettling,
  type PassCounts,
  type PassProgress,
  passCounts,
  type QueueStop,
  resolveStops,
  type StopDisposition,
  settledIds,
  settleStop,
  unsettleStop,
} from "./queue-pass";

/**
 * The canonical persisted shape of an in-flight pass.
 *
 * `extra` is an opaque per-flow blob — the recount session parks its staged
 * item resolutions and running summary there, while the photo pass has nothing
 * to add. Keeping it opaque is what lets one hook persist three flows without
 * knowing any of their domains.
 */
export interface StoredQueuePass<TExtra> {
  version: number;
  startedAt: number;
  updatedAt: number;
  currentIndex: number;
  completed: string[];
  skipped: string[];
  totalCount: number;
  extra?: TExtra;
}

export interface QueuePassPersistence<TExtra> {
  /** Full localStorage key for a scope, e.g. `cubby:audit-session:LOC-4K7M`. */
  storageKey: (scopeKey: string) => string;
  version: number;
  /** Parses the flow-owned payload before persisted state reaches the caller. */
  extraSchema: z.ZodType<TExtra>;
  /**
   * Read a stored blob this flow wrote under an older shape.
   *
   * Tried only when the canonical parse fails, so a flow that changed its
   * persisted layout keeps honoring passes already sitting on someone's phone.
   * Bumping a version without one silently discards every in-flight pass on the
   * device.
   */
  readLegacy?: (parsed: JsonValue) => StoredQueuePass<TExtra> | null;
}

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

const storedPassSchema = z.object({
  version: z.number(),
  startedAt: z.number(),
  updatedAt: z.number().optional(),
  currentIndex: z.number(),
  completed: z.array(z.string()),
  skipped: z.array(z.string()),
  totalCount: z.number().optional(),
  extra: z.json().optional(),
});

export interface QueuePassResumeCandidate<TExtra> {
  startedAt: number;
  updatedAt: number;
  completedCount: number;
  skippedCount: number;
  totalCount: number;
  extra: TExtra | undefined;
}

interface UseQueuePassOptions<TStop extends QueueStop, TExtra> {
  /**
   * Identity of the current scope. A change here — and only a change here — is
   * the boundary that re-freezes membership and restarts the pass. Query
   * refetches must not wipe an active pass, so this must not vary with them.
   * `null` means "no scope chosen yet".
   */
  scopeKey: string | null;
  /** Queue membership for the scope, evaluated at entry and then frozen. */
  candidateIds: readonly string[];
  /** Live content for every id in scope, including ones already handled. */
  stopsById: ReadonlyMap<string, TStop>;
  /** Omit for an ephemeral pass; supply to make it resumable. */
  persistence?: QueuePassPersistence<TExtra>;
  /**
   * Applies a restored pass's `extra` back into the caller's own state.
   *
   * Called on both adoption paths — the explicit Resume choice and the
   * automatic one for an already-finished pass — so a flow has exactly one
   * place that rehydrates its staged state. Held in a ref, so it need not be
   * memoized.
   */
  onAdopt?: (extra: TExtra | undefined) => void;
  /**
   * Per-flow state to persist alongside the queue bookkeeping.
   *
   * Must be referentially stable (memoized) — it is an effect dependency, and
   * a fresh object literal every render would rewrite localStorage every
   * render. Same rule as every other config object passed into a hook here.
   */
  extra?: TExtra;
}

export function parseStoredQueuePass<TExtra>(
  raw: string,
  persistence: QueuePassPersistence<TExtra>,
): StoredQueuePass<TExtra> | null {
  let parsed: JsonValue;
  try {
    const storedJson = z.json().safeParse(JSON.parse(raw));
    if (!storedJson.success) return null;
    parsed = storedJson.data;
  } catch {
    return null;
  }

  const candidate = storedPassSchema.safeParse(parsed);
  if (candidate.success && candidate.data.version === persistence.version) {
    const extra = persistence.extraSchema.safeParse(candidate.data.extra);
    if (!extra.success) return null;
    return {
      version: candidate.data.version,
      startedAt: candidate.data.startedAt,
      updatedAt: candidate.data.updatedAt ?? candidate.data.startedAt,
      currentIndex: candidate.data.currentIndex,
      completed: candidate.data.completed,
      skipped: candidate.data.skipped,
      totalCount: candidate.data.totalCount ?? 0,
      extra: extra.data,
    };
  }

  return persistence.readLegacy?.(parsed) ?? null;
}

/**
 * State for a flow that walks a queue of items one at a time: the cursor, the
 * settle bookkeeping, frozen membership, and optional resumable persistence.
 *
 * The semantics it fixes are documented on `queue-pass.ts`. The one worth
 * repeating: **membership is frozen per scope**. `candidateIds` is captured
 * when the scope changes and never recomputed, so handling an item cannot drop
 * it from the queue and renumber every position after it. Adjusting state
 * during render is the documented React pattern for this; the guard on a
 * non-empty candidate list keeps an in-flight query from freezing an empty
 * queue.
 */
export function useQueuePass<TStop extends QueueStop, TExtra = undefined>({
  scopeKey,
  candidateIds,
  stopsById,
  persistence,
  onAdopt,
  extra,
}: UseQueuePassOptions<TStop, TExtra>) {
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [progress, setProgress] = useState<PassProgress>(emptyPassProgress);
  const [resumeCandidate, setResumeCandidate] =
    useState<StoredQueuePass<TExtra> | null>(null);
  const [frozen, setFrozen] = useState<{ key: string; ids: string[] }>({
    key: "",
    ids: [],
  });

  const lastScopeKey = useRef<string | null>(null);
  // Referenced from the scope effect, which must run on a scope change only —
  // a caller passing a fresh config literal must not restart their pass.
  const persistenceRef = useRef(persistence);
  persistenceRef.current = persistence;
  const onAdoptRef = useRef(onAdopt);
  onAdoptRef.current = onAdopt;
  // Read inside the scope effect without making membership a dependency: the
  // freeze above already ran this render, so this holds the queue being entered.
  const candidateIdsRef = useRef(candidateIds);
  candidateIdsRef.current = candidateIds;

  const adopt = useCallback((stored: StoredQueuePass<TExtra>) => {
    setProgress({
      completed: new Set(stored.completed),
      skipped: new Set(stored.skipped),
    });
    setCurrentIndex(Math.max(0, stored.currentIndex));
    setStartedAt(stored.startedAt);
    setResumeCandidate(null);
    onAdoptRef.current?.(stored.extra);
  }, []);

  // Freeze membership and clear the previous scope's progress in one render, so
  // no frame shows old counts against a new queue.
  if (scopeKey !== null && frozen.key !== scopeKey && candidateIds.length > 0) {
    setFrozen({ key: scopeKey, ids: [...candidateIds] });
    setCurrentIndex(0);
    setProgress(emptyPassProgress());
  }

  // Scope change is the only initialization boundary for persistence.
  useEffect(() => {
    if (scopeKey === lastScopeKey.current) return;
    lastScopeKey.current = scopeKey;
    setResumeCandidate(null);

    const config = persistenceRef.current;
    if (!scopeKey || !config) {
      setStartedAt(scopeKey ? Date.now() : null);
      return;
    }

    let raw: string | null = null;
    try {
      raw = localStorage.getItem(config.storageKey(scopeKey));
    } catch {
      // SILENT: private mode / quota failures must not block starting a pass.
    }
    const restored = raw ? parseStoredQueuePass(raw, config) : null;
    if (!restored) {
      setStartedAt(Date.now());
      return;
    }

    // A finished pass has nothing to resume — reopen it on its summary rather
    // than offering a Resume/Start-over choice that leads nowhere. Only
    // *unfinished* work is gated behind that prompt, so a half-finished pass
    // from days ago never silently becomes the live one.
    if (isStoredPassComplete(restored, candidateIdsRef.current)) {
      adopt(restored);
      return;
    }
    setStartedAt(null);
    setResumeCandidate(restored);
  }, [scopeKey, adopt]);

  const stops = useMemo(
    () => resolveStops(frozen.ids, stopsById),
    [frozen, stopsById],
  );
  const settled = useMemo(() => settledIds(progress), [progress]);
  const counts = useMemo(
    (): PassCounts => passCounts(stops, progress),
    [stops, progress],
  );
  const complete = isPassComplete(stops, settled);
  const current = stops[currentIndex] ?? null;

  // Persist on every change once the pass is live. Skipped while a resume
  // choice is pending, so rendering the prompt cannot overwrite the very blob
  // the user is being offered.
  useEffect(() => {
    const config = persistenceRef.current;
    if (!config || !scopeKey || startedAt === null || resumeCandidate) return;
    const payload: StoredQueuePass<TExtra> = {
      version: config.version,
      startedAt,
      updatedAt: Date.now(),
      currentIndex,
      completed: [...progress.completed],
      skipped: [...progress.skipped],
      totalCount: stops.length,
      extra,
    };
    try {
      localStorage.setItem(
        config.storageKey(scopeKey),
        JSON.stringify(payload),
      );
    }
    // SILENT: best effort — a failed write must not block the pass; the
    // in-memory progress state is still authoritative for this session.
    catch {}
  }, [
    scopeKey,
    startedAt,
    resumeCandidate,
    currentIndex,
    progress,
    stops.length,
    extra,
  ]);

  const settle = useCallback(
    (id: string, disposition: StopDisposition) => {
      const next = settleStop(progress, id, disposition);
      setProgress(next);
      setCurrentIndex(
        advanceToOutstanding(stops, currentIndex, settledIds(next)),
      );
    },
    [progress, stops, currentIndex],
  );

  /** Return a stop to the queue and put the cursor back on it. */
  const unsettle = useCallback(
    (id: string) => {
      setProgress(unsettleStop(progress, id));
      setCurrentIndex(outstandingAfterUnsettling(stops, currentIndex, id));
    },
    [progress, stops, currentIndex],
  );

  /** Undo every deferral and land on the first of them. */
  const revisitSkipped = useCallback(() => {
    const next = clearSkipped(progress);
    setProgress(next);
    setCurrentIndex(advanceToOutstanding(stops, -1, settledIds(next)));
  }, [progress, stops]);

  const jumpTo = useCallback((index: number) => setCurrentIndex(index), []);

  /**
   * Move the cursor to a stop by id, reporting whether the queue holds it.
   *
   * Resolving here rather than at the call site is the point: the cursor is an
   * index into the *frozen* queue, so a caller that looked the id up in its own
   * live list would be handing over an index from a different space.
   */
  const jumpToId = useCallback(
    (id: string) => {
      const index = stops.findIndex((stop) => stop.id === id);
      if (index < 0) return false;
      setCurrentIndex(index);
      return true;
    },
    [stops],
  );

  const startNewPass = useCallback(() => {
    setResumeCandidate(null);
    setStartedAt(Date.now());
    setCurrentIndex(0);
    setProgress(emptyPassProgress());
  }, []);

  /** Adopt the stored pass the prompt is offering. */
  const resumePass = useCallback(() => {
    if (resumeCandidate) adopt(resumeCandidate);
  }, [adopt, resumeCandidate]);

  const resume = useMemo(
    (): QueuePassResumeCandidate<TExtra> | null =>
      resumeCandidate
        ? {
            startedAt: resumeCandidate.startedAt,
            updatedAt: resumeCandidate.updatedAt,
            completedCount: resumeCandidate.completed.length,
            skippedCount: resumeCandidate.skipped.length,
            totalCount: resumeCandidate.totalCount,
            extra: resumeCandidate.extra,
          }
        : null,
    [resumeCandidate],
  );

  return {
    stops,
    current,
    currentIndex,
    progress,
    settled,
    counts,
    complete,
    startedAt,
    settle,
    unsettle,
    revisitSkipped,
    jumpTo,
    jumpToId,
    resumeCandidate: resume,
    resumePass,
    startNewPass,
  };
}

/** Remove a scope's stored pass — call once its work is committed. */
export function clearStoredQueuePass<TExtra>(
  persistence: QueuePassPersistence<TExtra>,
  scopeKey: string,
): void {
  try {
    localStorage.removeItem(persistence.storageKey(scopeKey));
  } catch {
    // SILENT: best effort, as with the write.
  }
}
