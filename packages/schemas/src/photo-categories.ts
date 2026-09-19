/**
 * Photo import categories: manifest-declared groupings of entities that share
 * a Vision classifier vocabulary. Every entity that declares an
 * `images.routing` policy (`packages/schemas/src/entity-definitions/definition.ts`,
 * `imageRoutingMetadataSchema`) names one via `routing.category`.
 *
 * These `classifierLabels` are each category's BASE vocabulary. The
 * *effective* labels a category matches against — base labels plus every
 * member entity's own `signals.classifierLabels` — are computed once, in the
 * generator (`scripts/generator/entities/render/image-policy.ts`), and
 * emitted to both `image-policy.gen.ts` and `PhotoImportCatalog.swift`.
 * Neither TS nor Swift ever recomputes the union at runtime.
 *
 * Every label below (base and per-entity `signals.classifierLabels`) is a real
 * `ClassifyImageRequest` identifier (Vision's `revision2` taxonomy) — verified
 * against `ClassifyImageRequest().supportedIdentifiers` on-device, not guessed —
 * because `PhotoCategoryClassifierLabelsTests` (CubbyKit) asserts the effective
 * set is a subset of it. A label outside that taxonomy can never match a photo.
 */
/** Tuple-typed so `z.enum(photoCategoryKeys)` (definition.ts) infers the literal union.
 * `photoCategories` below is checked `satisfies Record<PhotoCategoryKey, ...>` (keeping literal
 * inference instead of widening to that type), so TypeScript itself rejects a missing or extra
 * category key — the two lists cannot drift silently. */
export const photoCategoryKeys = [
  "plants",
  "food",
  "documents",
  "home",
] as const;
export type PhotoCategoryKey = (typeof photoCategoryKeys)[number];

export const photoCategories = {
  plants: {
    label: "Plants",
    emoji: "🌱",
    classifierLabels: [
      "plant",
      "foliage",
      "flower",
      "tree",
      "shrub",
      "garden",
      "herb",
      "decorative_plant",
      "cactus",
    ],
  },
  food: {
    label: "Food",
    emoji: "🍽️",
    classifierLabels: [
      "food",
      "fruit",
      "vegetable",
      "drink",
      "dessert",
      "bread",
    ],
  },
  documents: {
    label: "Documents",
    emoji: "🧾",
    classifierLabels: [
      "receipt",
      "document",
      "book",
      "newspaper",
      "checkbook",
      "credit_card",
    ],
  },
  home: {
    label: "Home",
    emoji: "🏠",
    classifierLabels: [
      "kitchen",
      "furniture",
      "tool",
      "appliance",
      "bookshelf",
      "cardboard_box",
      "toolbox",
      "garage",
    ],
  },
} as const satisfies Record<
  PhotoCategoryKey,
  { label: string; emoji: string; classifierLabels: readonly string[] }
>;
