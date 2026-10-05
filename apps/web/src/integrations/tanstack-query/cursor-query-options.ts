import { z } from "zod";

import type { QueryDescriptor } from "./operation-catalog";

const cursorPageParam = z.string().nullable();
const declaredNextCursor = z.object({ nextCursor: z.string().nullish() });

type CursorInput = { cursor?: string | undefined };
type NextCursor<Page> = (page: Page) => string | null | undefined;

/**
 * Cursor paging over a catalog query, built on the operation's own
 * `infiniteQueryOptions` so its infinite key, input validation, cache policy,
 * and AbortSignal forwarding stay the catalog's. One rule for every caller:
 * a `cursor` in `input` seeds the first page and stays out of the cache key;
 * each later page sends the previous page's next cursor; a null or absent
 * next cursor ends paging. An output that names its next cursor anything but
 * `nextCursor` (run attempts) passes `nextCursor`.
 */
export function cursorQueryOptions<
  Input extends z.ZodType<unknown, CursorInput>,
  Output extends z.ZodTypeAny,
>(
  operation: QueryDescriptor<Input, Output>,
  input: z.input<Input>,
  ...[nextCursor]: z.output<Output> extends {
    nextCursor?: string | null | undefined;
  }
    ? [nextCursor?: NextCursor<z.output<Output>>]
    : [nextCursor: NextCursor<z.output<Output>>]
) {
  const { cursor = null } = input;
  return operation.infiniteQueryOptions(
    { ...input, cursor: undefined },
    {
      pageParamSchema: cursorPageParam,
      initialPageParam: cursor,
      page: (pageInput, pageCursor) =>
        pageCursor === null ? pageInput : { ...pageInput, cursor: pageCursor },
      getNextPageParam: (page) =>
        (nextCursor
          ? nextCursor(page)
          : declaredNextCursor.parse(page).nextCursor) ?? undefined,
    },
  );
}
