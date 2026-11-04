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

/**
 * Content that replaced a visible fallback fades in; a section that was ready at
 * first paint does not. Fades the first child because a wrapper could not
 * animate without changing the caller's layout.
 */
function SlowArrival({
  children,
  fallback,
}: {
  children: ReactNode;
  fallback: ReactNode;
}) {
  const sawFallback = useRef(false);
  return (
    <Suspense
      fallback={<FallbackMark seen={sawFallback}>{fallback}</FallbackMark>}
    >
      <ArrivalFade seen={sawFallback}>{children}</ArrivalFade>
    </Suspense>
  );
}

function FallbackMark({
  children,
  seen,
}: {
  children: ReactNode;
  seen: RefObject<boolean>;
}) {
  useEffect(() => {
    seen.current = true;
  }, [seen]);
  return children;
}

function ArrivalFade({
  children,
  seen,
}: {
  children: ReactNode;
  seen: RefObject<boolean>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!seen.current) return;
    seen.current = false;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    ref.current?.firstElementChild?.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: 120,
      easing: "cubic-bezier(0.2, 0, 0, 1)",
    });
  }, [seen]);
  return (
    <div ref={ref} className="contents">
      {children}
    </div>
  );
}
