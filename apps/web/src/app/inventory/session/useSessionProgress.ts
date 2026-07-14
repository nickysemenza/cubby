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
}

const emptySummary = (): SessionSummary => ({
  adjusted: 0,
  locations: 0,
  relocated: 0,
  removed: 0,
  verified: 0,
});

function loadSessionProgress(rootId: string): PersistedSessionProgress | null {
  try {
    const raw = localStorage.getItem(
      `${AUDIT_SESSION_STORAGE_PREFIX}${rootId}`,
    );
    if (!raw) return null;
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
  const [summary, setSummary] = useState<SessionSummary>(emptySummary);
  const [resumeCandidate, setResumeCandidate] =
    useState<PersistedSessionProgress | null>(null);
  const lastRootId = useRef<string | null>(null);

  const applyProgress = useCallback(
    (progress: PersistedSessionProgress) => {
      setStartedAt(progress.startedAt);
      setItemResolutions(new Map(progress.itemResolutions));
      setCompletedLocationIds(new Set(progress.completedLocationIds));
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

    if (!rootId || sessionLocations.length === 0) {
      setStartedAt(null);
      setCurrentIndex(0);
      setItemResolutions(new Map());
      setCompletedLocationIds(new Set());
      setSummary(emptySummary());
      return;
    }

    const restored = loadSessionProgress(rootId);
    if (!restored) {
      setStartedAt(Date.now());
      setCurrentIndex(0);
      setItemResolutions(new Map());
      setCompletedLocationIds(new Set());
      setSummary(emptySummary());
      return;
    }

    if (restored.completedLocationIds.length >= sessionLocations.length) {
      applyProgress(restored);
    } else {
      setStartedAt(null);
      setCurrentIndex(0);
      setItemResolutions(new Map());
      setCompletedLocationIds(new Set());
      setSummary(emptySummary());
      setResumeCandidate(restored);
    }
  }, [applyProgress, rootId, sessionLocations]);

  useEffect(() => {
    if (!rootId || startedAt === null || resumeCandidate) return;
    saveSessionProgress(rootId, {
      version: SESSION_PROGRESS_VERSION,
      startedAt,
      itemResolutions: [...itemResolutions],
      completedLocationIds: [...completedLocationIds],
      currentIndex,
      summary,
    });
  }, [
    rootId,
    startedAt,
    resumeCandidate,
    itemResolutions,
    completedLocationIds,
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

  return {
    startedAt,
    currentIndex,
    setCurrentIndex,
    itemResolutions,
    setItemResolutions,
    completedLocationIds,
    summary,
    resumeCandidate: resumeCandidate
      ? {
          startedAt: resumeCandidate.startedAt,
          completedCount: resumeCandidate.completedLocationIds.length,
        }
      : null,
    resumePass,
    startNewPass,
    recordLocationComplete,
  };
}
