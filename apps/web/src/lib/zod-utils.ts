import { z } from "zod";

/**
 * Context information for enhanced error messages when parsing fails.
 */
type ParseContext = {
  /** Entity type name (e.g., "Product", "Location") */
  entityType: string;
  /** Identifying information - can be a string or key-value pairs */
  identifier?: string | Record<string, string>;
};

/**
 * Format identifier for error messages.
 * Handles both string identifiers and object identifiers.
 */
function formatIdentifier(
  identifier: string | Record<string, string> | undefined,
): string {
  if (!identifier) return "";
  const scalar = z.string().safeParse(identifier);
  if (scalar.success) return scalar.data;

  return Object.entries(identifier)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}="${v}"`)
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
 */
export function parseWithContext<TSchema extends z.ZodType>(
  schema: TSchema,
  data: Parameters<TSchema["safeParse"]>[0],
  context: ParseContext,
): z.output<TSchema> {
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
