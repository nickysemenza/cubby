import type { LocationShortcode } from "@cubby/schemas/identifiers";
import { ColumnsIcon } from "@phosphor-icons/react/dist/csr/Columns";
import { TreeViewIcon } from "@phosphor-icons/react/dist/csr/TreeView";
import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { collectTreeProductIds } from "~/app/_components/locations/location-gallery-data";
import { ProductImageSummariesProvider } from "~/app/_components/products/product-image-summaries";
import { location } from "~/app/locations/location.functions";
import { Row, Stack } from "~/components/layout";
import {
  ViewSwitcher,
  type ViewSwitcherOption,
} from "~/components/ui/view-switcher";
import { useHydrated } from "~/hooks/useHydrated";

import { findUnknownRoot } from "./arrange-tree-utils";
import { ArrangeBoard } from "./ArrangeBoard";
import { ArrangeTree } from "./ArrangeTree";
import { ArrangeDndProvider } from "./use-arrange-dnd";
import { useArrangeMutations } from "./use-arrange-mutations";

type ArrangeView = "board" | "tree";

const VIEW_OPTIONS: ViewSwitcherOption<ArrangeView>[] = [
  { value: "board", label: "Board", icon: ColumnsIcon },
  { value: "tree", label: "Tree", icon: TreeViewIcon },
];

/** Stable empty default — a fresh `[]` per render would thrash the image query. */
const NO_PRODUCT_IDS: string[] = [];

const DEPTH_KEY = "arrange:depth";
const MIN_DEPTH = 1;
const MAX_DEPTH = 5;
const DEFAULT_DEPTH = 3;

function readDepth(): number {
  if (!globalThis.window) return DEFAULT_DEPTH;
  const raw = Number(window.localStorage.getItem(DEPTH_KEY));
  if (!Number.isFinite(raw) || raw < MIN_DEPTH || raw > MAX_DEPTH)
    return DEFAULT_DEPTH;
  return Math.round(raw);
}

interface ArrangeSurfaceProps {
  view: ArrangeView;
  onViewChange: (view: ArrangeView) => void;
  /** The drilled-to location, from the URL. Undefined = Home. */
  at?: LocationShortcode;
  onSelect: (at: LocationShortcode | undefined) => void;
}

export function ArrangeSurface({
  view,
  onViewChange,
  at,
  onSelect,
}: ArrangeSurfaceProps) {
  const { data: roots } = useSuspenseQuery(
    // Arrange is a live mutation surface. The shared tree is normally warm for
    // two minutes, but restoring a pre-move persisted cache after an immediate
    // reload must revalidate instead of showing the old hierarchy as current.
    { ...location.makeTree.queryOptions(), staleTime: 0 },
  );
  const { moveLocation, moveItem } = useArrangeMutations();
  const depthId = useId();

  const [depth, setDepth] = useState(readDepth);
  useEffect(() => {
    window.localStorage.setItem(DEPTH_KEY, String(depth));
  }, [depth]);

  const unknownRoot = useMemo(() => findUnknownRoot(roots), [roots]);

  // Product covers for the item chips. Derived from the same forest the
  // locations gallery uses, and `useChunkedRecordQuery` sorts before chunking,
  // so the two pages share cache entries instead of refetching.
  //
  // The hydration gate is load-bearing. `makeTree` above is a *suspense* query,
  // so `roots` is already populated during SSR — feeding it straight to the
  // provider fanned ~600 products out into a dozen concurrent
  // `product.summaries` calls inside the server render, and the whole SSR batch
  // came back UNAUTHORIZED (taking `makeTree` and even `dashboard.counts` down
  // with it, so the page rendered its error boundary instead).
  //
  // The locations gallery reads the same forest through a plain `useQuery`, so
  // its `locations` is undefined on the server and the fan-out can't happen —
  // it gets this property for free. Here it has to be explicit. Covers are
  // decorative; keep them off the server-render path.
  const hydrated = useHydrated();
  const productIds = useMemo(
    () => (hydrated ? collectTreeProductIds(roots) : NO_PRODUCT_IDS),
    [hydrated, roots],
  );

  // Create the global "Unknown" staging location once, lazily, only if it's
  // missing — so a first visit provisions it but repeat visits don't re-write.
  const ensureUnknown = useMutation(
    location.ensureGlobalUnknown.mutationOptions(),
  );
  const ensuredRef = useRef(false);
  useEffect(() => {
    if (unknownRoot || ensuredRef.current || ensureUnknown.isPending) return;
    ensuredRef.current = true;
    // `ensureGlobalUnknown`'s own ripple invalidates the `["location"]` root,
    // which the tree query answers to.
    ensureUnknown.mutate(undefined);
  }, [unknownRoot, ensureUnknown]);

  return (
    <Stack gap="md" className="min-h-[calc(100dvh-9rem)]">
      <Row align="center" justify="between" gap="sm" wrap>
        <ViewSwitcher
          ariaLabel="Arrange view"
          options={VIEW_OPTIONS}
          value={view}
          onValueChange={onViewChange}
        />
        <Row align="center" gap="sm">
          <label htmlFor={depthId} className="text-xs text-muted-foreground">
            {view === "board" ? "Columns" : "Depth"}
          </label>
          <input
            id={depthId}
            type="range"
            min={MIN_DEPTH}
            max={MAX_DEPTH}
            step={1}
            value={depth}
            onChange={(e) => setDepth(Number(e.target.value))}
            className="h-11 accent-primary md:h-auto"
            aria-label="Render depth"
          />
          <span className="w-3 font-mono text-xs tabular-nums">{depth}</span>
        </Row>
      </Row>

      <ArrangeDndProvider
        roots={roots}
        moveLocation={moveLocation}
        moveItem={moveItem}
      >
        <ProductImageSummariesProvider productIds={productIds}>
          {view === "board" ? (
            <ArrangeBoard
              roots={roots}
              depth={depth}
              unknownRoot={unknownRoot}
              at={at}
              onSelect={onSelect}
            />
          ) : (
            <ArrangeTree
              roots={roots}
              depth={depth}
              unknownRoot={unknownRoot}
              at={at}
              onSelect={onSelect}
            />
          )}
        </ProductImageSummariesProvider>
      </ArrangeDndProvider>
    </Stack>
  );
}
