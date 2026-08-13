import { countProblems } from "@cubby/schemas/problems";
import { Link } from "@tanstack/react-router";
import { useProblemsData } from "~/app/problems/use-problems-data";
import { useHydrated } from "~/hooks/useHydrated";
import { useIdle } from "~/hooks/useIdle";
import { authClient } from "~/lib/auth-client";

/**
 * Red alert bar shown only when the data-problems count is > 0. Ports the
 * deferred-fetch gate from the retired ProblemsStatCard: the 5 cost-grouped
 * detectors aren't needed for the page to be interactive, so `useIdle` keeps
 * them off the first-paint critical path (combined with the auth+hydration
 * gate, which also keeps SSR markup stable).
 */
export function ProblemsBanner() {
  const session = authClient.useSession();
  const enabled = useHydrated() && !!session.data?.user;
  const idle = useIdle();
  const { problems, isLoading } = useProblemsData({
    staleTime: 5 * 60 * 1000,
    enabled: enabled && idle,
  });
  const count = countProblems(problems).total;

  if (isLoading || count === 0) return null;

  return (
    <Link
      to="/problems"
      className="flex items-center gap-2 border border-destructive/60 bg-destructive/10 px-2 py-1 text-destructive transition-colors hover:bg-destructive/20"
    >
      <span className="font-mono font-semibold text-xs tabular-nums">
        {count}
      </span>
      <span className="text-xs">problems need attention →</span>
    </Link>
  );
}
