import { sql, type SQL } from "drizzle-orm";
import type { z } from "zod";

/** Schema-owned literals also work in DDL and repeated SELECT/GROUP BY expressions. */
export function sqlEnumConstant<const Values extends Record<string, string>>(
  schema: z.ZodEnum<Values>,
  value: Values[keyof Values],
): SQL {
  return sql.raw("'" + schema.parse(value).replaceAll("'", "''") + "'");
}
