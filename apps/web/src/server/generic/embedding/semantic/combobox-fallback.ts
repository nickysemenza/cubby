interface ComboboxSemanticFallbackInput {
  lexicalCount: number;
  query: string;
  hasStructuredFilters: boolean;
  minQueryLength?: number;
  maxStrongLexicalResults?: number;
}

/**
 * Combobox semantic search is intentionally conservative: use it only when the
 * user's text is meaningful, structured identity/category filters are absent,
 * and lexical search did not already produce a healthy result set.
 */
export function shouldUseSemanticComboboxFallback({
  lexicalCount,
  query,
  hasStructuredFilters,
  minQueryLength = 3,
  maxStrongLexicalResults = 2,
}: ComboboxSemanticFallbackInput): boolean {
  return (
    lexicalCount <= maxStrongLexicalResults &&
    query.trim().length >= minQueryLength &&
    !hasStructuredFilters
  );
}
