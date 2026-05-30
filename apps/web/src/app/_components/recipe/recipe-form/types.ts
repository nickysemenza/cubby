import { amount } from "@cubby/schemas/codec";
import type { ImageOut } from "@cubby/schemas/image";
import {
  type RecipeCreateInput,
  type RecipeOut,
  type RecipeUpdateInput,
  recipeMeta,
  recipeServings,
  recipeTags,
  recipeYieldSchema,
} from "@cubby/schemas/recipe";
import { z } from "zod";
import { ComboboxItem } from "../../combobox/combobox-types";
import type { PendingImage } from "../../PendingImageUpload";

// Fields shared by both ingredient-union variants. Mirrors the schema package's
// sectioningredientOut base + extend idiom so the form union is defined once.
const ingItemBase = z.object({
  id: z.string().uuid().optional(),
  amounts: z.array(amount),
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
// Form schema for recipe form
export const formSchema = z.object({
  name: z.string().min(1, "Name is required"),
  meta: recipeMeta,
  yield: recipeYieldSchema.nullable(),
  servings: recipeServings.nullable(),
  tags: recipeTags.nullable(),
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
