import { useQuery } from "@tanstack/react-query";
import { Link, useRouteContext } from "@tanstack/react-router";

import { problems } from "~/lib/problems.functions";
import { cn } from "~/lib/utils";

/**
 * Data-problems bar, shown only when something is outstanding. Ports the
 * shares the navbar's five-minute KV-backed count query instead of fetching
 * five groups of card samples merely to render two numbers. The cheap snapshot
 * joins Home's other compact reads on the authenticated hydration boundary.
 *
 * `total` is already defect-only — `PROBLEM_CLASS` keeps coverage rows out of
 * it precisely because a count that can never reach zero makes a permanent red
 * badge nobody can act on. So the two are reported side by side rather than
 * summed: the defect count carries the destructive tone and the coverage
 * backlog trails it as quiet context, which is the difference between "this is
 * wrong" and "this hasn't been filed yet".
 */
export function problemsBannerMessage(defects: number): string {
  return defects > 0
    ? `${defects === 1 ? "problem needs" : "problems need"} attention`
    : "No defects found.";
}

export interface ProblemsBannerOperations {
  readonly getCounts: typeof problems.getCounts;
}

const productionProblemsBannerOperations: ProblemsBannerOperations = {
  getCounts: problems.getCounts,
};

export function ProblemsBanner({
  isAuthed: authenticated,
  operations = productionProblemsBannerOperations,
}: {
  isAuthed?: boolean;
  operations?: ProblemsBannerOperations;
}) {
  if (authenticated !== undefined) {
    return (
      <ProblemsBannerContent isAuthed={authenticated} operations={operations} />
    );
  }
  return <RouteProblemsBanner operations={operations} />;
}

function RouteProblemsBanner({
  operations,
}: {
  operations: ProblemsBannerOperations;
}) {
  const { isAuthed } = useRouteContext({ from: "__root__" });
  return <ProblemsBannerContent isAuthed={isAuthed} operations={operations} />;
}

function ProblemsBannerContent({
  isAuthed,
  operations,
}: {
  isAuthed: boolean;
  operations: ProblemsBannerOperations;
}) {
  const { data: counts, isLoading } = useQuery({
    ...operations.getCounts.queryOptions(),
    enabled: isAuthed,
  });
  const defects = counts?.total ?? 0;
  const coverageTotal = counts?.coverageTotal ?? 0;

  if (!counts || isLoading || (defects === 0 && coverageTotal === 0)) {
    return null;
  }

  return (
    <Link
      to="/problems"
      className={cn(
        "flex min-h-11 items-center gap-2 border px-2 py-1 transition-colors sm:min-h-0",
        defects > 0
          ? "border-destructive/60 bg-destructive/10 text-foreground hover:bg-destructive/20"
          : "border-border bg-muted/40 text-muted-foreground hover:bg-muted",
      )}
    >
      {defects > 0 ? (
        <>
          <span className="font-mono text-xs font-semibold tabular-nums">
            {defects.toLocaleString()}
          </span>
          <span className="text-xs">{problemsBannerMessage(defects)}</span>
        </>
      ) : (
        <span className="text-xs">{problemsBannerMessage(defects)}</span>
      )}
      {coverageTotal > 0 && (
        <span className="ml-auto truncate font-mono text-2xs text-warning-ink uppercase">
          {coverageTotal.toLocaleString()} coverage gaps
        </span>
      )}
      <span aria-hidden="true" className="shrink-0 text-xs">
        →
      </span>
    </Link>
  );
}
