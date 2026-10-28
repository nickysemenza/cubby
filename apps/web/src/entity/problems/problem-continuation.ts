import { queryOptions, useQuery } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

/** Resolve the selected canonical declaration without shipping the Problems registry. */
const readProblemContinuation = createServerFn({ method: "GET" })
  .validator(z.string())
  .handler(async ({ data }) => {
    const { problemQueryDeclarations } =
      await import("~/entity/problems/problem-registry");
    const query = problemQueryDeclarations().find(
      (candidate) => candidate.key === data,
    );
    return query?.source.kind === "entity" &&
      query.continuation.kind === "entity-list"
      ? { key: query.key, title: query.title, source: query.source }
      : null;
  });

const problemContinuationQueryOptions = (key: string | undefined) =>
  queryOptions({
    queryKey: ["problem-continuation", key ?? null],
    queryFn: () => (key ? readProblemContinuation({ data: key }) : null),
    enabled: key !== undefined,
    staleTime: Infinity,
  });

export type ProblemContinuation = Awaited<
  ReturnType<typeof readProblemContinuation>
>;

export function useProblemContinuation(key: string | undefined) {
  const query = useQuery(problemContinuationQueryOptions(key));
  if (query.error) throw query.error;
  return query.data;
}
