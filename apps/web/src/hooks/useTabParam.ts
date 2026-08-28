/**
 * URL-synced tab state for base-ui `Tabs`. Centralizes the "default tab stays
 * out of the URL" logic shared by detail-page tabs; the caller supplies a
 * route-specific `setParam` (a `navigate(...)` call) so TanStack's per-route
 * search types stay sound.
 *
 * Usage:
 *   const { tab } = Route.useSearch();
 *   const navigate = useNavigate();
 *   const tabs = useTabParam(tab, "recipes", tabSchema, (next) =>
 *     navigate({ to: ".", search: (prev) => ({ ...prev, tab: next }) }),
 *   );
 *   <Tabs value={tabs.value} onValueChange={tabs.onValueChange}>
 */
export function useTabParam<T extends string>(
  current: T | undefined,
  defaultValue: T,
  schema: z.ZodType<T>,
  setParam: (next: T | undefined) => void,
) {
  return {
    value: current ?? defaultValue,
    // Drop the default from the URL so the base link stays clean.
    onValueChange: (next: string) => {
      const parsed = schema.safeParse(next);
      if (!parsed.success) return;
      if (parsed.data === defaultValue) {
        setParam(undefined);
        return;
      }
      setParam(parsed.data);
    },
  };
}
import type { z } from "zod";
