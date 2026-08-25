import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useHydrated } from "~/hooks/useHydrated";
import { authClient } from "~/lib/auth-client";
import { problemsCountsQueryOptions } from "~/lib/problems.functions";
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
export function ProblemsBanner() {
  const session = authClient.useSession();
  const enabled = useHydrated() && !!session.data?.user;
  const { data: counts, isLoading } = useQuery({
    ...problemsCountsQueryOptions({ staleTime: 5 * 60 * 1000, enabled }),
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
          ? "border-destructive/60 bg-destructive/10 text-destructive hover:bg-destructive/20"
          : "border-border bg-muted/40 text-muted-foreground hover:bg-muted",
      )}
    >
      {defects > 0 ? (
        <>
          <span className="font-mono font-semibold text-xs tabular-nums">
            {defects.toLocaleString()}
          </span>
          <span className="text-xs">
            {defects === 1 ? "problem needs" : "problems need"} attention
          </span>
        </>
      ) : (
        <span className="text-xs">Everything checks out.</span>
      )}
      {coverageTotal > 0 && (
        <span className="ml-auto truncate font-mono text-2xs uppercase opacity-70">
          {coverageTotal.toLocaleString()} coverage gaps
        </span>
      )}
      <span aria-hidden="true" className="shrink-0 text-xs">
        →
      </span>
    </Link>
  );
}
