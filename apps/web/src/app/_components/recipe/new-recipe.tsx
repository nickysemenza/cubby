import type { RecipeCreateInput } from "@cubby/schemas/recipe";
import { toast } from "sonner";
import { useTRPC } from "~/trpc/react";
import { useEntityCreateMode } from "../hooks/useEntityMode";
import { RecipeForm } from "./recipe-form";

interface NewRecipeFormProps {
  /** Prefill the scrape URL (e.g. from a shared link via the PWA share target). */
  initialUrl?: string;
  /** Prefill the recipe name (e.g. the shared page title). */
  initialName?: string;
  /** Open the scrape panel and, when a URL is prefilled, run the scrape on mount. */
  autoScrape?: boolean;
}

export default function NewRecipeForm({
  initialUrl,
  initialName,
  autoScrape,
}: NewRecipeFormProps = {}) {
  const api = useTRPC();

  const { error, isPending, handleCreate } = useEntityCreateMode<
    RecipeCreateInput,
    { id: string }
  >("recipe", api.recipe.create.mutationOptions(), {
    onSuccess: () => {
      toast.success("Recipe added to your book.");
    },
    onError: () => {
      toast.error("Failed to create recipe");
    },
  });

  return (
    <RecipeForm
      mode="create"
      onCreate={handleCreate}
      isPending={isPending}
      error={error}
      initialName={initialName}
      initialUrl={initialUrl}
      autoScrape={autoScrape}
      onCancel={() => window.history.back()}
    />
  );
}
