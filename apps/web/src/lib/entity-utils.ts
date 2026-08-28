import { z } from "zod";

const namedEntitySchema = z.object({ name: z.string().trim().min(1) });
const titledEntitySchema = z.object({
  name: z.string().trim().min(1).optional(),
  filename: z.string().trim().min(1).optional(),
  product: namedEntitySchema.optional(),
  location: namedEntitySchema.optional(),
});

export function extractEntityTitle<T>(rowData: T): string {
  const parsed = titledEntitySchema.safeParse(rowData);
  if (!parsed.success) return "Unknown";
  if (parsed.data.name) return parsed.data.name;
  if (parsed.data.filename) return parsed.data.filename;
  if (parsed.data.product && parsed.data.location)
    return `${parsed.data.product.name} @ ${parsed.data.location.name}`;

  return "Unknown";
}
