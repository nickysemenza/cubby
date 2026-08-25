export const MAX_DATABASE_STATEMENT_LENGTH = 1000;

/**
 * Extract only the driver's statement template. Bind values live in later
 * arguments (or `values`) and are deliberately never inspected.
 */
export const databaseStatementForTrace = (head: unknown): string => {
  const statement =
    typeof head === "string"
      ? head
      : head && typeof head === "object" && "text" in head
        ? String((head as { text: unknown }).text)
        : "unknown";
  return statement.slice(0, MAX_DATABASE_STATEMENT_LENGTH);
};
