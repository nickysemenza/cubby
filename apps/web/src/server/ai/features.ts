import {
  type DetectedInventoryAiResult,
  detectedInventoryAiResultSchema,
  type LocationDescription,
  locationDescriptionSchema,
} from "@cubby/schemas/ai";
import type { z } from "zod";
import {
  DEFAULT_CHAT_MODEL,
  type SupportedChatModel,
} from "~/server/ai/models";

export interface AiFeature<T> {
  feature: string;
  model: SupportedChatModel;
  promptVersion: string;
  schema: z.ZodType<T>;
}

export const LOCATION_DESCRIPTION_FEATURE = {
  feature: "location-description",
  model: DEFAULT_CHAT_MODEL,
  promptVersion: "2026-06-28.1",
  schema: locationDescriptionSchema,
} satisfies AiFeature<LocationDescription>;

export const LOCATION_INVENTORY_DETECTION_FEATURE = {
  feature: "location-inventory-detection",
  model: DEFAULT_CHAT_MODEL,
  promptVersion: "2026-06-28.2",
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
