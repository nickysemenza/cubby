import { z } from "zod";

/**
 * Context information for enhanced error messages when parsing fails.
 */
export type ParseContext = {
  /** Entity type name (e.g., "Product", "Location") */
  entityType: string;
  /** Identifying information - can be a string or key-value pairs */
  identifier?: string | Record<string, unknown>;
};

/**
 * Format identifier for error messages.
 * Handles both string identifiers and object identifiers.
 */
function formatIdentifier(
  identifier: string | Record<string, unknown> | undefined,
): string {
  if (!identifier) return "";
  if (typeof identifier === "string") return identifier;

  return Object.entries(identifier)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${typeof v === "string" ? `"${v}"` : v}`)
    .join(", ");
}

/**
 * Format Zod issues into a readable string.
 */
function formatIssues(issues: z.core.$ZodIssue[]): string {
  return issues
    .map((i) => {
      const path = i.path.length > 0 ? `${i.path.join(".")}: ` : "";
      return `${path}${i.message}`;
    })
    .join("; ");
}

/**
 * Parse data with a Zod schema, throwing an error with contextual information on failure.
 *
 * @example
 * // Simple usage with entity type only
 * const result = parseWithContext(productSchema, data, { entityType: "Product" });
 *
 * @example
 * // With identifier object (recommended for database entities)
 * const result = parseWithContext(productSchema, data, {
 *   entityType: "Product",
 *   identifier: { id: product.id, name: product.name }
 * });
 *
 * @example
 * // With string identifier
 * const result = parseWithContext(amountSchema, data, {
 *   entityType: "Amount",
 *   identifier: `for inventory entry ${entryId}`
 * });
 */
export function parseWithContext<T>(
  schema: z.ZodType<T>,
  data: unknown,
  context: ParseContext,
): T {
  const result = schema.safeParse(data);

  if (!result.success) {
    const identifierStr = formatIdentifier(context.identifier);
    const prefix = identifierStr
      ? `[${context.entityType} ${identifierStr}]`
      : `[${context.entityType}]`;
    const issues = formatIssues(result.error.issues);

    throw new Error(`${prefix} Validation failed: ${issues}`);
  }

  return result.data;
}
