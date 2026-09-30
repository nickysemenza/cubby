import { displayImagesField } from "@cubby/schemas/display-images";
import { entitySchema } from "@cubby/schemas/entity";
import { z } from "zod";

export const entityRecordSortSchema = z.enum([
  "name",
  "kind",
  "id",
  "hasImage",
  "quality",
  "createdAt",
  "updatedAt",
]);
const score = z.coerce.number().min(0).max(100);
const date = z.iso.date().optional();
export const entityRecordsInputSchema = z.object({
  q: z.string().max(200).optional(),
  kind: entitySchema.optional(),
  image: z.enum(["has", "none"]).optional(),
  qualityMin: score.optional(),
  qualityMax: score.optional(),
  createdFrom: date,
  createdTo: date,
  updatedFrom: date,
  updatedTo: date,
  orderBy: entityRecordSortSchema.default("updatedAt"),
  direction: z.enum(["asc", "desc"]).default("desc"),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});
export type EntityRecordsInput = z.infer<typeof entityRecordsInputSchema>;
export const entityRecordSchema = z.object({
  id: z.string(),
  kind: entitySchema,
  name: z.string(),
  quality: z.number().min(0).max(100).nullable(),
  hasImage: z.boolean(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  displayImages: displayImagesField,
});
export type EntityRecord = z.infer<typeof entityRecordSchema>;
export const entityRecordsOutputSchema = z.object({
  items: z.array(entityRecordSchema),
  totalCount: z.number().int().nonnegative(),
});
