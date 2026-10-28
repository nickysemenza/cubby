import { QueryErrorResetBoundary } from "@tanstack/react-query";
import {
  CatchBoundary,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { createContext, type ReactNode, Suspense, useContext } from "react";

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
            <Suspense fallback={fallback}>{children}</Suspense>
          </CatchBoundary>
        </SectionErrorContext>
      )}
    </QueryErrorResetBoundary>
  );
}
