import { type Metadata } from "next";
import NewRecipeForm from "~/app/_components/recipe/new-recipe";
import { WasmContextProvider } from "~/wasmContext";

export const metadata: Metadata = {
  title: "New Recipe",
};

export default function Page() {
  return (
    <div className="container py-6">
      <h1 className="mb-6 text-2xl font-bold">Create New Recipe</h1>
      <WasmContextProvider>
        <NewRecipeForm />
      </WasmContextProvider>
    </div>
  );
}
