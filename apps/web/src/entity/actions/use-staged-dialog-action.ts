import { useCallback, useRef, useState } from "react";

import type { EntityActionRow } from "./entity-actions";

/**
 * The stage → dialog → finish cycle of an entity action whose write happens
 * in a dialog. `stage` parses every row (a row that does not parse fails the
 * whole run) and returns a promise the dialog settles through `finish`, so a
 * `preserveSelection` action keeps the selection until the dialog confirms or
 * cancels. `parse` must be referentially stable.
 */
export function useStagedDialogAction<T>(
  parse: (row: EntityActionRow) => T | null,
) {
  const [items, setItems] = useState<T[]>([]);
  const resolveRef = useRef<((result: { success: boolean }) => void) | null>(
    null,
  );

  const stage = useCallback(
    (rows: readonly EntityActionRow[]) => {
      const parsed = rows.flatMap((row) => {
        const item = parse(row);
        return item === null ? [] : [item];
      });
      if (parsed.length === 0 || parsed.length !== rows.length) {
        return Promise.resolve({ success: false });
      }
      resolveRef.current?.({ success: false });
      setItems(parsed);
      return new Promise<{ success: boolean }>((resolve) => {
        resolveRef.current = resolve;
      });
    },
    [parse],
  );

  const finish = useCallback((success: boolean) => {
    setItems([]);
    resolveRef.current?.({ success });
    resolveRef.current = null;
  }, []);

  return { items, stage, finish };
}
