import { z } from "zod";
import { reportSlot } from "./entity-report-slots";

/**
 * The one client a summary slot or detail section is limited to; omitted, both
 * web and native render it.
 */
export const detailSurfacesSchema = z
  .tuple([z.enum(["web", "native"])])
  .optional();
export type DetailSurface = "web" | "native";

/** Whether a declared slot or section renders on `surface`. */
export const onDetailSurface = (
  item: { readonly surfaces?: readonly DetailSurface[] },
  surface: DetailSurface,
): boolean => item.surfaces === undefined || item.surfaces.includes(surface);

const identity = {
  id: z.string().min(1),
  title: z.string().min(1),
  surfaces: detailSurfacesSchema,
};

/**
 * Ordered, bounded detail cells shared by web and native. The first four are
 * the record's glance; a field a slot shows is omitted from later field
 * sections.
 */
export const detailSummarySlotSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...identity,
    kind: z.literal("fields"),
    fields: z.array(z.string().min(1)).min(1).max(4),
  }),
  z.strictObject({
    ...identity,
    kind: z.literal("records"),
    viewKey: z.string().min(1),
  }),
  z.strictObject({
    ...identity,
    kind: z.literal("report"),
    slot: reportSlot,
  }),
  z.strictObject({
    ...identity,
    kind: z.literal("chart"),
    viewKey: z.string().min(1),
  }),
]);
export type DetailSummarySlot = z.infer<typeof detailSummarySlotSchema>;
export const detailSummarySchema = z.array(detailSummarySlotSchema).max(8);

/**
 * The detail read's `breadcrumb`: the records above this one, outermost
 * first, projected from the declared `hero.breadcrumb` field.
 */
export const detailBreadcrumbSchema = z.array(
  z.strictObject({ entity: z.string(), id: z.string(), name: z.string() }),
);
export type DetailBreadcrumb = z.infer<typeof detailBreadcrumbSchema>;
