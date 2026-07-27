import { useCallback, useEffect, useRef, useState } from "react";
import type { ItemResolution } from "./_components/types";
import type { SessionLocation } from "./session-utils";

const AUDIT_SESSION_STORAGE_PREFIX = "cubby:audit-session:";
const SESSION_PROGRESS_VERSION = 3;

export interface SessionSummary {
  adjusted: number;
  locations: number;
  relocated: number;
  removed: number;
  verified: number;
}

interface PersistedSessionProgress {
  version: typeof SESSION_PROGRESS_VERSION;
  startedAt: number;
  itemResolutions: [string, ItemResolution][];
  completedLocationIds: string[];
  currentIndex: number;
  summary: SessionSummary;
  // Added after v3 shipped, so all three stay optional: an entry written by an
  // older build still loads (the reader falls back), and a v3 reader ignores
  // fields it doesn't know. No version bump — bumping would silently discard
  // every in-flight pass on this device.
  /** Last write time; the picker's "In progress" list sorts/labels by it. */
  updatedAt?: number;
  /** Session-location count at write time, so the picker can show X of Y. */
  totalCount?: number;
  /** Locations deferred in this pass. Client-only — never a server write. */
  skippedLocationIds?: string[];
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

function parseSessionProgress(raw: string): PersistedSessionProgress | null {
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedSessionProgress>;
    if (
      parsed.version !== SESSION_PROGRESS_VERSION ||
      typeof parsed.startedAt !== "number" ||
      !Array.isArray(parsed.itemResolutions) ||
      !Array.isArray(parsed.completedLocationIds) ||
      typeof parsed.currentIndex !== "number" ||
      !parsed.summary
    ) {
      return null;
    }
    return parsed as PersistedSessionProgress;
  } catch {
    return null;
  }
}

function loadSessionProgress(rootId: string): PersistedSessionProgress | null {
  try {
    const raw = localStorage.getItem(
      `${AUDIT_SESSION_STORAGE_PREFIX}${rootId}`,
    );
    return raw ? parseSessionProgress(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Every pass this device has stored, newest write first. Client-only: returns
 * an empty array during SSR so callers can render it straight into markup.
 */
export function listStoredSessionPasses(): StoredSessionPass[] {
  if (typeof window === "undefined") return [];
  const passes: StoredSessionPass[] = [];
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith(AUDIT_SESSION_STORAGE_PREFIX)) continue;
      const raw = localStorage.getItem(key);
      const parsed = raw ? parseSessionProgress(raw) : null;
      if (!parsed) continue;
      passes.push({
        rootId: key.slice(AUDIT_SESSION_STORAGE_PREFIX.length),
        startedAt: parsed.startedAt,
        updatedAt: parsed.updatedAt ?? parsed.startedAt,
        completedCount: parsed.completedLocationIds.length,
        skippedCount: parsed.skippedLocationIds?.length ?? 0,
        totalCount: parsed.totalCount ?? null,
      });
    }
  } catch {
    // Private mode / disabled storage: no resume list, not an error.
    return [];
  }
  return passes.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function clearStoredSessionPass(rootId: string) {
  try {
    localStorage.removeItem(`${AUDIT_SESSION_STORAGE_PREFIX}${rootId}`);
  } catch {
    // Best effort.
  }
}

function saveSessionProgress(rootId: string, data: PersistedSessionProgress) {
  try {
    localStorage.setItem(
      `${AUDIT_SESSION_STORAGE_PREFIX}${rootId}`,
      JSON.stringify(data),
    );
  } catch {
    // Best effort: private mode/quota failures should not block a recount.
  }
}

export function useSessionProgress(
  rootId: string | null,
  sessionLocations: SessionLocation[],
) {
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [itemResolutions, setItemResolutions] = useState<
    Map<string, ItemResolution>
  >(() => new Map());
  const [completedLocationIds, setCompletedLocationIds] = useState<Set<string>>(
    () => new Set(),
  );
  // Locations explicitly deferred ("Skip for now"). They count toward pass
  // completion so one unreachable bin can't strand the summary, but nothing is
  // written server-side — no verifiedAt, no lastBulkInventory.
  const [skippedLocationIds, setSkippedLocationIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [summary, setSummary] = useState<SessionSummary>(emptySummary);
  const [resumeCandidate, setResumeCandidate] =
    useState<PersistedSessionProgress | null>(null);
  const lastRootId = useRef<string | null>(null);

  const applyProgress = useCallback(
    (progress: PersistedSessionProgress) => {
      setStartedAt(progress.startedAt);
      setItemResolutions(new Map(progress.itemResolutions));
      setCompletedLocationIds(new Set(progress.completedLocationIds));
      setSkippedLocationIds(new Set(progress.skippedLocationIds ?? []));
      setSummary(progress.summary);
      setCurrentIndex(
        Math.min(
          Math.max(progress.currentIndex, 0),
          Math.max(sessionLocations.length - 1, 0),
        ),
      );
    },
    [sessionLocations.length],
  );

  const startNewPass = useCallback(() => {
    setResumeCandidate(null);
    setStartedAt(Date.now());
    setCurrentIndex(0);
    setItemResolutions(new Map());
    setCompletedLocationIds(new Set());
    setSkippedLocationIds(new Set());
    setSummary(emptySummary());
  }, []);

  const resumePass = useCallback(() => {
    if (!resumeCandidate) return;
    applyProgress(resumeCandidate);
    setResumeCandidate(null);
  }, [applyProgress, resumeCandidate]);

  // A root change is the only initialization boundary. Query/tree refetches
  // must not wipe the active pass. Incomplete saved work is gated behind an
  // explicit Resume / Start new choice so stale local state never surprises the
  // user; a finished pass reopens on its summary screen.
  useEffect(() => {
    if (rootId === lastRootId.current) return;
    lastRootId.current = rootId;
    setResumeCandidate(null);

    const reset = (nextStartedAt: number | null) => {
      setStartedAt(nextStartedAt);
      setCurrentIndex(0);
      setItemResolutions(new Map());
      setCompletedLocationIds(new Set());
      setSkippedLocationIds(new Set());
      setSummary(emptySummary());
    };

    if (!rootId || sessionLocations.length === 0) {
      reset(null);
      return;
    }

    const restored = loadSessionProgress(rootId);
    if (!restored) {
      reset(Date.now());
      return;
    }

    // Skipped locations settle a pass just like completed ones, so a pass that
    // ended with skips still reopens on its summary instead of re-prompting.
    const settled =
      restored.completedLocationIds.length +
      (restored.skippedLocationIds?.length ?? 0);
    if (settled >= sessionLocations.length) {
      applyProgress(restored);
    } else {
      reset(null);
      setResumeCandidate(restored);
    }
  }, [applyProgress, rootId, sessionLocations]);

  useEffect(() => {
    if (!rootId || startedAt === null || resumeCandidate) return;
    saveSessionProgress(rootId, {
      version: SESSION_PROGRESS_VERSION,
      startedAt,
      updatedAt: Date.now(),
      totalCount: sessionLocations.length,
      itemResolutions: [...itemResolutions],
      completedLocationIds: [...completedLocationIds],
      skippedLocationIds: [...skippedLocationIds],
      currentIndex,
      summary,
    });
  }, [
    rootId,
    startedAt,
    resumeCandidate,
    sessionLocations.length,
    itemResolutions,
    completedLocationIds,
    skippedLocationIds,
    currentIndex,
    summary,
  ]);

  const recordLocationComplete = useCallback(
    (
      locationId: string,
      resolutions: ReadonlyArray<{
        kind: "verify" | "adjust" | "remove" | "relocate";
      }>,
    ) => {
      setCompletedLocationIds((previous) => {
        if (previous.has(locationId)) return previous;
        const next = new Set(previous);
        next.add(locationId);
        return next;
      });
      // Saving a skipped location un-skips it: completed and skipped stay
      // disjoint, so the two counts always add up to the settled total.
      setSkippedLocationIds((previous) => {
        if (!previous.has(locationId)) return previous;
        const next = new Set(previous);
        next.delete(locationId);
        return next;
      });
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
    },
    [],
  );

  const toggleLocationSkipped = useCallback((locationId: string) => {
    setSkippedLocationIds((previous) => {
      const next = new Set(previous);
      if (next.has(locationId)) next.delete(locationId);
      else next.add(locationId);
      return next;
    });
  }, []);

  const clearSkippedLocations = useCallback(() => {
    setSkippedLocationIds((previous) =>
      previous.size === 0 ? previous : new Set(),
    );
  }, []);

  return {
    startedAt,
    currentIndex,
    setCurrentIndex,
    itemResolutions,
    setItemResolutions,
    completedLocationIds,
    skippedLocationIds,
    summary,
    resumeCandidate: resumeCandidate
      ? {
          startedAt: resumeCandidate.startedAt,
          completedCount: resumeCandidate.completedLocationIds.length,
          skippedCount: resumeCandidate.skippedLocationIds?.length ?? 0,
        }
      : null,
    resumePass,
    startNewPass,
    recordLocationComplete,
    toggleLocationSkipped,
    clearSkippedLocations,
  };
}
