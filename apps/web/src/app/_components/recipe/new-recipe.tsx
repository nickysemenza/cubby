import type { RecipeCreateInput } from "@cubby/schemas/recipe";
import { toast } from "sonner";

import { useEntityCreateController } from "~/entities/editing/use-entity-create-controller";

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
  const { error, isPending, submit } = useEntityCreateController<
    "recipe",
    RecipeCreateInput
  >("recipe", {
    onSuccess: () => {
      toast.success("Recipe added to your book.");
    },
  });

  return (
    <RecipeForm
      mode="create"
      onCreate={submit}
      isPending={isPending}
      error={error}
      initialName={initialName}
      initialUrl={initialUrl}
      autoScrape={autoScrape}
      onCancel={() => window.history.back()}
    />
  );
}
