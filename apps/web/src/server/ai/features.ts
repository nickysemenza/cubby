import {
  type DetectedInventoryAiResult,
  detectedInventoryAiResultSchema,
  type LocationDescription,
  locationDescriptionSchema,
} from "@cubby/schemas/ai";
import type { z } from "zod";

// Single source of truth for model-backed feature identity. Bump a feature's
// promptVersion whenever its instructions materially change.
export const AI_MODEL = "claude-haiku-4-5";

export interface AiFeature<T> {
  feature: string;
  model: string;
  promptVersion: string;
  schema: z.ZodType<T>;
}

export const LOCATION_DESCRIPTION_FEATURE = {
  feature: "location-description",
  model: AI_MODEL,
  promptVersion: "2026-06-28.1",
  schema: locationDescriptionSchema,
} satisfies AiFeature<LocationDescription>;

export const LOCATION_INVENTORY_DETECTION_FEATURE = {
  feature: "location-inventory-detection",
  model: AI_MODEL,
  promptVersion: "2026-06-28.1",
  schema: detectedInventoryAiResultSchema,
} satisfies AiFeature<DetectedInventoryAiResult>;

interface LocationAnalysisImageInput {
  id: string;
  updatedAt: Date;
}

export function buildLocationAnalysisFingerprint(
  feature: AiFeature<unknown>,
  input: {
    locationName: string;
    images: LocationAnalysisImageInput[];
  },
): string {
  const images = [...input.images]
    .map((image) => ({
      id: image.id,
      updatedAt: image.updatedAt.toISOString(),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return JSON.stringify({
    feature: feature.feature,
    model: feature.model,
    promptVersion: feature.promptVersion,
    locationName: input.locationName.trim(),
    images,
  });
}
