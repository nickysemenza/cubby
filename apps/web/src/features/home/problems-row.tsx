import { getErrorMessage } from "@cubby/shared";
import { useQuery } from "@tanstack/react-query";
import { Link, useRouteContext } from "@tanstack/react-router";

import { problems } from "~/integrations/tanstack-query/generated/catalog.gen";
import { formatCount } from "~/lib/number-format";

import { HomeRow } from "./home-list";

/**
 * Needs you's Problems line, shown only when something is outstanding. It
 * shares the navbar's five-minute KV-backed count query instead of fetching
 * five groups of card samples merely to render two numbers.
 *
 * `total` is already defect-only — `PROBLEM_CLASS` keeps coverage rows out of
 * it precisely because a count that can never reach zero makes a permanent red
 * badge nobody can act on. So the two are reported side by side rather than
 * summed: the defect count leads and the coverage backlog trails it as quiet
 * context, which is the difference between "this is wrong" and "this hasn't
 * been filed yet".
 */
function problemsMessage(defects: number): string {
  return defects > 0
    ? `${defects === 1 ? "problem needs" : "problems need"} attention`
    : "No defects found.";
}

export interface ProblemsRowOperations {
  readonly getCounts: typeof problems.getCounts;
}

const productionOperations: ProblemsRowOperations = {
  getCounts: problems.getCounts,
};

export function ProblemsRow({
  isAuthed: authenticated,
  operations = productionOperations,
}: {
  isAuthed?: boolean;
  operations?: ProblemsRowOperations;
}) {
  if (authenticated !== undefined)
    return (
      <ProblemsRowContent isAuthed={authenticated} operations={operations} />
    );
  return <RouteProblemsRow operations={operations} />;
}

function RouteProblemsRow({
  operations,
}: {
  operations: ProblemsRowOperations;
}) {
  const { isAuthed } = useRouteContext({ from: "__root__" });
  return <ProblemsRowContent isAuthed={isAuthed} operations={operations} />;
}

const LINK_CLASS =
  "min-w-0 truncate underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring";

function ProblemsRowContent({
  isAuthed,
  operations,
}: {
  isAuthed: boolean;
  operations: ProblemsRowOperations;
}) {
  const {
    data: counts,
    isLoading,
    error,
  } = useQuery({ ...operations.getCounts.queryOptions(), enabled: isAuthed });
  const defects = counts?.total ?? 0;
  const coverageTotal = counts?.coverageTotal ?? 0;

  // Regression: a failed count read hid the line, which reads as "no
  // problems". Say the count is unknown instead.
  if (error && !counts)
    return (
      <HomeRow>
        <Link to="/problems" className={LINK_CLASS}>
          <span className="font-medium">Couldn't load problem counts:</span>{" "}
          <span className="text-muted-foreground">
            {getErrorMessage(error)}
          </span>
        </Link>
      </HomeRow>
    );

  if (!counts || isLoading || (defects === 0 && coverageTotal === 0))
    return null;

  return (
    <HomeRow
      trailing={
        coverageTotal > 0 ? (
          <span className="text-xs text-muted-foreground">
            {formatCount(coverageTotal)} coverage gaps
          </span>
        ) : null
      }
    >
      <Link
        to="/problems"
        className={`${LINK_CLASS} font-medium text-foreground hover:text-primary`}
      >
        {defects > 0 && (
          <span className="font-mono tabular-nums">
            {formatCount(defects)}{" "}
          </span>
        )}
        <span>{problemsMessage(defects)}</span>
      </Link>
    </HomeRow>
  );
}
