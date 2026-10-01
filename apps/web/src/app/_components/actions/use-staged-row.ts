import { useCallback, useRef, useState } from "react";

import type { EntityActionRow } from "./entity-actions";

/**
 * The staging half of a confirm-before-run single-row action (delete, discard).
 * `stage` resolves once the dialog settles: `finish(true)` after the work
 * succeeds, `finish(false)` on cancel — or when a newer `stage` supersedes the
 * pending one — so a list selection survives until the operator confirms.
 * `onReset` clears the caller's per-dialog failure state on every stage/finish.
 */
export function useStagedRow<TStaged extends EntityActionRow>(
  stageRow: (row: EntityActionRow) => TStaged,
  onReset: () => void,
) {
  const [staged, setStaged] = useState<TStaged | null>(null);
  const resolveRef = useRef<((result: { success: boolean }) => void) | null>(
    null,
  );
  const stageRowRef = useRef(stageRow);
  stageRowRef.current = stageRow;
  const onResetRef = useRef(onReset);
  onResetRef.current = onReset;

  const finish = useCallback((success: boolean) => {
    setStaged(null);
    onResetRef.current();
    resolveRef.current?.({ success });
    resolveRef.current = null;
  }, []);

  const stage = useCallback((rows: readonly EntityActionRow[]) => {
    const row = rows[0];
    if (!row) return Promise.resolve({ success: false });
    resolveRef.current?.({ success: false });
    onResetRef.current();
    setStaged(stageRowRef.current(row));
    return new Promise<{ success: boolean }>((resolve) => {
      resolveRef.current = resolve;
    });
  }, []);

  return { staged, stage, finish };
}
