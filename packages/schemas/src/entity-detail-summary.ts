import { z } from "zod";
import { reportSlot } from "./entity-report-slots";

const identity = { id: z.string().min(1), title: z.string().min(1) };

/** Ordered, bounded detail cells shared by web and native. */
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
