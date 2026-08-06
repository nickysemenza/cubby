import type { AnyRouter } from "@trpc/server";
import {
  type FetchHandlerRequestOptions,
  fetchRequestHandler,
} from "@trpc/server/adapters/fetch";

export function handleTRPCFetchRequest<TRouter extends AnyRouter>(
  options: FetchHandlerRequestOptions<TRouter>,
) {
  return fetchRequestHandler<TRouter>(
    Object.assign({}, options, {
      // The UI sends queries as POST so large inputs stay in the request body.
      // tRPC still dispatches them as query procedures and preserves query cache
      // semantics; this only opts the server adapter into that HTTP transport.
      allowMethodOverride: true,
    }),
  );
}
