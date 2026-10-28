import type { PaginationParams } from "@cubby/schemas/pagination";

/**
 * Rows per query while walking a whole list. Deliberately above the API's
 * `MAX_PAGE_SIZE` (which bounds what a client may ask for in one response):
 * this walk is server-side and exists to avoid many round trips, not to cap
 * a response.
 */
const LIST_ALL_PAGE_SIZE = 2_000;

/**
 * Hard stop for a runaway walk. A household list that reaches this is a bug
 * (an unfiltered scan of a table that should be paged), and throwing beats the
 * old `pageSize: 100_000` bypass, which silently truncated.
 */
const LIST_ALL_MAX_ROWS = 100_000;

/**
 * Every row of a list, read page by page: the explicit form of "fetch all".
 * `readPage` must be a repository list with a deterministic order (every
 * scaffold list ends on the public shortcode), so the pages tile the result.
 * A counted page supplies its population; otherwise the completed walk counts
 * its actual rows.
 */
export async function listAll<T>(
  readPage: (
    pagination: PaginationParams,
  ) => Promise<{ data: T[]; count?: number }>,
): Promise<{ data: T[]; count: number }> {
  const data: T[] = [];
  let count: number | undefined;
  for (let pageIndex = 0; ; pageIndex += 1) {
    const page = await readPage({ pageIndex, pageSize: LIST_ALL_PAGE_SIZE });
    if (pageIndex === 0) count = page.count;
    data.push(...page.data);
    if (page.data.length < LIST_ALL_PAGE_SIZE)
      return { data, count: count ?? data.length };
    if (data.length >= LIST_ALL_MAX_ROWS) {
      throw new Error(
        `listAll read ${data.length} rows without reaching the end; narrow the filters instead of reading the whole list.`,
      );
    }
  }
}
