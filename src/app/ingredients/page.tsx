import { HydrateClient } from "~/trpc/server";
import { IngredientList } from "./ingredientlist";
import { type Metadata } from "next";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Recipes",
};

export default function Page() {
  return (
    <HydrateClient>
      <div className="container mx-auto">
        <IngredientList />
      </div>
    </HydrateClient>
  );
}
