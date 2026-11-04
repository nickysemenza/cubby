import { QueryErrorResetBoundary } from "@tanstack/react-query";
import {
  CatchBoundary,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import {
  createContext,
  type ReactNode,
  type RefObject,
  Suspense,
  useContext,
  useEffect,
  useRef,
} from "react";

import { ErrorDisplay } from "./error-display";

const SectionErrorContext = createContext({
  title: "section",
  resetQueries: () => {},
});

function SectionError({ error, reset }: ErrorComponentProps) {
  const { title, resetQueries } = useContext(SectionErrorContext);
  return (
    <ErrorDisplay
      error={error}
      title={title}
      onRetry={() => {
        resetQueries();
        reset?.();
      }}
    />
  );
}

/** Independent reads stream without suspending their page or sibling sections. */
export function QuerySection({
  children,
  fallback,
  title,
  resetKey = title,
}: {
  children: ReactNode;
  fallback: ReactNode;
  title: string;
  resetKey?: string;
}) {
  return (
    <QueryErrorResetBoundary>
      {({ reset }) => (
        <SectionErrorContext value={{ title, resetQueries: reset }}>
          <CatchBoundary
            getResetKey={() => resetKey}
            errorComponent={SectionError}
          >
            <SlowArrival fallback={fallback}>{children}</SlowArrival>
          </CatchBoundary>
        </SectionErrorContext>
      )}
    </QueryErrorResetBoundary>
  );
}

/** Where a fallback showed, and what already sat beside it. */
type FallbackSite = { parent: Element; siblings: ReadonlySet<Element> };

/**
 * Content that replaced a visible fallback fades in; a section that was ready at
 * first paint does not. Adds no wrapper, because callers and their CSS (`:empty`
 * cells, flex children) depend on the section's exact DOM.
 */
function SlowArrival({
  children,
  fallback,
}: {
  children: ReactNode;
  fallback: ReactNode;
}) {
  const site = useRef<FallbackSite | null>(null);
  return (
    <Suspense fallback={<FallbackMark site={site}>{fallback}</FallbackMark>}>
      <ArrivalFade site={site} />
      {children}
    </Suspense>
  );
}

function FallbackMark({
  children,
  site,
}: {
  children: ReactNode;
  site: RefObject<FallbackSite | null>;
}) {
  const marker = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const parent = marker.current?.parentElement;
    if (!parent) return;
    site.current = { parent, siblings: new Set(parent.children) };
  }, [site]);
  return (
    <>
      <span ref={marker} hidden />
      {children}
    </>
  );
}

function ArrivalFade({ site }: { site: RefObject<FallbackSite | null> }) {
  useEffect(() => {
    const arrived = site.current;
    site.current = null;
    if (
      !arrived ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    for (const child of arrived.parent.children)
      if (!arrived.siblings.has(child))
        child.animate?.([{ opacity: 0 }, { opacity: 1 }], {
          duration: 120,
          easing: "cubic-bezier(0.2, 0, 0, 1)",
        });
  }, [site]);
  return null;
}
