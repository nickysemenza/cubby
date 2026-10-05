import { useCallback, useRef, useState } from "react";

import type { EntityActionRow } from "./entity-actions";

/**
 * The stage → dialog → finish cycle of an entity action whose write happens
 * in a dialog. `stage` parses every row (a row that does not parse fails the
 * whole run) and returns a promise the dialog settles through `finish`:
 * `finish(true)` after the work succeeds, `finish(false)` on cancel — or when
 * a newer `stage` supersedes the pending one — so a `preserveSelection` action
 * keeps the selection until the dialog confirms or cancels. `onReset` clears
 * the caller's per-dialog failure state on every stage/finish.
 */
export function useStagedDialogAction<T>(
  parse: (row: EntityActionRow) => T | null,
  onReset?: () => void,
) {
  const [items, setItems] = useState<T[]>([]);
  const resolveRef = useRef<((result: { success: boolean }) => void) | null>(
    null,
  );
  const parseRef = useRef(parse);
  parseRef.current = parse;
  const onResetRef = useRef(onReset);
  onResetRef.current = onReset;

  const stage = useCallback((rows: readonly EntityActionRow[]) => {
    const parsed = rows.flatMap((row) => {
      const item = parseRef.current(row);
      return item === null ? [] : [item];
    });
    if (parsed.length === 0 || parsed.length !== rows.length) {
      return Promise.resolve({ success: false });
    }
    resolveRef.current?.({ success: false });
    onResetRef.current?.();
    setItems(parsed);
    return new Promise<{ success: boolean }>((resolve) => {
      resolveRef.current = resolve;
    });
  }, []);

  const finish = useCallback((success: boolean) => {
    setItems([]);
    onResetRef.current?.();
    resolveRef.current?.({ success });
    resolveRef.current = null;
  }, []);

  return { items, stage, finish };
}
