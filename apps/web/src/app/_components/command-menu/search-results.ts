export const COMMAND_SEARCH_RESULT_LIMIT = 6;

/** Preserve the server's rank order while keeping the palette above the fold. */
export function takeCommandSearchResults<T>(results: readonly T[]): T[] {
  return results.slice(0, COMMAND_SEARCH_RESULT_LIMIT);
}
