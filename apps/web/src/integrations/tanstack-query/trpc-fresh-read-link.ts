import type { TRPCLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import type { TRPCRouter } from "~/integrations/trpc/router";
import { markFreshReads } from "~/lib/fresh-read-marker";

function isSuccessfulResult(result: { result: unknown }): boolean {
  return (
    typeof result.result === "object" &&
    result.result !== null &&
    "data" in result.result
  );
}

/**
 * Mark successful tRPC mutations before their result reaches React Query or a
 * direct client caller. Errors and query results pass through untouched.
 */
export function createMutationFreshReadLink(): TRPCLink<TRPCRouter> {
  return () =>
    ({ op, next }) => {
      const result$ = next(op);
      if (op.type !== "mutation") return result$;

      return observable((observer) =>
        result$.subscribe({
          next(result) {
            if (isSuccessfulResult(result)) markFreshReads();
            observer.next(result);
          },
          error(error) {
            observer.error(error);
          },
          complete() {
            observer.complete();
          },
        }),
      );
    };
}
