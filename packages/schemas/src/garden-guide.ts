import { z } from "zod";

/** A source-specific, intentionally non-prescriptive planting recommendation. */
export const gardenGuideMethod = z.enum([
  "sow",
  "direct-sow",
  "transplant",
  "root",
  "set",
  "tuber",
  "rhizome",
  "bare-root",
  "unspecified",
]);
export type GardenGuideMethod = z.infer<typeof gardenGuideMethod>;

export const gardenGuideMicroclimate = z.enum([
  "sunny",
  "foggy",
  "bay-area",
  "unspecified",
]);
export type GardenGuideMicroclimate = z.infer<typeof gardenGuideMicroclimate>;

export const gardenGuideMonthPart = z.enum(["weeks-1-2", "weeks-3-4"]);
export type GardenGuideMonthPart = z.infer<typeof gardenGuideMonthPart>;

const guideKey = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const month = z.number().int().min(1).max(12);

export const gardenGuideSource = z.object({
  id: guideKey,
  name: z.string().min(1),
  url: z.url(),
  /** The document/page date supplied by the publisher, when available. */
  publishedOrRevised: z.string().min(1).nullable(),
  reviewedAt: z.iso.date(),
  /** Explicitly records material upstream copying so it is not treated as a vote. */
  basedOn: z.array(z.string().min(1)),
  notes: z.string().min(1).nullable(),
});
export type GardenGuideSource = z.infer<typeof gardenGuideSource>;

export const gardenGuideWindow = z.object({
  sourceId: guideKey,
  microclimate: gardenGuideMicroclimate,
  method: gardenGuideMethod,
  months: z.array(month).min(1),
  /** Applies to every month in this window. Split a window when a source varies. */
  monthPart: gardenGuideMonthPart.nullable(),
  notes: z.string().min(1).nullable(),
});
export type GardenGuideWindow = z.infer<typeof gardenGuideWindow>;

export const gardenGuide = z.object({
  key: guideKey,
  name: z.string().min(1),
  aliases: z.array(z.string().min(1)),
  windows: z.array(gardenGuideWindow).min(1),
  notes: z.string().min(1).nullable(),
});
export type GardenGuide = z.infer<typeof gardenGuide>;

export const gardenGuidesDocument = z
  .object({
    schemaVersion: z.literal(1),
    sources: z.array(gardenGuideSource).min(1),
    guides: z.array(gardenGuide).min(1),
  })
  .superRefine((document, context) => {
    const sourceIds = new Set<string>();
    for (const [index, source] of document.sources.entries()) {
      if (sourceIds.has(source.id)) {
        context.addIssue({
          code: "custom",
          path: ["sources", index, "id"],
          message: `Duplicate garden-guide source id: ${source.id}`,
        });
      }
      sourceIds.add(source.id);
    }

    const guideKeys = new Set<string>();
    for (const [guideIndex, guide] of document.guides.entries()) {
      if (guideKeys.has(guide.key)) {
        context.addIssue({
          code: "custom",
          path: ["guides", guideIndex, "key"],
          message: `Duplicate garden-guide key: ${guide.key}`,
        });
      }
      guideKeys.add(guide.key);

      for (const [windowIndex, window] of guide.windows.entries()) {
        if (!sourceIds.has(window.sourceId)) {
          context.addIssue({
            code: "custom",
            path: ["guides", guideIndex, "windows", windowIndex, "sourceId"],
            message: `Unknown garden-guide source id: ${window.sourceId}`,
          });
        }
        if (new Set(window.months).size !== window.months.length) {
          context.addIssue({
            code: "custom",
            path: ["guides", guideIndex, "windows", windowIndex, "months"],
            message: "A garden-guide window cannot repeat a month",
          });
        }
      }
    }
  });
export type GardenGuidesDocument = z.infer<typeof gardenGuidesDocument>;
