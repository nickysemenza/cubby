import { type Metadata } from "next";
import NewCompactRecipe from "~/app/_components/recipe/NewCompactRecipe";

export const metadata: Metadata = {
  title: "New Recipe",
};

export default function Page() {
  return (
    <div>
      <NewCompactRecipe />
    </div>
  );
}
