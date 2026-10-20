import { Link } from "@tanstack/react-router";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefCallback,
} from "react";

import { Panel, Section } from "~/ui/layout";

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
  const sectionRef = useRef<HTMLElement>(null);
  const [count, setCount] = useState<number>();
  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    const updateCount = () => {
      const next = Array.from(
        section.querySelectorAll("[data-needs-row]"),
      ).filter((row) => !row.closest('[aria-busy="true"]')).length;
      setCount((current) => (current === next ? current : next));
    };
    updateCount();
    const observer = new MutationObserver(updateCount);
    observer.observe(section, {
      attributes: true,
      attributeFilter: ["aria-busy", "data-needs-row"],
      childList: true,
      subtree: true,
    });
    return () => observer.disconnect();
  }, []);
  return (
    <Section
      ref={sectionRef}
      title="Needs you"
      headingAs="h2"
      count={count ? count : undefined}
      className="hidden has-[[data-needs-row]]:flex"
      data-testid="needs-you"
      actions={<Link to="/work-queue">Open queue</Link>}
    >
      <Panel
        tone="default"
        flush
        className="divide-y divide-hairline-soft [&>*:empty]:hidden"
      >
        {children}
        <div ref={context?.refs.suggestions} className="px-3 py-2" />
        <div ref={context?.refs.quality} className="px-3 py-2" />
      </Panel>
    </Section>
  );
}
