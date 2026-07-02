import { useEffect, useRef, useState } from "react";
import type { ItemResolution } from "./_components/types";
import type { SessionLocation } from "./session-utils";

// Per-session-root display progress (confirmed checks + position), persisted to
// localStorage so it survives a reload or a tree-invalidating mutation. This is
// UX state ONLY — never a source of truth for a destructive write.
const AUDIT_SESSION_STORAGE_PREFIX = "cubby:audit-session:";

interface PersistedSessionProgress {
  // [inventoryId, resolution] pairs — Map isn't JSON-serializable.
  itemResolutions: [string, ItemResolution][];
  confirmedLocationIds: string[];
  currentIndex: number;
}

function loadSessionProgress(rootId: string): PersistedSessionProgress | null {
  try {
    const raw = localStorage.getItem(
      `${AUDIT_SESSION_STORAGE_PREFIX}${rootId}`,
    );
    return raw ? (JSON.parse(raw) as PersistedSessionProgress) : null;
  } catch {
    // localStorage unavailable (SSR / private mode / quota) — start fresh.
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
    // best-effort; localStorage may be unavailable.
  }
}

/**
 * Owns the per-session-root UX progress state (currentIndex, staged item
 * resolutions, confirmed child-location acknowledgments) plus its localStorage
 * load/save. Rehydrates on root change and persists on every change.
 */
export function useSessionProgress(
  rootId: string | null,
  sessionLocations: SessionLocation[],
) {
  const [currentIndex, setCurrentIndex] = useState(0);
  // Staged decisions for expected inventory rows, keyed by (globally-unique)
  // inventory id — committed atomically on "Done", persisted to localStorage.
  const [itemResolutions, setItemResolutions] = useState<
    Map<string, ItemResolution>
  >(() => new Map());
  // Child-location acknowledgments (client-only — no DB write on Done).
  const [confirmedLocationIds, setConfirmedLocationIds] = useState<Set<string>>(
    () => new Set(),
  );

  // Initialize per session ROOT, keyed on rootId (NOT sessionLocations): a tree
  // refetch — e.g. the invalidation after editing a location's photo or a
  // quantity — must not wipe confirmed checks or currentIndex. Prior progress is
  // rehydrated from localStorage so it also survives a reload.
  const lastRootId = useRef<string | null>(null);
  useEffect(() => {
    if (rootId === lastRootId.current) return;
    lastRootId.current = rootId;
    if (!rootId || sessionLocations.length === 0) {
      setCurrentIndex(0);
      setItemResolutions(new Map());
      setConfirmedLocationIds(new Set());
      return;
    }
    const restored = loadSessionProgress(rootId);
    const firstIncomplete = sessionLocations.findIndex(
      (loc) => !loc.lastBulkInventory,
    );
    setItemResolutions(new Map(restored?.itemResolutions ?? []));
    setConfirmedLocationIds(new Set(restored?.confirmedLocationIds ?? []));
    setCurrentIndex(
      restored
        ? Math.min(
            Math.max(restored.currentIndex, 0),
            sessionLocations.length - 1,
          )
        : firstIncomplete >= 0
          ? firstIncomplete
          : 0,
    );
  }, [rootId, sessionLocations]);

  // Persist progress per root (UX resume only — see the storage-helper note).
  useEffect(() => {
    if (!rootId) return;
    saveSessionProgress(rootId, {
      itemResolutions: [...itemResolutions],
      confirmedLocationIds: [...confirmedLocationIds],
      currentIndex,
    });
  }, [rootId, itemResolutions, confirmedLocationIds, currentIndex]);

  return {
    currentIndex,
    setCurrentIndex,
    itemResolutions,
    setItemResolutions,
    confirmedLocationIds,
    setConfirmedLocationIds,
  };
}
