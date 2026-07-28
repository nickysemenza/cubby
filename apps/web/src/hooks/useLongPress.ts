import { useCallback, useEffect, useRef } from "react";

/** Hold duration before a press counts as long. Matches the iOS convention. */
const LONG_PRESS_MS = 450;

export interface LongPressHandlers {
  /** Begin timing (wire to touchstart). */
  start: () => void;
  /** Abort — the finger lifted or moved (wire to touchend/touchmove). */
  cancel: () => void;
  /**
   * True exactly once after the hold fired, so the click that iOS synthesizes
   * on release can be swallowed instead of also navigating.
   */
  consumeClick: () => boolean;
}

/**
 * Press-and-hold, for entering selection mode on a list row.
 *
 * Returns inert handlers when `onLongPress` is undefined, so a caller can wire
 * them unconditionally.
 */
export function useLongPress(onLongPress?: () => void): LongPressHandlers {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firedRef = useRef(false);

  const clear = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // A row that scrolls out of view unmounts mid-press; without this the timer
  // would still fire and select a row the user is no longer touching.
  useEffect(() => clear, [clear]);

  const start = useCallback(() => {
    if (!onLongPress) return;
    clear();
    firedRef.current = false;
    timerRef.current = setTimeout(() => {
      firedRef.current = true;
      onLongPress();
    }, LONG_PRESS_MS);
  }, [onLongPress, clear]);

  const consumeClick = useCallback(() => {
    if (!firedRef.current) return false;
    firedRef.current = false;
    return true;
  }, []);

  return { start, cancel: clear, consumeClick };
}
