export const SEMANTIC_MIN_QUERY_LENGTH = 3;

/**
 * The cosine similarity a semantic-only hit needs before a caller treats it as
 * related. Vector lookup always returns its nearest neighbours, so without a
 * floor an empty or unrelated corpus still yields "matches" (a different
 * brand's shoe for a Product's acquisition Expense). Lexical hits do not pass
 * through this floor; it only bounds what meaning alone may propose.
 */
export const SEMANTIC_MATCH_MIN_SIMILARITY = 0.75;
