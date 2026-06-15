/**
 * URL-synced tab state for base-ui `Tabs`. Centralizes the "default tab stays
 * out of the URL" logic shared by detail-page tabs; the caller supplies a
 * route-specific `setParam` (a `navigate(...)` call) so TanStack's per-route
 * search types stay sound.
 *
 * Usage:
 *   const { tab } = Route.useSearch();
 *   const navigate = useNavigate();
 *   const tabs = useTabParam(tab, "recipes", (next) =>
 *     navigate({ to: ".", search: (prev) => ({ ...prev, tab: next }) }),
 *   );
 *   <Tabs value={tabs.value} onValueChange={tabs.onValueChange}>
 */
export function useTabParam<T extends string>(
  current: T | undefined,
  defaultValue: T,
  setParam: (next: T | undefined) => void,
): { value: T; onValueChange: (next: string) => void } {
  return {
    value: current ?? defaultValue,
    // Drop the default from the URL so the base link stays clean.
    onValueChange: (next) =>
      setParam(next === defaultValue ? undefined : (next as T)),
  };
}
