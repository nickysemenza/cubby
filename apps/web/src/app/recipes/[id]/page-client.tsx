"use client";

import { RecipeOut } from "~/schemas/recipe";
import { useSearchParams } from "next/navigation";
import RecipeDetail from "~/app/_components/recipe/RecipeDetail";
import EditRecipeForm from "~/app/_components/recipe/edit-recipe";
import { Button } from "~/components/ui/button";
import { Edit, X } from "lucide-react";
import { useRouter } from "next/navigation";

interface RecipePageClientProps {
  recipe: RecipeOut;
}

export default function RecipePageClient({ recipe }: RecipePageClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const isEditing = searchParams.get("edit") === "true";

  const startEditing = () => {
    const params = new URLSearchParams(searchParams);
    params.set("edit", "true");
    router.push(`?${params.toString()}`);
  };

  const stopEditing = () => {
    const params = new URLSearchParams(searchParams);
    params.delete("edit");
    router.push(`?${params.toString()}`);
  };

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">{recipe.name}</h1>
        {!isEditing ? (
          <Button onClick={startEditing} variant="outline" size="sm">
            <Edit className="mr-2 h-4 w-4" />
            Edit Recipe
          </Button>
        ) : (
          <Button onClick={stopEditing} variant="outline" size="sm">
            <X className="mr-2 h-4 w-4" />
            Cancel
          </Button>
        )}
      </div>

      {isEditing ? (
        <EditRecipeForm recipe={recipe} onCancel={stopEditing} />
      ) : (
        <RecipeDetail recipe={recipe} />
      )}
    </div>
  );
}
