import type { ImageOut } from "@cubby/schemas/image-responses";
import type {
  RecipeCreateInput,
  RecipeUpdateInput,
} from "@cubby/schemas/recipe";
import type { RecipeOut } from "@cubby/schemas/recipe-responses";
import {
  recipeNotes,
  recipeServings,
  recipeTags,
} from "@cubby/schemas/recipe-shared";
import { z } from "zod";
import { ComboboxItem } from "../../combobox/combobox-types";
import type { PendingImage } from "../../PendingImageUpload";

// Draft shape for an ingredient amount, edited via separate qty/unit inputs.
// Either part may be blank so an amount-less ingredient (e.g. oil for frying) can
// be saved with no amount; the refine requires both-or-neither so a half-typed
// amount surfaces an error instead of silently dropping the typed half.
// handleSubmit strips fully-blank amounts to the strict API shape (amounts: []).
const draftAmount = z
  .object({
    value: z.number().nullish(),
    unit: z.string().nullish(),
    // Optional range upper bound ("2–3 cups"). Must exceed the quantity and
    // can't be set without one.
    upperValue: z.number().nullish(),
  })
  .refine((a) => (a.value == null) === !a.unit?.trim(), {
    error: "Enter both a quantity and unit, or leave both blank",
    path: ["unit"],
  })
  .refine(
    (a) => a.upperValue == null || (a.value != null && a.upperValue > a.value),
    {
      error: "Upper bound must be greater than the quantity",
      path: ["upperValue"],
    },
  );

// Fields shared by both ingredient-union variants. Mirrors the schema package's
// sectioningredientOut base + extend idiom so the form union is defined once.
const ingItemBase = z.object({
  id: z.string().uuid().optional(),
  amounts: z.array(draftAmount),
  // Import provenance: the original unparsed line and the parser-derived modifier.
  // Carried read-only through the form so editing a recipe doesn't drop them, and
  // so a row can offer "re-parse this line".
  rawLine: z.string().nullish(),
  modifier: z.string().nullish(),
  // The current ingredient's aliases, so the "re-parse" check can tell real drift
  // from a parse that just matches one of its aliases. Display-only, not submitted.
  aliases: z.array(z.string()).optional(),
});

const ingItem = z.discriminatedUnion("type", [
  ingItemBase.extend({
    type: z.literal("ingredient"),
    ingredient: ComboboxItem,
    recipe: z.null(),
  }),
  ingItemBase.extend({
    type: z.literal("recipe"),
    ingredient: z.null(),
    recipe: ComboboxItem,
  }),
]);

export type IngItem = z.infer<typeof ingItem>;

// Draft shape for the optional meta. The URL input + useWatch register `meta.url`,
// which makes react-hook-form materialize `meta` into { url: undefined } even when
// the field is left blank. The strict recipeMeta (url must be a valid URL or null,
// not undefined) would reject that and silently block the form, so accept a nullish
// url here and let handleSubmit normalize to null when empty.
const recipeMetaDraft = z.object({ url: z.url().nullish() }).nullable();

// Draft shape for the optional yield, edited via two separate inputs. Either part
// may be blank (nullish) so an untouched yield doesn't block submission; the refine
// requires a unit once a value is entered. handleSubmit normalizes this to the
// strict recipeYieldSchema (or null) before sending to the API.
const recipeYieldDraft = z
  .object({
    value: z.number().positive().nullish(),
    unit: z.string().nullish(),
  })
  .nullable()
  .refine((y) => y == null || y.value == null || !!y.unit, {
    error: "Enter a unit for the yield",
    path: ["unit"],
  });

// Form schema for recipe form
export const formSchema = z.object({
  name: z.string().min(1, "Name is required"),
  meta: recipeMetaDraft,
  // Yield is edited as two separate optional inputs, and react-hook-form
  // materializes `yield` into an object ({ value: undefined, unit: undefined }) the
  // moment those inputs render — even when left blank. Modeling it with the strict
  // recipeYieldSchema would fail that value-less object and silently block the
  // whole form. So hold a "draft" shape where either part may be blank (kept
  // transform-free so z.input === z.output and the form generics stay simple), and
  // normalize it to the strict API shape in handleSubmit. The refine still requires
  // a unit once a value is entered, so a partial yield surfaces an error instead of
  // being silently dropped.
  yield: recipeYieldDraft,
  servings: recipeServings.nullable(),
  tags: recipeTags.nullable(),
  // Freeform markdown notes; the textarea normalizes "" → null on change so an
  // untouched/cleared field round-trips as null.
  notes: recipeNotes.nullable(),
  sections: z.array(
    z.object({
      id: z.uuid().optional(),
      name: z.string().nullable(),
      ingredients: z.array(ingItem),
      instructions: z.array(
        z.object({
          id: z.uuid().optional(),
          instruction: z.string(),
        }),
      ),
    }),
  ),
});

export type RecipeFormValues = z.infer<typeof formSchema>;

// Props for create mode
interface CreateRecipeFormProps {
  mode: "create";
  isPending: boolean;
  error?: string;
  onCancel?: () => void;
  onCreate: (data: RecipeCreateInput) => void;
  initialName?: string;
}

// Props for edit mode
interface EditRecipeFormProps {
  mode: "edit";
  isPending: boolean;
  error?: string;
  onCancel?: () => void;
  onEdit: (data: RecipeUpdateInput) => void;
  entity: RecipeOut & {
    images?: PendingImage[] | ImageOut[];
  };
}

// Combined props type using discriminated union
export type RecipeFormProps = CreateRecipeFormProps | EditRecipeFormProps;

// Import types from schema
