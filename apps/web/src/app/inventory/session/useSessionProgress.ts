import { useCallback, useMemo, useState } from "react";
import {
  clearStoredQueuePass,
  type QueuePassPersistence,
  type StoredQueuePass,
  useQueuePass,
} from "~/app/_components/queue-pass/useQueuePass";
import type { ItemResolution } from "./_components/types";
import type { SessionLocation } from "./session-utils";

const AUDIT_SESSION_STORAGE_PREFIX = "cubby:audit-session:";

/**
 * Bumped from 3 when the pass moved onto the shared `useQueuePass` envelope,
 * which names the settle sets `completed`/`skipped` and parks recount's own
 * staged state under `extra`. Version 3 blobs are still read — see
 * {@link readLegacyV3}. Bumping without that reader would silently discard
 * every in-flight recount sitting on someone's phone.
 */
const SESSION_PROGRESS_VERSION = 4;

export interface SessionSummary {
  adjusted: number;
  locations: number;
  relocated: number;
  removed: number;
  verified: number;
}

/** Recount's slice of the persisted pass: what the queue core doesn't own. */
interface SessionExtra {
  itemResolutions: [string, ItemResolution][];
  summary: SessionSummary;
}

/**
 * One unfinished pass discovered in localStorage, for the session picker's
 * resume list. `totalCount` is null for entries written before it was
 * persisted — resolve the total from the location tree in that case.
 */
export interface StoredSessionPass {
  rootId: string;
  startedAt: number;
  updatedAt: number;
  completedCount: number;
  skippedCount: number;
  totalCount: number | null;
}

const emptySummary = (): SessionSummary => ({
  adjusted: 0,
  locations: 0,
  relocated: 0,
  removed: 0,
  verified: 0,
});

/** The pre-`useQueuePass` on-disk shape. Inbound only; nothing writes it. */
interface PersistedV3 {
  version: 3;
  startedAt: number;
  updatedAt?: number;
  totalCount?: number;
  itemResolutions: [string, ItemResolution][];
  completedLocationIds: string[];
  skippedLocationIds?: string[];
  currentIndex: number;
  summary: SessionSummary;
}

function readLegacyV3(parsed: unknown): StoredQueuePass<SessionExtra> | null {
  const v3 = parsed as Partial<PersistedV3>;
  if (
    v3.version !== 3 ||
    typeof v3.startedAt !== "number" ||
    typeof v3.currentIndex !== "number" ||
    !Array.isArray(v3.itemResolutions) ||
    !Array.isArray(v3.completedLocationIds) ||
    !v3.summary
  ) {
    return null;
  }
  return {
    version: 3,
    startedAt: v3.startedAt,
    updatedAt: v3.updatedAt ?? v3.startedAt,
    currentIndex: v3.currentIndex,
    completed: v3.completedLocationIds,
    skipped: v3.skippedLocationIds ?? [],
    totalCount: v3.totalCount ?? 0,
    extra: { itemResolutions: v3.itemResolutions, summary: v3.summary },
  };
}

const SESSION_PERSISTENCE: QueuePassPersistence<SessionExtra> = {
  storageKey: (rootId) => `${AUDIT_SESSION_STORAGE_PREFIX}${rootId}`,
  version: SESSION_PROGRESS_VERSION,
  readLegacy: readLegacyV3,
};

/**
 * Every pass this device has stored, newest write first. Client-only: returns
 * an empty array during SSR so callers can render it straight into markup.
 *
 * Reads both the current envelope and v3, so the picker keeps listing passes
 * started before the migration.
 */
export function listStoredSessionPasses(): StoredSessionPass[] {
  if (typeof window === "undefined") return [];
  const passes: StoredSessionPass[] = [];
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith(AUDIT_SESSION_STORAGE_PREFIX)) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }

      const current = parsed as Partial<StoredQueuePass<SessionExtra>>;
      const pass =
        current.version === SESSION_PROGRESS_VERSION &&
        typeof current.startedAt === "number" &&
        Array.isArray(current.completed) &&
        Array.isArray(current.skipped)
          ? {
              startedAt: current.startedAt,
              updatedAt: current.updatedAt ?? current.startedAt,
              completed: current.completed,
              skipped: current.skipped,
              totalCount: current.totalCount ?? 0,
            }
          : readLegacyV3(parsed);
      if (!pass) continue;

      passes.push({
        rootId: key.slice(AUDIT_SESSION_STORAGE_PREFIX.length),
        startedAt: pass.startedAt,
        updatedAt: pass.updatedAt,
        completedCount: pass.completed.length,
        skippedCount: pass.skipped.length,
        totalCount: pass.totalCount || null,
      });
    }
  } catch {
    // Private mode / disabled storage: no resume list, not an error.
    return [];
  }
  return passes.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function clearStoredSessionPass(rootId: string) {
  clearStoredQueuePass(SESSION_PERSISTENCE, rootId);
}

/**
 * Recount's pass state: the shared queue bookkeeping plus the two things only a
 * recount has — the staged per-item resolutions and the running summary, which
 * ride along in the persisted `extra` blob.
 */
export function useSessionProgress(
  rootId: string | null,
  sessionLocations: SessionLocation[],
) {
  const [itemResolutions, setItemResolutions] = useState<
    Map<string, ItemResolution>
  >(() => new Map());
  const [summary, setSummary] = useState<SessionSummary>(emptySummary);

  const stopsById = useMemo(
    () =>
      new Map<string, SessionLocation>(
        sessionLocations.map((location) => [location.id, location]),
      ),
    [sessionLocations],
  );
  const candidateIds = useMemo(
    () => sessionLocations.map((location) => location.id),
    [sessionLocations],
  );
  const extra = useMemo(
    (): SessionExtra => ({ itemResolutions: [...itemResolutions], summary }),
    [itemResolutions, summary],
  );

  // Rehydrates the staged choices and running tally whichever way the pass is
  // adopted — the explicit Resume, or the automatic reopen of a finished pass.
  const applyExtra = useCallback((restored: SessionExtra | undefined) => {
    setItemResolutions(new Map(restored?.itemResolutions ?? []));
    setSummary(restored?.summary ?? emptySummary());
  }, []);

  const pass = useQueuePass<SessionLocation, SessionExtra>({
    scopeKey: rootId,
    candidateIds,
    stopsById,
    persistence: SESSION_PERSISTENCE,
    onAdopt: applyExtra,
    extra,
  });

  const { resumePass, startNewPass: freshPass } = pass;

  const startNewPass = useCallback(() => {
    freshPass();
    setItemResolutions(new Map());
    setSummary(emptySummary());
  }, [freshPass]);

  const { settle, unsettle } = pass;

  /** Commit a bin: tally it, settle it, and move to the next one outstanding. */
  const recordLocationComplete = useCallback(
    (
      locationId: string,
      resolutions: ReadonlyArray<{
        kind: "verify" | "adjust" | "remove" | "relocate";
      }>,
    ) => {
      setSummary((previous) => {
        const next = { ...previous, locations: previous.locations + 1 };
        for (const resolution of resolutions) {
          if (resolution.kind === "verify") next.verified += 1;
          if (resolution.kind === "adjust") next.adjusted += 1;
          if (resolution.kind === "remove") next.removed += 1;
          if (resolution.kind === "relocate") next.relocated += 1;
        }
        return next;
      });
      // Completing un-skips, so a bin deferred and later saved counts once.
      settle(locationId, "completed");
    },
    [settle],
  );

  const toggleLocationSkipped = useCallback(
    (locationId: string) => {
      if (pass.progress.skipped.has(locationId)) unsettle(locationId);
      else settle(locationId, "skipped");
    },
    [pass.progress.skipped, settle, unsettle],
  );

  return {
    startedAt: pass.startedAt,
    currentIndex: pass.currentIndex,
    // The pass's own resolved queue and cursor. Deriving either from the live
    // location list instead would put the caller in a different index space
    // than the one `settle`/`advance` maintain.
    stops: pass.stops,
    current: pass.current,
    complete: pass.complete,
    jumpToId: pass.jumpToId,
    setCurrentIndex: pass.jumpTo,
    itemResolutions,
    setItemResolutions,
    completedLocationIds: pass.progress.completed,
    skippedLocationIds: pass.progress.skipped,
    counts: pass.counts,
    summary,
    resumeCandidate: pass.resumeCandidate,
    resumePass,
    startNewPass,
    recordLocationComplete,
    toggleLocationSkipped,
    clearSkippedLocations: pass.revisitSkipped,
  };
}
