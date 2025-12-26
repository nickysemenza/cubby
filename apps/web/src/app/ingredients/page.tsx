import { IngredientList } from "./ingredientlist";
import type { Metadata } from "next";
import { EntityLayout } from "~/components/layouts/entity-layout";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Ingredients - RecipeHub",
  description: "Browse and manage ingredients in your RecipeHub",
};

export default function Page() {
  return (
    <EntityLayout title="Ingredients">
      <IngredientList />
    </EntityLayout>
  );
}
