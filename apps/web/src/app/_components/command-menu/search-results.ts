export const COMMAND_SEARCH_RESULT_LIMIT = 6;

/** Preserve the server's rank order while keeping the palette above the fold. */
export function takeCommandSearchResults<T>(results: readonly T[]): T[] {
  return results.slice(0, COMMAND_SEARCH_RESULT_LIMIT);
}

interface SearchResultIdentity {
  entityType: string;
  id: string;
}

/**
 * Keep fast lexical rows fixed, then fill remaining palette space with only
 * new semantic hits. This prevents a late embedding response from moving the
 * active cmdk row underneath the user's keyboard selection.
 */
export function appendNovelSemanticResults<T extends SearchResultIdentity>(
  lexical: readonly T[],
  semantic: readonly T[],
): T[] {
  const seen = new Set(lexical.map((item) => `${item.entityType}:${item.id}`));
  return takeCommandSearchResults([
    ...lexical,
    ...semantic.filter((item) => {
      const key = `${item.entityType}:${item.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  ]);
}
