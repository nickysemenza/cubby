import { z } from "zod";
import { ComboboxItem } from "../../combobox/combobox-types";
import { amount } from "~/codec/codec";
import { recipeTopLevel } from "~/schemas/recipe";
import { type PendingImage } from "../../PendingImageUpload";
import { type ImageOut } from "~/schemas/image";

const ingItem = z.discriminatedUnion("type", [
  z.object({
    id: z.uuid().optional(),
    type: z.literal("ingredient"),
    ingredient: ComboboxItem,
    recipe: z.null(),
    amounts: z.array(amount),
  }),
  z.object({
    id: z.uuid().optional(),
    type: z.literal("recipe"),
    ingredient: z.null(),
    recipe: ComboboxItem,
    amounts: z.array(amount),
  }),
]);
export type IngItem = z.infer<typeof ingItem>;
// Form schema for recipe form
export const formSchema = z.object({
  name: z.string().min(1, "Name is required"),
  meta: recipeTopLevel.shape.meta,
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
import {
  RecipeCreateInput,
  RecipeUpdateInput,
  RecipeOut,
} from "~/schemas/recipe";
