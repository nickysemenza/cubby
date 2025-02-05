import { type Metadata } from "next";
import NewRecipe from "~/app/_components/recipe/NewRecipe";

export const metadata: Metadata = {
  title: "New Recipe",
};

export default function Page() {
  return (
    <div>
      <h1>Hello, New Recipe Page!</h1>
      <NewRecipe />
    </div>
  );
}
