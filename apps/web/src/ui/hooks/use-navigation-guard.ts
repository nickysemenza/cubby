import { useBlocker } from "@tanstack/react-router";
import { useCallback, useRef, useState } from "react";

type Spot = { pathname: string; search: unknown };

const sameSpot = (a: Spot, b: Spot) =>
  a.pathname === b.pathname &&
  JSON.stringify(a.search) === JSON.stringify(b.search);

/**
 * Holds in-app navigation and tab close while `active`, so a page can ask
 * before discarding work. Render a confirm dialog open while `held`; `stay`
 * cancels the navigation and `leave` lets it through.
 *
 * Not TanStack's `withResolver`: its state update lands inside the router's
 * navigation transition, which is itself waiting on the blocker, so the dialog
 * never rendered and the navigation hung. The timeout opens the dialog outside
 * that transition.
 */
export function useNavigationGuard(active: boolean) {
  const activeRef = useRef(active);
  activeRef.current = active;
  // Resolves the held navigation: true blocks it, false lets it through.
  const [resolve, setResolve] = useState<((block: boolean) => void) | null>(
    null,
  );
  const shouldBlockFn = useCallback(
    ({ current, next }: { current: Spot; next: Spot }) => {
      if (!activeRef.current || sameSpot(current, next)) return false;
      return new Promise<boolean>((settle) => {
        setTimeout(() =>
          setResolve(() => (block: boolean) => {
            setResolve(null);
            settle(block);
          }),
        );
      });
    },
    [],
  );
  const enableBeforeUnload = useCallback(() => activeRef.current, []);
  useBlocker({ shouldBlockFn, enableBeforeUnload });
  return {
    held: resolve !== null,
    stay: () => resolve?.(true),
    leave: () => resolve?.(false),
  };
}
