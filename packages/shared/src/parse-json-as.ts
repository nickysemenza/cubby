import type { z } from "zod";

/** `raw` as `schema`'s output, or undefined when it is not JSON or does not match. */
export function parseJsonAs<Schema extends z.ZodType>(
  schema: Schema,
  raw: string,
): z.output<Schema> | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return schema.safeParse(value).data;
}
