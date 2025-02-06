import { HydrateClient } from "~/trpc/server";
import { IngredientList } from "../_components/ingredientlist";
import { type Metadata } from "next";

export const metadata: Metadata = {
  title: "Recipes",
};

export default function Page() {
  return (
    <HydrateClient>
      <div>
        <h1>Hello, Dashboard Page!</h1>
        <IngredientList />
      </div>
    </HydrateClient>
  );
}
