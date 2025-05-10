import { z } from "zod";
import { ComboboxItem } from "../../combobox/combobox-types";
import { amount } from "~/codec/codec";
import { recipeTopLevel } from "~/schemas/recipe";
import { type PendingImage } from "../../PendingImageUpload";
import { type ImageOut } from "~/schemas/image";

// Form schema for recipe form
export const formSchema = z.object({
  name: z.string().min(1, "Name is required"),
  meta: recipeTopLevel.shape.meta,
  sections: z.array(
    z.object({
      id: z.string().uuid().optional(),
      name: z.string().nullable(),
      ingredients: z.array(
        z.object({
          id: z.string().uuid().optional(),
          type: z.literal("ingredient"),
          ingredient: ComboboxItem.nullable(),
          amounts: z.array(amount),
        }),
      ),
      instructions: z.array(
        z.object({
          id: z.string().uuid().optional(),
          instruction: z.string(),
        }),
      ),
    }),
  ),
});

export type RecipeFormValues = z.infer<typeof formSchema>;

// Props for create mode
export interface CreateRecipeFormProps {
  mode: "create";
  isPending: boolean;
  error?: string;
  onCancel?: () => void;
  onCreate: (data: RecipeCreateInput) => void;
  initialName?: string;
}

// Props for edit mode
export interface EditRecipeFormProps {
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
