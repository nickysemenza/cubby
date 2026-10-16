import type { Icon } from "@phosphor-icons/react/lib";
import { Suspense, type ReactNode } from "react";

import { ErrorDisplay } from "~/ui/feedback/error-display";
import { SectionHeading } from "~/ui/layout/section";

type RefreshState =
  | { refreshError?: never; onRetry?: never }
  | { refreshError: unknown; onRetry: () => void };

export type VisualizationState =
  | { status: "loading" }
  | ({ status: "empty" } & RefreshState)
  | { status: "error"; error: unknown; onRetry: () => void }
  | ({ status: "ready" } & RefreshState);

/** Current query-key data only. Never retain data from a previous record/filter. */
export function visualizationState({
  data,
  isLoading,
  error,
  empty,
  onRetry,
}: {
  data: unknown;
  isLoading: boolean;
  error: unknown;
  empty: boolean;
  onRetry: () => void;
}): VisualizationState {
  if (data !== undefined && error)
    return { status: empty ? "empty" : "ready", refreshError: error, onRetry };
  if (error) return { status: "error", error, onRetry };
  if (isLoading || data === undefined) return { status: "loading" };
  return { status: empty ? "empty" : "ready" };
}

/** Presentation only; query owners supply current-scope state and retry. */
export function Visualization({
  state,
  title,
  description,
  message,
  subMessage,
  height,
  icon: Icon,
  children,
}: {
  state: VisualizationState;
  title?: string;
  description?: string;
  message?: string;
  subMessage?: string;
  height?: number;
  icon?: Icon;
  children?: ReactNode;
}) {
  const loading = (
    <output
      className="flex items-center justify-center py-6 text-xs text-muted-foreground"
      style={{ minHeight: height }}
    >
      Loading visualization…
    </output>
  );
  return (
    <div className="min-w-0 space-y-2">
      {title && (
        <SectionHeading as="h3" title={title} description={description} />
      )}
      {(state.status === "ready" || state.status === "empty") &&
      state.refreshError != null ? (
        <ErrorDisplay
          title="the latest visualization"
          error={state.refreshError}
          onRetry={state.onRetry}
        />
      ) : null}
      <div className="min-w-0">
        {state.status === "ready" ? (
          <Suspense fallback={loading}>{children}</Suspense>
        ) : state.status === "loading" ? (
          loading
        ) : state.status === "error" ? (
          <ErrorDisplay
            error={state.error}
            title={title ?? "this visualization"}
            onRetry={state.onRetry}
          />
        ) : (
          <div
            className="flex flex-col items-center justify-center gap-1 py-6 text-center text-xs text-muted-foreground"
            style={{ minHeight: height }}
          >
            {Icon && <Icon aria-hidden className="size-5" />}
            <p>{message ?? "No data to display."}</p>
            {subMessage && <p>{subMessage}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
