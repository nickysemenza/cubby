import { Link } from "@tanstack/react-router";
import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
  type RefCallback,
} from "react";

import { SectionHeading } from "~/ui/layout";

type Slot = "quality" | "suggestions";
type Targets = Record<Slot, HTMLElement | null>;
type NeedsYouContextValue = {
  targets: Targets;
  refs: Record<Slot, RefCallback<HTMLElement>>;
};

const NeedsYouContext = createContext<NeedsYouContextValue | null>(null);

/**
 * Owns the "Needs you" block's mount points. Quality and suggestion status
 * render inside their providers (which wrap the whole page) and portal into
 * the block, so the block reads as one list wherever its sources live.
 */
export function NeedsYouProvider({ children }: { children: ReactNode }) {
  const [targets, setTargets] = useState<Targets>({
    quality: null,
    suggestions: null,
  });
  // Stable callbacks: a fresh ref each render detaches and reattaches the
  // slot, and each reattach sets state, which renders again.
  const refs = useMemo(() => {
    const refFor =
      (slot: Slot): RefCallback<HTMLElement> =>
      (element) =>
        setTargets((current) =>
          current[slot] === element ? current : { ...current, [slot]: element },
        );
    return { quality: refFor("quality"), suggestions: refFor("suggestions") };
  }, []);
  const value = useMemo(() => ({ targets, refs }), [targets, refs]);
  return <NeedsYouContext value={value}>{children}</NeedsYouContext>;
}

/**
 * The mount point for one source, or `undefined` outside a provider so the
 * source keeps its standalone placement (inspector, other pages).
 */
export function useNeedsYouTarget(slot: Slot): HTMLElement | null | undefined {
  const context = useContext(NeedsYouContext);
  return context ? context.targets[slot] : undefined;
}

/**
 * One bordered list of what the record is waiting on: work-queue rows,
 * pending suggestions, and quality. Rows that need attention (or are still
 * loading, which holds the space) carry `data-needs-row`; with none, the
 * block collapses.
 */
export function NeedsYou({ children }: { children?: ReactNode }) {
  const context = useContext(NeedsYouContext);
  return (
    <section
      aria-label="Needs you"
      className="hidden min-w-0 has-[[data-needs-row]]:block"
      data-testid="needs-you"
    >
      <SectionHeading
        title="Needs you"
        actions={
          <Link
            to="/work-queue"
            className="text-xs text-muted-foreground underline-offset-2 hover:underline"
          >
            Open queue
          </Link>
        }
      />
      <div className="mt-2 divide-y divide-hairline-soft rounded-lg border border-border text-sm [&>*:empty]:hidden">
        {children}
        <div ref={context?.refs.suggestions} className="px-3 py-2" />
        <div ref={context?.refs.quality} className="px-3 py-2" />
      </div>
    </section>
  );
}
