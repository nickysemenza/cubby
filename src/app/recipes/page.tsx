import { HydrateClient } from "~/trpc/server";
import { RecipeList } from "../_components/recipe";

export default function Page() {
  return (
    <HydrateClient>
      <div>
        <h1>Hello, Dashboard Page!</h1>
        <RecipeList />
      </div>
    </HydrateClient>
  );
}
