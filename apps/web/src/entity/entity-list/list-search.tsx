import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";

import {
  type ListNavigate,
  type ListSearch,
  listSearchSchema,
  type ListSlotProps,
} from "./list-slot-types";

type CardDensity = "cards" | "compact" | "contact-sheet";
type CardDensityState = {
  density: CardDensity;
  setDensity: (density: CardDensity) => void;
};
const CardDensityContext = createContext<CardDensityState | null>(null);

/**
 * Card density and Contact sheet belong to the mounted list screen, not the URL or persistence.
 * The provider is shared with the route chrome so its segmented control and
 * the record renderer change together.
 */
export function EntityListCardDensityProvider({
  children,
  value,
}: {
  children: ReactNode;
  /** Carries the same screen state into chrome rendered outside the route. */
  value?: CardDensityState;
}) {
  const [density, setDensity] = useState<CardDensity>("cards");
  return (
    <CardDensityContext value={value ?? { density, setDensity }}>
      {children}
    </CardDensityContext>
  );
}

export function useEntityListCardDensity() {
  const context = useContext(CardDensityContext);
  if (!context)
    throw new Error("EntityListCardDensityProvider is required for card lists");
  return context;
}

/**
 * The route's search as a bag plus a merge-navigate over it. Route-agnostic
 * on purpose: this component renders on every generated index route, each
 * with its own generated schema, so a typed `useNavigate` can't fit them all.
 */
export function useListSearch(): ListSlotProps {
  const search = listSearchSchema.parse(useSearch({ strict: false }));
  const routeNavigate = useNavigate();
  const navigate = useCallback<ListNavigate>(
    (patch, options) => {
      // SAFETY: route-specific search keys are intentionally erased here;
      // every generated index route validates the keys a view writes.
      routeNavigate({
        search: (previous: ListSearch) => ({ ...previous, ...patch }),
        replace: options?.replace,
      } as never);
    },
    [routeNavigate],
  );
  return { search, navigate };
}
