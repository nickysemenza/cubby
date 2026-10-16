import type { AiChatRequest, AiImagePart } from "~/server/ai/run-feature";

function buildProductIdentificationSystemPrompt(): string {
  return `You are a product identification assistant. Given one or more photos of a product, identify what it is.

Extract:
- "name": the product name WITHOUT the brand (e.g., "packing tape roll", "digital scale")
- "manufacturer": the brand/manufacturer if visible, or "(unspecified)" if not identifiable
- "model": the model number if visible on the product/packaging, or null

Rules:
1. Read any text visible on the product or packaging (labels, brand names, model numbers)
2. If multiple products are visible, identify the most prominent one
3. Be specific with product names but exclude the brand (brand goes in manufacturer)
4. For items you can't clearly identify, use a generic descriptive name
5. Only set model to a value if you can clearly read a model number`;
}

/** Photo URLs as the image parts every vision request opens with. */
function imageParts(imageUrls: string[]): AiImagePart[] {
  return imageUrls.map((url) => ({
    type: "image",
    source: { type: "url", value: url },
  }));
}

export function buildInventoryDetectionRequest(
  imageUrls: string[],
  locationName: string,
): AiChatRequest {
  return {
    systemPrompts: [
      `You are a visual inventory assistant. Identify distinct user-trackable inventory items visible in the photos.

Return canonical product names, not visual-only descriptions:
- Good: "blue tarp", "painters drop cloth", "plastic drop cloth", "packing tape roll"
- Bad: "small blue plastic bag", "cream cloth items", "various packaged items"

Use the location name as a strong hint when it agrees with what is visible. If a folded or partially hidden item is ambiguous but the location name clearly labels the bin contents, return the likely inventory item with medium or low confidence and explain the evidence.

For tarp/drop-cloth/storage-cloth bins, split recognizable material types into separate inventory items when the photo/context supports them. Prefer names like "blue tarp", "painters drop cloth", and "plastic drop cloth" over vague labels like "cloth items", "blue plastic bag", or "packaged items".

For each item:
- "name": product name without brand; include "misc:" only for unidentified or intentionally low-detail placeholders
- "manufacturer": visible brand/manufacturer, or "(unspecified)"
- "estimatedQuantity": quantity visible; use 1 for a single folded/rolled item
- "unit": usually "each" for household/shop items
- "evidence": one short sentence explaining the visual/location-name evidence
- "isMisc": true only for unidentified groups or low-detail bulk placeholders

Do not list the storage crate/bin/drawer itself. Do not list vague clutter, packaging, or bags unless they are the actual item being inventoried. Recognizable items like tarps, drop cloths, tools, containers, supplies, and named packaged goods are not misc. Never return "misc:" for a recognizable tarp or drop cloth.`,
    ],
    messages: [
      {
        role: "user",
        content: [
          ...imageParts(imageUrls),
          {
            type: "text",
            content: `Identify inventory items in this location: "${locationName}"`,
          },
        ],
      },
    ],
  };
}

export function buildLocationDescriptionRequest(
  imageUrls: string[],
  locationName: string,
): AiChatRequest {
  return {
    systemPrompts: [
      "You are a visual inventory assistant. Describe what you see stored in this location. Be concise (2-4 sentences). Identify specific items, brands, and quantities where visible. Don't speculate about items you can't clearly see.",
    ],
    messages: [
      {
        role: "user",
        content: [
          ...imageParts(imageUrls),
          {
            type: "text",
            content: `Describe the contents of this location: "${locationName}"`,
          },
        ],
      },
    ],
  };
}

export function buildProductIdentificationRequest(
  imageUrls: string[],
): AiChatRequest {
  return {
    systemPrompts: [buildProductIdentificationSystemPrompt()],
    messages: [
      {
        role: "user",
        content: [
          ...imageParts(imageUrls),
          {
            type: "text",
            content:
              "Identify this product from the photo(s). Determine the product name, manufacturer and model number if visible.",
          },
        ],
      },
    ],
  };
}

export function descriptionRequest(imageUrl: string) {
  const imagePart: AiImagePart = {
    type: "image",
    source: { type: "url", value: imageUrl },
  };
  return {
    systemPrompts: [
      "Describe this one image accurately for a household catalog. Return only what visual evidence supports. Claims must distinguish visible labels/OCR from visual inference. Never infer material composition from appearance. When a Nutrition Facts panel is legible, return nutritionFacts with its printed serving grams and per-serving nutrient amounts in the declared units (kcal for energy, g for macronutrients, mg or micrograms as declared for micronutrients). Use only numeric amounts printed on this panel; do not use percent daily values as amounts. Preserve omitted nutrients as unknown. An exception is a printed footnote explicitly naming a nutrient as not a significant source: include only those named nutrients in inferredZeroNutrients, quote the exact printed footnote verbatim in inferenceEvidence and in an OCR or label claim, and leave their numeric amounts absent. Never infer zero from an otherwise sparse panel, an omitted nutrient, USDA data, or appearance. If there is no such explicit footnote, leave inferredZeroNutrients empty and inferenceEvidence null. If the panel or serving grams are unreadable, return nutritionFacts null. Mark cutout eligibility eligible only for one clearly isolated object; labels, documents, people, room scenes, and ambiguous groups are ineligible or review.",
    ],
    messages: [
      {
        role: "user" as const,
        content: [
          imagePart,
          {
            type: "text" as const,
            content:
              "Analyze the original image. Do not describe a generated cutout.",
          },
        ],
      },
    ],
  };
}
