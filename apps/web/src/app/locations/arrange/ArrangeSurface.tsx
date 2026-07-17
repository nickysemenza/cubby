import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { Columns3, ListTree } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Row, Stack } from "~/components/layout";
import {
  ViewSwitcher,
  type ViewSwitcherOption,
} from "~/components/ui/view-switcher";
import { useTRPC } from "~/integrations/trpc/react";
import { invalidateTRPCQueries } from "~/lib/query-keys";
import { ArrangeBoard } from "./ArrangeBoard";
import { ArrangeTree } from "./ArrangeTree";
import { findUnknownRoot } from "./arrange-tree-utils";
import { useArrangeDnd } from "./use-arrange-dnd";
import { useArrangeMutations } from "./use-arrange-mutations";

type ArrangeView = "board" | "tree";

const VIEW_OPTIONS: ViewSwitcherOption<ArrangeView>[] = [
  { value: "board", label: "Board", icon: Columns3 },
  { value: "tree", label: "Tree", icon: ListTree },
];

const DEPTH_KEY = "arrange:depth";
const MIN_DEPTH = 1;
const MAX_DEPTH = 5;
const DEFAULT_DEPTH = 3;

function readDepth(): number {
  if (typeof window === "undefined") return DEFAULT_DEPTH;
  const raw = Number(window.localStorage.getItem(DEPTH_KEY));
  if (!Number.isFinite(raw) || raw < MIN_DEPTH || raw > MAX_DEPTH)
    return DEFAULT_DEPTH;
  return Math.round(raw);
}

interface ArrangeSurfaceProps {
  view: ArrangeView;
  onViewChange: (view: ArrangeView) => void;
}

export function ArrangeSurface({ view, onViewChange }: ArrangeSurfaceProps) {
  const api = useTRPC();
  const queryClient = useQueryClient();
  const { data: roots } = useSuspenseQuery(
    api.location.makeTree.queryOptions(),
  );
  const { moveLocation, moveItem } = useArrangeMutations();
  useArrangeDnd({ roots, moveLocation, moveItem });
  const depthId = useId();

  const [depth, setDepth] = useState(readDepth);
  useEffect(() => {
    window.localStorage.setItem(DEPTH_KEY, String(depth));
  }, [depth]);

  const unknownRoot = useMemo(() => findUnknownRoot(roots), [roots]);

  // Create the global "Unknown" staging location once, lazily, only if it's
  // missing — so a first visit provisions it but repeat visits don't re-write.
  const ensureUnknown = useMutation(
    api.location.ensureGlobalUnknown.mutationOptions(),
  );
  const ensuredRef = useRef(false);
  useEffect(() => {
    if (unknownRoot || ensuredRef.current || ensureUnknown.isPending) return;
    ensuredRef.current = true;
    ensureUnknown.mutate(undefined, {
      onSuccess: () =>
        invalidateTRPCQueries(queryClient, [api.location.makeTree.queryKey()]),
    });
  }, [unknownRoot, ensureUnknown, queryClient, api]);

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
          <label htmlFor={depthId} className="text-muted-foreground text-xs">
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
            className="accent-primary"
            aria-label="Render depth"
          />
          <span className="w-3 font-mono text-xs tabular-nums">{depth}</span>
        </Row>
      </Row>

      {view === "board" ? (
        <ArrangeBoard roots={roots} depth={depth} unknownRoot={unknownRoot} />
      ) : (
        <ArrangeTree roots={roots} depth={depth} unknownRoot={unknownRoot} />
      )}
    </Stack>
  );
}
