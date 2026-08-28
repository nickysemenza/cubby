export const MAX_DATABASE_STATEMENT_LENGTH = 1000;

export type DatabaseStatementInput = string | { readonly text: string };

const isStatementText = (
  statement: DatabaseStatementInput,
): statement is string => typeof statement === "string";

/**
 * Extract only the driver's statement template. Bind values live in later
 * arguments (or `values`) and are deliberately never inspected.
 */
export const databaseStatementForTrace = (
  head: DatabaseStatementInput,
): string => {
  const statement = isStatementText(head) ? head : head.text;
  return statement.slice(0, MAX_DATABASE_STATEMENT_LENGTH);
};
