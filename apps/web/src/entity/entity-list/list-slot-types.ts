import type { ComponentType } from "react";
import { z } from "zod";

/**
 * The route's validated search as a bag. Router search values are JSON
 * (TanStack `parseSearch`), so every generated index route's schema — the
 * manifest filter keys, table keys, `view`, timeline keys and a slot's
 * declared `searchKeys` — reads through this one shape.
 */
export const listSearchSchema = z.record(z.string(), z.json().optional());
export type ListSearch = z.infer<typeof listSearchSchema>;

/** Merge-navigate over the list route's search; `undefined` clears a key. */
export type ListNavigate = (
  patch: ListSearch,
  options?: { replace?: boolean },
) => void;

/**
 * What a slot list view receives. A slot that needs typed access to its own
 * route keeps using `getRouteApi` as before.
 */
export interface ListSlotProps {
  search: ListSearch;
  navigate: ListNavigate;
}

export type ListSlotComponent = ComponentType<ListSlotProps>;
