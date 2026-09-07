import { z } from "zod";
import { MAX_EXTERNAL_HTML_BYTES } from "@cubby/shared";
import { amount } from "./codec";
import {
  cookbookShortcode,
  productShortcode,
  recipeShortcode,
} from "./identifiers";
import { cookbookSummary } from "./recipe";

// Times arrive twice over: the prose string is verbatim what the source printed,
// the `*_minutes` count is the same duration as a number. A present string does
// NOT imply a present count — the scraper fills both from an ISO-8601 duration,
// but the EPUB extractor parses the model's freeform prose conservatively, so a
// range ("1 to 2 hours") or an open-ended phrase ("overnight") keeps its string
// and leaves the count absent. Snake-cased because these mirror the Rust
// `recipe_types::RecipeTimes` JSON verbatim.
const importRecipeTimes = z.object({
  active: z.string().optional(),
  total: z.string().optional(),
  prep: z.string().optional(),
  cook: z.string().optional(),
  active_minutes: z.number().int().nonnegative().optional(),
  total_minutes: z.number().int().nonnegative().optional(),
  prep_minutes: z.number().int().nonnegative().optional(),
  cook_minutes: z.number().int().nonnegative().optional(),
});

// Structured yield, as the URL scraper produces it (parsed from schema.org).
// Reuses `amount` — the recipe-scraper Rust grammar (recipebridge's
// `WRecipeYield`) always emits a real unit token, so `amount`'s `unit.min(1)`
// tightening over the previous bare `z.string()` cannot reject its output.
const structuredYield = amount;

const importRecipeMeta = z.object({
  title: z.string(),
  description: z.string().optional(),
  // Yield is either a freeform line ("Makes 1 loaf", from EPUB/Notion — re-parsed
  // at import) or already-structured `{value, unit}` (from the URL scraper). The
  // converter normalizes both; the raw string is what `Cookbook.rawJson` stores
  // so `reprocessCookbook` can re-apply WASM parser upgrades.
  recipe_yield: z.union([z.string(), structuredYield]).optional(),
  times: importRecipeTimes.optional(),
  equipment: z.array(z.string()).optional(),
  notes: z.array(z.string()).optional(),
  category: z.string().optional(),
  page: z.string().optional(),
});

export const composeNotesMarkdown = (
  description: string | undefined | null,
  notes: readonly string[] | undefined | null,
): string | null => {
  const parts: string[] = [];
  const headnote = description?.trim();
  if (headnote) parts.push(headnote);
  const bullets = (notes ?? []).map((n) => n.trim()).filter(Boolean);
  if (bullets.length > 0) parts.push(bullets.map((n) => `- ${n}`).join("\n"));
  return parts.length > 0 ? parts.join("\n\n") : null;
};

const importRecipeSection = z.object({
  name: z.string().optional(),
  ingredients: z.array(z.string()),
  instructions: z.array(z.string()).default([]),
});

export const recipeRefSchema = z.object({
  title: z.string(),
  line: z.string(),
  confidence: z.enum(["linked", "title_match"]),
});
export type RecipeRef = z.infer<typeof recipeRefSchema>;

export const archiveImageRefSchema = z.object({
  path: z.string().min(1),
  mime: z.string().min(1),
  alt: z.string().optional(),
});

const publicRecipeImageUrl = z
  .url()
  .refine(
    (value) => /^https?:\/\//iu.test(value),
    "Recipe image URL must use HTTP or HTTPS",
  );

export const recipeImageSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("url"), url: publicRecipeImageUrl }),
  archiveImageRefSchema.extend({ kind: z.literal("epub") }),
]);

// Normalize upstream scraper/EPUB output and persisted cookbook JSON once at
// ingress. All consumers receive an explicit source; archive paths are not URLs.
const importedImageSource = z.union([
  recipeImageSourceSchema,
  publicRecipeImageUrl.transform((url) => ({ kind: "url" as const, url })),
  archiveImageRefSchema.transform((ref) => ({ kind: "epub" as const, ...ref })),
]);

export const importRecipeSchema = z.object({
  meta: importRecipeMeta,
  sections: z.array(importRecipeSection),
  // The book label (food-cli passes the .epub path); provenance only.
  source: z.string().optional(),
  // Synthetic `source#doc_path`, not a real URL; provenance only.
  url: z.string().optional(),
  references: z.array(recipeRefSchema).default([]),
  servings: z.number().optional(),
  image: importedImageSource.optional(),
});
export type ImportRecipe = z.infer<typeof importRecipeSchema>;

export const importRecipesSchema = z.array(importRecipeSchema);

export const scrapeRecipeInput = z.url();

export const parseRecipeHtmlInput = z.object({
  html: z.string().min(1).max(MAX_EXTERNAL_HTML_BYTES),
  url: z.url(),
});

export const recipeImportIdOut = z.object({
  id: recipeShortcode,
});

export const upsertCookbookInput = z.object({
  name: z.string().min(1),
  rawJson: importRecipesSchema,
  author: z.array(z.string()).optional(),
  subjects: z.array(z.string()).optional(),
  sourceLabel: z.string(),
  coverImageId: z.uuid().optional(),
  /**
   * The book's ISBN as a canonical GTIN-14, picked out of the EPUB's OPF
   * `<dc:identifier>` values by `isbnFromEpubIdentifiers`. Absent when the book
   * declares no valid ISBN (plenty declare only a Calibre UUID).
   *
   * Transient: it is NOT stored on the Cookbook. The importer resolves it to a
   * Product — matching an existing one by barcode, or minting one — and keeps
   * only `Cookbook.productId`. Barcodes live on `ProductExternalId`, and a
   * second copy on Cookbook would be a second thing to keep in agreement.
   */
  isbn: z.string().optional(),
});

export const cookbookIdOut = z.object({
  id: cookbookShortcode,
});

export const cookbookIdInput = z.object({
  cookbookId: cookbookShortcode,
});

export const cookbookReprocessEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("progress"),
    done: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("done"),
    result: z.object({
      reprocessed: z.number().int().nonnegative(),
      importableExtras: z.array(z.string()),
    }),
  }),
]);

// Link (or, with a null productId, unlink) a cookbook's physical copy. Always
// operator-driven: see the `Cookbook.productId` column comment for why nothing
// resolves a title to a product without a human confirming it.
export const setCookbookProductInput = z.object({
  cookbookId: cookbookShortcode,
  productId: productShortcode.nullable(),
});

export const cookbookSourceOut = z.object({
  id: cookbookShortcode,
  name: z.string(),
  recipes: importRecipesSchema,
});

export const importCookbookStreamInput = z.object({
  cookbookId: cookbookShortcode,
  indices: z.array(z.number().int().nonnegative()).min(1),
});

export const cookbookImportEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("progress"),
    done: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    item: z
      .union([
        z.object({
          index: z.number().int().nonnegative(),
          ok: z.literal(true),
          id: z.string(),
          hasImage: z.boolean(),
        }),
        z.object({
          index: z.number().int().nonnegative(),
          ok: z.literal(false),
          error: z.string(),
        }),
      ])
      .optional(),
  }),
  z.object({
    type: z.literal("done"),
    result: z.object({
      succeeded: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
    }),
  }),
]);

export const cookbookDiffInput = z.object({
  book: z.string().min(1),
});

export const cookbookDiffOut = z.array(
  z.object({
    title: z.string(),
    id: recipeShortcode,
    sig: z.string(),
    hasImage: z.boolean(),
  }),
);

export const notionPreviewItem = z.object({
  pageId: z.string(),
  name: z.string(),
  notionUrl: z.string(),
  status: z.enum(["new", "unchanged", "will-update", "needs-formatting"]),
  existingId: recipeShortcode.nullable(),
  reasons: z.array(z.string()),
  recipe: importRecipeSchema,
});

export const notionPreviewOut = z.array(notionPreviewItem);

export const importNotionSyncInput = z.object({
  pageIds: z.array(z.string()).min(1),
});

export const notionImportEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("progress"),
    done: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    item: z
      .union([
        z.object({
          pageId: z.string(),
          ok: z.literal(true),
          id: z.string(),
          status: z.enum(["created", "updated"]),
        }),
        z.object({
          pageId: z.string(),
          ok: z.literal(false),
          error: z.string(),
        }),
      ])
      .optional(),
  }),
  z.object({
    type: z.literal("done"),
    result: z.object({
      succeeded: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
    }),
  }),
]);

export const cookbookSummariesOut = z.array(cookbookSummary);

export const deleteCookbookOut = z.object({
  deletedRecipes: z.number().int().nonnegative(),
});

export const attachCookbookRecipePhotoInput = z.object({
  cookbookId: cookbookShortcode,
  recipeId: recipeShortcode,
  sourceIndex: z.number().int().nonnegative(),
  data: z.string().min(1),
});

export const attachCookbookRecipePhotoOut = z.object({
  status: z.enum(["attached", "reused", "skipped-existing"]),
  cleanupWarning: z.string().optional(),
});

// Input for `recipe.extractCookbookChunk` (camelCased WASM request). Exported
// so the client carrier type derives from it via `z.infer` instead of being
// maintained in two places.
export const chunkRequestInput = z.object({
  system: z.string(),
  user: z.string(),
  toolName: z.string(),
  toolSchema: z.record(z.string(), z.json()),
  // Escalate this chunk to the stronger fallback model. The browser sets
  // this only after the default model fails to return parseable output. The
  // model itself stays server-owned (a bool, not a model id) so a client
  // can't pick an arbitrary expensive model.
  escalate: z.boolean().optional(),
});

export const cookbookLlmUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_creation_input_tokens: z.number().int().nonnegative(),
  cache_read_input_tokens: z.number().int().nonnegative(),
});

export const chunkResponseOut = z.object({
  input: z.json().nullable(),
  usage: cookbookLlmUsageSchema,
  truncated: z.boolean(),
  error: z
    .object({
      message: z.string(),
      // Transport failures are retried by the authenticated TypeScript hop;
      // payload failures are passed to upstream retry and escalation policy.
      kind: z.enum(["payload", "transport"]),
    })
    .optional(),
});

export const mcpRecipeCreateFromTextSection = z.object({
  name: z
    .string()
    .optional()
    .describe("Section name, e.g. 'Sauce' (omit for a single unnamed section)"),
  ingredients: z
    .array(z.string())
    .describe(
      "Raw ingredient lines, e.g. '1 cup jasmine rice' — NOT ingredient IDs",
    ),
  instructions: z
    .array(z.string())
    .default([])
    .describe("Instruction step lines, one string per step"),
});

export const mcpRecipeCreateFromTextInput = z.object({
  name: z.string().min(1).describe("Recipe name"),
  servings: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Number of servings"),
  yield: z
    .string()
    .optional()
    .describe(
      "Freeform yield, e.g. '2 loaves' or 'Makes 12 pancakes' (parsed server-side)",
    ),
  notes: z.string().optional().describe("Headnote / notes markdown"),
  sections: z
    .array(mcpRecipeCreateFromTextSection)
    .min(1)
    .describe(
      "Recipe sections; each holds raw ingredient lines and instruction steps",
    ),
});
