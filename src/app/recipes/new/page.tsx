import { type Metadata } from "next";
import { api } from "~/trpc/server";
import NewRecipeForm from "~/app/_components/recipe/new-recipe";
import { WasmContextProvider } from "~/wasmContext";

export const metadata: Metadata = {
  title: "New Recipe",
};

export default function Page() {
  return (
    <div className="container py-6">
      <h1 className="text-2xl font-bold mb-6">Create New Recipe</h1>
      <WasmContextProvider>
        <NewRecipeForm />
      </WasmContextProvider>
    </div>
  );
}